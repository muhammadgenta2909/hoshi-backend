import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload beli pack yang DIBAYAR TREASURY (POST /api/gacha/packs/purchase, perlu login).
 *
 * Bedanya dengan GeneratePackDto: di sini user tidak menandatangani apa pun. Treasury
 * Hoshi yang membayar USDC dan menandatangani server-side, kartunya dikirim ke wallet
 * user lewat `altPlayerAddress`.
 *
 * TIDAK ADA SATU PUN FIELD YANG BISA MENYEBUT WALLET. Itu bukan kelalaian, itu inti
 * keamanannya:
 *
 * - `playerAddress` (pembayar) SELALU treasury, konstanta server dari environment.
 *   Kalau body boleh menentukannya, penyerang tinggal menyebut wallet KORBAN sebagai
 *   pembayar dan kita yang menerbitkan transaksi yang mendebit korban.
 * - `altPlayerAddress` (penerima kartu) SELALU diturunkan dari JWT (user.walletAddress).
 *   Kalau body boleh menentukannya, JWT curian bisa membelokkan kartu senilai ~$50 yang
 *   DIBAYAR TREASURY ke wallet penyerang — dan buyback() (yang mencocokkan userId +
 *   nftAddress) jadi mustahil karena kartunya duduk di wallet yang tidak pernah kita catat.
 * - `altFundsRecipient` (hasil auto-sell turbo) tidak diekspos dengan alasan yang sama.
 *
 * ValidationPipe global (whitelist + forbidNonWhitelisted, main.ts) menolak request yang
 * tetap mengirim field-field itu dengan 400 — bukan diam-diam membuangnya.
 */
export class PurchasePackDto {
  @ApiPropertyOptional({
    example: 'pokemon_50',
    description:
      'Kode mesin dari GET /api/gacha/machines. Default: pokemon_50. ' +
      'Harga di-snapshot dari mesin, tidak pernah dari klien.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  packType?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'DINONAKTIFKAN pada jalur treasury: `true` ditolak 400. Field ini ada supaya ' +
      'penolakannya eksplisit (bukan diam-diam diabaikan) dan supaya bentuk request ' +
      'tetap sama dengan jalur user-bayar.',
  })
  @IsOptional()
  // @Type(() => Object) mematikan enableImplicitConversion untuk field ini. Tanpa itu,
  // ValidationPipe global mengubah string APA PUN jadi boolean lewat Boolean(value):
  // "false", "off", dan "0" semuanya menjadi `true`. Di jalur treasury itu bahaya uang —
  // turbo menjual-otomatis kartu jadi USDC ke penerima kartu (= wallet user), alias
  // memompa USDC treasury keluar. Nilai ambigu harus DITOLAK, bukan ditebak.
  @Type(() => Object)
  @IsBoolean()
  turbo?: boolean;
}
