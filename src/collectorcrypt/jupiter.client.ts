import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Klien Jupiter Aggregator — SATU-SATUNYA sumber rute swap IDRX → USDC.
 *
 * ATURAN (sama seperti idrx.types.ts): file ini hanya berisi bentuk yang benar-benar
 * dikembalikan API. `quoteResponse` sengaja diperlakukan sebagai OPAQUE (`unknown`):
 * ia dikembalikan apa adanya ke endpoint /swap, dan setiap usaha "merapikan" isinya
 * berisiko mengubah rute yang sudah dikuotasi. Yang kita baca hanya field yang
 * benar-benar dipakai untuk KEPUTUSAN UANG — dan itu di-parse eksplisit.
 *
 * Kenapa Jupiter dan bukan bikin instruksi swap sendiri: /swap mengembalikan transaksi
 * yang SUDAH jadi (termasuk pembuatan ATA bila perlu, compute budget, dan priority fee),
 * jadi backend cukup MENANDATANGANI — tidak perlu @solana/spl-token dan tidak perlu
 * mengarang layout instruksi AMM yang bisa berubah sewaktu-waktu.
 */

/** Mint IDRX di Solana. 2 DESIMAL (bukan 6) — Rp 448.353 = 44.835.300 base unit. */
export const IDRX_MINT_SOLANA = 'idrxZcP8xiKkYk6XGD4uz1dxEYCWSgKDHqgjsBbwDur';

/** Desimal IDRX, diverifikasi lewat getTokenSupply di mainnet. JANGAN diasumsikan 6. */
export const IDRX_DECIMALS = 2;

/** USDC mainnet. Swap IDRX hanya masuk akal di mainnet — IDRX tidak ada di devnet. */
export const USDC_MINT_MAINNET_STR =
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/**
 * Hasil kuotasi yang SUDAH di-parse. `raw` wajib diteruskan utuh ke swapTransaction()
 * — Jupiter memakainya untuk membangun transaksi atas rute yang PERSIS ini.
 */
export interface JupQuote {
  /** Base unit token masuk (IDRX, 2 desimal). */
  inAmount: bigint;
  /** Base unit token keluar (USDC, 6 desimal) — perkiraan. */
  outAmount: bigint;
  /**
   * Batas bawah yang DITEGAKKAN ON-CHAIN. Kalau eksekusi menghasilkan kurang dari ini,
   * transaksi GAGAL (bukan diam-diam menerima harga buruk). Inilah pengaman slippage
   * yang sebenarnya — bukan angka slippageBps yang kita kirim.
   */
  minOutAmount: bigint;
  /** Fraksi, BUKAN persen: 0.0128% datang sebagai 0.000128. */
  priceImpactPct: number;
  /** Jumlah hop. >1 berarti rute lewat token perantara. */
  hops: number;
  /** Payload mentah, diteruskan apa adanya ke /swap. */
  raw: unknown;
}

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_API_BASE = 'https://lite-api.jup.ag';

@Injectable()
export class JupiterClient {
  private readonly logger = new Logger(JupiterClient.name);

  constructor(private readonly config: ConfigService) {}

  private apiBase(): string {
    const configured = this.config.get<string>('JUPITER_API_BASE')?.trim();
    const base =
      configured && configured.length > 0 ? configured : DEFAULT_API_BASE;
    return base.startsWith('http')
      ? base.replace(/\/+$/, '')
      : `https://${base}`;
  }

  /**
   * Kuotasi ExactIn: "kalau saya setor `amount` IDRX, dapat berapa USDC".
   *
   * `slippageBps` TIDAK menentukan harga yang kita terima — ia menentukan
   * `minOutAmount`, yaitu batas di bawah mana transaksi menolak untuk selesai.
   * Melonggarkannya berarti bersedia menerima harga lebih buruk, bukan "lebih aman".
   */
  async quoteIdrxToUsdc(
    idrxBaseUnits: bigint,
    slippageBps: number,
  ): Promise<JupQuote> {
    const url =
      `${this.apiBase()}/swap/v1/quote` +
      `?inputMint=${IDRX_MINT_SOLANA}` +
      `&outputMint=${USDC_MINT_MAINNET_STR}` +
      `&amount=${idrxBaseUnits.toString()}` +
      `&slippageBps=${slippageBps}` +
      // Rute banyak-hop menambah permukaan kegagalan tanpa manfaat nyata di pasangan
      // langsung IDRX/USDC (Whirlpool). Diverifikasi: 1 hop untuk seluruh rentang
      // ukuran yang kita izinkan.
      `&onlyDirectRoutes=true`;

    const body = await this.getJson(url);
    return this.parseQuote(body);
  }

  /**
   * Bangun transaksi swap untuk kuotasi ini. Mengembalikan base64 yang siap
   * DITANDATANGANI treasury — backend tidak pernah menyusun instruksinya sendiri.
   *
   * `userPublicKey` = treasury: ia pemilik IDRX-nya sekaligus penerima USDC-nya.
   */
  async buildSwapTransaction(
    quote: JupQuote,
    userPublicKey: string,
  ): Promise<{
    swapTransactionBase64: string;
    lastValidBlockHeight: number | null;
  }> {
    const url = `${this.apiBase()}/swap/v1/swap`;
    const payload = {
      quoteResponse: quote.raw,
      userPublicKey,
      // Treasury tidak menukar SOL di sini; membiarkan Jupiter membungkus SOL hanya
      // menambah instruksi yang tidak kita butuhkan.
      wrapAndUnwrapSol: false,
      // Biarkan Jupiter mengukur compute unit: nilai statis yang kekecilan membuat
      // swap gagal di tengah, dan yang kebesaran memboroskan priority fee.
      dynamicComputeUnitLimit: true,
      // Transaksi yang tidak pernah masuk blok sama buruknya dengan gagal, tapi jauh
      // lebih membingungkan (kita tidak tahu apakah ia akan masuk nanti).
      dynamicSlippage: false,
    };

    const body = await this.postJson(url, payload);
    const obj = body as Record<string, unknown> | null;
    const tx = obj?.swapTransaction;
    if (typeof tx !== 'string' || tx.length === 0) {
      throw new ServiceUnavailableException(
        'Jupiter tidak mengembalikan swapTransaction. Swap dibatalkan.',
      );
    }
    const lvbh = Number(obj?.lastValidBlockHeight);
    return {
      swapTransactionBase64: tx,
      lastValidBlockHeight: Number.isSafeInteger(lvbh) ? lvbh : null,
    };
  }

  /* --- Internal --- */

  /**
   * Kuotasi di-parse EKSPLISIT ke bigint. Jupiter mengirim nominal sebagai STRING
   * justru karena bisa melebihi presisi float — membacanya lewat Number() adalah
   * cara paling rapi untuk kehilangan uang tanpa jejak.
   */
  private parseQuote(body: unknown): JupQuote {
    const obj = body as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') {
      throw new ServiceUnavailableException('Kuotasi Jupiter tidak terbaca.');
    }
    if (typeof obj.error === 'string') {
      // "No routes found" masuk ke sini — itu kondisi pasar, bukan bug kita.
      throw new ServiceUnavailableException(
        `Jupiter tidak menemukan rute IDRX→USDC: ${obj.error}`,
      );
    }

    const inAmount = toBigInt(obj.inAmount);
    const outAmount = toBigInt(obj.outAmount);
    const minOutAmount = toBigInt(obj.otherAmountThreshold);
    if (inAmount === null || outAmount === null || minOutAmount === null) {
      throw new ServiceUnavailableException(
        'Kuotasi Jupiter tidak menyertakan nominal yang sah (inAmount/outAmount/otherAmountThreshold).',
      );
    }
    if (outAmount <= 0n || minOutAmount <= 0n) {
      throw new ServiceUnavailableException(
        'Kuotasi Jupiter mengembalikan nominal keluar nol. Swap dibatalkan.',
      );
    }

    const impact = Number(obj.priceImpactPct);
    const routePlan = Array.isArray(obj.routePlan) ? obj.routePlan : [];

    return {
      inAmount,
      outAmount,
      minOutAmount,
      // priceImpactPct absen/NaN diperlakukan sebagai TIDAK DIKETAHUI (bukan nol):
      // pemanggil menolak swap yang dampaknya tak terbaca, bukan meloloskannya.
      priceImpactPct: Number.isFinite(impact) ? impact : Number.NaN,
      hops: routePlan.length,
      raw: body,
    };
  }

  private async getJson(url: string): Promise<unknown> {
    return this.fetchJson(url, { method: 'GET' });
  }

  private async postJson(url: string, payload: unknown): Promise<unknown> {
    return this.fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  private async fetchJson(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) {
        // Pesan asli Jupiter diteruskan (dipotong): saat swap ditolak, alasannya
        // hampir selalu ada di sini dan menghilangkannya bikin debugging buta.
        throw new ServiceUnavailableException(
          `Jupiter ${res.status}: ${text.slice(0, 300)}`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new ServiceUnavailableException(
          'Respons Jupiter bukan JSON yang sah.',
        );
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const msg = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Panggilan Jupiter gagal (${msg}).`);
      throw new ServiceUnavailableException(
        `Jupiter tidak bisa dihubungi: ${msg}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

/** String/number → bigint, TANPA melewati float. Nilai tak sah → null (bukan 0). */
function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? BigInt(value) : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}
