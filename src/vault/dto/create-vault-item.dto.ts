import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateVaultItemDto {
  @ApiProperty({ description: 'ID card yang disimpan di vault' })
  @IsString()
  cardId!: string;

  @ApiPropertyOptional({ description: 'Nomor seri kartu fisik (unik)' })
  @IsOptional()
  @IsString()
  serialNumber?: string;
}
