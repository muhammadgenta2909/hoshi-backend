import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IDRX_MAX } from '../marketplace.constants';

/** Payload untuk menjual ulang kartu milik sendiri (POST /marketplace/:id/relist). */
export class RelistListingDto {
  @ApiProperty({ example: 24_250_000, description: 'Harga jual baru (IDRX)' })
  @IsInt()
  @Min(1)
  @Max(IDRX_MAX)
  price!: number;

  @ApiPropertyOptional({
    example: 27_000_000,
    description: 'Estimasi nilai Hoshi (IDRX). Kosong = pakai nilai lama.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IDRX_MAX)
  expectedValue?: number;

  @ApiPropertyOptional({
    example: 18_000_000,
    description: 'Jaminan buyback (IDRX). Kosong = pakai nilai lama.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDRX_MAX)
  buyback?: number;
}
