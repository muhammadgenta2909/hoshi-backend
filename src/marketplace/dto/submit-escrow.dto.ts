import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Payload langkah-2 escrow (POST /marketplace/:id/escrow/submit): transaksi transfer
 * kartu penjual → wallet escrow yang SUDAH ditandatangani penjual (base64). Backend
 * menyiarkannya lalu mengaktifkan listing (PENDING_ESCROW → ACTIVE).
 */
export class SubmitEscrowDto {
  @ApiProperty({
    description: 'Transaksi transfer-ke-escrow yang sudah ditandatangani penjual (base64).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(8192)
  signedTransaction!: string;
}
