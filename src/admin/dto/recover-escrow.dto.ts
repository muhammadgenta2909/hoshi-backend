import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsBoolean, IsString, Length } from 'class-validator';

/**
 * Body POST /admin/escrow/:listingId/return.
 *
 * TIDAK ADA PARAMETER TUJUAN — dan itu disengaja. Wallet penerima SELALU diturunkan dari baris
 * penjual listing-nya; kalau alamat tujuan boleh datang dari body, aksi "pemulihan" ini berubah
 * jadi "kirim kartu siapa pun ke mana pun", yang bukan pemulihan melainkan pintu belakang.
 *
 * PERINGATAN — BACA SEBELUM MEMAKAI: aksi ini MEMINDAHKAN ASET NYATA. Ia hanya sah untuk kartu
 * yang escrow memang masih memegangnya DAN yang listing-nya sudah tidak bisa dibeli siapa pun
 * (CANCELLED, atau PENDING_ESCROW yang tak pernah jadi). Listing SOLD TIDAK PERNAH memenuhi
 * syarat: di sana kartunya sudah/mungkin sah menjadi milik pembeli.
 */
export class RecoverEscrowDto {
  @ApiProperty({
    description:
      'Alasan operator — WAJIB, disimpan permanen di tabel escrow_recoveries. Sebutkan kenapa ' +
      'kartu ini perlu dikembalikan manual (mis. "cancel gagal mengembalikan, lihat log X").',
    minLength: 10,
    maxLength: 400,
  })
  @IsString()
  @Length(10, 400)
  reason!: string;

  @ApiProperty({
    description:
      'WAJIB true. Pernyataan eksplisit operator bahwa ia sudah MEMERIKSA ON-CHAIN bahwa kartu ' +
      'ini masih dipegang wallet escrow dan BELUM diserahkan ke pembeli mana pun.',
  })
  @IsBoolean()
  @Equals(true, {
    message:
      'verifiedOnChain harus true — operator wajib memastikan dulu kartunya masih di escrow dan ' +
      'belum diserahkan ke pembeli.',
  })
  verifiedOnChain!: boolean;
}
