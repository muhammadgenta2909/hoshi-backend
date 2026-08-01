import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CcBuyClient } from './cc-buy.client';
import { CcMarketClient } from './cc-market.client';
import { TreasuryService } from './treasury.service';
import { assertCcBuyTxMatchesQuote } from './cc-buy.verify';

/** USDC 6 desimal. */
const USDC_UNITS = 1_000_000;

/**
 * Kegagalan SETELAH treasury sudah membeli kartu (USDC keluar, NFT ada di treasury) tetapi
 * transfer ke pembeli belum tuntas. Ditangani KHUSUS oleh pemanggil: JANGAN refund — uang
 * sudah keluar dan kartu secara ekonomi sudah milik pembeli; yang kurang cuma pengiriman,
 * jadi tandai untuk kirim-ulang manual (bukan refund yang malah melipatgandakan kerugian).
 */
export class ResellerPostBuyError extends Error {
  constructor(
    message: string,
    readonly buySignature: string,
    readonly nftAddress: string,
  ) {
    super(message);
    this.name = 'ResellerPostBuyError';
  }
}

export type ResellerSettleResult = {
  buySignature: string;
  transferSignature: string;
  priceUsdc: number;
};

/**
 * Settlement REAL jalur reseller CollectorCrypt. Satu-satunya pintu yang membuat treasury
 * benar-benar MEMBELANJAKAN USDC untuk membeli kartu katalog CC lalu mengirim NFT-nya ke
 * pembeli. Hidup DI DALAM CollectorCryptModule justru karena butuh TreasuryService
 * (private key) — mengikuti pola yang sama dengan GachaService.
 *
 * GERBANG belanja ada di PEMANGGIL (PaymentsService.fulfilListing, cek HOSHI_CC_RESELL_ENABLED
 * + bukan mock). Service ini mengasumsikan sudah sah untuk belanja; tugasnya benar & aman.
 */
@Injectable()
export class ResellerSettlementService {
  private readonly logger = new Logger(ResellerSettlementService.name);

  constructor(
    private readonly buyClient: CcBuyClient,
    private readonly marketClient: CcMarketClient,
    private readonly treasury: TreasuryService,
  ) {}

  /**
   * @param maxPriceUsdcBaseUnits plafon (snapshot saat order dibuat). Kalau harga LIVE CC
   *        melebihi ini → tolak SEBELUM beli (jangan belanja di atas yang pembeli bayar).
   *
   * BATAS KEGAGALAN KRITIS:
   *  - throw SEBELUM broadcast beli (kutip/build/verify/sign) → belum ada USDC keluar →
   *    pemanggil boleh refund aman (BadRequestException dll).
   *  - throw SESUDAH broadcast beli (transfer gagal) → USDC SUDAH keluar & NFT di treasury →
   *    ResellerPostBuyError; pemanggil JANGAN refund, tandai kirim-ulang manual.
   */
  async settle(params: {
    nftAddress: string;
    buyerWallet: string;
    maxPriceUsdcBaseUnits: number;
  }): Promise<ResellerSettleResult> {
    const treasuryWallet = this.treasury.publicKey;

    // 1. Kutip LIVE — harga di DB cuma snapshot sync dan tidak boleh dipercaya di sini.
    const found = await this.marketClient.browse({
      search: params.nftAddress,
      step: 1,
    });
    const card = found.filterNFtCard?.[0];
    if (!card || card.nftAddress !== params.nftAddress)
      throw new BadRequestException(
        'Kartu tidak ditemukan lagi di katalog CollectorCrypt.',
      );
    const ccListing = card.listing;
    if (!ccListing)
      throw new BadRequestException(
        'Kartu ini sedang tidak dijual di CollectorCrypt.',
      );
    if (String(ccListing.marketplace ?? '').toUpperCase() !== 'CC')
      throw new BadRequestException(
        'Kartu ini dijual di marketplace lain (bukan CollectorCrypt).',
      );
    if (String(ccListing.currency ?? '').toUpperCase() !== 'USDC')
      throw new BadRequestException('Listing CollectorCrypt bukan dalam USDC.');
    const priceUsdc = Number(ccListing.price);
    if (!Number.isFinite(priceUsdc) || priceUsdc <= 0)
      throw new BadRequestException('Harga listing CollectorCrypt tidak valid.');
    const sellerWallet = card.owner?.wallet;
    if (!sellerWallet)
      throw new BadRequestException('Penjual CollectorCrypt tidak diketahui.');

    // 2. Plafon: harga live tidak boleh melebihi yang pembeli bayar (snapshot order).
    const priceBaseUnits = Math.round(priceUsdc * USDC_UNITS);
    if (priceBaseUnits > params.maxPriceUsdcBaseUnits) {
      this.logger.warn(
        `Reseller tolak: harga live CC ${priceBaseUnits} > plafon order ` +
          `${params.maxPriceUsdcBaseUnits} (USDC base unit).`,
      );
      throw new BadRequestException(
        'Harga kartu di CollectorCrypt naik melebihi yang dibayar — pembelian dibatalkan.',
      );
    }

    // 3. Bangun tx beli dengan feePayer = TREASURY, lalu verifikasi nominal/penjual/program.
    const built = await this.buyClient.buildBuyTx({
      wallet: treasuryWallet,
      nftAddress: params.nftAddress,
      price: priceUsdc,
    });
    if (built.fundingSource !== 'wallet' || built.transactions.length !== 1)
      throw new BadRequestException(
        'CollectorCrypt mengembalikan alur escrow yang belum didukung.',
      );
    const serialized = built.transactions[0];
    assertCcBuyTxMatchesQuote(serialized, {
      feePayerWallet: treasuryWallet,
      sellerWallet,
      priceUsdc,
    });

    // 4. Treasury tanda tangan. Throw SEBELUM broadcast = BELUM ada USDC keluar → pemanggil
    //    boleh refund aman. (Semua langkah 1–4 di atas juga pre-belanja.)
    const signed = this.treasury.sign(serialized);

    // 5. Broadcast beli — BATAS BELANJA. Kegagalannya INDETERMINATE: CC bisa saja SUDAH
    //    menyiarkan tx on-chain (USDC keluar) lalu respons HTTP-nya hilang/timeout/5xx. Maka
    //    throw di sini WAJIB diperlakukan POST-BUY (JANGAN auto-refund; cek on-chain dulu),
    //    BUKAN pre-buy. Itulah kenapa broadcast dibungkus try → ResellerPostBuyError.
    let buySignature: string;
    try {
      const buy = await this.buyClient.broadcast({
        wallet: treasuryWallet,
        signedTransaction: signed,
        nftAddress: params.nftAddress,
      });
      buySignature = buy.signature;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Reseller KRITIS: broadcast beli ${params.nftAddress} GAGAL/INDETERMINATE: ${msg}. ` +
          'CC MUNGKIN sudah menyiarkan tx (USDC keluar) — CEK ON-CHAIN sebelum refund/kirim ulang. JANGAN auto-refund.',
      );
      throw new ResellerPostBuyError(
        `broadcast indeterminate: ${msg}`,
        'CEK_ON_CHAIN',
        params.nftAddress,
      );
    }
    this.logger.warn(
      `Reseller: treasury MEMBELI ${params.nftAddress} seharga ${priceUsdc} USDC ` +
        `(sig ${buySignature}). USDC treasury sudah keluar.`,
    );

    // 6. Kirim NFT ke pembeli. Gagal di sini = utang PENGIRIMAN (kirim-ulang manual), BUKAN refund.
    let transferSignature: string;
    try {
      transferSignature = await this.treasury.transferCoreAssetToBuyer({
        assetAddress: params.nftAddress,
        newOwner: params.buyerWallet,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Reseller KRITIS: kartu ${params.nftAddress} SUDAH dibeli treasury (sig ` +
          `${buySignature}) tapi transfer ke pembeli ${params.buyerWallet} GAGAL: ${msg}. ` +
          'Perlu kirim ulang manual — JANGAN refund.',
      );
      throw new ResellerPostBuyError(msg, buySignature, params.nftAddress);
    }

    this.logger.warn(
      `Reseller: NFT ${params.nftAddress} terkirim ke pembeli ${params.buyerWallet} ` +
        `(sig ${transferSignature}).`,
    );
    return { buySignature, transferSignature, priceUsdc };
  }
}
