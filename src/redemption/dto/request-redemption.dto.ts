import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body untuk POST /redemptions — minta kirim kartu fisik ke rumah.
 *
 * Cukup nftAddress kartunya + id alamat tujuan. Kepemilikan kartu & alamat DIVERIFIKASI di
 * service lewat ledger (bukan dipercaya dari body). Tidak ada nominal/uang di sini.
 */
export class RequestRedemptionDto {
  @ApiProperty({ description: 'Alamat NFT kartu (hasil pack) yang mau dikirim fisik' })
  @IsString()
  @IsNotEmpty()
  nftAddress!: string;

  @ApiProperty({ description: 'Id ShippingAddress tujuan (milik user sendiri)' })
  @IsString()
  @IsNotEmpty()
  shippingAddressId!: string;
}
