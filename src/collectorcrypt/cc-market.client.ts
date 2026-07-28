import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CcMarketBrowseQuery,
  CcMarketBrowseResponse,
} from './cc-market.types';

/**
 * Produksi. API katalog ini PUBLIK (tanpa key), jadi tidak ada varian devnet yang
 * perlu kita pakai — data kartunya ya katalog produksi mereka.
 */
const CC_MARKET_DEFAULT_BASE_URL = 'https://api.collectorcrypt.com';

/**
 * Lebih longgar dari gacha (15s): endpoint browse mereka terobservasi ~2.3s untuk
 * 2 item; halaman 50-100 item bisa lebih lambat. Tetap dibatasi supaya satu sync
 * tidak menyandera worker.
 */
const CC_MARKET_TIMEOUT_MS = 30_000;

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Klien HTTP katalog publik CollectorCrypt Marketplace — LAPISAN TRANSPORT MURNI,
 * mengikuti disiplin CcGachaClient: tanpa business logic, tanpa database, tanpa
 * retry otomatis. Endpoint ini read-only dan TANPA kredensial, jadi tidak ada
 * risiko idempotensi — tapi keputusan retry tetap milik pemanggil.
 *
 * SENGAJA terpisah dari CcGachaClient: base URL beda (api. vs gacha.), auth beda
 * (tanpa key vs x-api-key), dan kegagalan katalog tidak boleh ikut mematikan
 * jalur gacha yang memindahkan uang.
 */
@Injectable()
export class CcMarketClient {
  private readonly logger = new Logger(CcMarketClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * GET /marketplace — browse katalog kartu ter-vault CC beserta harga listing.
   * Respons berisi `filterNFtCard[]`; kartu tanpa sub-objek `listing` sedang
   * tidak dijual (pemanggil yang memutuskan mau memakai atau melewatinya).
   */
  browse(
    query: CcMarketBrowseQuery,
    opts?: { timeoutMs?: number },
  ): Promise<CcMarketBrowseResponse> {
    const params: Record<string, string> = {};
    if (query.page !== undefined) params.page = String(query.page);
    if (query.step !== undefined) params.step = String(query.step);
    if (query.categories) params.categories = query.categories;
    if (query.marketplaceSource)
      params.marketplaceSource = query.marketplaceSource;
    if (query.marketplaceStatus)
      params.marketplaceStatus = query.marketplaceStatus;
    if (query.listPriceMin !== undefined)
      params.listPriceMin = String(query.listPriceMin);
    if (query.listPriceMax !== undefined)
      params.listPriceMax = String(query.listPriceMax);
    if (query.ccBuyback !== undefined)
      params.ccBuyback = String(query.ccBuyback);
    if (query.orderBy) params.orderBy = query.orderBy;
    if (query.search) params.search = query.search;

    const qs = new URLSearchParams(params).toString();
    return this.request<CcMarketBrowseResponse>(
      qs ? `/marketplace?${qs}` : '/marketplace',
      opts?.timeoutMs,
    );
  }

  /* --- Internal --- */

  private baseUrl(): string {
    const base =
      this.config.get<string>('COLLECTORCRYPT_MARKET_BASE_URL') ??
      CC_MARKET_DEFAULT_BASE_URL;
    return base.replace(/\/+$/, '');
  }

  private async request<T>(path: string, timeoutMs?: number): Promise<T> {
    const budget = timeoutMs ?? CC_MARKET_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);

    let res: FetchResponse;
    try {
      res = await fetch(`${this.baseUrl()}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      // Pakai signal.aborted, bukan err.name — konsisten dengan CcGachaClient.
      const detail = controller.signal.aborted
        ? `timeout ${budget}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`CC market GET ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException(
        `Katalog CollectorCrypt tidak dapat dihubungi (${detail}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      this.logger.error(`CC market GET ${path} → HTTP ${res.status}`);
      throw new ServiceUnavailableException(
        `Katalog CollectorCrypt menjawab HTTP ${res.status}.`,
      );
    }

    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(
        `CC market GET ${path} → body bukan JSON (${text.slice(0, 120)})`,
      );
      throw new ServiceUnavailableException(
        'Katalog CollectorCrypt mengembalikan respons yang tidak bisa dibaca.',
      );
    }
  }
}
