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
