import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Body POST /redemptions/:id/cancel — batalkan permintaan kirim yang BELUM menyentuh uang.
 *
 * Tidak ada field yang WAJIB: rute ini hanya sah untuk baris yang nol dana bergerak
 * (REQUESTED, atau AWAITING_PAYMENT yang pembayarannya belum mendarat), jadi tidak ada pernyataan
 * berisiko yang perlu diminta dari user. `reason` murni untuk jejak — disimpan di kolom `note`
 * baris redemption (DITAMBAHKAN, tidak menimpa catatan yang sudah ada).
 */
export class CancelRedemptionDto {
  @ApiPropertyOptional({
    description:
      'Alasan user membatalkan (opsional, maksimal 200 karakter). Disimpan di catatan baris.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
