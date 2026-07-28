import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Grader } from '@prisma/client';
import {
  IsEnum,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { IDRX_MAX } from '../marketplace.constants';

/** Payload untuk memajang kartu ke marketplace (POST /marketplace, perlu login). */
export class CreateListingDto {
  @ApiProperty({ example: 'Charizard VMAX' })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ example: 'Classic' })
  @IsOptional()
  @IsString()
  set?: string;

  @ApiPropertyOptional({ example: 'Legendary Rare' })
  @IsOptional()
  @IsString()
  rarity?: string;

  @ApiProperty({ example: '/card1.png' })
  @IsString()
  image!: string;

  @ApiPropertyOptional({ example: '/card-back.svg' })
  @IsOptional()
  @IsString()
  imageBack?: string;

  @ApiProperty({ example: 24_250_000, description: 'Harga jual (IDRX)' })
  @IsInt()
  @Min(0)
  @Max(IDRX_MAX)
  price!: number;

  @ApiProperty({
    example: 27_000_000,
    description: 'Estimasi nilai Hoshi (IDRX)',
  })
  @IsInt()
  @Min(0)
  @Max(IDRX_MAX)
  expectedValue!: number;

  @ApiPropertyOptional({
    example: 18_000_000,
    description: 'Jaminan buyback (IDRX). 0 = bukan Hoshi-backed.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(IDRX_MAX)
  buyback?: number;

  /* --- Grade ---------------------------------------------------------------
   *
   * WAJIB untuk listing Hoshi biasa (penjual mendeklarasikan slab-nya sendiri),
   * dan DIABAIKAN sepenuhnya kalau `fromPackMemo` diisi: grade kartu hasil pull
   * dibaca server dari katalog CollectorCrypt. Klien tidak boleh bisa menerbitkan
   * "PSA 10" untuk kartu yang grade aslinya tidak diketahui.
   */
  @ApiPropertyOptional({
    example: 'PSA 10',
    description:
      'Wajib kecuali `fromPackMemo` diisi (grade ditentukan server).',
  })
  @IsOptional()
  @IsString()
  grade?: string;

  @ApiPropertyOptional({ enum: Grader, example: Grader.PSA })
  @IsOptional()
  @IsEnum(Grader)
  grader?: Grader;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  gradeScore?: number;

  @ApiPropertyOptional({
    example: 'English',
    description: '"English" | "Japan"',
  })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ example: 'Classic' })
  @IsOptional()
  @IsString()
  era?: string;

  @ApiPropertyOptional({ example: 'Fire' })
  @IsOptional()
  @IsString()
  element?: string;

  @ApiPropertyOptional({ example: 'Character Illustration' })
  @IsOptional()
  @IsString()
  category?: string;

  @ApiPropertyOptional({ description: 'Tautan opsional ke katalog Card.' })
  @IsOptional()
  @IsString()
  cardId?: string;

  @ApiPropertyOptional({ example: '8841 2207' })
  @IsOptional()
  @IsString()
  certificate?: string;

  @ApiPropertyOptional({ example: 'Jakarta Vault A' })
  @IsOptional()
  @IsString()
  vaultLocation?: string;

  @ApiPropertyOptional({ example: '102/190' })
  @IsOptional()
  @IsString()
  cardNumber?: string;

  @ApiPropertyOptional({ example: 'Holo' })
  @IsOptional()
  @IsString()
  variant?: string;

  @ApiPropertyOptional({
    example: 'HHw4oQh9pNqL4sY7F7hX7sFAzW9yJ7jUu4w9rHf3Z6a1',
    description:
      'Alamat asset/kontrak jika listing sudah punya asset on-chain.',
  })
  @IsOptional()
  @IsString()
  contractAddress?: string;

  @ApiPropertyOptional({
    example: [22_000_000, 23_500_000, 24_250_000],
    description: 'Riwayat harga untuk sparkline detail.',
  })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  priceHistory?: number[];

  @ApiPropertyOptional({
    example: 'hoshi-slug-11111111-2222-3333-4444-555555555555',
    description:
      'Jika diisi: memo CcPackPurchase kartu hasil pack yang mau dijual. ' +
      'Backend memverifikasi kartu ini benar milik user (status OPENED), lalu ' +
      'menautkan listing ke NFT aslinya (provenance CollectorCrypt).',
  })
  @IsOptional()
  @IsString()
  fromPackMemo?: string;
}
