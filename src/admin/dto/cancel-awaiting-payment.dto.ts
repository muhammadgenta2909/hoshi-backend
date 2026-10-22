import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Body POST /admin/redemptions/:id/cancel-awaiting-payment.
 *
 * B1 — JALAN KELUAR TERAKHIR untuk baris AWAITING_PAYMENT. Tombol batal milik user sudah menutup
 * kasus umumnya; rute ini untuk saat usernya sudah tidak ada, atau saat order ongkirnya duduk di
 * status yang tombol user tolak (PAID/FULFILLED).
 *
 * APA YANG TERJADI: baris redemption → CANCELED (mint-nya bebas diminta kirim lagi), alasan Anda
 * DITAMBAHKAN ke catatan baris, dan setiap order ongkir yang macet di FULFILLING ditandai
 * REFUND_DUE. Respons mengembalikan daftar `shippingDebts` — berapa Rupiah, order mana, dan apakah
 * aman di-refund.
 *
 * APA YANG TIDAK TERJADI: tidak ada uang yang dikirim/dikembalikan otomatis, dan tidak ada
 * `refundSafe` yang ditulis. Baris AWAITING_PAYMENT yang membawa jejak pasca-danai
 * (fundingSignature terisi / refundSafe=false) DITOLAK — itu kasus RECLAIM_DUE, bukan kasus ini.
 */
export class CancelAwaitingPaymentDto {
  @ApiProperty({
    description:
      'Alasan/catatan operator — WAJIB, DITAMBAHKAN (tidak menimpa) ke catatan baris redemption. ' +
      'Sebutkan kenapa baris ini ditutup (mis. user tidak pernah kembali, order ongkirnya macet di ' +
      'FULFILLING sejak deploy X) dan referensi tiket/refund-nya.',
    minLength: 10,
    maxLength: 400,
  })
  @IsString()
  @Length(10, 400)
  note!: string;
}
