import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsOptional, IsString } from 'class-validator';

/**
 * Body untuk POST /redemptions/:id/submit-burn — transaksi burn+ship CC yang SUDAH ditandatangani
 * wallet user (base64). Diteruskan apa adanya ke CC; kepemilikan & status redemption diverifikasi
 * di service (bukan dipercaya dari body).
 *
 * DUA ARRAY TERPISAH, sama seperti yang dikembalikan fund-and-prepare: CC memvalidasi
 * `transactions` dan `delistTransactions` sebagai set yang berbeda (403 "not the complete set"
 * bila digabung/kurang), dan leg de-list yang tidak ikut dikirim membuat leg burn GAGAL on-chain.
 */
export class SubmitBurnDto {
  @ApiProperty({
    description:
      'Transaksi burn base64 yang sudah ditandatangani user (salinan SEMUA entri `transactions` dari fund-and-prepare)',
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  signedTransactions!: string[];

  @ApiPropertyOptional({
    description:
      'Transaksi DE-LIST base64 yang sudah ditandatangani (salinan SEMUA entri `delistTransactions` ' +
      'dari fund-and-prepare). Kosongkan/abaikan bila fund-and-prepare mengembalikan [].',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  signedDelistTransactions?: string[];
}
