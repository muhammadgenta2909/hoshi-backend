import { ApiProperty } from '@nestjs/swagger';
import { IsBase64, IsNotEmpty, IsString } from 'class-validator';

/**
 * Transaksi buyback yang SUDAH ditandatangani wallet user, untuk diteruskan ke
 * CollectorCrypt. Cermin dari SubmitPackDto — alur dan jaminannya sama persis.
 *
 * NON-KUSTODIAL: backend tidak pernah memegang private key. POST /gacha/buyback
 * hanya MENERBITKAN transaksi unsigned; yang memindahkan kartu dan menarik dana
 * refund adalah tanda tangan user, bukan kita.
 *
 * Memo diambil dari path (dan dicocokkan dengan pemilik baris ledger), bukan dari
 * body: memo tertulis di transaksi on-chain sehingga PUBLIK — ia kunci join
 * internal, bukan kapabilitas yang boleh dipercaya dari klien.
 */
export class SubmitBuybackDto {
  @ApiProperty({
    example: 'AQABAgMEBQYHCAkKCwwNDg8Q...',
    description:
      'Transaksi buyback yang SUDAH ditandatangani wallet user (base64).',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  signedTransaction!: string;
}
