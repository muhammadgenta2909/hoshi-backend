import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DUITKU_TX_NOT_FOUND,
  DuitkuClient,
  type DuitkuTransactionStatus,
} from './duitku.client';
import { IdrxClient } from './idrx.client';
import type {
  IdrxMintRequestInput,
  IdrxMintRequestResponse,
  IdrxRatesResponse,
  IdrxTransactionRecord,
} from './idrx.types';

/**
 * Awalan nomor order Duitku. Nomor order IDRX berupa angka murni (mis. 20261009021827) dan nomor
 * mock IDRX berawalan "MOCK-", jadi "DK" tidak bisa bertabrakan dengan keduanya.
 *
 * Inilah yang membuat perpindahan rel aman di tengah jalan: verifikasi memilih rel dari NOMOR
 * ORDER-nya, bukan dari saklar yang sedang menyala. Order IDRX yang masih menggantung saat saklar
 * dipindah ke Duitku tetap diverifikasi ke IDRX, dan sebaliknya.
 */
export const DUITKU_ORDER_PREFIX = 'DK';

export const isDuitkuOrderId = (merchantOrderId: string): boolean =>
  merchantOrderId.startsWith(DUITKU_ORDER_PREFIX);

/** "DK" + ms epoch + 8 hex acak: 23 karakter, jauh di bawah batas Duitku (50). */
export const newDuitkuOrderId = (now: number = Date.now()): string =>
  `${DUITKU_ORDER_PREFIX}${now}${randomBytes(4).toString('hex')}`;

export type PaymentProvider = 'idrx' | 'duitku';

/**
 * Status Duitku → bentuk catatan yang sudah dimengerti jalur verifikasi.
 *
 * Dipetakan ke kosakata IDRX (`PAID`+`MINTED`, `WAITING_FOR_PAYMENT`, `EXPIRED`) supaya SELURUH
 * pengaman yang sudah teruji — klaim atomik, utang refund, balapan callback vs kedaluwarsa —
 * berlaku untuk Duitku tanpa ditulis ulang. Yang TIDAK dipinjam adalah pin-nya: catatan ini
 * bertanda `rail: 'DUITKU'`, dan `assertRecordMatchesOrder` memakai pin khusus fiat.
 *
 * Kode yang tidak dikenal jatuh ke MENUNGGU, bukan ke LUNAS dan bukan ke KEDALUWARSA: dua-duanya
 * keputusan uang yang tidak boleh diambil dari kode yang tidak kita mengerti.
 */
export function duitkuStatusToRecord(
  status: DuitkuTransactionStatus,
): IdrxTransactionRecord {
  const paid = status.statusCode === '00';
  const expired = status.statusCode === '02';
  return {
    id: status.reference ?? status.merchantOrderId,
    merchantOrderId: status.merchantOrderId,
    paymentStatus: paid ? 'PAID' : expired ? 'EXPIRED' : 'WAITING_FOR_PAYMENT',
    userMintStatus: paid ? 'MINTED' : 'NOT_AVAILABLE',
    toBeMinted: status.amount,
    paymentAmount: status.amount,
    rail: 'DUITKU',
  };
}

/**
 * Kelonggaran sesudah `expiresAt` order sebelum tagihan Duitku yang TIDAK PERNAH DIBUKA dianggap
 * kedaluwarsa. Kita mengirim expiryPeriod yang sama ke Duitku, jadi sesudah itu halaman bayarnya
 * sudah mati; kelonggaran ini cuma menyerap selisih jam antara server kita dan Duitku.
 */
export const DUITKU_NOT_OPENED_GRACE_MS = 15 * 60 * 1000;

/**
 * Tagihan yang belum pernah dibuka pembeli → catatan verifikasi.
 *
 * Belum ada transaksi = belum ada satu rupiah pun yang bisa masuk. Selama tenggat order belum
 * lewat (+ kelonggaran) ia MENUNGGU; sesudahnya KEDALUWARSA, supaya order-nya berhenti dipoll dan
 * redemption ongkir yang dikuncinya dilepas. Order TANPA tenggat tidak pernah dikedaluwarsakan dari
 * sini — itu keputusan yang tidak boleh diambil tanpa angka.
 *
 * Kalau ternyata ada pembayaran sesudahnya (seharusnya mustahil), sapuan EXPIRED tetap bertanya
 * ulang ke Duitku dan settleExpiredButPaid MENCATAT UTANGNYA — tidak ada uang yang hilang diam-diam.
 */
export function duitkuNotOpenedRecord(
  merchantOrderId: string,
  expiresAt: Date | null | undefined,
  now: number = Date.now(),
): IdrxTransactionRecord {
  const expired =
    expiresAt instanceof Date &&
    now > expiresAt.getTime() + DUITKU_NOT_OPENED_GRACE_MS;
  return {
    id: merchantOrderId,
    merchantOrderId,
    paymentStatus: expired ? 'EXPIRED' : 'WAITING_FOR_PAYMENT',
    userMintStatus: 'NOT_AVAILABLE',
    toBeMinted: '0',
    paymentAmount: '0',
    rail: 'DUITKU',
  };
}

/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SATU PINTU UNTUK DUA REL — DENGAN BENTUK YANG SAMA PERSIS DENGAN IdrxClient.               ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * PaymentsService memanggil tepat tiga hal dari rel pembayarannya: terbitkan tagihan, ambil bukti,
 * dan kurs. Kelas ini menyediakan ketiganya dengan tanda tangan yang identik dengan IdrxClient,
 * jadi enam titik penerbitan tagihan dan dua titik pengambilan bukti di service TIDAK diubah satu
 * baris pun. Setiap pengaman uang di sana tetap berlaku apa adanya.
 *
 *   - Tagihan BARU mengikuti saklar PAYMENT_PROVIDER (bawaan: idrx — produksi tidak berubah
 *     sampai saklar ini dinyalakan dengan sengaja).
 *   - Bukti mengikuti NOMOR ORDER-nya (lihat DUITKU_ORDER_PREFIX), bukan saklar.
 *   - Kurs selalu dari IDRX: itu cuma membaca harga, tidak terkena name matching, dan treasury
 *     memang belanja dalam USDC.
 */
@Injectable()
export class PaymentGateway {
  private readonly logger = new Logger(PaymentGateway.name);

  constructor(
    private readonly idrx: IdrxClient,
    private readonly duitku: DuitkuClient,
    private readonly config: ConfigService,
  ) {}

  provider(): PaymentProvider {
    const raw = (this.config.get<string>('PAYMENT_PROVIDER') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'duitku' ? 'duitku' : 'idrx';
  }

  async mintRequest(
    input: IdrxMintRequestInput,
  ): Promise<IdrxMintRequestResponse> {
    if (this.provider() !== 'duitku') return this.idrx.mintRequest(input);

    // Alur "QRIS langsung" milik IDRX tidak punya padanan di halaman bayar Duitku. Frontend Hoshi
    // memang tidak pernah memakainya (selalu HOSTED), jadi menolak di sini lebih jujur daripada
    // diam-diam menerbitkan halaman bayar untuk pemanggil yang menunggu string QR.
    if (input.paymentMethod) {
      throw new BadRequestException(
        'Metode bayar langsung tidak tersedia. Gunakan halaman pembayaran.',
      );
    }
    const paymentAmount = Number(input.toBeMinted);
    const merchantOrderId = newDuitkuOrderId();
    const invoice = await this.duitku.createInvoice({
      paymentAmount,
      merchantOrderId,
      productDetails: input.productDetails ?? 'Hoshimarket',
      returnUrl: input.returnUrl,
      expiryPeriod: input.expiryPeriod,
    });
    this.logger.log(
      `Tagihan Duitku ${merchantOrderId} terbit: Rp ${paymentAmount} (ref ${invoice.reference}).`,
    );
    return {
      statusCode: 200,
      message: 'success',
      data: {
        merchantOrderId,
        merchantCode: this.duitku.readConfig().merchantCode,
        reference: invoice.reference,
        paymentUrl: invoice.paymentUrl,
        // Nominal TAGIHAN. Duitku memotong biayanya di sisi settlement ke rekening PT, bukan dari
        // angka ini — beda dengan IDRX, yang `amount`-nya sudah dikurangi biaya.
        amount: paymentAmount,
        statusCode: '00',
        statusMessage: 'SUCCESS',
      },
    };
  }

  /**
   * `expiresAt` hanya dipakai rel Duitku, untuk tagihan yang belum pernah dibuka (lihat
   * duitkuNotOpenedRecord). Tidak diisi → tagihan itu selalu MENUNGGU, tidak pernah dikedaluwarsakan.
   */
  async findMintByMerchantOrderId(
    merchantOrderId: string,
    expiresAt?: Date | null,
  ): Promise<IdrxTransactionRecord | null> {
    if (!isDuitkuOrderId(merchantOrderId)) {
      return this.idrx.findMintByMerchantOrderId(merchantOrderId);
    }
    const status = await this.duitku.transactionStatus(merchantOrderId);
    if (status === DUITKU_TX_NOT_FOUND) {
      return duitkuNotOpenedRecord(merchantOrderId, expiresAt);
    }
    return status ? duitkuStatusToRecord(status) : null;
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ BISAKAH PEMBELI SUNGGUHAN MEMBAYAR SEKARANG?                                           ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Dijawab di SERVER supaya frontend tidak perlu dideploy ulang di hari Duitku dinyalakan:
   * mengisi env di droplet lalu restart sudah cukup untuk membuka tombol bayar di seluruh situs.
   *
   *   - IDRX (bawaan) → TERTUTUP. IDRX mewajibkan nama pembayar = nama pemilik akun IDRX (PT), jadi
   *     tidak satu pun pembeli bisa melunasi QR-nya. Menerbitkan QR yang pasti gagal dibayar lebih
   *     buruk daripada berkata jujur bahwa pembayaran online belum dibuka.
   *     Pengecualian satu-satunya: IDRX MOCK di mesin non-produksi, supaya alur demo tetap jalan.
   *   - Duitku → TERBUKA hanya kalau konfigurasinya lengkap DAN sah untuk mesin ini (readConfig
   *     yang sama yang dipakai saat menagih — termasuk penolakan sandbox di produksi). Saklar yang
   *     menyala dengan kredensial kurang tidak boleh membuka tombol yang lalu gagal 503.
   */
  buyerCheckoutStatus(): {
    provider: 'IDRX' | 'DUITKU';
    buyerCheckoutOpen: boolean;
  } {
    if (this.provider() === 'duitku') {
      try {
        this.duitku.readConfig();
        return { provider: 'DUITKU', buyerCheckoutOpen: true };
      } catch {
        return { provider: 'DUITKU', buyerCheckoutOpen: false };
      }
    }
    return { provider: 'IDRX', buyerCheckoutOpen: this.idrx.mockEnabled() };
  }

  /** Callback Duitku bertanda tangan sah? Lihat DuitkuClient.isCallbackSignatureValid. */
  isDuitkuCallbackValid(body: Record<string, unknown>): boolean {
    return this.duitku.isCallbackSignatureValid(body);
  }

  rates(usdtAmount: string, chainId?: string): Promise<IdrxRatesResponse> {
    return this.idrx.rates(usdtAmount, chainId);
  }
}
