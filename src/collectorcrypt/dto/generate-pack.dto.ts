import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Payload beli pack CollectorCrypt (POST /api/gacha/packs, perlu login).
 *
 * `playerAddress` SENGAJA TIDAK ADA di DTO ini. Wallet pembayar selalu diturunkan
 * dari JWT (user.walletAddress). Kalau body boleh menentukannya, penyerang tinggal
 * mengirim wallet KORBAN sebagai pembayar: kita yang memanggil generatePack, kita
 * yang menyodorkan transaksinya ke browser korban, korban menandatangani, dan
 * korban membayar. Ledger kita pun jadi tak bisa dipercaya sebagai bukti bagi
 * hasil 50% karena "siapa membeli apa" bisa dipalsukan.
 *
 * `altPlayerAddress` & `altFundsRecipient` juga tidak diekspos: keduanya memisahkan
 * PEMBAYAR dari PENERIMA (kartu / hasil auto-sell turbo). Kartu dan dana turbo selalu
 * mendarat di wallet yang membayar. ValidationPipe (whitelist + forbidNonWhitelisted)
 * menolak request yang tetap mengirim field-field itu dengan 400 — bukan diam-diam
 * membuangnya.
 */
export class GeneratePackDto {
  @ApiPropertyOptional({
    example: 'pokemon_50',
    description:
      'Kode mesin dari GET /api/gacha/machines. Default: pokemon_50.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  packType?: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Turbo: kartu menang langsung di-auto-sell jadi USDC ke wallet pembayar. ' +
      'Hanya menerima boolean JSON asli — nilai lain ditolak 400.',
  })
  @IsOptional()
  // @Type(() => Object) mematikan enableImplicitConversion untuk field ini. Tanpa itu,
  // ValidationPipe global mengubah string APA PUN jadi boolean lewat Boolean(value):
  // "false", "off", dan "0" semuanya menjadi `true`. Untuk flag biasa itu cuma jelek;
  // di sini itu bahaya uang — turbo = kartu menang LANGSUNG dijual jadi USDC dan tidak
  // bisa dibatalkan. Nilai ambigu harus DITOLAK, bukan ditebak.
  @Type(() => Object)
  @IsBoolean()
  turbo?: boolean;
}
