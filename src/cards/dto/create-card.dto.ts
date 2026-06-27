import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateCardDto {
  @ApiProperty({ example: 'Hoshi Card #001 — Charizard' })
  @IsString()
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ example: 'Base' })
  @IsOptional()
  @IsString()
  set?: string;

  @ApiPropertyOptional({ example: 'Holo Rare' })
  @IsOptional()
  @IsString()
  rarity?: string;

  @ApiPropertyOptional({
    description: 'Atribut bebas: [{ "trait_type": "Set", "value": "Base" }]',
  })
  @IsOptional()
  attributes?: unknown;

  @ApiPropertyOptional({ description: 'URL metadata JSON untuk mint' })
  @IsOptional()
  @IsString()
  metadataUri?: string;
}
