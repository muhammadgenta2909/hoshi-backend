import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  attachCcShippingErrorMeta,
  CC_SHIPPING_DELIST_ERRORS_KEY,
} from './cc-shipping.types';
import type {
  CcBurnRequest,
  CcBurnResponse,
  CcCreateAddressResponse,
  CcEstimateRequest,
  CcEstimateResponse,
  CcPrepareRequest,
  CcPrepareResponse,
  CcShipmentResponse,
  CcShippingAddressInput,
  CcShippingErrorBody,
  CcSiwsNonceRequest,
  CcSiwsNonceResponse,
  CcSiwsRefreshRequest,
  CcSiwsRefreshResponse,
  CcSiwsVerifyRequest,
  CcSiwsVerifyResponse,
} from './cc-shipping.types';

/** Devnet default. Produksi: https://api.collectorcrypt.com (di-set via env). */
const CC_SHIPPING_DEFAULT_BASE_URL = 'https://dev-api.collectorcrypt.com';

/** User-Agent WAJIB non-kosong — CC menolak sebagian request tanpa UA. Fallback bila env kosong. */
const CC_SHIPPING_DEFAULT_USER_AGENT = 'hoshi-backend';

/** CC tak punya SLA terdokumentasi → request tanpa batas waktu bisa menyandera worker kita. */
const CC_SHIPPING_TIMEOUT_MS = 20_000;

/** Potong body error yang kepanjangan sebelum masuk log/pesan exception. */
const CC_ERROR_MESSAGE_MAX = 300;

type FetchResponse = Awaited<ReturnType<typeof fetch>>;

/**
 * Klien HTTP CC Vault Shipping — LAPISAN TRANSPORT MURNI (model: cc-gacha.client.ts).
 * Tanpa business logic, tanpa database, dan TANPA retry otomatis: /redeem/prepare membuat shipment
 * dan /blockchain/:id/burn membakar NFT — keduanya TIDAK idempoten untuk di-retry buta.
 *
 * BEDA dari CcGachaClient:
 *  - Auth per-request `Authorization: Bearer <cc-access-token>` — ACCESS TOKEN SESI WALLET SIGN-IN
 *    CC (prefix `cca_`, umur 15 menit) hasil handshake SIWS di bawah. Dokumen CC hanya mengenal DUA
 *    kredensial (access token `cca_` dan API key `ccsk_` + X-CC-Customer); TIDAK ADA jalur "Privy
 *    identity token", dan burn Solana MEMANG WAJIB memakai sesi wallet sign-in — API key ditolak
 *    untuk leg Solana. Token milik USER, dioper dari frontend tiap panggilan, TIDAK PERNAH dipersist.
 *  - Header `User-Agent` WAJIB non-kosong (env COLLECTORCRYPT_SHIPPING_USER_AGENT) — request tanpa
 *    UA ditolak di edge CC dan tidak pernah sampai ke API.
 *  - Base URL dari COLLECTORCRYPT_SHIPPING_BASE_URL (devnet default dev-api.collectorcrypt.com).
 *
 * Pemetaan status: 401/403 → Unauthorized (token buruk/expired/di luar scope), 404 → NotFound,
 * 409 → Conflict, 400 → BadRequest, 5xx/429/timeout → ServiceUnavailable.
 */
@Injectable()
export class CcShippingClient {
  private readonly logger = new Logger(CcShippingClient.name);

  constructor(private readonly config: ConfigService) {}

  createShippingAddress(
    ccAccessToken: string,
    body: CcShippingAddressInput,
  ): Promise<CcCreateAddressResponse> {
    return this.request<CcCreateAddressResponse>(
      'POST',
      '/shipping-address/create',
      ccAccessToken,
      body,
    );
  }

  estimate(
    ccAccessToken: string,
    body: CcEstimateRequest,
  ): Promise<CcEstimateResponse> {
    return this.request<CcEstimateResponse>(
      'POST',
      '/redeem/estimate',
      ccAccessToken,
      body,
    );
  }

  prepare(
    ccAccessToken: string,
    body: CcPrepareRequest,
  ): Promise<CcPrepareResponse> {
    return this.request<CcPrepareResponse>(
      'POST',
      '/redeem/prepare',
      ccAccessToken,
      body,
    );
  }

  /**
   * Kirim transaksi yang SUDAH ditandatangani user → CC menyiarkan + membakar + mengirim.
   * Body membawa DUA ARRAY TERPISAH (`transactions` + `delistTransactions`) — masing-masing salinan
   * bertanda tangan dari setiap entri yang dikembalikan prepare.
   *
   * Responsnya HTTP 200 dengan ARRAY TELANJANG (kegagalan di depan) — bukan objek berstatus. Klien
   * TIDAK menilai isinya; pemeriksaan per-elemen (`error` non-null = leg gagal) ada di service,
   * karena itu keputusan uang, bukan transport.
   */
  burn(
    ccAccessToken: string,
    outboundShipmentId: string,
    body: CcBurnRequest,
  ): Promise<CcBurnResponse> {
    return this.request<CcBurnResponse>(
      'POST',
      `/blockchain/${encodeURIComponent(outboundShipmentId)}/burn`,
      ccAccessToken,
      body,
    );
  }

  /**
   * GET /outbound-shipment/:id. Dokumen: id yang TIDAK DIKENAL dijawab 200 dengan BODY KOSONG —
   * bukan 404 — jadi khusus rute ini body kosong dipetakan ke `null` ("tidak ditemukan"), bukan
   * ServiceUnavailable seperti rute lain. Body kosong di rute lain TETAP dianggap kegagalan.
   */
  getShipment(
    ccAccessToken: string,
    outboundShipmentId: string,
  ): Promise<CcShipmentResponse | null> {
    return this.requestAllowEmpty<CcShipmentResponse>(
      'GET',
      `/outbound-shipment/${encodeURIComponent(outboundShipmentId)}`,
      ccAccessToken,
    );
  }

  /* --- SIWS (Sign-In With Solana) — Track B login handshake, PRA-AUTH ---
     nonce/verify/refresh TIDAK membawa bearer: mereka MENGHASILKAN token, jadi lewat
     requestNoAuth (User-Agent + content-type tetap dikirim, Authorization tidak). */

  /** POST /auth/wallet/nonce → nonce + teks SIWS kanonik untuk ditandatangani wallet. */
  siwsNonce(body: CcSiwsNonceRequest): Promise<CcSiwsNonceResponse> {
    return this.requestNoAuth<CcSiwsNonceResponse>(
      'POST',
      '/auth/wallet/nonce',
      body,
    );
  }

  /** POST /auth/wallet/verify → tukar message+signature dengan token sesi CC (cca_/ccr_). */
  siwsVerify(body: CcSiwsVerifyRequest): Promise<CcSiwsVerifyResponse> {
    return this.requestNoAuth<CcSiwsVerifyResponse>(
      'POST',
      '/auth/wallet/verify',
      body,
    );
  }

  /** POST /auth/wallet/refresh → pasangan token baru dari refreshToken. */
  siwsRefresh(body: CcSiwsRefreshRequest): Promise<CcSiwsRefreshResponse> {
    return this.requestNoAuth<CcSiwsRefreshResponse>(
      'POST',
      '/auth/wallet/refresh',
      body,
    );
  }

  /* --- Internal --- */

  /**
   * Base URL + User-Agent dibaca LAZY (bukan saat boot). Base URL punya default devnet; UA punya
   * fallback non-kosong supaya kontrak "selalu kirim UA" tak pernah bocor jadi header kosong.
   */
  private endpoint(): { baseUrl: string; userAgent: string } {
    const baseUrl =
      this.config.get<string>('COLLECTORCRYPT_SHIPPING_BASE_URL') ??
      CC_SHIPPING_DEFAULT_BASE_URL;
    const ua =
      this.config.get<string>('COLLECTORCRYPT_SHIPPING_USER_AGENT') ??
      CC_SHIPPING_DEFAULT_USER_AGENT;
    const userAgent =
      typeof ua === 'string' && ua.trim().length > 0
        ? ua.trim()
        : CC_SHIPPING_DEFAULT_USER_AGENT;
    return { baseUrl: baseUrl.replace(/\/+$/, ''), userAgent };
  }

  /**
   * Jalur AUTH: kirim `Authorization: Bearer <cc-access-token>` (token sesi wallet sign-in CC,
   * prefix `cca_`). Token WAJIB non-kosong — tanpa itu CC pasti 401 dan kita boros satu round-trip.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    ccAccessToken: string,
    body?: unknown,
  ): Promise<T> {
    const res = await this.send<T>(
      method,
      path,
      this.authHeaders(ccAccessToken),
      body,
      false,
    );
    // emptyBodyOk=false → send() melempar untuk body kosong, jadi di sini tak pernah null.
    return res as T;
  }

  /**
   * Sama dengan request(), tapi body kosong pada HTTP 2xx dipetakan ke `null` alih-alih dianggap
   * kegagalan. HANYA untuk GET /outbound-shipment/:id, yang menurut dokumen menjawab id tak dikenal
   * dengan "200 + body kosong" (bukan 404).
   */
  private async requestAllowEmpty<T>(
    method: 'GET' | 'POST',
    path: string,
    ccAccessToken: string,
    body?: unknown,
  ): Promise<T | null> {
    return this.send<T>(
      method,
      path,
      this.authHeaders(ccAccessToken),
      body,
      true,
    );
  }

  /** Header jalur auth. Token kosong = 401 pasti di sisi CC → tolak lebih awal. */
  private authHeaders(ccAccessToken: string): Record<string, string> {
    if (typeof ccAccessToken !== 'string' || ccAccessToken.trim().length === 0) {
      throw new UnauthorizedException(
        'Token sesi CollectorCrypt (cca_…) tidak ada — login wallet dulu lewat /redemptions/siws/verify, ' +
          'lalu kirim token itu di header x-cc-access-token.',
      );
    }
    return {
      Authorization: `Bearer ${ccAccessToken.trim()}`,
      'User-Agent': this.endpoint().userAgent,
      'content-type': 'application/json',
    };
  }

  /**
   * Jalur PRA-AUTH (SIWS nonce/verify/refresh): TANPA Authorization — endpoint ini yang MENGHASILKAN
   * token, jadi belum ada bearer untuk dikirim. Header WAJIB `User-Agent` + `content-type` TETAP
   * dikirim; timeout, pemetaan error, dan parsing JSON identik dengan jalur auth (lewat send()).
   */
  private async requestNoAuth<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { userAgent } = this.endpoint();
    const res = await this.send<T>(
      method,
      path,
      {
        'User-Agent': userAgent,
        'content-type': 'application/json',
      },
      body,
      false,
    );
    return res as T;
  }

  /**
   * Transport bersama untuk jalur auth & pra-auth: satu-satunya tempat fetch dijalankan, timeout
   * di-abort, status dipetakan (toHttpException), dan body JSON diparse. Header disuplai pemanggil
   * (dengan/atau tanpa Authorization) — itulah satu-satunya beda antara request & requestNoAuth.
   *
   * `emptyBodyOk`: DEFAULT false → body kosong pada 2xx = kegagalan (ServiceUnavailable), karena
   * semua rute lain memang selalu punya body. Hanya GET /outbound-shipment/:id yang mengoperkannya
   * true: dokumen CC menjawab id tak dikenal dengan 200 + body kosong, dan itu berarti "tidak
   * ditemukan" (`null`), bukan CC rusak.
   */
  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    headers: Record<string, string>,
    body?: unknown,
    emptyBodyOk = false,
  ): Promise<T | null> {
    const { baseUrl } = this.endpoint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CC_SHIPPING_TIMEOUT_MS);

    let res: FetchResponse;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout ${CC_SHIPPING_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(
        `CC Shipping ${method} ${path} → gagal (${detail})`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt Shipping ${method} ${path} tidak dapat dihubungi (${detail}).`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw await this.toHttpException(method, path, res);
    }

    const text = (await res.text()).trim();
    if (!text) {
      if (emptyBodyOk) {
        // Kontrak CC untuk /outbound-shipment/:id: 200 + body kosong = id tidak dikenal.
        this.logger.warn(
          `CC Shipping ${method} ${path} → HTTP ${res.status} body kosong = tidak ditemukan (kontrak CC).`,
        );
        return null;
      }
      this.logger.error(
        `CC Shipping ${method} ${path} → HTTP ${res.status} body kosong`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt Shipping ${method} ${path} mengembalikan body kosong.`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(
        `CC Shipping ${method} ${path} → body bukan JSON valid`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt Shipping ${method} ${path} mengembalikan respons non-JSON.`,
      );
    }
  }

  /**
   * Petakan status CC ke exception kita — jangan pernah membocorkan 5xx mentah mereka.
   * 401/403 = token identitas buruk/expired atau user belum terdaftar di CC (JANGAN diperlakukan
   * sebagai kegagalan uang; user cukup mengulang dengan token segar); 404 = shipment/kartu tak ada;
   * 409 = bentrok (mis. sudah di-prepare); 5xx/429 = transien.
   */
  private async toHttpException(
    method: 'GET' | 'POST',
    path: string,
    res: FetchResponse,
  ): Promise<HttpException> {
    const { message: remote, json } = await this.readErrorBody(res);
    this.logger.error(
      `CC Shipping ${method} ${path} → HTTP ${res.status}${remote ? ` — ${remote}` : ''}`,
    );
    const message = `CollectorCrypt Shipping ${method} ${path} gagal (HTTP ${res.status})${
      remote ? `: ${remote}` : '.'
    }`;

    const exception = ((): HttpException => {
      switch (res.status) {
        case 400:
          return new BadRequestException(message);
        case 401:
        case 403:
          return new UnauthorizedException(message);
        case 404:
          return new NotFoundException(message);
        case 409:
          return new ConflictException(message);
        default:
          // 429 (rate limit) + 5xx + status tak terduga → transien di sisi kita.
          return new ServiceUnavailableException(message);
      }
    })();

    /* SINYAL TERSTRUKTUR — dilampirkan SELALU, untuk SETIAP status. `message` di atas LOSSY:
       dipotong CC_ERROR_MESSAGE_MAX char, dan untuk body bergaya Nest isinya hanya
       `message`/`error` sehingga nama kunci `delistErrors` (kunci SAUDARA) lenyap. Keputusan
       uang di service TIDAK boleh menebak dari prosa itu. Di sini kita cuma melaporkan FAKTA
       hasil parsing — tanpa menilai artinya (itu tugas service, beserta sikap fail-closed-nya). */
    return attachCcShippingErrorMeta(exception, {
      status: res.status,
      jsonBody: json !== null,
      delistErrorsPresent:
        json !== null &&
        Object.prototype.hasOwnProperty.call(
          json,
          CC_SHIPPING_DELIST_ERRORS_KEY,
        ),
      delistErrors:
        json === null ? undefined : json[CC_SHIPPING_DELIST_ERRORS_KEY],
    });
  }

  /**
   * Baca body error SEKALI, kembalikan DUA hal:
   *  - `message`: pesan manusiawi untuk log/exception — TETAP `details ?? message ?? error`
   *    dipotong CC_ERROR_MESSAGE_MAX char (perilaku lama, sengaja TIDAK diubah);
   *  - `json`: OBJEK hasil JSON.parse apa adanya bila body memang objek JSON, selain itu `null`.
   *
   * `json` inilah sumber sinyal terstruktur: nama kunci seperti `delistErrors` sering TIDAK
   * selamat di `message`. Array & skalar JSON SENGAJA dihitung "bukan objek" (`null`) supaya
   * bentuk tak terduga jatuh ke jalur fail-closed di service.
   */
  private async readErrorBody(res: FetchResponse): Promise<{
    message?: string;
    json: Record<string, unknown> | null;
  }> {
    let text: string;
    try {
      text = await res.text();
    } catch {
      return { message: undefined, json: null };
    }
    if (!text) return { message: undefined, json: null };

    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
      ) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      // Bukan JSON — `json` tetap null, pesan pakai teks mentahnya (dipotong).
    }

    if (json !== null) {
      const body = json as CcShippingErrorBody;
      const message = body.details ?? body.message ?? body.error;
      if (typeof message === 'string' && message.length > 0) {
        return { message: message.slice(0, CC_ERROR_MESSAGE_MAX), json };
      }
    }
    return { message: text.slice(0, CC_ERROR_MESSAGE_MAX), json };
  }
}
