import { ApiProperty } from '@nestjs/swagger';
import { IsBase64, IsNotEmpty, IsString } from 'class-validator';

/**
 * Payload submit transaksi pack (POST /api/gacha/packs/:memo/submit, perlu login).
 *
 * NON-KUSTODIAL: backend tidak pernah memegang private key dan tidak pernah
 * menandatangani apa pun. Transaksi UNSIGNED dari generatePack ditandatangani di
 * wallet user, lalu hasilnya dikirim balik ke sini untuk diteruskan ke CollectorCrypt.
 *
 * Memo diambil dari path (dan dicocokkan dengan pemilik baris ledger), bukan dari body:
 * memo tertulis di transaksi on-chain sehingga bersifat PUBLIK — ia kunci join internal,
 * bukan kapabilitas yang boleh dipercaya dari klien.
 */
export class SubmitPackDto {
  @ApiProperty({
    example: 'AQABAgMEBQYHCAkKCwwNDg8Q...',
    description:
      'Transaksi hasil generatePack yang SUDAH ditandatangani wallet user (base64).',
  })
  @IsString()
  @IsNotEmpty()
  @IsBase64()
  signedTransaction!: string;
}
