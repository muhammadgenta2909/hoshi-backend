import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Grader } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

class ImportListingItemDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsString() set!: string;
  @ApiProperty() @IsString() rarity!: string;
  @ApiProperty() @IsString() image!: string;
  @ApiProperty() @IsInt() @Min(0) price!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) expectedValue?: number;
  @ApiProperty() @IsString() grade!: string;
  @ApiProperty({ enum: Grader }) @IsEnum(Grader) grader!: Grader;
  @ApiProperty() @IsNumber() @Min(0) gradeScore!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() language?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() era?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() element?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() category?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sellerAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) buyback?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() certificate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vaultLocation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cardNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() variant?: string;
}

export class ImportListingsDto {
  @ApiProperty({ type: [ImportListingItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ImportListingItemDto)
  items!: ImportListingItemDto[];

  @ApiPropertyOptional({ description: 'Override seller address for all imported items' })
  @IsOptional() @IsString()
  sellerOverride?: string;
}
