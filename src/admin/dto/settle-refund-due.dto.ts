import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsString, Length } from 'class-validator';

/**
 * Body POST /admin/redemptions/:id/settle-refund-due.
 *
 * BACA SEBELUM MEMAKAI: mengirim body ini memindahkan baris READY_TO_FUND (ongkir Rupiah SUDAH
 * lunas, USDC BELUM dikirim) ke REFUND_DUE — satu-satunya tempat di repo ini yang menulis
 * RedemptionStatus.REFUND_DUE. Yang Anda nyatakan: Anda akan MENGEMBALIKAN ongkir Rupiah user
 * DI LUAR SISTEM. Tidak ada kode yang mengirim uangnya otomatis; baris ini hanyalah catatan
 * utangnya.
 *
 * Kenapa itu aman di status ini: pada READY_TO_FUND nol USDC treasury pernah bergerak. Service
 * MEMERIKSANYA (fundingSignature null + refundSafe true, keduanya jadi predikat tulisan berpagar),
 * jadi baris yang ternyata sudah pasca-danai akan ditolak, bukan di-refund.
 *
 * Efek samping yang disengaja: REFUND_DUE terminal → mint-nya bebas lagi, user boleh meminta kirim
 * ulang dengan tagihan ongkir baru tanpa menunggu refundnya beres.
 */
export class SettleRefundDueDto {
  @ApiProperty({
    description:
      'Alasan/catatan operator — WAJIB, DITAMBAHKAN (tidak menimpa) ke catatan baris redemption. ' +
      'Sebutkan kenapa ongkir ini tidak bisa dipenuhi (mis. harga CC melewati plafon slippage, ' +
      'user tidak pernah kembali) dan referensi tiket/refund-nya.',
    minLength: 10,
    maxLength: 400,
  })
  @IsString()
  @Length(10, 400)
  note!: string;

  @ApiProperty({
    description:
      'WAJIB true. Pernyataan eksplisit operator bahwa ongkir Rupiah user akan DIKEMBALIKAN di ' +
      'luar sistem (IDRX/manual) — baris REFUND_DUE ini hanya catatan utangnya.',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'rupiahRefundWillBeIssued harus true — menandai REFUND_DUE berarti operator berkomitmen ' +
      'mengembalikan ongkir Rupiah user di luar sistem.',
  })
  rupiahRefundWillBeIssued!: boolean;
}
