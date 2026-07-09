import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Grader } from '@prisma/client';
import { IsArray, IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class AdminCreateListingDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsString() set!: string;
  @ApiProperty() @IsString() rarity!: string;
  @ApiProperty() @IsString() image!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() imageBack?: string;
  @ApiProperty() @IsInt() @Min(0) price!: number;
  @ApiProperty() @IsInt() @Min(0) expectedValue!: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) buyback?: number;
  @ApiProperty() @IsString() grade!: string;
  @ApiProperty({ enum: Grader }) @IsEnum(Grader) grader!: Grader;
  @ApiProperty() @IsNumber() @Min(0) gradeScore!: number;
  @ApiProperty() @IsString() language!: string;
  @ApiProperty() @IsString() era!: string;
  @ApiProperty() @IsString() element!: string;
  @ApiProperty() @IsString() category!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sellerAddress?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() certificate?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() vaultLocation?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() cardNumber?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() variant?: string;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsNumber({}, { each: true }) priceHistory?: number[];
}
