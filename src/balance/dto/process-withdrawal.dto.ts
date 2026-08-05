import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Payload admin memproses penarikan (approve = no. ref transfer; reject = alasan). */
export class ProcessWithdrawalDto {
  @ApiPropertyOptional({
    example: 'Transfer BCA ref 20260805-001',
    description: 'Catatan admin: no. referensi transfer (approve) atau alasan tolak (reject).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
