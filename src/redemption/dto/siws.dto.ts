import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length } from 'class-validator';

/**
 * DTO handshake SIWS (Sign-In With Solana) — Track B, login wallet Phantom ke CollectorCrypt.
 *
 * Body-nya sengaja minimal: kepemilikan wallet (wallet === user.walletAddress) ditegakkan di
 * controller, dan partnerAppId/domain/uri DISUNTIK dari config oleh service — bukan dari klien.
 */

/** POST /redemptions/siws/nonce — minta nonce CC untuk WALLET SENDIRI. */
export class SiwsNonceDto {
  @ApiProperty({
    example: '5UcNEuD2jMVsfuDu3xuE6yDM1r8X7BjXYAeRvd4Qa9ET',
    description:
      'Solana wallet address (base58). WAJIB sama dengan wallet user login (403 bila beda).',
  })
  @IsString()
  @Length(32, 44)
  wallet!: string;
}

/** POST /redemptions/siws/verify — tukar message+signature dengan token sesi CC. */
export class SiwsVerifyDto {
  @ApiProperty({
    description:
      'Teks SIWS kanonik yang ditandatangani VERBATIM (dari respons /siws/nonce).',
  })
  @IsString()
  @IsNotEmpty()
  message!: string;

  @ApiProperty({
    description: 'Signature base58 ed25519 atas UTF-8 bytes dari message.',
  })
  @IsString()
  @IsNotEmpty()
  signature!: string;
}

/** POST /redemptions/siws/refresh — tukar refreshToken CC (ccr_) dengan pasangan token baru. */
export class SiwsRefreshDto {
  @ApiProperty({ description: 'refreshToken CC (prefix ccr_) dari /siws/verify.' })
  @IsString()
  @IsNotEmpty()
  refreshToken!: string;
}
