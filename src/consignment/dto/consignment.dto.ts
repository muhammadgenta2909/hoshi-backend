import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsignmentPhotoKind, Grader } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  CONSIGNMENT_RETURN_METHOD,
  CONSIGNMENT_RETURN_PAYER,
} from '../../common/consignment.gate';

/** Batas atas nominal Rupiah yang masuk akal untuk satu kartu (sejalan dengan IDRX_MAX listing). */
const IDR_MAX = 2_000_000_000;

/** Panjang minimal catatan manusia yang WAJIB beralasan (sejalan dengan OPERATOR_NOTE_MIN admin). */
const NOTE_MIN = 10;

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   RUJUKAN GAMBAR — KENAPA INI BUKAN @MaxLength(2000)

   Versi pertama DTO ini memakai `@MaxLength(2000)` untuk `url` foto dan `image` listing. Angka
   2000 masuk akal untuk sebuah URL, dan justru itu masalahnya: di lingkungan ini, yang dikirim
   belum tentu URL.

   Rute unggah gambar punya FALLBACK YANG DISENGAJA. Kalau `CLOUDINARY_URL` tidak terpasang,
   `POST /admin/upload` di produksi mengembalikan DATA URL base64 (admin.service.ts, dibatasi 2MB
   per gambar) supaya unggahan tetap jalan tanpa kredensial apa pun. Gambar 2MB menjadi ~2,7 juta
   karakter base64 — 1350 kali di atas batas 2000.

   Akibat nyatanya bukan "validasi ketat", melainkan INTAKE YANG MATI DI LAPANGAN: operator berdiri
   di ruang tamu pemilik kartu, memotret kartunya, lalu menerima 400 "url must be shorter than or
   equal to 2000 characters" dan TIDAK BISA mencatat serah-terimanya sama sekali. Kartunya tidak
   pernah sampai ke rak.

   YANG MEMBUATNYA PALING SULIT DIDIAGNOSIS: seluruh sisa sistem memang dibangun untuk menampung
   data URL. `main.ts` menaikkan batas body ke 12mb dengan komentar yang menyebut fallback ini, dan
   `CreateListingDto.image` (jalur listing Hoshi biasa) sama sekali TIDAK punya `@MaxLength`. Jadi
   di droplet tanpa Cloudinary, listing Hoshi tetap jalan dan HANYA titipan yang tumbang — persis
   pola kegagalan yang paling lama dikira "bug titipan" padahal soal lingkungan.

   Karena itu batasnya dua cabang, bukan dibuang:
     • `data:image/...`  → panjangnya dijaga DUA pagar yang sudah ada: guard 2MB di rute unggah dan
                           limit body 12mb. Menambah pagar ketiga di sini hanya melahirkan angka
                           keempat yang bisa berbeda sendiri.
     • selain itu        → tetap maksimum 2000 karakter, seperti URL yang waras.

   `data:` non-gambar (mis. `data:text/html`) DITOLAK: nilai ini berakhir di atribut `src`, dan
   satu-satunya alasan ia boleh panjang adalah karena ia gambar.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const IMAGE_REF_URL_MAX = 2000;

function isImageRef(v: unknown): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  // Setiap `data:` diadili sebagai data URL, TIDAK PERNAH jatuh ke cabang panjang di bawah.
  // Kalau tidak, `data:text/html;base64,…` yang pendek lolos hanya karena ia pendek — dan
  // panjang bukan alasan sesuatu boleh masuk ke atribut `src`.
  if (v.startsWith('data:')) return v.startsWith('data:image/');
  return v.length <= IMAGE_REF_URL_MAX;
}

const IMAGE_REF_MESSAGE =
  `harus berupa URL (maks ${IMAGE_REF_URL_MAX} karakter) atau data URL gambar ` +
  '(diawali "data:image/"; panjangnya dijaga batas unggah 2MB dan limit body server)';

/** Dipakai untuk setiap field yang menampung rujukan gambar di jalur titipan. Lihat blok di atas. */
function IsImageRef(): PropertyDecorator {
  return Validate(ImageRefConstraint);
}

@ValidatorConstraint({ name: 'isImageRef', async: false })
class ImageRefConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isImageRef(value);
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} ${IMAGE_REF_MESSAGE}`;
  }
}

export class ConsignmentPhotoInput {
  @ApiProperty({
    example: 'https://cdn.hoshi/intake/abc-front.jpg',
    description:
      'URL gambar, ATAU data URL base64 (yang dikembalikan rute unggah kalau CLOUDINARY_URL ' +
      'tidak terpasang). Lihat blok RUJUKAN GAMBAR di kepala berkas ini.',
  })
  @IsString()
  @IsImageRef()
  url!: string;

  @ApiProperty({ enum: ConsignmentPhotoKind })
  @IsEnum(ConsignmentPhotoKind)
  kind!: ConsignmentPhotoKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * INTAKE — kesepakatan dicatat. Kartunya BELUM tentu sudah diserahkan; yang membuatnya "ada di
 * tangan Hoshi" adalah langkah `accept-custody` yang TERPISAH, dan itu disengaja.
 *
 * ADMIN-ONLY. Tidak ada rute self-service: sebuah endpoint yang bisa dipanggil orang asing untuk
 * menyatakan "kartu saya ada di kalian" adalah mesin pembuat kebohongan.
 */
export class CreateConsignmentDto {
  @ApiPropertyOptional({
    description:
      'User id PEMILIK kartu (consignor). OPSIONAL. Isi HANYA kalau pemiliknya sudah punya akun ' +
      'Hoshi DAN operator sudah MEMILIHNYA sendiri dari hasil ' +
      'GET /admin/consignments/consignor-search. Kosongkan kalau ia belum punya akun: ' +
      'titipannya tetap tercatat, dan responsnya memuat KODE KLAIM sekali pakai untuk dicetak di ' +
      'tanda terima. Kartu tanpa pemilik tertaut TIDAK BISA dipajang maupun terjual.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  consignorId?: string;

  /*
   * TIDAK ADA `consignorEmail` DI SINI, DAN TIDAK BOLEH DITAMBAHKAN.
   *
   * `User.email` di schema ini `String?` — TIDAK unik dan TIDAK PERNAH diverifikasi; siapa pun
   * bisa mengetik alamat orang lain di setelan profilnya sendiri. Hanya `walletAddress` yang
   * `@unique`. Sebuah field yang menautkan kartu senilai puluhan juta Rupiah ke siapa pun yang
   * MENGAKU memiliki sebuah alamat email adalah kelas bug terburuk yang bisa dipunyai fitur ini.
   * Satu-satunya nilai yang tidak ambigu adalah id, dan id datang dari operator yang MEMILIH
   * orangnya dari daftar.
   */

  @ApiProperty({
    description:
      'SNAPSHOT nama pemilik saat serah-terima. Sengaja disalin, bukan dibaca dari User: ' +
      'displayName bisa berubah, dan apa yang benar pada HARI itu tidak bisa diturunkan ulang. ' +
      'WAJIB juga ketika consignorId kosong — di sana justru ia paling penting: tanpa akun untuk ' +
      'dirujuk, nama dan telepon inilah satu-satunya cara operator dan pemilik kartu bisa saling ' +
      'mengenali lagi nanti.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  consignorNameAtIntake!: string;

  @ApiProperty({
    description: 'SNAPSHOT nomor telepon pemilik saat serah-terima.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(40)
  consignorPhoneAtIntake!: string;

  @ApiPropertyOptional({ enum: ['KTP', 'SIM', 'PASPOR'] })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  consignorIdKind?: string;

  @ApiPropertyOptional({
    description:
      'EMPAT DIGIT TERAKHIR saja. Nomor identitas lengkap TIDAK PERNAH disimpan — ia tidak ' +
      'dibutuhkan untuk apa pun di sini, dan menyimpannya hanya menambah barang berharga milik ' +
      'orang lain yang bisa bocor.',
    example: '4417',
  })
  @IsOptional()
  @IsString()
  @Length(4, 4)
  consignorIdLast4?: string;

  @ApiProperty({ example: 'Rumah pemilik, Bandung' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  receivedAtPlace!: string;

  @ApiProperty({ example: 'Charizard VMAX' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  cardName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cardSet?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  cardNumber?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  language?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) tcg?: string;

  @ApiPropertyOptional({
    enum: Grader,
    description: 'null = kartu MENTAH (belum di-grade).',
  })
  @IsOptional()
  @IsEnum(Grader)
  grader?: Grader;

  @ApiPropertyOptional({
    description:
      'Nomor sertifikat PSA/TAG/CGC/BGS. Ini identitas TERKUAT yang tersedia dan bisa dicek di ' +
      'SITUS GRADER-nya sendiri — bukti yang tidak bersandar pada "kata Hoshi".',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  certNumber?: string;

  @ApiPropertyOptional({ example: 'PSA 10' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  gradeLabel?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  gradeScore?: number;

  @ApiProperty({
    description:
      'Kondisi SAAT DITERIMA, dengan kata-kata penerima sendiri. WAJIB, bahkan untuk slab ' +
      '("slab utuh, tidak ada retak, label lurus") — kalimat inilah tumpuan kalau ada sengketa.',
    example: 'Slab utuh, tidak ada retak, label lurus, sudut tajam.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(2000)
  conditionNote!: string;

  @ApiPropertyOptional({ enum: ['NM', 'LP', 'MP', 'HP', 'DMG'] })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  rawCondition?: string;

  @ApiPropertyOptional({
    description:
      'Kunci dokumen tanda terima serah-terima yang DITANDATANGANI KEDUA PIHAK. Pemilik ' +
      'memegang salinannya — ini bukti MILIK PEMILIK, bukan milik Hoshi.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  intakeReceiptRef?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  agreementRef?: string;

  @ApiProperty({
    example: 24_250_000,
    description: 'Harga jual yang disepakati (Rupiah).',
  })
  @IsInt()
  @Min(1)
  @Max(IDR_MAX)
  askPriceIdr!: number;

  @ApiPropertyOptional({
    description: 'Harga terendah yang pemilik mau terima (Rupiah).',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDR_MAX)
  reservePriceIdr?: number;

  @ApiPropertyOptional({
    default: 500,
    description:
      'Komisi Hoshi dalam basis poin (500 = 5%). DI-SNAPSHOT di sini dan TIDAK PERNAH dibaca ' +
      'ulang dari env saat payout: perjanjian bertanda tangan berbunyi 5%, dan perubahan env ' +
      'tidak boleh mengubah apa yang dijanjikan untuk kartu yang sudah di tangan kita. ' +
      'Plafonnya 3.000 bps (30%) — angka di atas itu bukan kesepakatan, melainkan salah ketik.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  // ╔══════════════════════════════════════════════════════════════════════════════════════════╗
  // ║ PLAFON BISNIS, BUKAN PLAFON MATEMATIS. 3.000 bps = 30%, bukan 10.000 bps = 100%.         ║
  // ╚══════════════════════════════════════════════════════════════════════════════════════════╝
  //
  // Nilai ini DI-SNAPSHOT dan dipakai apa adanya oleh `fulfilConsignment` berbulan-bulan
  // kemudian, saat kartunya terjual. Plafon lama (10.000 = 100%) sah secara aritmetika dan
  // MUSTAHIL secara bisnis: komisi Hoshi 5%, dan satu nol kelebihan saat intake (500 → 5000,
  // 1000 → 10000) tidak akan tertangkap oleh siapa pun sampai uang pembeli sudah mendarat.
  //
  // Menolaknya DI DEPAN — pada detik operator mengetiknya, saat pemilik kartu masih berdiri di
  // depan meja dan angkanya masih bisa dibetulkan — jauh lebih murah daripada menolaknya di
  // settlement (yang memang sekarang juga menolak; lihat `ConsignmentPayoutEmpty`), karena di
  // sana ongkosnya adalah satu refund manual + satu penjualan yang batal.
  //
  // 30% dipilih SENGAJA longgar terhadap kesepakatan khusus (konsinyasi bernilai kecil, titipan
  // yang butuh restorasi/grading ulang) dan tetap KETAT terhadap salah ketik satu nol: 5% dan
  // 10% lolos, 50% dan 100% ditolak.
  @Max(3_000)
  commissionBps?: number;

  @ApiPropertyOptional({
    type: [ConsignmentPhotoInput],
    description:
      'Foto boleh diunggah sekarang atau menyusul sebelum accept-custody.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ConsignmentPhotoInput)
  photos?: ConsignmentPhotoInput[];
}

/**
 * ACCEPT CUSTODY — SATU-SATUNYA penulis `custodyAcceptedAt`. Panggil HANYA setelah kartunya
 * benar-benar ada di tangan Hoshi.
 */
export class AcceptCustodyDto {
  @ApiProperty({ example: 'Rak A-3, Jakarta' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  storageLocation!: string;

  @ApiPropertyOptional({
    description: 'Kunci tanda terima bertanda tangan, kalau baru ada sekarang.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  intakeReceiptRef?: string;

  @ApiPropertyOptional({ type: [ConsignmentPhotoInput] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ConsignmentPhotoInput)
  photos?: ConsignmentPhotoInput[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/**
 * PAJANG — membuat baris `Listing` untuk kartu titipan. Field tampilan yang WAJIB ada di
 * `Listing` tapi tidak dicatat saat intake (rarity/era/element/category/gambar) diisi di sini.
 */
export class CreateConsignmentListingDto {
  @ApiProperty({
    example: '/uploads/consign/abc-front.jpg',
    description:
      'URL gambar, ATAU data URL base64 — sama dengan foto intake. Lihat blok RUJUKAN GAMBAR.',
  })
  @IsString()
  @IsImageRef()
  image!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsImageRef()
  imageBack?: string;

  @ApiPropertyOptional({
    description: 'Default: askPriceIdr dari kesepakatan.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IDR_MAX)
  priceIdrx?: number;

  @ApiPropertyOptional({
    description: 'Estimasi nilai pasar (Rupiah). Default: harga jual.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDR_MAX)
  expectedValueIdrx?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  rarity?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) era?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  element?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;
}

/** Ubah harga kartu titipan. Rute ADMIN, karena harganya bagian dari perjanjian. */
export class UpdateConsignmentPriceDto {
  @ApiProperty({ example: 21_000_000 })
  @IsInt()
  @Min(1)
  @Max(IDR_MAX)
  askPriceIdr!: number;

  @ApiProperty({
    description:
      'Alasan perubahan harga. DISIMPAN permanen sebagai baris audit.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;
}

/* ══════════════════ PENGEMBALIAN KARTU KE PEMILIK: ALAMAT, ONGKIR, RESI ══════════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ ALAMAT PENGEMBALIAN — BENTUKNYA SENGAJA SAMA PERSIS dengan alamat kirim domestik yang SUDAH ║
 * ║ ADA (`CardRedemption`: recipientName/country/street/apt/city/state/zip/phone*).             ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * TIDAK ADA bentuk alamat kedua yang diciptakan untuk hal yang sama, dan itu bukan soal rapi:
 * tarif ongkirnya dihitung fungsi yang SAMA (`resolveDomesticShippingIdr` atas tabel
 * `domestic_shipping_rates`), yang membaca `city`/`state`/`country`. Bentuk alamat yang berbeda
 * berarti dua daftar ongkir yang suatu hari akan menjawab berbeda untuk satu provinsi yang sama.
 *
 * DISIMPAN SEBAGAI SNAPSHOT di baris titipan, bukan sebagai FK ke `ShippingAddress`:
 *   • pemilik kartu BISA belum punya akun sama sekali (Path B / kode klaim), jadi ia tidak punya
 *     buku alamat untuk dirujuk;
 *   • alamat yang diubah atau dihapus SESUDAH kartunya dikirim tidak boleh mengubah ke mana kartu
 *     itu TERCATAT dikirim.
 */
export class ConsignmentReturnAddressDto {
  @ApiProperty({
    example: 'Budi Santoso',
    description:
      'Nama PENERIMA di alamat tujuan. Boleh berbeda dari nama pemilik kartu — paket sering ' +
      'diterima anggota keluarga, dan memaksanya sama hanya akan membuat kurir menolak.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  recipientName!: string;

  @ApiProperty({ example: '081234567890' })
  @IsString()
  @MinLength(5)
  @MaxLength(40)
  phoneNumber!: string;

  @ApiPropertyOptional({ example: '+62' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  phoneCountryCode?: string;

  @ApiProperty({
    example: 'Jl. Merdeka No. 10, RT 03 RW 05',
    description: 'Alamat jalan lengkap.',
  })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  street!: string;

  @ApiPropertyOptional({
    description:
      'Unit/blok/patokan. SENGAJA opsional: kebanyakan alamat rumah tidak punya.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apt?: string;

  @ApiProperty({ example: 'Kota Bandung', description: 'Kota / kabupaten.' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  city!: string;

  @ApiProperty({
    example: 'Jawa Barat',
    description:
      'PROVINSI. WAJIB di sini — beda dengan buku alamat user, yang membiarkannya kosong. ' +
      'Provinsilah yang menentukan TIER ONGKIR, dan provinsi yang tidak disebut jatuh ke tier ' +
      'PENAMPUNG yang lebih mahal; alamat ini diketik OPERATOR sambil bicara dengan pemiliknya, ' +
      'jadi menanyakannya sekali jauh lebih murah daripada menaksir ongkir yang salah.',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  state!: string;

  @ApiProperty({ example: '40115', description: 'Kode pos.' })
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  zip!: string;

  @ApiPropertyOptional({
    default: 'Indonesia',
    description:
      'Default "Indonesia". Kolom ini ADA (bukan diasumsikan) karena ia GERBANG, bukan hiasan: ' +
      'taksiran ongkir domestik hanya berlaku untuk Indonesia, dan alamat luar negeri akan ' +
      'membuat taksirannya dilewati alih-alih menagih angka yang mustahil.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ RENCANA PENGEMBALIAN — SATU BENTUK, dipakai saat PENARIKAN DIMINTA maupun saat kartunya     ║
 * ║ BENAR-BENAR DISERAHKAN. Sengaja BUKAN dua bentuk yang mirip.                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Dalam praktik, keduanya terjadi di dua momen yang berbeda dan kadang di momen yang sama:
 *   • pemilik menelepon minta kartunya kembali → alamatnya dicatat SEKARANG, kartunya dibungkus
 *     besok;
 *   • pemilik datang ke kantor tanpa pemberitahuan → semuanya dicatat pada detik yang sama.
 * Karena itu bentuk ini ikut di DUA rute (`withdraw` dan `release`) dan TIDAK punya rute sendiri:
 * rute ketiga hanya akan jadi jalur kedua yang menulis kolom yang sama, dan salah satunya akan
 * melenceng.
 *
 * MENGIRIMNYA LAGI berarti MEMPERBARUI rencananya (alamat bisa salah ketik, dan pemilik bisa
 * berubah pikiran antara "kirim" dan "saya ambil sendiri"). Yang TIDAK bisa diperbarui adalah
 * baris yang custody-nya sudah dilepas — di sana rencananya sudah jadi RIWAYAT.
 */
export class ConsignmentReturnPlanDto {
  @ApiProperty({
    enum: Object.values(CONSIGNMENT_RETURN_METHOD),
    description:
      'PICKUP = pemilik mengambil sendiri di tempat Hoshi (tidak butuh alamat, tapi butuh ' +
      'catatan SIAPA yang mengambil saat penyerahannya). COURIER = dikirim kurir (butuh alamat ' +
      'lengkap di bawah, dan nanti butuh nomor resi sebelum custody boleh dilepas).',
  })
  @IsString()
  @IsIn(Object.values(CONSIGNMENT_RETURN_METHOD))
  returnMethod!: string;

  @ApiPropertyOptional({
    type: ConsignmentReturnAddressDto,
    description:
      'WAJIB kalau returnMethod = COURIER; diabaikan kalau PICKUP. Ditegakkan di service (bukan ' +
      'di decorator) supaya penolakannya bisa menjelaskan hubungan antara kedua field ini, ' +
      'bukan sekadar "validation failed".',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsignmentReturnAddressDto)
  returnAddress?: ConsignmentReturnAddressDto;

  @ApiPropertyOptional({
    enum: Object.values(CONSIGNMENT_RETURN_PAYER),
    description:
      'SIAPA yang menanggung ongkir balik. ⚠️ DICATAT SAJA — tidak ada tagihan yang terbit, ' +
      'tidak ada saldo yang dipotong, dan menarik kartu TETAP GRATIS bagi pemiliknya. Kolom ini ' +
      'ada supaya ongkos yang ditanggung Hoshi berhenti jadi kebocoran yang tidak muncul di ' +
      'laporan mana pun.',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(CONSIGNMENT_RETURN_PAYER))
  returnShippingPayer?: string;

  @ApiPropertyOptional({
    example: 25_000,
    description:
      'Ongkir balik (Rupiah utuh). Kalau dikosongkan untuk pengiriman kurir ke alamat ' +
      'Indonesia, server MENAKSIRNYA dari tarif wilayah yang SUDAH ADA (tabel yang sama dengan ' +
      'kirim domestik). Taksiran boleh ditimpa — yang benar adalah angka di struk kurir. 0 sah ' +
      'dan BERBEDA dari kosong: 0 berarti "digratiskan / diambil sendiri", kosong berarti ' +
      '"belum dicatat".',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDR_MAX)
  returnShippingFeeIdr?: number;
}

/** Kartunya FISIK keluar dari Hoshi. Menulis `custodyReleasedAt` — dan itu tidak bisa dibatalkan. */
export class ReleaseConsignmentDto {
  @ApiProperty({
    enum: ['WITHDRAWN', 'SHIPPED_TO_BUYER'],
    description:
      'LOST punya rutenya sendiri (POST :id/lost) — supaya "hilang" tidak pernah bisa tercatat ' +
      'diam-diam sebagai pengembalian biasa.',
  })
  @IsString()
  @MaxLength(40)
  releaseReason!: string;

  @ApiPropertyOptional({
    description: 'Kunci tanda terima pengembalian bertanda tangan.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  releaseReceiptRef?: string;

  @ApiProperty()
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;

  /* ── PENGEMBALIAN KE PEMILIK (releaseReason = WITHDRAWN) ──────────────────────────────────
     Field di bawah TIDAK BERLAKU untuk SHIPPED_TO_BUYER: pengiriman ke pembeli punya jalurnya
     sendiri (`CardRedemption` + tarif domestik + rute kirim), dan menumpangkannya di sini akan
     melahirkan dua tempat yang menyimpan resi untuk satu kejadian. */

  @ApiPropertyOptional({
    type: ConsignmentReturnPlanDto,
    description:
      'Rencana pengembalian, kalau baru dicatat SEKARANG — mis. pemiliknya datang tanpa ' +
      'pemberitahuan. Bentuk yang SAMA dengan yang diterima rute penarikan; kalau rencananya ' +
      'sudah pernah dicatat di sana, kosongkan (atau kirim lagi untuk memperbaruinya). Server ' +
      'menuliskannya LEBIH DULU di transaksi yang sama, lalu klaim pelepasan custody membacanya ' +
      'dari BARIS — jadi "alamatnya ada" tidak pernah cuma berarti "alamatnya disebut di body".',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsignmentReturnPlanDto)
  returnPlan?: ConsignmentReturnPlanDto;

  @ApiPropertyOptional({
    example: 'JNE REG',
    description:
      'Nama kurir. WAJIB bersama nomor resi untuk pengembalian ber-metode COURIER: tanpa ' +
      'keduanya, "sudah dikirim" adalah klaim yang TIDAK BISA DIPERIKSA oleh pemilik kartunya ' +
      'sendiri — dan dialah satu-satunya orang yang berhak memeriksanya.',
  })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  returnCourier?: string;

  @ApiPropertyOptional({
    example: 'JNE0123456789',
    description: 'Nomor resi. WAJIB bersama nama kurir untuk metode COURIER.',
  })
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(100)
  returnTrackingNo?: string;

  @ApiPropertyOptional({
    example: 'Budi Santoso (pemilik), KTP dicocokkan dengan catatan intake.',
    description:
      'SIAPA yang mengambil kartunya di tempat. WAJIB untuk metode PICKUP. Kalimat manusia, ' +
      'bukan id: yang datang mengambil sering BUKAN pemegang akunnya (istri, kurir pribadi, ' +
      'rekan yang membawa surat kuasa), dan yang perlu tercatat adalah siapa yang berdiri di ' +
      'sana. "KAPAN"-nya tidak ditanyakan: itu `custodyReleasedAt`, yang ditulis detik ini juga.',
  })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(300)
  returnPickedUpBy?: string;
}

/** Kartu HILANG/RUSAK dalam pengawasan Hoshi. Wajib beralasan; listing ikut ditarik. */
export class MarkConsignmentLostDto {
  @ApiProperty()
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(2000)
  note!: string;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ GANTI RUGI — NOMINALNYA TIDAK DIKETIK OPERATOR. Ia DIBACA dari struk.                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * KEPUTUSAN PEMILIK PRODUK: dasar ganti rugi adalah `Consignment.askPriceIdr` — "Harga jual yang
 * disepakati" yang TERCETAK di struk serah terima dua lembar yang ditandatangani kedua pihak.
 * Bukan `reservePriceIdr` (harga dasar), bukan taksiran pasar hari ini. Alasannya kepercayaan
 * pemilik kartu: angka yang ia bawa pulang di kertasnya HARUS sama dengan angka yang ia terima.
 *
 * KENAPA `amountIdr` MASIH ADA, dan kenapa ia OPSIONAL SEKARANG:
 *   • ia bukan lagi PERINTAH melainkan KONFIRMASI. Kalau dikirim, ia WAJIB sama persis dengan
 *     `askPriceIdr`; kalau berbeda, permintaannya DITOLAK dengan kedua angka disebutkan. Itulah
 *     yang membunuh salah ketik "kurang satu nol" — bentuk kesalahan yang dulu diam-diam lolos
 *     dan mengkredit pemilik sepersepuluh dari yang dijanjikan struknya.
 *   • opsional supaya layar yang sudah tidak lagi menanyakan nominalnya (karena memang bukan
 *     keputusan operator) tidak tertolak `forbidNonWhitelisted`, dan layar lama yang masih
 *     mengirimkannya tetap jalan.
 */
export class CompensateConsignmentDto {
  @ApiPropertyOptional({
    example: 20_000_000,
    description:
      'KONFIRMASI, bukan perintah. Rupiah utuh. Kalau dikirim, HARUS sama persis dengan ' +
      '`askPriceIdr` titipan (angka yang tercetak di struk serah terima) — selisih berapa pun ' +
      'DITOLAK. Boleh dikosongkan: server memakai `askPriceIdr` apa pun isinya.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IDR_MAX)
  amountIdr?: number;

  @ApiProperty()
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;
}

/**
 * KOREKSI — catatan intake adalah BUKTI, jadi ia tidak boleh bisa diedit diam-diam. Koreksi
 * ditulis sebagai baris audit BARU, sehingga koreksi TERLIHAT sebagai koreksi.
 */
export class CorrectConsignmentDto {
  @ApiProperty({
    description:
      'Apa yang dikoreksi dan kenapa. Ditulis sebagai baris `ConsignmentEvent` ber-kind ' +
      'CORRECTION. TIDAK menimpa kolom mana pun.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(2000)
  note!: string;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KOREKSI LABEL — dan GARIS yang memisahkannya dari `CorrectConsignmentDto` di atas.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * `conditionNote` dan foto adalah BUKTI dan TETAP tidak punya rute update. Field di bawah ini
 * adalah LABEL: klaim tentang kartu MANA ini, yang bisa dicek terhadap kartu fisiknya sendiri dan
 * terhadap situs grader-nya. Label yang salah ketik bukan bukti tentang apa pun — ia cuma salah,
 * dan sampai rute ini ada, "Charizad VMAX" yang terketik di ponsel menjadi JUDUL PUBLIK PERMANEN
 * kartu orang lain (`createListingFor` menyalin `cardName` langsung ke `Listing.name`).
 *
 * SEMUA FIELD OPSIONAL, tapi MINIMAL SATU wajib ada — ditegakkan di service supaya pesannya bisa
 * menyebutkan garis bukti/label di atas, bukan sekadar "validation failed".
 *
 * STRING KOSONG BERARTI KOSONGKAN KOLOMNYA (untuk field yang memang nullable): koreksi yang benar
 * kadang berarti MENGHAPUS — nomor sertifikat yang diketik untuk kartu yang ternyata mentah,
 * misalnya. `cardName` dikecualikan: ia judul publik dan tidak boleh kosong.
 */
export class CorrectConsignmentLabelDto {
  @ApiPropertyOptional({
    example: 'Charizard VMAX',
    description: 'Nama kartu. TIDAK boleh dikosongkan — ini judul publiknya.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cardName?: string;

  @ApiPropertyOptional({ description: 'String kosong = kosongkan kolomnya.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cardSet?: string;

  @ApiPropertyOptional({ description: 'String kosong = kosongkan kolomnya.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  cardNumber?: string;

  @ApiPropertyOptional({
    description:
      'Nomor sertifikat grader. String kosong = kosongkan. Nomor yang dikoreksi ikut diperiksa ' +
      'terhadap kunci anti-dobel-titip (satu kartu fisik = satu titipan hidup).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  certNumber?: string;

  @ApiPropertyOptional({
    example: 'PSA 10',
    description: 'String kosong = kosongkan kolomnya.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  gradeLabel?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10)
  gradeScore?: number;

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ `grader` — SATU-SATUNYA JALAN KELUAR dari kartu yang terkunci di rak.                  ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Sebelum field ini ada, dropdown Grader yang tertinggal kosong saat intake adalah kesalahan
   * PERMANEN: `createListingFor` menolak SELAMANYA kartu tanpa grader ("kartu mentah belum bisa
   * dipajang"), dan tidak ada SATU rute pun di repo ini yang bisa mengisi kolom itu sesudah
   * serah-terima. Fotonya lengkap, struknya ditandatangani, custody diterima — dan kartu fisik
   * milik orang lain duduk di rak tanpa bisa dijual, dengan satu-satunya jalan keluar dari
   * IN_CUSTODY berupa RELEASE ("dikembalikan" — padahal tidak) atau LOST ("hilang" — padahal
   * tidak). Dua-duanya FAKTA PALSU yang ditulis ke buku besar yang sengaja append-only.
   *
   * STRING KOSONG = KOSONGKAN (kartunya ternyata mentah). Nilai lain WAJIB salah satu nilai enum
   * `Grader` (PSA/TAG/CGC/BGS) — daftarnya diturunkan dari enum-nya sendiri di `@IsIn` di bawah,
   * jadi menambah grader baru cukup lewat migrasi + schema.prisma, TANPA menyentuh validasi ini.
   *
   * TIGA SYARAT, ditegakkan di service (lihat `correctLabel`):
   *   (a) ikut memicu pra-cek bentrok nomor sertifikat — kunci anti-dobel-titip adalah PASANGAN
   *       (grader, certNumber), jadi mengubah separuhnya sama saja dengan mengubah kuncinya;
   *   (b) `Listing.grader`/`grade` ikut diperbarui di transaksi yang SAMA kalau listing-nya
   *       masih ACTIVE — dan MENGOSONGKAN grader ditolak selama listing itu tayang, karena
   *       `Listing.grader` NOT NULL dan tidak ada nilai jujur untuk kartu mentah di sana;
   *   (c) DITOLAK kalau titipannya sudah punya pembeli. Grading yang dibaca pembeli SAAT IA
   *       MEMBAYAR tidak boleh berubah sesudahnya.
   */
  @ApiPropertyOptional({
    enum: Grader,
    description:
      'Grader kartu (PSA/TAG/CGC/BGS). String kosong = kosongkan (kartunya ternyata MENTAH). ' +
      'Ikut diperiksa terhadap kunci anti-dobel-titip (grader, certNumber) dan DITOLAK kalau ' +
      'titipannya sudah terjual.',
  })
  @IsOptional()
  @IsIn([...Object.values(Grader), ''])
  grader?: Grader | '';

  @ApiProperty({
    description:
      'APA yang salah dan DARI MANA tahu nilai yang benar. DISIMPAN permanen sebagai baris ' +
      'ConsignmentEvent ber-kind LABEL_CORRECTION, lengkap dengan nilai SEBELUM dan SESUDAH.',
    example:
      'Salah ketik saat intake di lokasi; dicocokkan ulang dengan slab dan cert PSA 12345678.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;
}

/** Tambah foto bukti. APPEND-ONLY: tidak ada rute update/delete untuk foto. */
export class AddConsignmentPhotosDto {
  @ApiProperty({ type: [ConsignmentPhotoInput] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ConsignmentPhotoInput)
  photos!: ConsignmentPhotoInput[];
}

/**
 * Pemilik minta kartunya kembali. TIDAK ADA BIAYA APA PUN DI JALUR INI — nol Rupiah bergerak,
 * termasuk sesudah `returnPlan` ada di bawah.
 *
 * ┌──── KENAPA ALAMATNYA DITANYAKAN DI SINI, BUKAN NANTI ──────────────────────────────────────┐
 * │ Sebelum `returnPlan` ada, DTO ini hanya menerima `note`. Artinya sistem bisa menyatakan     │
 * │ sebuah kartu "ditarik" tanpa pernah tahu ke MANA ia dikirim, SIAPA yang menanggung          │
 * │ ongkirnya, dan apakah ia benar-benar sampai. Momen paling murah untuk menanyakan alamat     │
 * │ adalah momen orangnya sedang bicara dengan kita — yaitu SEKARANG, saat ia meminta.          │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * TETAP OPSIONAL, dan itu keputusan yang perlu dijelaskan: permintaan "saya mau kartu saya
 * kembali" TIDAK BOLEH bisa gagal karena sebuah kode pos. Pemilik yang menekan tombolnya dari
 * ponsel di jalan tetap harus bisa menyampaikan maksudnya; alamatnya menyusul lewat rute yang
 * sama. Yang TIDAK opsional adalah alamat pada saat kartunya ditandai KELUAR — lihat
 * `withdrawnReleaseClaimWhere()`, yang menolak melepas custody tanpa itu.
 */
export class WithdrawConsignmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiPropertyOptional({
    type: ConsignmentReturnPlanDto,
    description:
      'Ke mana kartunya dikembalikan, dan siapa yang menanggung ongkirnya. OPSIONAL saat ' +
      'meminta — tapi WAJIB sudah ada sebelum kartunya boleh ditandai keluar. Mengirimnya lagi ' +
      'berarti MEMPERBARUI rencananya (alamat salah ketik, atau pemilik berubah pikiran antara ' +
      '"kirim" dan "saya ambil sendiri"). TIDAK BERLAKU untuk titipan berstatus INTAKE: di sana ' +
      'kartunya belum pernah berpindah tangan, jadi tidak ada yang perlu dikembalikan.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ConsignmentReturnPlanDto)
  returnPlan?: ConsignmentReturnPlanDto;
}

/* ══════════════════════ KODE KLAIM & PENAUTAN PEMILIK ══════════════════════ */

/**
 * TUKARKAN KODE KLAIM. Rute PEMILIK KARTU (butuh login, cara masuk apa pun).
 *
 * `code` sengaja hanya divalidasi PANJANG KASARNYA di sini, dan longgar: normalisasi yang
 * sesungguhnya (huruf besar, buang tanda hubung/spasi, O→0, I/L→1) ada di `normalizeClaimCode`,
 * dan penolakan bentuk yang salah dijawab dengan objek error yang SAMA PERSIS dengan penolakan
 * "kode tidak ditemukan". Kalau DTO ini menolak lebih ketat, pesan 400 dari class-validator akan
 * membocorkan bentuk kode yang benar — persis hal yang dijaga rutenya untuk tidak dibocorkan.
 */
export class ClaimConsignmentDto {
  @ApiProperty({
    example: '4T9KM-2X7PQ',
    description:
      'Kode pada tanda terima serah-terima Anda. Huruf besar/kecil, spasi, dan tanda hubung ' +
      'tidak berpengaruh. Berlaku sekali pakai.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;
}

/**
 * TERBITKAN / TERBITKAN ULANG kode klaim. ADMIN-ONLY.
 *
 * `note` WAJIB dan tersimpan permanen: penerbitan ulang MEMATIKAN kode sebelumnya, jadi "kenapa"
 * harus selalu punya jawaban tertulis ("kertas tanda terima hilang, dikonfirmasi lewat telepon
 * ke nomor yang tercatat saat serah-terima").
 */
export class IssueClaimCodeDto {
  @ApiProperty({
    description:
      'Alasan penerbitan / penerbitan ulang. DISIMPAN permanen sebagai baris audit.',
    example:
      'Tanda terima hilang; dikonfirmasi lewat telepon ke nomor saat serah-terima.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;
}

/**
 * ADMIN MENAUTKAN akun pemilik ke titipan yang belum bertuan.
 *
 * HANYA `consignorId` — alasannya sama dengan `CreateConsignmentDto`: email tidak unik dan tidak
 * pernah diverifikasi, jadi ia tidak boleh jadi kunci penautan. Id-nya datang dari
 * GET /admin/consignments/consignor-search, yang mengembalikan DAFTAR dan memaksa memilih.
 */
export class LinkConsignorDto {
  @ApiProperty({
    description:
      'User id pemilik kartu, DIPILIH operator dari hasil pencarian — bukan diketik dari ingatan.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  consignorId!: string;

  @ApiProperty({
    description:
      'BAGAIMANA identitasnya diperiksa. DISIMPAN permanen sebagai baris audit — ini yang ' +
      'menjawab "dari mana kamu tahu ini orangnya" berbulan-bulan kemudian.',
    example:
      'Pemilik datang ke kantor membawa tanda terima bertanda tangan; wallet dicocokkan di layarnya.',
  })
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(1000)
  note!: string;
}
