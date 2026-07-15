import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload bikin order pack berbayar rupiah (POST /api/payments/pack-orders, perlu login).
 *
 * TIDAK ADA SATU PUN FIELD YANG BISA MENYEBUT NOMINAL ATAU WALLET. Sama seperti
 * PurchasePackDto, itu bukan kelalaian melainkan inti keamanannya:
 *
 * - `priceIdr` & `priceUsdc` SELALU di-snapshot server dari /api/machines + GET
 *   /api/transaction/rates. Kalau body boleh menyebut harga, user tinggal memesan pack
 *   $50 seharga Rp 20.000 (batas minimum IDRX) dan treasury yang menomboki selisihnya.
 * - `destinationWalletAddress` (penerima IDRX) SELALU treasury Hoshi, konstanta server.
 *   Kalau body boleh menentukannya, rupiah user mendarat di wallet penyerang sementara
 *   treasury tetap membayar pack-nya.
 * - Penerima kartu SELALU diturunkan dari baris User milik order ini saat fulfilment,
 *   tidak pernah dari body request maupun dari body callback IDRX.
 *
 * ValidationPipe global (whitelist + forbidNonWhitelisted, main.ts) menolak request yang
 * tetap mengirim field-field itu dengan 400 — bukan diam-diam membuangnya.
 */
export class CreatePackOrderDto {
  @ApiPropertyOptional({
    example: 'pokemon_50',
    description:
      'Kode mesin dari GET /api/gacha/machines. Default: pokemon_50. ' +
      'Harga di-snapshot dari mesin + kurs IDRX, tidak pernah dari klien.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  packType?: string;

  @ApiPropertyOptional({
    enum: ['QRIS', 'HOSTED'],
    example: 'QRIS',
    description:
      'QRIS = kita terima qrContent langsung. HOSTED = halaman bayar IDRX (paymentUrl), ' +
      'cakupan terluas: QRIS + e-wallet + virtual account + retail. Default: QRIS.',
  })
  @IsOptional()
  @IsIn(['QRIS', 'HOSTED'])
  method?: 'QRIS' | 'HOSTED';
}
