import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Parameter POST /api/admin/cc-sync — menarik katalog publik CollectorCrypt ke
 * tabel Listing (source=COLLECTORCRYPT). Semua opsional: default aman untuk demo
 * (1 halaman × 50 kartu Pokemon). maxPages dibatasi 20 supaya satu klik admin
 * tidak berubah jadi tarikan ribuan baris + menit-menit request keluar.
 */
export class CcSyncDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  categories?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxPages?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  step?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  listPriceMin?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  listPriceMax?: number;

  @IsOptional()
  @IsBoolean()
  markBuyback?: boolean;
}
