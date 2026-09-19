import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Body untuk POST /redemptions — minta kirim kartu fisik ke rumah.
 *
 * SEBUTKAN TEPAT SATU dari dua field di bawah; service menolak (400
 * HOSHI_DOMESTIC_TARGET_REQUIRED) kalau keduanya kosong ATAU keduanya diisi.
 *
 * KENAPA TEPAT SATU DAN BUKAN "salah satu, yang mana saja": kedua field itu memilih RAIL
 * PENGIRIMAN, dan rail adalah keputusan SERVER — ia menentukan apakah ada NFT yang dibakar dan
 * USDC treasury yang berpindah (jalur CC Vault) atau sama sekali tidak ada (jalur domestik).
 * Membiarkan klien mengirim keduanya = membiarkan klien memilih rail lewat urutan pembacaan
 * kode kita.
 *
 * Kepemilikan kartu & alamat DIVERIFIKASI di service lewat ledger (bukan dipercaya dari body).
 * Tidak ada nominal/uang di sini.
 */
export class RequestRedemptionDto {
  /**
   * JALUR CC VAULT. Alamat NFT kartu hasil pack, atau kartu marketplace yang punya alamat NFT.
   * Fisiknya di gudang CollectorCrypt → pengirimannya lewat burn + USDC + tanda tangan wallet.
   */
  @ApiPropertyOptional({
    description:
      'Alamat NFT kartu vault CollectorCrypt (hasil pack / pembelian ber-NFT). Isi INI atau ' +
      'listingId, jangan dua-duanya.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  nftAddress?: string;

  /**
   * JALUR DOMESTIK. Id Listing STOK HOSHI yang SOLD ke pemanggil. Kartu ini fisiknya disimpan
   * Hoshi di Indonesia dan dikirim kurir lokal: NOL NFT, NOL burn, NOL USDC, NOL CollectorCrypt,
   * NOL tanda tangan wallet. Kartu seperti ini TIDAK punya alamat NFT sama sekali (settlement-nya
   * database-only), jadi ia tidak bisa diminta lewat `nftAddress`.
   */
  @ApiPropertyOptional({
    description:
      'Id Listing stok Hoshi yang kamu beli (kirim kurir domestik). Isi INI atau nftAddress, ' +
      'jangan dua-duanya.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  listingId?: string;

  @ApiPropertyOptional({
    description: 'Id ShippingAddress tujuan (milik user sendiri)',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  shippingAddressId!: string;
}
