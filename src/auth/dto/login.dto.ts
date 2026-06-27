import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

export class LoginDto {
  @ApiProperty({
    example: '5UcNEuD2jMVsfuDu3xuE6yDM1r8X7BjXYAeRvd4Qa9ET',
    description: 'Solana wallet address (base58)',
  })
  @IsString()
  @Length(32, 44)
  walletAddress!: string;

  @ApiProperty({
    description: 'Signature base58 dari message yang dikembalikan /auth/nonce',
  })
  @IsString()
  signature!: string;
}
