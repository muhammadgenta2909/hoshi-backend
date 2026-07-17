import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Trim string; nilai non-string dibiarkan agar gagal di @IsString, bukan meledak di sini. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Ubah profil sendiri (PATCH /users/me). Semua field opsional — kirim hanya yang
 * mau diubah. String KOSONG pada field nullable berarti "hapus nilainya"
 * (di-service jadi null); field yang tidak dikirim tidak disentuh.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Satoshi', minLength: 1, maxLength: 32 })
  @IsOptional()
  @IsString()
  // Trim BEFORE @Length so "   " is a 0-char name, not a valid 3-char one.
  @Transform(trim)
  @Length(1, 32)
  displayName?: string;

  @ApiPropertyOptional({
    example: 'Kolektor kartu Pokemon sejak 1999.',
    maxLength: 280,
    description: 'Bio singkat. String kosong = hapus bio.',
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(280)
  bio?: string;

  @ApiPropertyOptional({
    example: 'satoshi',
    maxLength: 50,
    description:
      'Handle Twitter/X tanpa "@" (satu "@" di depan otomatis dibuang).',
  })
  @IsOptional()
  @IsString()
  // Trim dulu, lalu buang SATU "@" di depan — user terbiasa mengetik "@handle".
  @Transform(({ value }): unknown => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  })
  @MaxLength(50)
  twitter?: string;

  @ApiPropertyOptional({
    example: 'https://hoshi.example.com',
    maxLength: 200,
    description: 'URL website. String kosong = hapus.',
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  @MaxLength(200)
  website?: string;

  @ApiPropertyOptional({
    example: '+62',
    description: 'Kode negara telepon, format "+62". String kosong = hapus.',
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  // String kosong SENGAJA lolos: itu perintah "hapus", bukan kode negara yang salah.
  @ValidateIf((o: UpdateProfileDto) => o.phoneCountryCode !== '')
  @Matches(/^\+\d{1,4}$/, {
    message: 'phoneCountryCode harus berformat "+62" (1-4 digit).',
  })
  phoneCountryCode?: string;

  @ApiPropertyOptional({
    example: '812-3456-7890',
    description:
      'Nomor telepon (digit/spasi/strip, 4-20 karakter). String kosong = hapus.',
  })
  @IsOptional()
  @IsString()
  @Transform(trim)
  // String kosong SENGAJA lolos: itu perintah "hapus", bukan nomor yang salah.
  @ValidateIf((o: UpdateProfileDto) => o.phoneNumber !== '')
  @Matches(/^[\d\s-]{4,20}$/, {
    message: 'phoneNumber hanya boleh digit/spasi/strip, 4-20 karakter.',
  })
  phoneNumber?: string;
}
