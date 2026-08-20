import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  ActivityType,
  CcPackStatus,
  ListingStatus,
  Prisma,
  RedemptionStatus,
} from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import {
  CcShippingService,
  type FundAndPrepareResult,
} from '../collectorcrypt/cc-shipping.service';
import { PaymentsService } from '../payments/payments.service';
import { RequestRedemptionDto } from './dto/request-redemption.dto';

export type CardRedemptionDto = {
  id: string;
  nftAddress: string;
  cardName: string;
  cardImage: string | null;
  cardSet: string | null;
  recipientName: string;
  city: string;
  country: string;
  status: RedemptionStatus;
  createdAt: Date;
};

/** Status yang masih "aktif" (kartu dianggap sedang diproses kirim) — blok request dobel. */
const ACTIVE_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PACKING,
  RedemptionStatus.SHIPPED,
];

function toDto(r: CardRedemption): CardRedemptionDto {
  return {
    id: r.id,
    nftAddress: r.nftAddress,
    cardName: r.cardName,
    cardImage: r.cardImage,
    cardSet: r.cardSet,
    recipientName: r.recipientName,
    city: r.city,
    country: r.country,
    status: r.status,
    createdAt: r.createdAt,
  };
}

/**
 * Redeem kartu vault → kirim fisik ke rumah.
 *
 * RECORD-ONLY (MVP): mencatat permintaan + tujuan kirim dan menulis satu baris feed
 * `SEND_TO_HOME`. TIDAK burn NFT, TIDAK transfer aset, TIDAK menyentuh treasury/on-chain —
 * pemenuhan fisik ditangani admin manual. (Kalau nanti ada yang menambah burnV1/transferV1 di
 * sini, itu memindahkan/menghancurkan aset on-chain nyata — JANGAN, kecuali diarmed sadar.)
 */
@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ccShipping: CcShippingService,
    private readonly payments: PaymentsService,
  ) {}

  async request(
    dto: RequestRedemptionDto,
    user: AuthUser,
  ): Promise<CardRedemptionDto> {
    // 1. Kepemilikan lewat LEDGER, bukan klaim klien. DUA sumber kartu vault yang sah:
    //    (a) hasil PACK yang OPENED (ccPackPurchase), atau
    //    (b) kartu yang DIBELI user di marketplace (Listing SOLD, buyerId = user).
    //    Keduanya mewakili kartu fisik di vault CC → boleh diminta kirim. Info kartu (nama/gambar/
    //    set) diambil dari sumber yang cocok, bukan dari body.
    let cardName = 'Kartu';
    let cardImage: string | null = null;
    let cardSet: string | null = null;
    // ASAL kartu → petunjuk siapa yang kirim fisik. PACK/CC_CATALOG/P2P fisiknya di gudang CC (CC
    // kirim); HOSHI = stok fisik Hoshi sendiri (Hoshi kirim). Di-snapshot saat request.
    let source = 'PACK';

    const pull = await this.prisma.ccPackPurchase.findFirst({
      where: {
        userId: user.id,
        nftAddress: dto.nftAddress,
        status: CcPackStatus.OPENED,
      },
    });
    if (pull) {
      cardName = pull.ccItemName ?? pull.nftName ?? 'Kartu';
      cardImage = pull.nftImage ?? null;
      cardSet = pull.ccSet ?? pull.ccCategory ?? null;
      source = 'PACK';
    } else {
      const bought = await this.prisma.listing.findFirst({
        where: {
          buyerId: user.id,
          status: ListingStatus.SOLD,
          OR: [
            { ccNftAddress: dto.nftAddress },
            { nft: { assetAddress: dto.nftAddress } },
          ],
        },
      });
      if (!bought) {
        this.logger.warn(
          `Redeem ditolak: NFT ${dto.nftAddress} bukan pack/pembelian user ${user.id}.`,
        );
        throw new ForbiddenException(
          'Kartu ini bukan milikmu di Hoshi (bukan hasil pack maupun pembelian).',
        );
      }
      cardName = bought.name;
      cardImage = bought.image ?? null;
      cardSet = bought.set ?? bought.category ?? null;
      // Beli dari user lain (sellerId ada) = P2P; katalog CC (source CC, tanpa penjual) = CC_CATALOG;
      // selain itu (source HOSHI) = stok fisik Hoshi sendiri.
      source =
        bought.sellerId != null
          ? 'P2P'
          : bought.source === 'COLLECTORCRYPT'
            ? 'CC_CATALOG'
            : 'HOSHI';
    }

    // 2. Alamat tujuan harus milik user.
    const addr = await this.prisma.shippingAddress.findFirst({
      where: { id: dto.shippingAddressId, userId: user.id },
    });
    if (!addr) {
      throw new BadRequestException(
        'Alamat pengiriman tidak ditemukan. Tambahkan alamat dulu di Settings.',
      );
    }

    // 3. Anti-dobel: satu kartu tidak boleh punya dua permintaan kirim yang masih aktif.
    const active = await this.prisma.cardRedemption.findFirst({
      where: {
        userId: user.id,
        nftAddress: dto.nftAddress,
        status: { in: ACTIVE_STATUSES },
      },
    });
    if (active) {
      throw new BadRequestException(
        'Kartu ini sudah dalam proses pengiriman fisik.',
      );
    }

    // 4. Record + activity dalam SATU transaksi. NOL burn/transfer — murni catatan.
    //    Gerbang anti-dobel yang SEBENARNYA = partial unique index (nftAddress WHERE status aktif)
    //    di DB. Pre-check langkah 3 di atas cuma jalur cepat untuk error ramah di kasus berurutan;
    //    dua request PARALEL yang lolos pre-check kalah di sini (P2002) → tetap ditolak dengan pesan
    //    yang sama. Tanpa constraint DB ini, cek aplikasi TOCTOU bisa menghasilkan dobel-kirim fisik.
    let created: CardRedemption;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.cardRedemption.create({
          data: {
            userId: user.id,
            nftAddress: dto.nftAddress,
            cardName,
            cardImage,
            cardSet,
            source,
            shippingAddressId: addr.id,
            recipientName: addr.fullName,
            country: addr.country,
            street: addr.street,
            apt: addr.apt,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            phoneCountryCode: addr.phoneCountryCode,
            phoneNumber: addr.phoneNumber,
            status: RedemptionStatus.REQUESTED,
          },
        });
        await tx.activity.create({
          data: {
            type: ActivityType.SEND_TO_HOME,
            itemName: cardName,
            itemImage: cardImage,
            category: cardSet,
            set: cardSet,
            amount: null, // tak ada nominal uang
            fromId: user.id,
            fromLabel: user.displayName ?? user.walletAddress,
            toLabel: addr.city,
          },
        });
        return row;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          'Kartu ini sudah dalam proses pengiriman fisik.',
        );
      }
      throw err;
    }

    this.logger.log(
      `Redemption ${created.id} REQUESTED: NFT ${dto.nftAddress} → ${addr.city} ` +
        `(user ${user.id}). RECORD-ONLY — tidak ada burn/transfer.`,
    );
    return toDto(created);
  }

  async listMine(userId: string): Promise<CardRedemptionDto[]> {
    const rows = await this.prisma.cardRedemption.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toDto);
  }

  /* ---------------------- Jalur REAL (CC Vault Shipping) ---------------------- */
  /* Semua di bawah DIGERBANG HOSHI_CC_SHIPPING_ENABLED di dalam CcShippingService.assertEnabled();
     kalau mati, mereka menolak dan perilaku record-only di atas tidak berubah sama sekali. */

  /**
   * Taksiran ongkir (READ-ONLY) untuk redemption ini: USD + USDC base unit + Rupiah. Rupiah dihitung
   * lewat PaymentsService.quoteRupiah — SUMBER HARGA yang sama dengan invoice ongkir (createShippingOrder)
   * — supaya angka yang dilihat user dan yang ditagihkan tidak lahir dari dua kalkulasi berbeda.
   */
  async estimate(
    id: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<{ usd: number; usdcBaseUnits: number; rupiah: number }> {
    const est = await this.ccShipping.estimateForRedemption(
      id,
      user,
      privyToken,
    );
    const rupiah = await this.payments.quoteRupiah(est.usdcBaseUnits);
    return { usd: est.usd, usdcBaseUnits: est.usdcBaseUnits, rupiah };
  }

  /** Danai USDC ongkir ke wallet user + bangun transaksi burn UNSIGNED (money-critical, di CcShippingService). */
  fundAndPrepare(
    id: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<FundAndPrepareResult> {
    return this.ccShipping.fundAndPrepare(id, user, privyToken);
  }

  /** Teruskan transaksi burn+ship yang sudah ditandatangani user ke CC. */
  submitBurn(
    id: string,
    user: AuthUser,
    privyToken: string,
    signedTransactions: string[],
  ): Promise<{ status: RedemptionStatus; burnSignature: string | null }> {
    return this.ccShipping.submitBurn(id, user, privyToken, signedTransactions);
  }

  /** Poll status shipment CC → petakan ke status Hoshi + tracking. */
  async status(
    id: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<CardRedemptionDto & { trackingIds: string[]; trackingUrls: string[] }> {
    const row = await this.ccShipping.refreshStatus(id, user, privyToken);
    return {
      ...toDto(row),
      trackingIds: row.trackingIds,
      trackingUrls: row.trackingUrls,
    };
  }
}
