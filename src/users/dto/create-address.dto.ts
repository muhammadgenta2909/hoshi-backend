import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/** Trim string; nilai non-string dibiarkan agar gagal di @IsString, bukan meledak di sini. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Trim, lalu perlakukan string kosong sebagai "tidak diisi" (undefined) — field
 * OPSIONAL yang dikirim "" oleh form frontend tidak boleh gagal di @Matches.
 */
const trimEmptyToUndefined = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Alamat pengiriman baru (POST /users/me/addresses). Maks 5 alamat per user. */
export class CreateAddressDto {
  @ApiProperty({ example: 'Satoshi Nakamoto', minLength: 1, maxLength: 80 })
  @IsString()
  @Transform(trim)
  @Length(1, 80)
  fullName!: string;

  @ApiProperty({ example: 'Indonesia', minLength: 1, maxLength: 56 })
  @IsString()
  @Transform(trim)
  @Length(1, 56)
  country!: string;

  @ApiProperty({ example: 'Jl. Sudirman No. 1', minLength: 1, maxLength: 160 })
  @IsString()
  @Transform(trim)
  @Length(1, 160)
  street!: string;

  @ApiPropertyOptional({ example: 'Tower B, Unit 12F', maxLength: 80 })
  @IsOptional()
  @IsString()
  @Transform(trimEmptyToUndefined)
  @MaxLength(80)
  apt?: string;

  @ApiPropertyOptional({ example: 'DKI Jakarta', maxLength: 80 })
  @IsOptional()
  @IsString()
  @Transform(trimEmptyToUndefined)
  @MaxLength(80)
  state?: string;

  @ApiProperty({ example: 'Jakarta Selatan', minLength: 1, maxLength: 80 })
  @IsString()
  @Transform(trim)
  @Length(1, 80)
  city!: string;

  @ApiPropertyOptional({
    example: '+62',
    description: 'Kode negara telepon, format "+62" (1-4 digit).',
  })
  @IsOptional()
  @IsString()
  @Transform(trimEmptyToUndefined)
  @Matches(/^\+\d{1,4}$/, {
    message: 'phoneCountryCode harus berformat "+62" (1-4 digit).',
  })
  phoneCountryCode?: string;

  @ApiPropertyOptional({
    example: '812-3456-7890',
    description: 'Nomor telepon (digit/spasi/strip, 4-20 karakter).',
  })
  @IsOptional()
  @IsString()
  @Transform(trimEmptyToUndefined)
  @Matches(/^[\d\s-]{4,20}$/, {
    message: 'phoneNumber hanya boleh digit/spasi/strip, 4-20 karakter.',
  })
  phoneNumber?: string;

  @ApiProperty({ example: '12190', minLength: 1, maxLength: 16 })
  @IsString()
  @Transform(trim)
  @Length(1, 16)
  zip!: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Jadikan alamat default. Alamat default lain otomatis dilepas statusnya.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
