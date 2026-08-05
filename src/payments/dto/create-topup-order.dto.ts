import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';

/**
 * Body untuk POST /payments/topup — isi saldo in-app (Rupiah) user.
 *
 * BEDA dari pack/listing: nominal di sini DATANG dari user (bukan snapshot mesin/listing),
 * karena top-up memang menambah saldo mereka sendiri. Tapi batasnya tetap ditegakkan ulang di
 * service (IDRX_MIN/MAX_MINT_IDR) — DTO ini gerbang bentuk, service gerbang kebenaran. Fulfilment
 * TIDAK PERNAH membelanjakan treasury: ia hanya mengkredit BalanceEntry (lihat fulfilTopup).
 */
export class CreateTopupOrderDto {
  @ApiProperty({
    description: 'Nominal rupiah utuh yang mau diisikan ke saldo (mis. 100000)',
    minimum: 20_000,
    maximum: 1_000_000_000,
  })
  @IsInt()
  @Min(20_000)
  @Max(1_000_000_000)
  amountIdr!: number;
}
