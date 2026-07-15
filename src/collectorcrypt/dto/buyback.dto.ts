import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/** Alamat Solana base58 (32-44 karakter, tanpa 0/O/I/l). */
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Payload jual-balik kartu ke CollectorCrypt (POST /api/gacha/buyback, perlu login).
 * Hanya berlaku dalam jendela 72 jam milik mereka.
 *
 * `playerAddress` diturunkan dari JWT, dan `nftAddress` divalidasi terhadap ledger:
 * harus berasal dari pack yang DIBUKA oleh user ini. Tanpa cek itu, user B bisa
 * meminta buyback atas kartu user A.
 *
 * `altRecipient` sengaja tidak diekspos: ia mengirim dana refund ke wallet selain
 * pembayar. Dana buyback selalu kembali ke wallet yang memiliki kartunya.
 *
 * Nominal refund TIDAK pernah dihitung sendiri — hanya CollectorCrypt yang berhak
 * menentukannya (respons `refundAmount`, USDC base unit 6 desimal).
 */
export class BuybackDto {
  @ApiProperty({
    example: 'HHw4oQh9pNqL4sY7F7hX7sFAzW9yJ7jUu4w9rHf3Z6a1',
    description: 'Alamat NFT hasil pack yang ingin dijual balik.',
  })
  @IsString()
  @Matches(SOLANA_ADDRESS, {
    message: 'nftAddress harus alamat Solana base58 yang valid.',
  })
  nftAddress!: string;
}
