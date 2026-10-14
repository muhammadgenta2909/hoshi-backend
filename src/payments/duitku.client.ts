import { createHash, timingSafeEqual } from 'crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { detectProductionSignal } from '../common/demo-mode';

/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ DUITKU — PAYMENT GATEWAY UNTUK PEMBELI. IDRX TIDAK BISA MENJADI INI.                       ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * IDRX mewajibkan "name matching": nama pembayar harus sama dengan nama pemilik akun IDRX (PT).
 * Pembeli Hoshi membayar atas nama mereka sendiri, jadi TIDAK SATU PUN pembayaran pembeli lewat
 * IDRX bisa berhasil (dikonfirmasi tim IDRX, Oktober 2026). Duitku adalah payment gateway biasa:
 * siapa pun boleh membayar, rupiahnya mendarat di rekening PT.
 *
 * Bentuk API diambil dari library RESMI Duitku (github.com/duitkupg/duitku-php, Duitku/Pop.php +
 * Duitku/Config.php), BUKAN dari port pihak ketiga. Port Go yang beredar menandatangani
 * createInvoice dengan HMAC-SHA256 berkunci apiKey; library PHP resmi memakai SHA-256 BIASA atas
 * `merchantCode + timestamp + apiKey`. Yang kita ikuti yang resmi — dan sandbox yang
 * memastikannya, karena tanda tangan yang salah langsung ditolak di sana, bukan diam-diam lolos.
 *
 *   createInvoice     POST {POP}/api/merchant/createInvoice
 *                     header x-duitku-signature = sha256(merchantCode + timestamp + apiKey)
 *   transactionStatus POST {POP}/api/merchant/transactionStatus
 *                     body.signature = md5(merchantCode + merchantOrderId + apiKey)
 *   callback          POST x-www-form-urlencoded ke callbackUrl
 *                     signature = md5(merchantCode + amount + merchantOrderId + apiKey)
 *
 * POP = https://api-sandbox.duitku.com (sandbox) | https://api-prod.duitku.com (produksi).
 */

const DUITKU_POP_BASE = {
  sandbox: 'https://api-sandbox.duitku.com',
  production: 'https://api-prod.duitku.com',
} as const;

export type DuitkuEnv = keyof typeof DUITKU_POP_BASE;

/** Sama dengan IDRX: tanpa batas waktu, satu request menggantung menyandera worker kita. */
const DUITKU_TIMEOUT_MS = 15_000;

/** Potong body error yang kepanjangan sebelum masuk log/pesan exception. */
const ERROR_BODY_MAX = 300;

export interface DuitkuConfig {
  env: DuitkuEnv;
  merchantCode: string;
  apiKey: string;
  callbackUrl: string;
  /**
   * Email yang dikirim ke Duitku sebagai "email pelanggan". Duitku mewajibkannya, tapi pembeli
   * Hoshi nyaris tidak pernah punya email di database (login wallet tidak mengisinya). Jadi ini
   * alamat operasional Hoshi — BUKAN alamat karangan per pembeli, yang akan membuat Duitku
   * mengirim struk ke kotak surat yang tidak ada.
   */
  customerEmail: string;
  /** Nama yang tampil di konfirmasi bank / VA pembeli. */
  vaName: string;
}

export interface DuitkuInvoiceInput {
  /** Rupiah utuh. Duitku tidak menerima pecahan. */
  paymentAmount: number;
  merchantOrderId: string;
  productDetails: string;
  returnUrl: string;
  /** Menit. */
  expiryPeriod?: number;
}

export interface DuitkuInvoice {
  reference: string;
  paymentUrl: string;
}

/** Respons cek status. `statusCode`: "00" lunas, "01" menunggu, "02" batal/kedaluwarsa. */
export interface DuitkuTransactionStatus {
  merchantOrderId: string;
  reference?: string;
  amount: string;
  fee?: string;
  statusCode: string;
  statusMessage?: string;
}

/* ─────────────── Tanda tangan — fungsi murni, diekspor supaya bisa diuji tanpa jaringan ─────────────── */

const sha256Hex = (s: string): string =>
  createHash('sha256').update(s, 'utf8').digest('hex');
const md5Hex = (s: string): string =>
  createHash('md5').update(s, 'utf8').digest('hex');

export const duitkuInvoiceSignature = (
  merchantCode: string,
  timestamp: string,
  apiKey: string,
): string => sha256Hex(merchantCode + timestamp + apiKey);

export const duitkuStatusSignature = (
  merchantCode: string,
  merchantOrderId: string,
  apiKey: string,
): string => md5Hex(merchantCode + merchantOrderId + apiKey);

export const duitkuCallbackSignature = (
  merchantCode: string,
  amount: string,
  merchantOrderId: string,
  apiKey: string,
): string => md5Hex(merchantCode + amount + merchantOrderId + apiKey);

/** Bandingkan dua hex string tanpa membocorkan posisi beda lewat waktu. */
function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

@Injectable()
export class DuitkuClient {
  private readonly logger = new Logger(DuitkuClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Dibaca LAZY (bukan saat boot) — sama seperti IDRX — supaya server tetap menyala tanpa Duitku
   * selama rel ini belum dinyalakan.
   *
   * ╔══ SANDBOX DI PRODUKSI DITOLAK — ITU KARTU GRATIS ══╗
   * Di sandbox, "membayar" itu gratis dan instan. Kalau server produksi tersambung ke sandbox,
   * siapa pun bisa menebus kartu titipan sungguhan — milik orang lain — tanpa satu rupiah pun.
   * Jadi sandbox hanya boleh hidup di mesin yang TIDAK terlihat seperti produksi, memakai sinyal
   * yang sama dengan pagar IDRX mock.
   */
  readConfig(): DuitkuConfig {
    const env = (this.config.get<string>('DUITKU_ENV') ?? '').trim();
    if (env !== 'sandbox' && env !== 'production') {
      throw new ServiceUnavailableException(
        'Duitku belum dikonfigurasi: DUITKU_ENV harus "sandbox" atau "production".',
      );
    }
    const production = detectProductionSignal();
    if (env === 'sandbox' && production !== null) {
      throw new ServiceUnavailableException(
        `Duitku SANDBOX ditolak di deployment produksi (${production}). Pembayaran sandbox ` +
          'itu gratis — menyambungkannya ke produksi berarti menyerahkan kartu sungguhan tanpa bayar.',
      );
    }
    const need = (key: string): string => {
      const v = this.config.get<string>(key)?.trim();
      if (!v) {
        throw new ServiceUnavailableException(
          `Duitku belum dikonfigurasi: ${key} kosong.`,
        );
      }
      return v;
    };
    return {
      env,
      merchantCode: need('DUITKU_MERCHANT_CODE'),
      apiKey: need('DUITKU_API_KEY'),
      callbackUrl: need('DUITKU_CALLBACK_URL'),
      customerEmail: need('DUITKU_CUSTOMER_EMAIL'),
      vaName:
        this.config.get<string>('DUITKU_VA_NAME')?.trim() || 'Hoshimarket',
    };
  }

  /** Terbitkan tagihan di halaman bayar Duitku (POP). Pembeli memilih metodenya sendiri di sana. */
  async createInvoice(input: DuitkuInvoiceInput): Promise<DuitkuInvoice> {
    const cfg = this.readConfig();
    if (
      !Number.isSafeInteger(input.paymentAmount) ||
      input.paymentAmount <= 0
    ) {
      throw new ServiceUnavailableException(
        `Nominal Duitku tidak sah: ${String(input.paymentAmount)} (harus rupiah utuh > 0).`,
      );
    }
    const timestamp = Date.now().toString();
    const res = await this.post<{
      merchantCode?: string;
      reference?: string;
      paymentUrl?: string;
      statusCode?: string;
      statusMessage?: string;
    }>(
      cfg,
      '/api/merchant/createInvoice',
      {
        paymentAmount: input.paymentAmount,
        merchantOrderId: input.merchantOrderId,
        productDetails: input.productDetails.slice(0, 255),
        email: cfg.customerEmail,
        customerVaName: cfg.vaName,
        callbackUrl: cfg.callbackUrl,
        returnUrl: input.returnUrl,
        ...(input.expiryPeriod ? { expiryPeriod: input.expiryPeriod } : {}),
      },
      {
        'x-duitku-signature': duitkuInvoiceSignature(
          cfg.merchantCode,
          timestamp,
          cfg.apiKey,
        ),
        'x-duitku-timestamp': timestamp,
        'x-duitku-merchantcode': cfg.merchantCode,
      },
    );
    // Respons 2xx tanpa paymentUrl/reference tidak boleh melahirkan order: pembeli tidak punya
    // halaman untuk membayar, dan kita tidak punya apa pun untuk dicocokkan nanti.
    if (res.statusCode !== '00' || !res.paymentUrl || !res.reference) {
      throw new ServiceUnavailableException(
        `Duitku menolak membuat tagihan (${res.statusCode ?? '?'}: ${res.statusMessage ?? 'tanpa pesan'}).`,
      );
    }
    return { reference: res.reference, paymentUrl: res.paymentUrl };
  }

  /**
   * Bukti pembayaran SERVER-KE-SERVER. Satu-satunya sumber kebenaran — body callback hanya pemicu.
   *
   * Mengembalikan null kalau Duitku tidak mengenal order ini (atau menjawab order LAIN): sama
   * dengan IdrxClient, "tidak ditemukan" dan "tidak cocok" sama-sama berarti JANGAN menebus.
   */
  async transactionStatus(
    merchantOrderId: string,
  ): Promise<DuitkuTransactionStatus | null> {
    const cfg = this.readConfig();
    const res = await this.post<Partial<DuitkuTransactionStatus>>(
      cfg,
      '/api/merchant/transactionStatus',
      {
        merchantCode: cfg.merchantCode,
        merchantOrderId,
        signature: duitkuStatusSignature(
          cfg.merchantCode,
          merchantOrderId,
          cfg.apiKey,
        ),
      },
    );
    if (
      typeof res.merchantOrderId !== 'string' ||
      res.merchantOrderId !== merchantOrderId ||
      typeof res.statusCode !== 'string' ||
      res.amount == null
    ) {
      this.logger.warn(
        `Duitku transactionStatus ${merchantOrderId}: respons tidak cocok/ tidak lengkap — diperlakukan TIDAK DITEMUKAN.`,
      );
      return null;
    }
    return {
      merchantOrderId: res.merchantOrderId,
      reference: res.reference,
      amount: String(res.amount),
      fee: res.fee != null ? String(res.fee) : undefined,
      statusCode: res.statusCode,
      statusMessage: res.statusMessage,
    };
  }

  /**
   * Tanda tangan callback sah? Ini PERTAHANAN BERLAPIS, bukan gerbang uangnya: callback yang lolos
   * tetap hanya memicu verifikasi server-ke-server. Gunanya menolak spam yang memaksa kita
   * memanggil Duitku berulang-ulang atas order karangan.
   */
  isCallbackSignatureValid(body: Record<string, unknown>): boolean {
    let cfg: DuitkuConfig;
    try {
      cfg = this.readConfig();
    } catch {
      return false;
    }
    const str = (k: string): string | null =>
      typeof body[k] === 'string' ? body[k] : null;
    const merchantCode = str('merchantCode');
    const amount = str('amount');
    const merchantOrderId = str('merchantOrderId');
    const signature = str('signature');
    if (!merchantCode || !amount || !merchantOrderId || !signature)
      return false;
    if (merchantCode !== cfg.merchantCode) return false;
    return safeEqualHex(
      signature,
      duitkuCallbackSignature(
        merchantCode,
        amount,
        merchantOrderId,
        cfg.apiKey,
      ),
    );
  }

  private async post<T>(
    cfg: DuitkuConfig,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const url = `${DUITKU_POP_BASE[cfg.env]}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DUITKU_TIMEOUT_MS);
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': 'hoshi-backend/1.0',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout ${DUITKU_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`Duitku POST ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException(
        `Duitku ${path} tidak dapat dihubungi (${detail}).`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) {
      const snippet = text.slice(0, ERROR_BODY_MAX);
      this.logger.error(`Duitku POST ${path} → HTTP ${res.status}: ${snippet}`);
      throw new ServiceUnavailableException(
        `Duitku ${path} menjawab HTTP ${res.status}.`,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      this.logger.error(`Duitku POST ${path} → body bukan JSON yang valid`);
      throw new ServiceUnavailableException(
        `Duitku ${path} mengembalikan respons non-JSON.`,
      );
    }
  }
}
