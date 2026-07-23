import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActivityType, ListingSource, ListingStatus } from '@prisma/client';
import { PublicKey, Transaction } from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/jwt.strategy';
import { CcBuyClient } from './cc-buy.client';
import { CcMarketClient } from './cc-market.client';

/** Program marketplace CollectorCrypt V2 (sama untuk prod & devnet). */
const CC_MARKETPLACE_PROGRAM = 'CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr';
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

/** USDC 6 desimal. */
const USDC_DECIMALS = 1_000_000;

export type CcBuyQuote = {
  listingId: string;
  nftAddress: string;
  /** Harga LIVE CollectorCrypt dalam USDC (dolar utuh) — INI yang akan didebit. */
  priceUsdc: number;
  sellerWallet: string;
  /** Transaksi base64 yang harus ditandatangani wallet pembeli. */
  serializedTransaction: string;
};

/**
 * Pembelian kartu KATALOG CollectorCrypt — diselesaikan DI CC, bukan di Hoshi.
 *
 * Kenapa jalur terpisah dari MarketplaceService.buy(): kartu katalog CC fisiknya
 * ada di custody CC dan masih dijual di collectorcrypt.com. Jalur buy() Hoshi
 * me-MINT NFT baru — dipakai di sini artinya menjual barang yang bukan milik kita
 * dan memberi pembeli NFT palsu. Jadi di sini Hoshi TIDAK PERNAH mint apa pun:
 * kita hanya memfasilitasi transaksi CC, dan aset CC ASLI yang pindah ke wallet
 * pembeli.
 *
 * Model ekonomi: PASS-THROUGH. Pembeli membayar harga USDC CC apa adanya,
 * langsung ke penjual CC. Hoshi tidak mengambil margin on-chain — API CC memang
 * tidak punya field markup, dan broadcast mereka menolak instruksi asing
 * (allow-list program), jadi biaya Hoshi tidak bisa ditempelkan ke transaksi ini.
 */
@Injectable()
export class CcBuyService {
  private readonly logger = new Logger(CcBuyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly buyClient: CcBuyClient,
    private readonly marketClient: CcMarketClient,
  ) {}

  private assertEnabled(): void {
    const on =
      (this.config.get<string>('HOSHI_CC_BUY_ENABLED') ?? '').trim().toLowerCase() ===
      'true';
    if (!on) {
      throw new ForbiddenException(
        'Pembelian kartu CollectorCrypt belum diaktifkan di deployment ini ' +
          '(set HOSHI_CC_BUY_ENABLED=true setelah alurnya diuji).',
      );
    }
  }

  /**
   * Langkah 1 — kutip harga LIVE lalu bangun transaksi, DAN verifikasi nominalnya.
   *
   * Verifikasi itu wajib: field `price` yang kita kirim ke CC TIDAK menentukan
   * nominal on-chain (terbukti lewat probe — kirim price:1 untuk kartu 26 USDC
   * tetap menghasilkan 26_000_000). Tanpa membongkar transaksinya, harga bisa
   * berubah antara kutipan dan tanda tangan dan user membayar diam-diam.
   */
  async prepare(listingId: string, user: AuthUser): Promise<CcBuyQuote> {
    this.assertEnabled();

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        name: true,
        status: true,
        source: true,
        ccNftAddress: true,
      },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');
    if (listing.source !== ListingSource.COLLECTORCRYPT || !listing.ccNftAddress)
      throw new BadRequestException(
        'Jalur ini hanya untuk kartu katalog CollectorCrypt.',
      );
    if (listing.status !== ListingStatus.ACTIVE)
      throw new BadRequestException('Listing sudah tidak aktif.');

    // --- Kutip LIVE. Harga tersimpan di DB kita cuma snapshot saat sync pertama
    //     dan sengaja tidak pernah di-refresh, jadi tidak boleh dipercaya di sini.
    const found = await this.marketClient.browse({
      search: listing.ccNftAddress,
      step: 1,
    });
    const card = found.filterNFtCard?.[0];
    if (!card || card.nftAddress !== listing.ccNftAddress)
      throw new NotFoundException(
        'Kartu tidak ditemukan lagi di katalog CollectorCrypt.',
      );

    const ccListing = card.listing;
    if (!ccListing)
      throw new BadRequestException(
        'Kartu ini sedang tidak dijual di CollectorCrypt.',
      );
    // Listing agregasi Magic Eden ikut muncul di katalog yang sama, tapi TIDAK
    // bisa dibeli lewat /marketplace/buy milik CC.
    if (String(ccListing.marketplace ?? '').toUpperCase() !== 'CC')
      throw new BadRequestException(
        'Kartu ini dijual di marketplace lain (bukan CollectorCrypt), belum didukung.',
      );
    if (String(ccListing.currency ?? '').toUpperCase() !== 'USDC')
      throw new BadRequestException('Listing CollectorCrypt bukan dalam USDC.');

    const priceUsdc = Number(ccListing.price);
    if (!Number.isFinite(priceUsdc) || priceUsdc <= 0)
      throw new BadRequestException('Harga listing CollectorCrypt tidak valid.');

    const sellerWallet = card.owner?.wallet;
    if (!sellerWallet)
      throw new BadRequestException('Penjual CollectorCrypt tidak diketahui.');

    // --- Bangun transaksi.
    const built = await this.buyClient.buildBuyTx({
      wallet: user.walletAddress,
      nftAddress: listing.ccNftAddress,
      price: priceUsdc,
    });
    if (built.fundingSource !== 'wallet' || built.transactions.length !== 1)
      throw new BadRequestException(
        'CollectorCrypt mengembalikan alur escrow yang belum didukung Hoshi.',
      );

    const serialized = built.transactions[0];
    this.assertTransactionMatchesQuote(serialized, {
      buyerWallet: user.walletAddress,
      sellerWallet,
      priceUsdc,
    });

    return {
      listingId: listing.id,
      nftAddress: listing.ccNftAddress,
      priceUsdc,
      sellerWallet,
      serializedTransaction: serialized,
    };
  }

  /**
   * Membongkar transaksi bikinan CC dan menolak apa pun yang tidak sesuai kutipan.
   * FAIL-CLOSED: bentuk yang tidak dikenali = tolak, bukan diloloskan.
   */
  private assertTransactionMatchesQuote(
    base64: string,
    expect: { buyerWallet: string; sellerWallet: string; priceUsdc: number },
  ): void {
    let tx: Transaction;
    try {
      tx = Transaction.from(Buffer.from(base64, 'base64'));
    } catch {
      throw new BadRequestException(
        'Transaksi dari CollectorCrypt tidak bisa dibaca — pembelian dibatalkan.',
      );
    }

    // Pembeli harus jadi fee payer (dia yang menandatangani).
    if (!tx.feePayer || tx.feePayer.toBase58() !== expect.buyerWallet)
      throw new BadRequestException(
        'Transaksi CollectorCrypt tidak ditujukan ke wallet Anda — dibatalkan.',
      );

    // Tidak boleh ada program di luar yang kita harapkan.
    const allowed = new Set([CC_MARKETPLACE_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
    for (const ix of tx.instructions) {
      if (!allowed.has(ix.programId.toBase58()))
        throw new BadRequestException(
          'Transaksi CollectorCrypt memuat program tak dikenal — dibatalkan.',
        );
    }

    const ccIx = tx.instructions.find(
      (i) => i.programId.toBase58() === CC_MARKETPLACE_PROGRAM,
    );
    if (!ccIx)
      throw new BadRequestException(
        'Transaksi CollectorCrypt tidak memuat instruksi marketplace — dibatalkan.',
      );

    // Layout terverifikasi: 8 byte discriminator + u64 LE harga (USDC 6 desimal).
    // Panjang lain = layout tak dikenal → tolak (jangan menebak nominal).
    if (ccIx.data.length !== 16)
      throw new BadRequestException(
        'Format instruksi CollectorCrypt tidak dikenali — pembelian dibatalkan.',
      );

    const onChain = ccIx.data.readBigUInt64LE(8);
    const quoted = BigInt(Math.round(expect.priceUsdc * USDC_DECIMALS));
    if (onChain !== quoted) {
      this.logger.warn(
        `CC buy ditolak: nominal on-chain ${onChain} != kutipan ${quoted}`,
      );
      throw new BadRequestException(
        `Harga di CollectorCrypt berubah (transaksi menagih ` +
          `${Number(onChain) / USDC_DECIMALS} USDC, bukan ${expect.priceUsdc}). ` +
          'Muat ulang halaman untuk harga terbaru.',
      );
    }

    // Penjual yang dikutip harus benar-benar ada di daftar akun transaksi.
    let sellerPk: PublicKey;
    try {
      sellerPk = new PublicKey(expect.sellerWallet);
    } catch {
      throw new BadRequestException('Alamat penjual CollectorCrypt tidak valid.');
    }
    const keys = new Set(ccIx.keys.map((k) => k.pubkey.toBase58()));
    if (!keys.has(sellerPk.toBase58()))
      throw new BadRequestException(
        'Penjual pada transaksi berbeda dari listing — dibatalkan.',
      );
  }

  /**
   * Langkah 2 — siarkan transaksi yang sudah ditandatangani lewat CC.
   *
   * CATATAN: sukses di sini berarti "terkirim ke jaringan", belum tentu final.
   * Hoshi tidak punya RPC mainnet untuk konfirmasi, jadi signature dikembalikan
   * agar bisa ditelusuri di explorer.
   */
  async submit(
    listingId: string,
    user: AuthUser,
    signedTransaction: string,
  ): Promise<{ signature: string; listingId: string }> {
    this.assertEnabled();

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: {
        id: true,
        name: true,
        image: true,
        category: true,
        set: true,
        status: true,
        source: true,
        ccNftAddress: true,
      },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');
    if (listing.source !== ListingSource.COLLECTORCRYPT || !listing.ccNftAddress)
      throw new BadRequestException(
        'Jalur ini hanya untuk kartu katalog CollectorCrypt.',
      );

    const result = await this.buyClient.broadcast({
      wallet: user.walletAddress,
      signedTransaction,
      nftAddress: listing.ccNftAddress,
    });

    this.logger.log(
      `CC buy sukses: listing=${listing.id} nft=${listing.ccNftAddress} sig=${result.signature}`,
    );

    // Kartu sudah berpindah di CC → cerminan katalog kita tidak boleh tetap ACTIVE.
    // Hoshi TIDAK mint NFT apa pun di sini: yang pindah adalah aset CC asli.
    await this.prisma.listing.updateMany({
      where: { id: listing.id, status: ListingStatus.ACTIVE },
      data: {
        status: ListingStatus.SOLD,
        buyerId: user.id,
        soldAt: new Date(),
      },
    });

    // amount sengaja null: kolom Activity.amount bersatuan IDRX, sedangkan
    // pembelian ini dalam USDC — menaruh angka USDC di sana akan salah baca.
    await this.prisma.activity.create({
      data: {
        type: ActivityType.SALE_CARD,
        listingId: listing.id,
        itemName: listing.name,
        itemImage: listing.image,
        category: listing.category,
        set: listing.set,
        amount: null,
        fromLabel: 'CollectorCrypt',
        toId: user.id,
        toLabel: user.walletAddress,
      },
    });

    return { signature: result.signature, listingId: listing.id };
  }
}
