import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { IDRX_MAX } from '../marketplace.constants';

/**
 * Ubah harga listing yang masih ACTIVE (PATCH /marketplace/:id).
 *
 * Mengikuti Collector Crypt: mengubah harga adalah aksi "update listing"
 * tersendiri, BUKAN cancel lalu list ulang — jadi listing tidak kehilangan
 * `listedAt`, view count, maupun offer yang sedang berjalan.
 */
export class UpdateListingDto {
  @ApiPropertyOptional({
    example: 24_250_000,
    description: 'Harga jual baru (IDRX)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IDRX_MAX)
  price?: number;

  @ApiPropertyOptional({
    example: 27_000_000,
    description: 'Estimasi nilai Hoshi (IDRX)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(IDRX_MAX)
  expectedValue?: number;

  @ApiPropertyOptional({
    example: 18_000_000,
    description: 'Jaminan buyback (IDRX)',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDRX_MAX)
  buyback?: number;
}
