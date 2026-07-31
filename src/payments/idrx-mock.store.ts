import { Injectable } from '@nestjs/common';

/**
 * State in-memory untuk IDRX MOCK (staging/devnet demo). BUKAN untuk produksi.
 *
 * Menyimpan order yang "diterbitkan" mock mint-request + himpunan order yang sudah "dibayar"
 * lewat halaman bayar palsu. Versi-mock dari findMintByMerchantOrderId membaca ini untuk
 * memutuskan WAITING vs PAID+MINTED — jadi ilusi "pencet Bayar = lunas" tetap benar
 * (reconciler tidak akan memenuhi order sebelum tombol ditekan).
 *
 * In-memory memang cukup untuk satu instance staging yang hangat. Kalau instance tidur/
 * restart di antara create dan bayar, order lama hilang → user tinggal order lagi (gratis,
 * devnet). Tidak ada uang nyata yang bergerak, jadi kehilangan state ini tak berbahaya.
 */
export interface IdrxMockOrder {
  destinationWalletAddress: string;
  toBeMinted: string;
  returnUrl: string;
  createdAt: number;
}

@Injectable()
export class IdrxMockStore {
  private readonly orders = new Map<string, IdrxMockOrder>();
  /** merchantOrderId → epoch ms saat tombol "Bayar" ditekan. */
  private readonly paidAt = new Map<string, number>();

  /** Batasi pertumbuhan memori: buang yang terlama saat melewati ambang. */
  private static readonly MAX = 500;

  /**
   * SETTLE INSTAN (0 ms). Dulu 2500 ms untuk meniru jeda mint async IDRX asli, TAPI itu
   * justru MENGALAHKAN fulfil-segera di pay/complete: `complete` menandai paidAt lalu SEGERA
   * memanggil handleCallback (t≈0 ms) yang butuh MINTED — dengan jeda 2,5 dtk order belum
   * settle, jadi fulfil-nya gagal dan order menggantung menunggu poll frontend. Di instance
   * Render efemeral, kalau restart/sleep terjadi di jendela itu, `paidAt` in-memory HILANG →
   * isSettled tak pernah true → order STUCK "menunggu konfirmasi" selamanya (reconciler pun
   * butuh MINTED yang tak akan datang). Dengan 0, isSettled langsung true → handleCallback
   * memenuhi order SINKRON sebelum redirect → order sudah FULFILLED (durable di DB) saat user
   * kembali → tak ada jendela stuck. (Alur asli tetap async: hanya MOCK yang instan.)
   */
  static readonly SETTLE_DELAY_MS = 0;

  remember(
    merchantOrderId: string,
    order: Omit<IdrxMockOrder, 'createdAt'>,
  ): void {
    if (this.orders.size >= IdrxMockStore.MAX) {
      const oldest = this.orders.keys().next().value;
      if (oldest !== undefined) {
        this.orders.delete(oldest);
        this.paidAt.delete(oldest);
      }
    }
    this.orders.set(merchantOrderId, { ...order, createdAt: Date.now() });
  }

  get(merchantOrderId: string): IdrxMockOrder | undefined {
    return this.orders.get(merchantOrderId);
  }

  /** Tandai pembayaran masuk (tombol "Bayar"). False kalau order tidak dikenal (mis. restart). */
  markPaid(merchantOrderId: string): boolean {
    if (!this.orders.has(merchantOrderId)) return false;
    if (!this.paidAt.has(merchantOrderId)) {
      this.paidAt.set(merchantOrderId, Date.now());
    }
    return true;
  }

  /** User SUDAH bayar (pembayaran masuk) — tapi mint belum tentu settle. */
  isPaid(merchantOrderId: string): boolean {
    return this.paidAt.has(merchantOrderId);
  }

  /** Mint sudah SETTLE (lewat jeda simulasi) → baru boleh MINTED, seperti IDRX asli. */
  isSettled(merchantOrderId: string): boolean {
    const t = this.paidAt.get(merchantOrderId);
    return t !== undefined && Date.now() - t >= IdrxMockStore.SETTLE_DELAY_MS;
  }
}
