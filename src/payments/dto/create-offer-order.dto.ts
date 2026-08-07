import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body untuk POST /payments/offer — bayar OFFER yang sudah diterima penjual. Cukup id offer-nya;
 * harga = amount offer (di-snapshot server), penerima IDRX selalu treasury. Kartu baru pindah
 * setelah lunas (settlement P2P).
 */
export class CreateOfferOrderDto {
  @ApiProperty({ description: 'Id Offer yang sudah ACCEPTED, milik pembeli sendiri' })
  @IsString()
  @IsNotEmpty()
  offerId!: string;
}
