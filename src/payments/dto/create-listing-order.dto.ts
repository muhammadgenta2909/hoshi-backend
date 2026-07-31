import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body untuk POST /payments/listing — terbitkan tagihan rupiah membeli satu kartu KATALOG
 * CollectorCrypt lewat jalur reseller. Cukup id listing-nya; SEMUA nominal (harga kita, biaya
 * CC, plafon) di-snapshot server dari baris Listing, tidak pernah dari body.
 */
export class CreateListingOrderDto {
  @ApiProperty({ description: 'Id Listing katalog CC yang mau dibeli' })
  @IsString()
  @IsNotEmpty()
  listingId!: string;
}
