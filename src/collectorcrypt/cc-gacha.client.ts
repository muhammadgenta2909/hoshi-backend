import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  CcBuybackAvailableResponse,
  CcBuybackCheckResponse,
  CcBuybackRequest,
  CcBuybackResponse,
  CcErrorBody,
  CcGeneratePackRequest,
  CcGeneratePackResponse,
  CcGenerateYoloPacksRequest,
  CcGenerateYoloPacksResponse,
  CcMachine,
  CcMachineNormalized,
  CcMachinesResponse,
  CcOpenPackRequest,
  CcOpenPackResponse,
  CcPackStatusResponse,
  CcRecentWinnersResponse,
  CcStatusResponse,
  CcStockResponse,
  CcSubmitTransactionRequest,
  CcSubmitTransactionResponse,
  CcVrfVerifyResponse,
} from './cc-gacha.types';
import { usdDollarsToUsdcBaseUnits } from './cc-gacha.types';

/** Devnet. Produksi: https://gacha.collectorcrypt.com (di-set via env). */
const CC_GACHA_DEFAULT_BASE_URL = 'https://dev-gacha.collectorcrypt.com';

/** CC tidak punya SLA terdokumentasi → request tanpa batas waktu bisa menyandera worker kita. */
const CC_GACHA_TIMEOUT_MS = 15_000;

/** Potong body error yang kepanjangan sebelum masuk log/pesan exception. */
const CC_ERROR_MESSAGE_MAX = 300;

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Klien HTTP CollectorCrypt Gacha — LAPISAN TRANSPORT MURNI.
 * Tanpa business logic, tanpa database, tanpa persistence, dan TANPA retry otomatis:
 * POST /api/submitTransaction TIDAK idempoten, jadi retry buta bisa men-charge user 2×.
 * Outcome yang ambigu (timeout/5xx) diselesaikan dengan MEMBACA /api/pack/status?memo=,
 * bukan dengan mengulang submit — itu keputusan pemanggil, bukan keputusan klien ini.
 *
 * Kunci API dikirim sebagai header `x-api-key` (BUKAN bearer). Key inilah yang
 * menurunkan `slug` kita, dan slug jadi prefix memo tiap transaksi → dasar bagi hasil 50%.
 * Kunci ini tidak boleh bocor ke browser: semua panggilan di sini tetap server-side.
 */
@Injectable()
export class CcGachaClient {
  private readonly logger = new Logger(CcGachaClient.name);

  constructor(private readonly config: ConfigService) {}

  /* --- Pack --- */

  /**
   * Langkah 1: CC membuat memo + transaksi UNSIGNED. Belum ada uang berpindah di sini,
   * jadi ini titik aman untuk write-ahead baris intent sebelum user menandatangani.
   */
  generatePack(body: CcGeneratePackRequest): Promise<CcGeneratePackResponse> {
    return this.request<CcGeneratePackResponse>(
      'POST',
      '/api/generatePack',
      body,
    );
  }

  generateYoloPacks(
    body: CcGenerateYoloPacksRequest,
  ): Promise<CcGenerateYoloPacksResponse> {
    return this.request<CcGenerateYoloPacksResponse>(
      'POST',
      '/api/generateYoloPacks',
      body,
    );
  }

  /** Langkah 3 (setelah wallet user menandatangani). TIDAK idempoten — jangan pernah di-retry. */
  submitTransaction(
    body: CcSubmitTransactionRequest,
  ): Promise<CcSubmitTransactionResponse> {
    return this.request<CcSubmitTransactionResponse>(
      'POST',
      '/api/submitTransaction',
      body,
    );
  }

  /** Langkah 4. Idempoten: memo yang sudah dibuka mengembalikan hasil aslinya. */
  openPack(body: CcOpenPackRequest): Promise<CcOpenPackResponse> {
    return this.request<CcOpenPackResponse>('POST', '/api/openPack', body);
  }

  /* --- Buyback (jendela 72 jam) --- */

  buyback(body: CcBuybackRequest): Promise<CcBuybackResponse> {
    return this.request<CcBuybackResponse>('POST', '/api/buyback', body);
  }

  buybackCheck(memo: string): Promise<CcBuybackCheckResponse> {
    return this.request<CcBuybackCheckResponse>(
      'GET',
      this.withQuery('/api/buyback/check', { memo }),
    );
  }

  /** Satu-satunya harga buyback yang sah. Jangan pernah menghitungnya sendiri. */
  buybackAvailable(
    wallet: string,
    nft: string,
  ): Promise<CcBuybackAvailableResponse> {
    return this.request<CcBuybackAvailableResponse>(
      'GET',
      this.withQuery('/api/buyback/available', { wallet, nft }),
    );
  }

  /* --- Read-only --- */

  /**
   * Sumber kebenaran harga/odds/EV — snapshot hasilnya ke baris pembelian, jangan di-hardcode.
   *
   * INI BOUNDARY KONVERSI UANG, tepat sekali di titik masuk. FAKTA yang bikin bug lama:
   * /api/machines mengirim `price` dalam DOLAR PENUH (50, bukan 50_000_000). Di sinilah
   * kita ubah ke USDC base units (`priceUsdcBaseUnits`) sehingga TIDAK ADA service hilir
   * yang pernah melihat harga dolar mentah lalu lupa mengonversinya. `ev` sengaja
   * dibiarkan float (display-only, bukan input uang).
   */
  async machines(): Promise<CcMachineNormalized[]> {
    const raw = await this.request<CcMachinesResponse>('GET', '/api/machines');
    // BENTUK ASLI (diverifikasi ke API devnet): { machines: [...] } — BUKAN array telanjang.
    // Tetap toleran kalau suatu saat mereka mengirim array langsung, supaya perubahan bentuk
    // di sisi mereka tidak langsung membuat seluruh halaman Open Packs 500.
    const list = Array.isArray(raw) ? raw : (raw?.machines ?? []);
    return list.map((machine) => this.normalizeMachine(machine));
  }

  /** Ubah satu mesin dolar-penuh menjadi bentuk base-units yang aman untuk jalur uang. */
  private normalizeMachine(machine: CcMachine): CcMachineNormalized {
    const { price, ...rest } = machine;
    return {
      ...rest,
      priceUsdcDollars: price,
      priceUsdcBaseUnits: usdDollarsToUsdcBaseUnits(price),
    };
  }

  stock(): Promise<CcStockResponse> {
    return this.request<CcStockResponse>('GET', '/api/stock');
  }

  status(): Promise<CcStatusResponse> {
    return this.request<CcStatusResponse>('GET', '/api/status');
  }

  /** Oracle idempoten untuk rekonsiliasi: apakah pembelian memo ini benar-benar ada on-chain. */
  packStatus(memo: string): Promise<CcPackStatusResponse> {
    return this.request<CcPackStatusResponse>(
      'GET',
      this.withQuery('/api/pack/status', { memo }),
    );
  }

  recentWinners(packType: string): Promise<CcRecentWinnersResponse> {
    return this.request<CcRecentWinnersResponse>(
      'GET',
      this.withQuery('/api/getRecentWinners', { packType }),
    );
  }

  vrfVerify(memo: string): Promise<CcVrfVerifyResponse> {
    return this.request<CcVrfVerifyResponse>(
      'GET',
      this.withQuery('/api/vrf/verify', { memo }),
    );
  }

  /* --- Internal --- */

  /**
   * Kredensial dibaca LAZY (bukan saat boot) supaya aplikasi tetap bisa start tanpa gacha.
   * Base URL punya default devnet; API key tidak boleh punya default — tanpa key, memo yang
   * terbit tidak membawa slug kita dan pembelian user jadi 0% pendapatan buat kita.
   */
  private credentials(): { baseUrl: string; apiKey: string } {
    const baseUrl =
      this.config.get<string>('COLLECTORCRYPT_GACHA_BASE_URL') ??
      CC_GACHA_DEFAULT_BASE_URL;
    const apiKey = this.config.get<string>('COLLECTORCRYPT_GACHA_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'Gacha CollectorCrypt belum dikonfigurasi. Set COLLECTORCRYPT_GACHA_API_KEY ' +
          '(dan COLLECTORCRYPT_GACHA_BASE_URL bila bukan devnet) di environment.',
      );
    }
    return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
  }

  private withQuery(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return query ? `${path}?${query}` : path;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { baseUrl, apiKey } = this.credentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CC_GACHA_TIMEOUT_MS);

    let res: FetchResponse;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          // Kontrak CC: x-api-key, BUKAN Authorization: Bearer.
          'x-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Pakai signal.aborted, bukan err.name: undici melempar DOMException saat abort,
      // dan bentuk error-nya berbeda antar versi Node.
      const detail = controller.signal.aborted
        ? `timeout ${CC_GACHA_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`CollectorCrypt ${method} ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException(
        `CollectorCrypt ${method} ${path} tidak dapat dihubungi (${detail}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw await this.toHttpException(method, path, res);
    }

    const text = await res.text();
    if (!text) {
      this.logger.error(
        `CollectorCrypt ${method} ${path} → HTTP ${res.status} dengan body kosong`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt ${method} ${path} mengembalikan body kosong.`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(
        `CollectorCrypt ${method} ${path} → body bukan JSON yang valid`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt ${method} ${path} mengembalikan respons non-JSON.`,
      );
    }
  }

  /**
   * Petakan status CC ke exception kita — jangan pernah membocorkan 500 mentah mereka.
   * Tiap status punya arti yang berbeda dan penanganan yang berlawanan:
   * 403 = alamat diblokir (sinyal kepatuhan, JANGAN di-retry, catat),
   * 404 = tidak ada pembelian on-chain untuk memo (fakta rekonsiliasi, bukan error transien),
   * 503 = satu-satunya yang layak di-retry, dan hanya pada endpoint idempoten.
   */
  private async toHttpException(
    method: 'GET' | 'POST',
    path: string,
    res: FetchResponse,
  ): Promise<HttpException> {
    const remote = await this.readErrorMessage(res);
    this.logger.error(
      `CollectorCrypt ${method} ${path} → HTTP ${res.status}${remote ? ` — ${remote}` : ''}`,
    );
    const message = `CollectorCrypt ${method} ${path} gagal (HTTP ${res.status})${
      remote ? `: ${remote}` : '.'
    }`;

    switch (res.status) {
      case 400:
        return new BadRequestException(message);
      case 403:
        return new ForbiddenException(message);
      case 404:
        return new NotFoundException(message);
      default: {
        // 500 (mesin off/stok habis/saldo kurang/processing), 503 (terlalu banyak pack
        // terbuka), dan status tak terduga lainnya → semua jadi 503 di sisi kita.
        // Pesan mentah CC ("Internal server error"/"Machine is empty") tampil ke USER,
        // jadi kalau ini soal ketersediaan mesin, ganti dengan kalimat yang jelas &
        // bisa ditindaklanjuti. Detail teknis tetap masuk log di atas.
        return new ServiceUnavailableException(
          friendlyMachineMessage(remote) ?? message,
        );
      }
    }
  }

  /** Ambil pesan asli CC bila ada; body error tidak dijamin JSON. */
  private async readErrorMessage(
    res: FetchResponse,
  ): Promise<string | undefined> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      return undefined;
    }
    if (!text) return undefined;

    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        const bodyError = parsed as CcErrorBody;
        // `details` lebih spesifik dari `error` yang generik ("Internal server error").
        const message =
          bodyError.details ?? bodyError.message ?? bodyError.error;
        if (typeof message === 'string' && message.length > 0) {
          return message.slice(0, CC_ERROR_MESSAGE_MAX);
        }
      }
    } catch {
      // Bukan JSON — pakai teks mentahnya (dipotong).
    }
    return text.slice(0, CC_ERROR_MESSAGE_MAX);
  }
}

/**
 * Ubah alasan mentah CC menjadi kalimat yang jelas & bisa ditindaklanjuti untuk USER.
 * Di devnet, status mesin sering berubah: "Machine is empty" (kolam hadiah kosong),
 * "Machine is off"/"low stock"/"balance"/"processing". Semua itu artinya sama bagi user —
 * mesin ini sedang tidak bisa dibuka — jadi jangan tampilkan teks teknis mereka.
 * Kembalikan null bila bukan soal ketersediaan mesin (biar pesan asli yang dipakai).
 */
function friendlyMachineMessage(remote: string | undefined): string | null {
  if (!remote) return null;
  if (
    /empty|off|stock|balance|processing|not\s*available|unavailable/i.test(
      remote,
    )
  ) {
    return 'Mesin pack ini sedang tidak tersedia (kolam hadiahnya kosong atau ditutup sementara). Coba mesin lain, atau ulangi sebentar lagi.';
  }
  return null;
}
