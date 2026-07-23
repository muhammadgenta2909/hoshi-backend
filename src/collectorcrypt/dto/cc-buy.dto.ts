import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CcBuySubmitDto {
  @ApiProperty({
    description:
      'Transaksi hasil /cc-buy/prepare yang SUDAH ditandatangani wallet pembeli, base64.',
  })
  @IsString()
  @MinLength(1)
  signedTransaction!: string;
}
