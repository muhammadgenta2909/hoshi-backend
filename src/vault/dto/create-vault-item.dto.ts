import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StorageProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateVaultItemDto {
  @ApiProperty({ description: 'ID card yang disimpan di vault' })
  @IsString()
  cardId!: string;

  @ApiPropertyOptional({ description: 'Nomor seri kartu fisik (unik)' })
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional({
    enum: StorageProvider,
    description: 'Provider custody. Default HOSHI (vault kelolaan sendiri).',
  })
  @IsOptional()
  @IsEnum(StorageProvider)
  storageProvider?: StorageProvider;

  @ApiPropertyOptional({
    description: 'Label lokasi vault (mis. "Jakarta Vault A").',
  })
  @IsOptional()
  @IsString()
  vaultLocation?: string;
}
