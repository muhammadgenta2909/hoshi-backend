import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsString, Length } from 'class-validator';

/**
 * Body POST /admin/redemptions/:id/recover-burn-submitted.
 *
 * PERINGATAN — BACA SEBELUM MEMAKAI: mengirim body ini berarti OPERATOR MENYATAKAN sudah
 * MEMVERIFIKASI KE COLLECTORCRYPT bahwa kartu pada redemption ini BELUM DIBAKAR (mis. lewat
 * GET /outbound-shipment/:id atau support@collectorcrypt.com). Kalau ternyata sudah dibakar,
 * mengembalikan baris ke FUNDED akan mengundang user menandatangani burn KEDUA untuk kartu yang
 * sudah tidak ada. Aksi ini TIDAK mengembalikan uang: refundSafe tetap false.
 */
export class RecoverBurnSubmittedDto {
  @ApiProperty({
    description:
      'Alasan/catatan operator — WAJIB, disimpan permanen di baris redemption. Sebutkan apa yang ' +
      'diverifikasi ke CollectorCrypt dan referensinya (mis. nomor tiket support).',
    minLength: 10,
    maxLength: 400,
  })
  @IsString()
  @Length(10, 400)
  note!: string;

  @ApiProperty({
    description:
      'WAJIB true. Pernyataan eksplisit operator bahwa ia SUDAH memverifikasi ke CollectorCrypt ' +
      'bahwa kartu ini BELUM dibakar.',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'verifiedWithCollectorCrypt harus true — operator wajib memverifikasi dulu ke CollectorCrypt ' +
      'bahwa kartunya BELUM dibakar.',
  })
  verifiedWithCollectorCrypt!: boolean;
}
