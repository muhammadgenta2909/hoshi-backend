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
import { buildIdrxRequest } from '../idrx/idrx.signature';
import { detectProductionSignal } from '../common/demo-mode';
import { IdrxMockStore } from './idrx-mock.store';
import type {
  IdrxErrorBody,
  IdrxMintRequestInput,
  IdrxMintRequestResponse,
  IdrxRatesResponse,
  IdrxTransactionHistoryResponse,
  IdrxTransactionRecord,
} from './idrx.types';

const IDRX_DEFAULT_BASE_URL = 'https://idrx.co';

/** Tanpa batas waktu, satu request IDRX yang menggantung bisa menyandera worker kita. */
const IDRX_TIMEOUT_MS = 15_000;

/** Potong body error yang kepanjangan sebelum masuk log/pesan exception. */
const IDRX_ERROR_MESSAGE_MAX = 300;

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

type IdrxMethod = 'GET' | 'POST';

/**
 * Klien HTTP IDRX — LAPISAN TRANSPORT MURNI.
 * Tanpa business logic, tanpa database, tanpa retry otomatis. Klien ini tidak tahu apa-apa
 * soal PaymentOrder: ia hanya menandatangani, mengirim, dan memetakan error.
 *
 * Penandatanganan DIPINJAM UTUH dari src/idrx/idrx.signature.ts — jangan pernah menulis
 * ulang HMAC-nya di sini. Detail yang mematikan: buildIdrxRequest menandatangani `path`,
 * BUKAN URL absolut. Karena itu query string WAJIB ikut di dalam `path` (lihat withQuery);
 * kalau query ditempel ke URL setelah penandatanganan, HMAC menutupi string yang berbeda
 * dari yang dilihat server dan SETIAP verifikasi akan 401 — yang berarti tidak ada satu pun
 * pembayaran yang pernah kita penuhi.
 *
 * IDRX_API_SECRET tidak boleh pernah muncul di log, di pesan exception, atau di respons.
 * Yang boleh dicatat hanya method + path + status.
 */
@Injectable()
export class IdrxClient {
  private readonly logger = new Logger(IdrxClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly mockStore: IdrxMockStore,
  ) {}

  /**
   * ON-RAMP. `destinationWalletAddress` di input WAJIB alamat treasury Hoshi — klien ini
   * sengaja tidak memaksakannya (itu keputusan pemanggil), tapi mengisinya dari input user
   * berarti kita mencetak IDRX ke wallet mereka dan tetap membayari packnya.
   */
  mintRequest(input: IdrxMintRequestInput): Promise<IdrxMintRequestResponse> {
    if (this.mockEnabled()) return this.mockMintRequest(input);
    return this.request<IdrxMintRequestResponse>(
      'POST',
      '/api/transaction/mint-request',
      input,
    );
  }

  /**
   * THE VERIFIER — satu-satunya bukti pembayaran yang boleh dipercaya (callback IDRX tidak
   * ditandatangani, jadi ia cuma pemicu).
   *
   * `null` HANYA berarti satu hal: IDRX menjawab dengan benar dan tidak ada record MINT untuk
   * merchantOrderId ini (belum dibayar / belum tercetak). Semua kegagalan lain — timeout, 5xx,
   * body non-JSON, 404 path salah — MELEMPAR, supaya pemanggil bisa membedakan "terbukti belum
   * dibayar" dari "kita gagal memeriksa". Kalau keduanya dilebur jadi `null`, satu salah ketik
   * pada path akan tampak seperti "semua orang belum bayar" dan setiap user yang membayar
   * ditelantarkan diam-diam.
   *
   * Klien ini TIDAK memutuskan lunas/tidak. Pemanggil wajib menuntut
   * paymentStatus === 'PAID' && userMintStatus === 'MINTED', plus pin destinationWalletAddress
   * ke treasury, requestType, chainId, dan toBeMinted >= nominal order.
   */
  async findMintByMerchantOrderId(
    merchantOrderId: string,
  ): Promise<IdrxTransactionRecord | null> {
    if (this.mockEnabled()) return this.mockFindMint(merchantOrderId);
    const path = this.withQuery('/api/transaction/user-transaction-history', {
      transactionType: 'MINT',
      merchantOrderId,
      page: '1',
      take: '1',
    });
    const res = await this.request<IdrxTransactionHistoryResponse>('GET', path);

    const records = Array.isArray(res.records) ? res.records : [];
    const record: IdrxTransactionRecord | undefined = records[0];
    if (!record) return null;

    // Sabuk pengaman terhadap filter server yang diam-diam diabaikan: kalau `merchantOrderId`
    // tidak dipakai IDRX untuk memfilter, take=1 akan mengembalikan record MINT SEMBARANGAN —
    // dan verifier yang percaya begitu saja akan memenuhi order yang tidak pernah dibayar.
    // Tolak dengan keras, dan catat: ini kondisi mustahil kecuali kontrak berubah.
    if (record.merchantOrderId !== merchantOrderId) {
      this.logger.error(
        'IDRX history mengembalikan record dengan merchantOrderId yang tidak cocok — ' +
          'filter kemungkinan diabaikan server. Verifikasi ditolak (fail-closed).',
      );
      return null;
    }
    return record;
  }

  /**
   * FX. IDRX 1:1 IDR, jadi rates(usdtAmount = harga pack dalam USDC) menghasilkan HARGA RUPIAH
   * pack itu di `data.buyAmount`. Kurs bergerak — hasilnya wajib di-snapshot ke order.
   */
  rates(usdtAmount: string, chainId?: string): Promise<IdrxRatesResponse> {
    if (this.mockEnabled()) return this.mockRates(usdtAmount);
    const path = this.withQuery('/api/transaction/rates', {
      usdtAmount,
      ...(chainId ? { chainId } : {}),
    });
    return this.request<IdrxRatesResponse>('GET', path);
  }

  /* --- IDRX MOCK (staging/devnet saja — TIDAK PERNAH di produksi) --- */

  /**
   * Mock aktif HANYA bila IDRX_MOCK=1 DAN deployment tidak terlihat produksi
   * (detectProductionSignal() === null). Jadi walau flag kepencet di mainnet, jalur
   * asli yang dipakai — mock tak akan pernah menyentuh uang/rupiah nyata.
   */
  private mockEnabled(): boolean {
    return (
      this.config.get<string>('IDRX_MOCK') === '1' &&
      detectProductionSignal() === null
    );
  }

  /** Base URL publik backend ini — dipakai membangun paymentUrl halaman bayar palsu. */
  private mockPublicBase(): string {
    const configured = this.config.get<string>('IDRX_MOCK_PUBLIC_URL')?.trim();
    const base =
      configured && configured.length > 0 ? configured : 'http://localhost:3001';
    return base.replace(/\/+$/, '');
  }

  private mockMintRequest(
    input: IdrxMintRequestInput,
  ): Promise<IdrxMintRequestResponse> {
    const merchantOrderId = `MOCK-${Date.now()}-${Math.floor(
      Math.random() * 1_000_000,
    )}`;
    this.mockStore.remember(merchantOrderId, {
      destinationWalletAddress: input.destinationWalletAddress,
      toBeMinted: input.toBeMinted,
      returnUrl: input.returnUrl,
    });
    const paymentUrl = `${this.mockPublicBase()}/api/idrx-mock/pay?order=${encodeURIComponent(
      merchantOrderId,
    )}`;
    this.logger.warn(
      `IDRX MOCK: mint-request → ${merchantOrderId} (paymentUrl ${paymentUrl})`,
    );
    return Promise.resolve({
      statusCode: 200,
      message: 'ok (mock)',
      data: {
        id: merchantOrderId,
        merchantOrderId,
        merchantCode: 'MOCK',
        reference: `MOCKREF-${merchantOrderId}`,
        paymentUrl,
        amount: input.toBeMinted,
        statusCode: 200,
        statusMessage: 'created (mock)',
      },
    });
  }

  /**
   * WAITING sebelum tombol "Bayar" ditekan, PAID+MINTED sesudahnya. Meng-echo treasury +
   * nominal supaya assertRecordMatchesOrder di PaymentsService tetap lolos apa adanya.
   */
  private mockFindMint(
    merchantOrderId: string,
  ): Promise<IdrxTransactionRecord | null> {
    const order = this.mockStore.get(merchantOrderId);
    if (!order) return Promise.resolve(null);
    const paid = this.mockStore.isPaid(merchantOrderId);
    return Promise.resolve({
      id: merchantOrderId,
      merchantOrderId,
      paymentStatus: paid ? 'PAID' : 'WAITING_FOR_PAYMENT',
      userMintStatus: paid ? 'MINTED' : 'PROCESSING',
      destinationWalletAddress: order.destinationWalletAddress,
      requestType: 'idrx',
      toBeMinted: order.toBeMinted,
      ...(paid ? { txHash: `MOCKTX-${merchantOrderId}` } : {}),
    });
  }

  private mockRates(usdtAmount: string): Promise<IdrxRatesResponse> {
    const usd = Number(usdtAmount);
    const rate = 16_000; // IDR per USD (mock, realistis; IDRX 1:1 IDR)
    const buyAmount = Math.max(
      20_000,
      Math.round((Number.isFinite(usd) ? usd : 0) * rate),
    );
    return Promise.resolve({
      statusCode: 200,
      message: 'ok (mock)',
      data: {
        price: rate,
        buyAmount,
        chainId: '2',
        quote: { expectedResult: { min: buyAmount, max: buyAmount } },
      },
    });
  }

  /* --- Internal --- */

  /**
   * Kredensial dibaca LAZY (bukan saat boot) supaya aplikasi tetap bisa start tanpa IDRX —
   * sama seperti treasury. Base URL punya default; key dan secret TIDAK BOLEH punya default.
   */
  private credentials(): {
    apiBase: string;
    apiKey: string;
    secretKeyBase64: string;
  } {
    // `??` alone only catches undefined/null — an env set to an EMPTY string (a
    // very easy mistake in a dashboard) would slip through and make every request
    // URL relative ("Failed to parse URL"). Trim + `||` fall back on empty too, and
    // a value missing its scheme (e.g. "idrx.co") gets https:// so fetch can parse it.
    const configured = this.config.get<string>('IDRX_API_BASE')?.trim();
    const apiBase = configured
      ? /^https?:\/\//i.test(configured)
        ? configured
        : `https://${configured}`
      : IDRX_DEFAULT_BASE_URL;
    const apiKey = this.config.get<string>('IDRX_API_KEY');
    const secretKeyBase64 = this.config.get<string>('IDRX_API_SECRET');

    if (!apiKey || !secretKeyBase64) {
      throw new ServiceUnavailableException(
        'Pembayaran IDRX belum dikonfigurasi. Set IDRX_API_KEY dan IDRX_API_SECRET ' +
          '(serta IDRX_API_BASE bila bukan https://idrx.co) di environment.',
      );
    }
    return { apiBase: apiBase.replace(/\/+$/, ''), apiKey, secretKeyBase64 };
  }

  /**
   * Query WAJIB dibangun di sini dan ikut masuk ke `path` yang ditandatangani. String yang
   * dihasilkan dipakai untuk HMAC DAN untuk URL, jadi keduanya mustahil melenceng.
   */
  private withQuery(path: string, params: Record<string, string>): string {
    const query = new URLSearchParams(params).toString();
    return query ? `${path}?${query}` : path;
  }

  private async request<T>(
    method: IdrxMethod,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { apiBase, apiKey, secretKeyBase64 } = this.credentials();

    const signed = buildIdrxRequest({
      apiBase,
      path,
      method,
      apiKey,
      secretKeyBase64,
      // Kontrak IDRX: ms epoch sebagai string. Jam kita yang melenceng jauh = signature ditolak.
      timestamp: Date.now().toString(),
      body,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IDRX_TIMEOUT_MS);

    let res: FetchResponse;
    try {
      res = await fetch(signed.url, {
        method: signed.method,
        headers: signed.headers,
        // Body sudah di-serialize oleh buildIdrxRequest — JANGAN di-stringify ulang.
        // Byte yang ditandatangani harus persis byte yang dikirim.
        body: signed.body,
        signal: controller.signal,
      });
    } catch (err) {
      // Pakai signal.aborted, bukan err.name: undici melempar DOMException saat abort dan
      // bentuk error-nya berbeda antar versi Node.
      const detail = controller.signal.aborted
        ? `timeout ${IDRX_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`IDRX ${method} ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException(
        `IDRX ${method} ${path} tidak dapat dihubungi (${detail}).`,
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
        `IDRX ${method} ${path} → HTTP ${res.status} dengan body kosong`,
      );
      throw new ServiceUnavailableException(
        `IDRX ${method} ${path} mengembalikan body kosong.`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(`IDRX ${method} ${path} → body bukan JSON yang valid`);
      throw new ServiceUnavailableException(
        `IDRX ${method} ${path} mengembalikan respons non-JSON.`,
      );
    }
  }

  /**
   * Petakan status IDRX ke exception kita — jangan pernah membocorkan 500 mentah mereka.
   * 401/403 hampir selalu berarti signature/kredensial salah, BUKAN "user tidak berhak":
   * ia dipetakan ke Forbidden supaya berisik dan tidak pernah tersamar sebagai "belum dibayar".
   * Sisanya (5xx, 429, tak terduga) → 503: satu-satunya kelas yang layak dicoba ulang oleh
   * reconciler.
   */
  private async toHttpException(
    method: IdrxMethod,
    path: string,
    res: FetchResponse,
  ): Promise<HttpException> {
    const remote = await this.readErrorMessage(res);
    this.logger.error(
      `IDRX ${method} ${path} → HTTP ${res.status}${remote ? ` — ${remote}` : ''}`,
    );
    const message = `IDRX ${method} ${path} gagal (HTTP ${res.status})${
      remote ? `: ${remote}` : '.'
    }`;

    switch (res.status) {
      case 400:
        return new BadRequestException(message);
      case 401:
      case 403:
        return new ForbiddenException(message);
      case 404:
        return new NotFoundException(message);
      default:
        return new ServiceUnavailableException(message);
    }
  }

  /** Ambil pesan asli IDRX bila ada; body error tidak dijamin JSON. */
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
        const bodyError = parsed as IdrxErrorBody;
        const message = bodyError.message ?? bodyError.error;
        if (typeof message === 'string' && message.length > 0) {
          return message.slice(0, IDRX_ERROR_MESSAGE_MAX);
        }
      }
    } catch {
      // Bukan JSON — pakai teks mentahnya (dipotong).
    }
    return text.slice(0, IDRX_ERROR_MESSAGE_MAX);
  }
}
