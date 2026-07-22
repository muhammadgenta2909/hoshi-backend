import { ApiPropertyOptional } from '@nestjs/swagger';
import { StorageProvider } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateVaultItemDto {
  @ApiPropertyOptional({
    enum: StorageProvider,
    description: 'Provider custody baru.',
  })
  @IsOptional()
  @IsEnum(StorageProvider)
  storageProvider?: StorageProvider;

  @ApiPropertyOptional({ description: 'Label lokasi vault baru.' })
  @IsOptional()
  @IsString()
  vaultLocation?: string;
}
