import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ConsignmentPhotoKind, Grader } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Batas atas nominal Rupiah yang masuk akal untuk satu kartu (sejalan dengan IDRX_MAX listing). */
const IDR_MAX = 2_000_000_000;

/** Panjang minimal catatan manusia yang WAJIB beralasan (sejalan dengan OPERATOR_NOTE_MIN admin). */
const NOTE_MIN = 10;

export class ConsignmentPhotoInput {
  @ApiProperty({ example: 'https://cdn.hoshi/intake/abc-front.jpg' })
  @IsString()
  @MaxLength(2000)
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
  @ApiProperty({ description: 'User id PEMILIK kartu (consignor).' })
  @IsString()
  consignorId!: string;

  @ApiProperty({
    description:
      'SNAPSHOT nama pemilik saat serah-terima. Sengaja disalin, bukan dibaca dari User: ' +
      'displayName bisa berubah, dan apa yang benar pada HARI itu tidak bisa diturunkan ulang.',
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
      'Nomor sertifikat PSA/CGC/BGS. Ini identitas TERKUAT yang tersedia dan bisa dicek di ' +
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
      'tidak boleh mengubah apa yang dijanjikan untuk kartu yang sudah di tangan kita.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
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
  @ApiProperty({ example: '/uploads/consign/abc-front.jpg' })
  @IsString()
  @MaxLength(2000)
  image!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
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
}

/** Kartu HILANG/RUSAK dalam pengawasan Hoshi. Wajib beralasan; listing ikut ditarik. */
export class MarkConsignmentLostDto {
  @ApiProperty()
  @IsString()
  @MinLength(NOTE_MIN)
  @MaxLength(2000)
  note!: string;
}

/** Ganti rugi ke pemilik lewat ledger saldo yang SUDAH ADA. Idempoten per consignment. */
export class CompensateConsignmentDto {
  @ApiProperty({ example: 20_000_000, description: 'Rupiah utuh.' })
  @IsInt()
  @Min(1)
  @Max(IDR_MAX)
  amountIdr!: number;

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

/** Tambah foto bukti. APPEND-ONLY: tidak ada rute update/delete untuk foto. */
export class AddConsignmentPhotosDto {
  @ApiProperty({ type: [ConsignmentPhotoInput] })
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => ConsignmentPhotoInput)
  photos!: ConsignmentPhotoInput[];
}

/** Pemilik minta kartunya kembali. Tidak ada biaya apa pun di jalur ini. */
export class WithdrawConsignmentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
