import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, Length } from 'class-validator';

/** Ubah profil sendiri (PATCH /users/me). Untuk sekarang cuma nama tampilan. */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Satoshi', minLength: 1, maxLength: 32 })
  @IsOptional()
  @IsString()
  // Trim BEFORE @Length so "   " is a 0-char name, not a valid 3-char one.
  @Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(1, 32)
  displayName?: string;
}
