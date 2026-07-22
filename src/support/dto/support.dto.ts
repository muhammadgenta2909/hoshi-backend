import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportThreadStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateThreadDto {
  @ApiPropertyOptional({ description: 'Judul singkat thread' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  subject?: string;

  @ApiPropertyOptional({ description: 'Listing terkait (opsional)' })
  @IsOptional()
  @IsString()
  listingId?: string;

  @ApiProperty({ description: 'Isi pesan pertama' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class PostMessageDto {
  @ApiProperty({ description: 'Isi pesan' })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class SetThreadStatusDto {
  @ApiProperty({ enum: SupportThreadStatus })
  @IsEnum(SupportThreadStatus)
  status!: SupportThreadStatus;
}
