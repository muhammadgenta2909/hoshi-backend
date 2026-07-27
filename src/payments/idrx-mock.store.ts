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
  private readonly paid = new Set<string>();

  /** Batasi pertumbuhan memori: buang yang terlama saat melewati ambang. */
  private static readonly MAX = 500;

  remember(
    merchantOrderId: string,
    order: Omit<IdrxMockOrder, 'createdAt'>,
  ): void {
    if (this.orders.size >= IdrxMockStore.MAX) {
      const oldest = this.orders.keys().next().value;
      if (oldest !== undefined) {
        this.orders.delete(oldest);
        this.paid.delete(oldest);
      }
    }
    this.orders.set(merchantOrderId, { ...order, createdAt: Date.now() });
  }

  get(merchantOrderId: string): IdrxMockOrder | undefined {
    return this.orders.get(merchantOrderId);
  }

  /** Tandai lunas. False kalau order-nya tidak dikenal (mis. instance sudah restart). */
  markPaid(merchantOrderId: string): boolean {
    if (!this.orders.has(merchantOrderId)) return false;
    this.paid.add(merchantOrderId);
    return true;
  }

  isPaid(merchantOrderId: string): boolean {
    return this.paid.has(merchantOrderId);
  }
}
