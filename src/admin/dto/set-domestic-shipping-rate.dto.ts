import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Body PUT /admin/shipping/domestic-rates — set SATU TIER ongkir kirim DOMESTIK (kurir lokal).
 *
 * ┌──── INI RUTE TEMPAT PEMILIK PRODUK MENETAPKAN ONGKIRNYA ──────────────────────────────────┐
 * │ Model ongkirnya BERTINGKAT PER WILAYAH, dan tier-nya DATA: satu baris = satu tier, yang    │
 * │ membawa harganya SEKALIGUS daftar provinsinya. Jadi MENAMBAH TIER = memanggil rute ini     │
 * │ dengan scope baru. Tidak ada deploy, tidak ada migrasi, tidak ada restart.                 │
 * │                                                                                            │
 * │ Dua tier awal yang disarankan (pembelahan baku Indonesia):                                 │
 * │   { "scope":"TIER:JAWA",      "priceIdr":22000, "label":"Jawa",                            │
 * │     "provinces":["jakarta","jawa barat","jawa tengah","jawa timur","banten","yogyakarta"] }│
 * │   { "scope":"TIER:LUAR_JAWA", "priceIdr":45000, "label":"Luar Jawa", "fallback":true }     │
 * │                                                                                            │
 * │ Pembelahan yang lebih halus nanti, tanpa menyentuh kode:                                   │
 * │   { "scope":"TIER:TIMUR", "priceIdr":80000, "label":"Papua & Maluku",                      │
 * │     "provinces":["papua","papua barat","maluku","maluku utara"] }                          │
 * │   { "scope":"STATE:papua", "priceIdr":95000 }        ← harga khusus SATU provinsi          │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * NOL DANA TREASURY: baris ini hanya menentukan nominal RUPIAH yang ditagihkan ke pembeli.
 * Batas nominalnya divalidasi ke batas mint IDRX di service (assertSaneRate), bukan di sini — satu
 * titik penegakan supaya pemanggil baru tidak bisa melewatinya.
 */
export class SetDomesticShippingRateDto {
  @ApiPropertyOptional({
    description:
      "Kunci baris. 'TIER:<NAMA>' = tier wilayah (pakai `provinces`). 'STATE:<provinsi>' = harga " +
      "khusus satu provinsi. '*' = flat nasional (bentuk lama). Kosong = '*'.",
    default: '*',
    example: 'TIER:JAWA',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  scope?: string;

  @ApiProperty({
    description:
      'Ongkir Rupiah UTUH. Harus di dalam batas mint IDRX (Rp 20.000–Rp 1.000.000.000) — ' +
      'tarif di bawah minimum IDRX menghasilkan invoice yang tidak akan pernah bisa terbit, dan ' +
      'ditolak DI SINI (bukan nanti di checkout user).',
    example: 22000,
  })
  @IsInt()
  priceIdr!: number;

  /**
   * DAFTAR PROVINSI MILIK TIER INI — inilah yang membuat tier jadi DATA, bukan kode.
   *
   * Dinormalkan service (huruf kecil, tanda baca jadi spasi), jadi "DKI Jakarta" dan "dki jakarta"
   * sama saja. Boleh memuat BANYAK EJAAN untuk satu provinsi — kolom `state` pada alamat user
   * diisi dari dropdown geo (yang untuk Indonesia memakai sebagian nama INGGRIS: "West Java")
   * ATAU diketik bebas ketika CSC_API_KEY kosong ("Jabar", "Jogja"). Daftar yang cuma memuat nama
   * resmi Indonesia akan melempar separuh pembeli Jawa ke tier luar Jawa.
   *
   * TIDAK DISEBUT = daftar lama baris ini TIDAK diubah. Untuk mengosongkannya, kirim [].
   */
  @ApiPropertyOptional({
    description:
      'Provinsi milik tier ini (boleh banyak ejaan per provinsi). Tidak disebut = daftar lama ' +
      'tidak diubah; kirim [] untuk mengosongkan.',
    type: [String],
    example: ['jakarta', 'jawa barat', 'jabar', 'west java'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  provinces?: string[];

  /**
   * TIER PENAMPUNG: dipakai untuk provinsi yang tidak cocok ke tier mana pun — termasuk alamat
   * yang tidak menyebut provinsi sama sekali.
   *
   * SEHARUSNYA TEPAT SATU tier aktif bernilai true, dan service MENEGAKKANNYA: menyalakan flag ini
   * di satu baris otomatis mematikannya di baris lain (dalam satu transaksi), jadi tidak mungkin
   * ada dua penampung yang saling berebut.
   *
   * SARAN: pasang di tier TERMAHAL (biasanya luar Jawa). Penampung yang lebih mahal tidak pernah
   * menagih kurang untuk provinsi yang belum terdaftar.
   */
  @ApiPropertyOptional({
    description:
      'true = tier PENAMPUNG untuk provinsi yang tidak dikenal / alamat tanpa provinsi. Otomatis ' +
      'mematikan flag ini di tier lain. Pasang di tier TERMAHAL.',
  })
  @IsOptional()
  @IsBoolean()
  fallback?: boolean;

  @ApiPropertyOptional({
    description:
      'Nama manusiawi tier ini ("Jawa", "Luar Jawa", "Papua & Maluku"). Ikut tampil di dashboard ' +
      'dan di taksiran ongkir yang dilihat user.',
    example: 'Jawa',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({
    description:
      'false = baris disimpan tapi tidak dipakai (resolusi jatuh ke lapis berikutnya).',
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    description: 'Catatan operator, mis. "flat JNE REG 2026 Q4".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
