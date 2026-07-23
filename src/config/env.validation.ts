import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Skema validasi environment. Dipanggil ConfigModule saat boot — kalau ada yang
 * salah/ kurang, aplikasi gagal start dengan pesan jelas (fail fast).
 */
class EnvironmentVariables {
  @IsString()
  @MinLength(1, { message: 'DATABASE_URL wajib diisi' })
  DATABASE_URL!: string;

  // HS256 → butuh entropi >= 256-bit. Generate: openssl rand -hex 32.
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET minimal 32 karakter (openssl rand -hex 32)',
  })
  JWT_SECRET!: string;

  // Wajib bersatuan biar tidak ambigu (mis. "7d", "30m", "12h"). Cegah misconfig diam-diam.
  @IsOptional()
  @Matches(/^\d+(\.\d+)?(ms|s|m|h|d|w|y)$/, {
    message: 'JWT_EXPIRES_IN harus durasi bersatuan, mis. 7d / 30m / 12h',
  })
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsInt()
  PORT?: number;

  @IsOptional()
  @IsString()
  FRONTEND_ORIGIN?: string;

  @IsOptional()
  @IsString()
  SOLANA_RPC_URL?: string;

  @IsOptional()
  @IsString()
  SOLANA_CLUSTER?: string;

  // Opsional saat boot: endpoint mint akan memberi error jelas bila belum diisi.
  @IsOptional()
  @IsString()
  PLATFORM_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  DEFAULT_METADATA_URI?: string;

  // Sumber inventory default untuk Open Packs (default 'hoshi-vault').
  @IsOptional()
  @IsIn(['hoshi-vault', 'collectorcrypt', 'mock'])
  INVENTORY_PROVIDER?: string;

  // Opsional (WAJIB kalau INVENTORY_PROVIDER=collectorcrypt) — kredensial API CollectorCrypt.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_API_BASE_URL?: string;

  @IsOptional()
  @IsString()
  COLLECTORCRYPT_API_KEY?: string;

  // Opsional — fallback secret untuk admin login POC (kalau backend belum punya admin user).
  @IsOptional()
  @IsString()
  ADMIN_SECRET?: string;

  // Opsional — base URL API KATALOG PUBLIK CollectorCrypt Marketplace (tanpa key).
  // Default: https://api.collectorcrypt.com — dipakai POST /admin/cc-sync untuk
  // menarik produk mereka ke marketplace kita. Terpisah dari GACHA_* (host beda,
  // auth beda) dan dari COLLECTORCRYPT_API_* lama yang deprecated.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_MARKET_BASE_URL?: string;

  // Opsional — "true" untuk MENGAKTIFKAN pembelian kartu katalog CollectorCrypt
  // (POST /marketplace/:id/cc-buy/*). Default MATI: jalur ini menyuruh wallet user
  // menandatangani transaksi USDC sungguhan di jaringan yang ditunjuk
  // COLLECTORCRYPT_MARKET_BASE_URL. Nyalakan hanya setelah diuji — mulai dari
  // https://dev-api.collectorcrypt.com (katalog & USDC devnet).
  @IsOptional()
  @IsString()
  HOSHI_CC_BUY_ENABLED?: string;

  // Opsional — kurs USD→IDR untuk mengubah harga katalog CC menjadi harga display
  // IDRX saat listing PERTAMA dibuat (re-sync tidak menyentuh harga). String
  // (bukan @IsInt) mengikuti pola HOSHI_PACK_MARGIN_BPS: salah ketik tidak boleh
  // diam-diam berubah jadi angka. Default 16000; MarketSyncService memvalidasi
  // rentang 1000–1000000.
  @IsOptional()
  @IsString()
  HOSHI_USD_IDR_RATE?: string;

  // Opsional (WAJIB kalau fitur gacha CollectorCrypt dipakai) — kredensial API gacha.
  // SENGAJA terpisah dari COLLECTORCRYPT_API_* di atas: var lama itu milik inventory
  // provider lama; mengisinya akan "mempersenjatai" provider tsb ke endpoint yang belum
  // terverifikasi. Base URL devnet: https://dev-gacha.collectorcrypt.com
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_GACHA_BASE_URL?: string;

  // Dikirim sebagai header `x-api-key` (BUKAN bearer token). Key ini yang menurunkan
  // `slug` kita, dan slug jadi prefix memo tiap transaksi → dasar bagi hasil 50%.
  // Kunci ini TIDAK BOLEH sampai ke browser: semua panggilan CC tetap server-side.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_GACHA_API_KEY?: string;

  // Opsional saat boot (WAJIB kalau gacha treasury dipakai) — secret key dompet
  // treasury Hoshi sebagai JSON byte array, format sama persis dengan
  // PLATFORM_SECRET_KEY. Dompet inilah yang MEMEGANG USDC ASLI dan membayar setiap
  // pack: user Indonesia bayar rupiah, treasury yang menandatangani on-chain.
  // Sengaja @IsOptional() supaya app tetap bisa start tanpa treasury — TreasuryService
  // memberi error jelas saat pertama kali dipakai, bukan mematikan boot semua deploy.
  // RAHASIA TERBESAR di sistem ini: siapa pun yang bisa membacanya bisa menguras treasury.
  @IsOptional()
  @IsString()
  HOSHI_TREASURY_SECRET_KEY?: string;

  // Opsional — plafon harga SATU pack yang treasury mau tandatangani (USDC base unit,
  // 6 desimal; $100 = 100000000). Default 100000000. Harga pack di-snapshot dari
  // /api/machines milik CollectorCrypt, jadi nominal yang kita bayar ditentukan RESPONS
  // MEREKA — dan di jalur treasury tidak ada lagi popup wallet yang bisa menahannya.
  // Plafon ini yang memastikan satu respons harga yang jahat/salah tidak berubah jadi
  // tanda tangan treasury senilai puluhan ribu dolar.
  @IsOptional()
  @IsInt()
  GACHA_MAX_PACK_PRICE_USDC?: number;

  // Opsional — plafon belanja treasury dalam 24 jam berjalan (USDC base unit).
  // Default 500000000 ($500). SELAMA GERBANG PEMBAYARAN RUPIAH BELUM ADA, inilah
  // satu-satunya batas nominal antara seorang user login dan isi treasury: identitas
  // itu gratis (/auth/nonce meng-upsert user untuk alamat Solana apa pun), jadi
  // rate-limit per-user bisa dikalahkan Sybil sementara plafon ini berlaku untuk
  // SELURUH treasury. Turunkan sesuai isi dompet panas — jangan dinaikkan.
  @IsOptional()
  @IsInt()
  GACHA_TREASURY_DAILY_CAP_USDC?: number;

  // ── IDRX (on-ramp rupiah) ────────────────────────────────────────────────
  // Semua @IsOptional(): deploy yang belum memakai pembayaran rupiah harus tetap bisa boot.
  // Konsekuensinya, konfigurasi IDRX yang kurang baru ketahuan saat order pertama dibuat —
  // PaymentsService yang wajib memberi error jelas di titik itu, sama seperti TreasuryService.

  // Opsional — base URL API IDRX. Default: https://idrx.co
  @IsOptional()
  @IsString()
  IDRX_API_BASE?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — dikirim sebagai header `idrx-api-key`.
  @IsOptional()
  @IsString()
  IDRX_API_KEY?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — secret HMAC-SHA256 dalam BASE64.
  // Nilai paling sensitif kedua setelah HOSHI_TREASURY_SECRET_KEY: ia yang membuktikan
  // bahwa panggilan mint-request & verifikasi riwayat transaksi benar-benar dari kita.
  // JANGAN pernah di-log, dikembalikan lewat API, atau ikut masuk ke pesan error.
  @IsOptional()
  @IsString()
  IDRX_API_SECRET?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — chain id Solana versi IDRX, string.
  // Nilainya diberikan saat onboarding IDRX; JANGAN ditebak. Salah chain = IDRX ter-mint di
  // jaringan lain dan treasury Solana kita tidak pernah menerimanya.
  @IsOptional()
  @IsString()
  IDRX_NETWORK_CHAIN_ID?: string;

  // Opsional — margin Hoshi dalam basis point, sebagai string ("500" = 5%). Ditambahkan di atas
  // harga pack hasil konversi rates() sebelum jadi harga rupiah yang dibayar user.
  // String (bukan @IsInt) supaya enableImplicitConversion tidak diam-diam mengubah nilai
  // salah ketik jadi angka; PaymentsService yang mem-parse & memvalidasi rentangnya.
  @IsOptional()
  @IsString()
  HOSHI_PACK_MARGIN_BPS?: string;
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      'Konfigurasi environment tidak valid:\n' +
        errors
          .map((e) => Object.values(e.constraints ?? {}).join(', '))
          .join('\n'),
    );
  }
  return validated;
}
