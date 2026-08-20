import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString } from 'class-validator';

/**
 * Body untuk POST /redemptions/:id/submit-burn — transaksi burn+ship CC yang SUDAH ditandatangani
 * wallet user (base64). Diteruskan apa adanya ke CC; kepemilikan & status redemption diverifikasi
 * di service (bukan dipercaya dari body).
 */
export class SubmitBurnDto {
  @ApiProperty({
    description: 'Transaksi base64 yang sudah ditandatangani user (dari fund-and-prepare)',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  signedTransactions!: string[];
}
