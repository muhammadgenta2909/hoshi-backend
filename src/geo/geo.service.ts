import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * KONTRAK GEO (backend implements, frontend consumes — SAMA PERSIS).
 * Bentuk yang di-trim: hanya field yang dipakai frontend, sisanya dari upstream dibuang.
 */
export type GeoCountry = {
  iso2: string;
  name: string;
  phonecode: string;
  emoji: string;
};
export type GeoState = { iso2: string; name: string };
export type GeoCity = { name: string };

/** Bentuk mentah dari countrystatecity.in (hanya field yang kita baca). */
type UpstreamCountry = {
  iso2?: unknown;
  name?: unknown;
  phonecode?: unknown;
  emoji?: unknown;
};
type UpstreamState = { iso2?: unknown; name?: unknown };
type UpstreamCity = { name?: unknown };

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/** Satu slot cache dengan kadaluarsa. */
type CacheEntry<T> = { value: T; expiresAt: number };

const UPSTREAM_BASE = 'https://api.countrystatecity.in/v1';

/** ~10s: cukup untuk free-tier CSC, tapi tidak menyandera worker bila upstream hang. */
const TIMEOUT_MS = 10_000;

/** Negara ~tak pernah berubah → cache lama. */
const COUNTRIES_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const STATES_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
const CITIES_TTL_MS = 24 * 60 * 60 * 1000; // 24 jam

/** Batasi Map agar tidak tumbuh tanpa henti (proteksi memori); evict entri terlama. */
const STATES_CACHE_MAX = 300; // ~250 negara di dunia
const CITIES_CACHE_MAX = 2000; // banyak kombinasi (negara, provinsi)

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * PROXY ke countrystatecity.in — supaya API key TETAP di server (tidak pernah ke browser,
 * tidak perlu ubah CSP frontend). Membaca CSC_API_KEY secara LAZY dari ConfigService:
 * deploy yang belum mengisi key tetap bisa boot; endpoint yang menjawab 503 jelas, dan
 * frontend jatuh ke input teks bebas (address form tetap jalan).
 *
 * Read-only + tanpa uang: aman di-cache agresif untuk hemat kuota free-tier.
 */
@Injectable()
export class GeoService {
  private readonly logger = new Logger(GeoService.name);

  // Negara: satu slot (tak dipartisi). States/Cities: bounded Map per-kunci.
  private countriesCache: CacheEntry<GeoCountry[]> | null = null;
  private readonly statesCache = new Map<string, CacheEntry<GeoState[]>>();
  private readonly citiesCache = new Map<string, CacheEntry<GeoCity[]>>();

  constructor(private readonly config: ConfigService) {}

  async countries(): Promise<GeoCountry[]> {
    const cached = this.readFresh(this.countriesCache);
    if (cached) return cached;

    const raw = await this.fetchUpstream<UpstreamCountry[]>('/countries');
    const mapped: GeoCountry[] = (Array.isArray(raw) ? raw : []).map((c) => ({
      iso2: str(c.iso2),
      name: str(c.name),
      phonecode: str(c.phonecode),
      emoji: str(c.emoji),
    }));
    this.countriesCache = {
      value: mapped,
      expiresAt: Date.now() + COUNTRIES_TTL_MS,
    };
    return mapped;
  }

  async states(ciso: string): Promise<GeoState[]> {
    const key = ciso.toUpperCase();
    const cached = this.readFresh(this.statesCache.get(key));
    if (cached) return cached;

    const raw = await this.fetchUpstream<UpstreamState[]>(
      `/countries/${encodeURIComponent(key)}/states`,
    );
    const mapped: GeoState[] = (Array.isArray(raw) ? raw : []).map((s) => ({
      iso2: str(s.iso2),
      name: str(s.name),
    }));
    this.setBounded(this.statesCache, key, mapped, STATES_TTL_MS, STATES_CACHE_MAX);
    return mapped;
  }

  async cities(ciso: string, siso: string): Promise<GeoCity[]> {
    const key = `${ciso.toUpperCase()}/${siso.toUpperCase()}`;
    const cached = this.readFresh(this.citiesCache.get(key));
    if (cached) return cached;

    const raw = await this.fetchUpstream<UpstreamCity[]>(
      `/countries/${encodeURIComponent(ciso.toUpperCase())}/states/` +
        `${encodeURIComponent(siso.toUpperCase())}/cities`,
    );
    const mapped: GeoCity[] = (Array.isArray(raw) ? raw : []).map((c) => ({
      name: str(c.name),
    }));
    this.setBounded(this.citiesCache, key, mapped, CITIES_TTL_MS, CITIES_CACHE_MAX);
    return mapped;
  }

  /* --- Internal --- */

  private readFresh<T>(entry: CacheEntry<T> | null | undefined): T | null {
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
  }

  private setBounded<T>(
    map: Map<string, CacheEntry<T>>,
    key: string,
    value: T,
    ttlMs: number,
    max: number,
  ): void {
    // Re-insert menaruh key di posisi terbaru (Map menjaga urutan insersi).
    map.delete(key);
    map.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private apiKey(): string {
    // LAZY: dibaca tiap panggil, bukan di-constructor — key bisa di-set setelah boot,
    // dan deploy tanpa key tetap bisa start (endpoint yang memberi 503, bukan boot).
    return (this.config.get<string>('CSC_API_KEY') ?? '').trim();
  }

  /**
   * GET ke upstream dengan header X-CSCAPI-KEY + timeout ~10s. TIDAK PERNAH membocorkan
   * key atau error mentah upstream ke pemanggil: semua kegagalan → 503 generik.
   */
  private async fetchUpstream<T>(path: string): Promise<T> {
    const key = this.apiKey();
    if (!key) {
      // 503 dengan pesan jelas → frontend fallback ke input teks bebas.
      throw new ServiceUnavailableException('Geo lookup not configured');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    let res: FetchResponse;
    try {
      res = await fetch(`${UPSTREAM_BASE}${path}`, {
        method: 'GET',
        headers: { 'X-CSCAPI-KEY': key, accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      // Log detail internal (tanpa key), tapi lempar pesan generik.
      const detail = controller.signal.aborted
        ? `timeout ${TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`GEO GET ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException('Geo lookup unavailable');
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      // Jangan teruskan body upstream (bisa memuat hint soal key/kuota).
      this.logger.error(`GEO GET ${path} → HTTP ${res.status}`);
      throw new ServiceUnavailableException('Geo lookup unavailable');
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(`GEO GET ${path} → body bukan JSON`);
      throw new ServiceUnavailableException('Geo lookup unavailable');
    }
  }
}
