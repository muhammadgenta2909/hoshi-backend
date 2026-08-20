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
 *  - Auth per-request `Authorization: Bearer <privy-identity-token>` — token IDENTITAS USER,
 *    dioper dari frontend tiap panggilan dan TIDAK PERNAH dipersist di sini.
 *  - Header `User-Agent` WAJIB non-kosong (env COLLECTORCRYPT_SHIPPING_USER_AGENT).
 *  - Base URL dari COLLECTORCRYPT_SHIPPING_BASE_URL (devnet default dev-api.collectorcrypt.com).
 *
 * Pemetaan status: 401/403 → Unauthorized (token buruk/tidak terdaftar), 404 → NotFound,
 * 409 → Conflict, 400 → BadRequest, 5xx/429/timeout → ServiceUnavailable.
 */
@Injectable()
export class CcShippingClient {
  private readonly logger = new Logger(CcShippingClient.name);

  constructor(private readonly config: ConfigService) {}

  createShippingAddress(
    privyToken: string,
    body: CcShippingAddressInput,
  ): Promise<CcCreateAddressResponse> {
    return this.request<CcCreateAddressResponse>(
      'POST',
      '/shipping-address/create',
      privyToken,
      body,
    );
  }

  estimate(
    privyToken: string,
    body: CcEstimateRequest,
  ): Promise<CcEstimateResponse> {
    return this.request<CcEstimateResponse>(
      'POST',
      '/redeem/estimate',
      privyToken,
      body,
    );
  }

  prepare(
    privyToken: string,
    body: CcPrepareRequest,
  ): Promise<CcPrepareResponse> {
    return this.request<CcPrepareResponse>(
      'POST',
      '/redeem/prepare',
      privyToken,
      body,
    );
  }

  /** Kirim transaksi yang SUDAH ditandatangani user → CC menyiarkan + membakar + mengirim. */
  burn(
    privyToken: string,
    outboundShipmentId: string,
    body: CcBurnRequest,
  ): Promise<CcBurnResponse> {
    return this.request<CcBurnResponse>(
      'POST',
      `/blockchain/${encodeURIComponent(outboundShipmentId)}/burn`,
      privyToken,
      body,
    );
  }

  getShipment(
    privyToken: string,
    outboundShipmentId: string,
  ): Promise<CcShipmentResponse> {
    return this.request<CcShipmentResponse>(
      'GET',
      `/outbound-shipment/${encodeURIComponent(outboundShipmentId)}`,
      privyToken,
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

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    privyToken: string,
    body?: unknown,
  ): Promise<T> {
    // Token identitas user WAJIB ada — tanpa itu CC pasti 401 dan kita boros satu round-trip.
    if (typeof privyToken !== 'string' || privyToken.trim().length === 0) {
      throw new UnauthorizedException(
        'Token identitas Privy tidak ada — kirim header x-privy-identity-token.',
      );
    }
    const { baseUrl, userAgent } = this.endpoint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CC_SHIPPING_TIMEOUT_MS);

    let res: FetchResponse;
    try {
      res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${privyToken.trim()}`,
          'User-Agent': userAgent,
          'content-type': 'application/json',
        },
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

    const text = await res.text();
    if (!text) {
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
    const remote = await this.readErrorMessage(res);
    this.logger.error(
      `CC Shipping ${method} ${path} → HTTP ${res.status}${remote ? ` — ${remote}` : ''}`,
    );
    const message = `CollectorCrypt Shipping ${method} ${path} gagal (HTTP ${res.status})${
      remote ? `: ${remote}` : '.'
    }`;

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
        const body = parsed as CcShippingErrorBody;
        const message = body.details ?? body.message ?? body.error;
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
