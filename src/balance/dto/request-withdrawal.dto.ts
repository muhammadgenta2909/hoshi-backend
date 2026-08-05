import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

/** Payload minta tarik saldo (POST /balance/withdraw). Tujuan = rekening bank / e-wallet. */
export class RequestWithdrawalDto {
  @ApiProperty({ example: 500_000, description: 'Jumlah tarik (rupiah utuh).' })
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  amount!: number;

  @ApiProperty({ enum: ['BANK', 'EWALLET'], example: 'BANK' })
  @IsIn(['BANK', 'EWALLET'])
  method!: string;

  @ApiProperty({ example: 'BCA', description: 'Nama bank / e-wallet.' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  destBank!: string;

  @ApiProperty({ example: '1234567890', description: 'No. rekening / no. HP e-wallet.' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  destAccount!: string;

  @ApiProperty({ example: 'Muhammad Genta', description: 'Nama pemilik rekening.' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  destName!: string;
}
