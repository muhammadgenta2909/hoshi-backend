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

  @ApiProperty({ example: 'Classic' })
  @IsString()
  set!: string;

  @ApiProperty({ example: 'Legendary Rare' })
  @IsString()
  rarity!: string;

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

  @ApiProperty({ example: 'PSA 10' })
  @IsString()
  grade!: string;

  @ApiProperty({ enum: Grader, example: Grader.PSA })
  @IsEnum(Grader)
  grader!: Grader;

  @ApiProperty({ example: 10 })
  @IsNumber()
  @Min(0)
  gradeScore!: number;

  @ApiProperty({ example: 'English', description: '"English" | "Japan"' })
  @IsString()
  language!: string;

  @ApiProperty({ example: 'Classic' })
  @IsString()
  era!: string;

  @ApiProperty({ example: 'Fire' })
  @IsString()
  element!: string;

  @ApiProperty({ example: 'Character Illustration' })
  @IsString()
  category!: string;

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
}
