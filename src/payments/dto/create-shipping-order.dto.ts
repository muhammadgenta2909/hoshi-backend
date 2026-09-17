import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Body untuk POST /payments/shipping — terbitkan tagihan rupiah ONGKIR kirim kartu fisik.
 * Cukup id redemption-nya; ongkir (USD) di-taksir SERVER dari CC, Rupiah-nya dari kurs IDRX —
 * tidak pernah dari body. Access token sesi CC (cca_) dibaca dari header x-cc-access-token.
 */
export class CreateShippingOrderDto {
  @ApiProperty({ description: 'Id CardRedemption yang ongkirnya mau dibayar' })
  @IsString()
  @IsNotEmpty()
  redemptionId!: string;
}
