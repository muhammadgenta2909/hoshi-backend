import { ApiPropertyOptional } from '@nestjs/swagger';
import { Grader } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

/** Kunci sort — cermin `SortKey` di frontend (lib/market.ts). */
export const SORT_KEYS = [
  'newest',
  'price-asc',
  'price-desc',
  'rarity',
  'value',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** Filter & sort opsional untuk GET /marketplace. Semua boleh kosong. */
export class QueryListingDto {
  @ApiPropertyOptional({ enum: SORT_KEYS, default: 'newest' })
  @IsOptional()
  @IsEnum(SORT_KEYS)
  sort?: SortKey;

  @ApiPropertyOptional({ description: 'Filter set (Classic/Jungle/…).' })
  @IsOptional()
  @IsString()
  set?: string;

  @ApiPropertyOptional({ enum: Grader })
  @IsOptional()
  @IsEnum(Grader)
  grader?: Grader;

  @ApiPropertyOptional({ description: 'Grade minimum (mis. 9.5).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minGrade?: number;

  @ApiPropertyOptional({ description: 'Cari berdasar nama kartu (contains).' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 60, description: 'Batas jumlah baris.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
