import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const CC_MARKET_DEFAULT_BASE_URL = 'https://api.collectorcrypt.com';
const CC_BUY_TIMEOUT_MS = 30_000;

/** Hasil build: mode wallet = 1 tx; mode escrow = beberapa tx berurutan. */
export type CcBuyBuildResult = {
  transactions: string[];
  fundingSource: 'wallet' | 'escrow';
};

export type CcBroadcastResult = {
  success: boolean;
  signature: string;
  message?: string;
};

/**
 * Klien HTTP untuk jalur BELI marketplace CollectorCrypt.
 *
 * SENGAJA terpisah dari CcMarketClient: klien itu didokumentasikan read-only &
 * aman di-retry, sedangkan yang ini MEMINDAHKAN UANG. Memisahkannya membuat
 * disiplin retry/idempotensi tidak tercampur.
 *
 * Catatan lapangan (diverifikasi lewat probe langsung ke API CC):
 *  - POST /marketplace/buy menjawab HTTP **201** dengan `Content-Type: text/html`
 *    dan body berupa string base64 TELANJANG (tanpa kutip/envelope). `res.json()`
 *    akan melempar — WAJIB `res.text()`.
 *  - Hanya saat `fundingSource: "escrow"` body-nya JSON `{ transactions[] }`.
 *  - Broadcast memvalidasi transaksi terhadap allow-list program ID (403 kalau
 *    ada program asing) → JANGAN pernah menyisipkan instruksi Hoshi ke tx CC.
 */
@Injectable()
export class CcBuyClient {
  private readonly logger = new Logger(CcBuyClient.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * POST /marketplace/buy — bangun transaksi beli (BELUM ditandatangani).
   *
   * PENTING: `price` yang dikirim TIDAK menentukan nominal on-chain. CC memakai
   * harga listing LIVE mereka saat build. Karena itu pemanggil WAJIB memverifikasi
   * nominal di dalam transaksi sebelum menyodorkannya ke user (lihat CcBuyService).
   */
  async buildBuyTx(params: {
    wallet: string;
    nftAddress: string;
    price: number;
  }): Promise<CcBuyBuildResult> {
    // tokenStandard & sellerWallet SENGAJA tidak dikirim: katalog memberi
    // "core" (huruf kecil) sedangkan endpoint buy mengharapkan "CoreNft", dan
    // probe membuktikan hasilnya identik bila keduanya dihilangkan (CC resolve
    // sendiri via DAS). Mengirim nilai yang salah justru berisiko ditolak.
    const body = {
      wallet: params.wallet,
      nftAddress: params.nftAddress,
      price: params.price,
      currency: 'USDC',
    };

    const { status, text } = await this.post('/marketplace/buy', body);

    if (status === 404)
      throw new NotFoundException(
        'Listing CollectorCrypt tidak ditemukan — kemungkinan sudah tidak dijual.',
      );
    if (status === 409)
      throw new ConflictException(
        'Kartu ini baru saja berpindah tangan di CollectorCrypt. Muat ulang lalu coba lagi.',
      );
    if (status < 200 || status >= 300) {
      this.logger.error(
        `CC buy → HTTP ${status} (${text.slice(0, 200)})`,
      );
      throw new BadRequestException(
        this.extractMessage(text) ??
          `CollectorCrypt menolak permintaan beli (HTTP ${status}).`,
      );
    }

    const trimmed = text.trim();
    if (!trimmed)
      throw new ServiceUnavailableException(
        'CollectorCrypt mengembalikan transaksi kosong.',
      );

    // Mode escrow → JSON; mode wallet (default) → base64 telanjang.
    if (trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed) as {
          transactions?: string[];
          fundingSource?: string;
        };
        if (!parsed.transactions?.length) throw new Error('no transactions');
        return {
          transactions: parsed.transactions,
          fundingSource: parsed.fundingSource === 'escrow' ? 'escrow' : 'wallet',
        };
      } catch {
        throw new ServiceUnavailableException(
          'Respons beli CollectorCrypt tidak bisa dibaca.',
        );
      }
    }

    return { transactions: [trimmed], fundingSource: 'wallet' };
  }

  /** POST /marketplace/broadcast — kirim transaksi yang sudah ditandatangani. */
  async broadcast(params: {
    wallet: string;
    signedTransaction: string;
    nftAddress?: string;
  }): Promise<CcBroadcastResult> {
    const { status, text } = await this.post('/marketplace/broadcast', {
      wallet: params.wallet,
      signedTransaction: params.signedTransaction,
      ...(params.nftAddress ? { nftAddress: params.nftAddress } : {}),
    });

    if (status < 200 || status >= 300) {
      this.logger.error(`CC broadcast → HTTP ${status} (${text.slice(0, 200)})`);
      // Kasus SOL tidak cukup dikirim sebagai JSON string di dalam `message`.
      const msg = this.extractMessage(text) ?? '';
      if (msg.includes('INSUFFICIENT_FUNDS')) {
        throw new BadRequestException(
          'SOL di wallet tidak cukup untuk biaya jaringan. Isi sedikit SOL lalu ulangi.',
        );
      }
      if (status === 403)
        throw new BadRequestException(
          'Transaksi ditolak CollectorCrypt (program tidak masuk allow-list).',
        );
      throw new BadRequestException(
        msg || `CollectorCrypt gagal menyiarkan transaksi (HTTP ${status}).`,
      );
    }

    try {
      const parsed = JSON.parse(text) as CcBroadcastResult;
      if (!parsed?.signature)
        throw new Error('missing signature');
      return parsed;
    } catch {
      throw new ServiceUnavailableException(
        'CollectorCrypt tidak mengembalikan signature transaksi.',
      );
    }
  }

  /* --- Internal --- */

  baseUrl(): string {
    const base =
      this.config.get<string>('COLLECTORCRYPT_MARKET_BASE_URL') ??
      CC_MARKET_DEFAULT_BASE_URL;
    return base.replace(/\/+$/, '');
  }

  private extractMessage(text: string): string | null {
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message;
      if (Array.isArray(parsed.message)) return parsed.message.join(', ');
    } catch {
      /* body bukan JSON */
    }
    return null;
  }

  private async post(
    path: string,
    body: unknown,
  ): Promise<{ status: number; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CC_BUY_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout ${CC_BUY_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      this.logger.error(`CC POST ${path} → gagal (${detail})`);
      throw new ServiceUnavailableException(
        `CollectorCrypt tidak dapat dihubungi (${detail}).`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
