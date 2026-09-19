import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RedemptionStatus } from '@prisma/client';

/** Body PATCH /admin/redemptions/:id/status — majukan status kirim kartu fisik. */
export class UpdateRedemptionStatusDto {
  @ApiProperty({ enum: RedemptionStatus })
  @IsEnum(RedemptionStatus)
  status!: RedemptionStatus;

  /**
   * NOMOR RESI kurir — HANYA untuk pengiriman DOMESTIK (stok Hoshi, kurir lokal).
   *
   * Pada baris jalur CC Vault, kolom ini MILIK poll shipment CollectorCrypt. Mengisinya tangan di
   * sana akan menimpa resi asli dengan angka yang kita karang, tanpa jejak bahwa itu terjadi —
   * jadi service MENOLAK (400), bukan mengabaikan.
   */
  @ApiPropertyOptional({
    description:
      'Nomor resi kurir domestik (mis. ["JP1234567890"]). HANYA untuk baris rail HOSHI_DOMESTIC; ' +
      'ditolak 400 untuk baris CC_VAULT (resinya datang dari poll CollectorCrypt).',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(120, { each: true })
  trackingIds?: string[];

  @ApiPropertyOptional({
    description: 'Link lacak resi, sejajar dengan trackingIds. HANYA rail HOSHI_DOMESTIC.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(500, { each: true })
  trackingUrls?: string[];

  /**
   * B2 — HOSHI MENANGGUNG ONGKIRNYA, DINYATAKAN SADAR-SADAR.
   *
   * Baris rail HOSHI_DOMESTIC di REQUESTED yang ongkirnya BELUM lunas MENOLAK PACKING/SHIPPED
   * (400). Dulu ia cuma di-`logger.warn`, dan peringatan itu tidak pernah sampai ke operator —
   * jadi tiap klik "Kemas"/"Kirim" adalah satu paket yang ongkirnya ditanggung Hoshi tanpa
   * seorang pun memutuskannya.
   *
   * Flag ini BUKAN "paksa apa saja": ia hanya berlaku untuk sel matriks itu, wajib disertai
   * `note`, dan pernyataannya DISIMPAN permanen di kolom `note` baris redemption-nya.
   */
  @ApiPropertyOptional({
    description:
      'true = Hoshi MENANGGUNG ongkir paket ini (rail HOSHI_DOMESTIC, REQUESTED → ' +
      'PACKING/SHIPPED tanpa tagihan ongkir yang lunas). Wajib disertai `note`. Diabaikan di ' +
      'transisi lain dan di rail CC_VAULT.',
  })
  @IsOptional()
  @IsBoolean()
  absorbShippingFee?: boolean;

  @ApiPropertyOptional({
    description:
      'Alasan operator saat `absorbShippingFee: true` (minimal 10 karakter). DISIMPAN permanen ' +
      'di kolom `note` baris redemption.',
    example: 'kompensasi keterlambatan, ongkir ditanggung Hoshi (disetujui PM)',
  })
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(300)
  note?: string;
}
