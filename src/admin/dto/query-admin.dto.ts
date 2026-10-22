import { ApiPropertyOptional } from '@nestjs/swagger';
import { ListingStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class QueryAdminListingsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: ListingStatus })
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus;

  @ApiPropertyOptional({ description: 'Filter by exact vault location' })
  @IsOptional()
  @IsString()
  vault?: string;

  @ApiPropertyOptional({
    description: 'Sort field: newest | price-asc | price-desc',
  })
  @IsOptional()
  @IsString()
  sort?: string;
}

export class QueryAdminCardsDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  set?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  rarity?: string;
}

export class QueryAdminActivityDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Filter by action type' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;
}

/**
 * Query GET /admin/escrow (D / checklist 4.6).
 *
 * `verify` SENGAJA opt-in dan SENGAJA string: memverifikasi kepemilikan on-chain berarti satu
 * panggilan RPC per kartu, jadi ia tidak boleh jadi default sebuah dashboard yang di-refresh
 * terus-menerus. Tanpa verify, kolom `escrowOwnsOnChain` bernilai null — yang berarti TIDAK
 * DIPERIKSA, bukan "tidak dipegang".
 */
export class QueryAdminEscrowDto {
  @ApiPropertyOptional({
    description:
      'Kirim "true" untuk MEMVERIFIKASI kepemilikan on-chain tiap kartu yang mengaku ber-escrow ' +
      '(satu panggilan RPC per kartu). Default: tidak diverifikasi.',
  })
  @IsOptional()
  @IsString()
  verify?: string;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
