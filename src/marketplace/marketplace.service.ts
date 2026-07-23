import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityType,
  CcPackStatus,
  ListingSource,
  ListingStatus,
  NftStatus,
  OfferStatus,
  Prisma,
} from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { NftService } from '../nft/nft.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { QueryActivityDto } from './dto/query-activity.dto';
import { QueryListingDto, SortKey } from './dto/query-listing.dto';
import { RelistListingDto } from './dto/relist-listing.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { assertDemoOnly } from '../common/demo-mode';
import {
  ActivityDto,
  displayLabel,
  ListingDto,
  OfferDto,
  shortWallet,
  toActivityDto,
  toCardDetailDto,
  toListingDto,
  toOfferDto,
} from './marketplace.serialize';

// Urutan tier (cermin TIER_ORDER frontend); dipakai utk sort "rarity".
const TIER_ORDER = ['Common', 'Rare', 'Epic', 'Legendary', 'Legendary Rare'];
const tierRank = (rarity: string) => {
  const i = TIER_ORDER.indexOf(rarity);
  return i === -1 ? -1 : i;
};

// Edge nilai vs harga (cermin valueDeltaPct frontend): + = EV di atas harga.
type Row = Prisma.ListingGetPayload<{ include: { nft: true } }>;
const valueDelta = (l: Row) =>
  l.priceIdrx > 0 ? (l.expectedValueIdrx - l.priceIdrx) / l.priceIdrx : 0;

const SORTERS: Record<SortKey, (a: Row, b: Row) => number> = {
  newest: (a, b) => b.listedAt.getTime() - a.listedAt.getTime(),
  'price-asc': (a, b) => a.priceIdrx - b.priceIdrx,
  'price-desc': (a, b) => b.priceIdrx - a.priceIdrx,
  rarity: (a, b) => tierRank(b.rarity) - tierRank(a.rarity),
  value: (a, b) => valueDelta(b) - valueDelta(a),
};

/** Kolom user seadanya untuk label From/To — jangan pernah ikut `nonce`. */
const USER_LABEL_SELECT = {
  id: true,
  displayName: true,
  walletAddress: true,
} as const;

/** Listing + seller, cukup untuk merender satu baris tabel offer. */
const OFFER_INCLUDE = {
  listing: {
    select: {
      id: true,
      name: true,
      image: true,
      category: true,
      set: true,
      priceIdrx: true,
      status: true,
      sellerAddress: true,
      seller: { select: USER_LABEL_SELECT },
    },
  },
  buyer: { select: USER_LABEL_SELECT },
} as const;

@Injectable()
export class MarketplaceService {
  private readonly logger = new Logger(MarketplaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nft: NftService,
  ) {}

  /** Listing ACTIVE + filter + sort. Bentuk cocok dgn lib/market.ts frontend. */
  async list(query: QueryListingDto): Promise<ListingDto[]> {
    const where: Prisma.ListingWhereInput = { status: ListingStatus.ACTIVE };
    if (query.set) where.set = query.set;
    if (query.grader) where.grader = query.grader;
    if (query.minGrade != null) where.gradeScore = { gte: query.minGrade };
    if (query.search)
      where.name = { contains: query.search, mode: 'insensitive' };

    const rows = await this.prisma.listing.findMany({
      where,
      include: { nft: true },
    });
    const sorter = SORTERS[query.sort ?? 'newest'];
    rows.sort(sorter);
    return rows.slice(0, query.limit ?? 200).map(toListingDto);
  }

  /** Listing milik user login (semua status, terbaru dulu). */
  async listMine(userId: string): Promise<ListingDto[]> {
    const rows = await this.prisma.listing.findMany({
      where: { sellerId: userId },
      include: { nft: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toListingDto);
  }

  /**
   * Kartu MILIK user login — isi Vault/koleksi. Kepemilikan = buyerId, TANPA
   * filter status: kartu yang owner jual ulang (ACTIVE) atau delist (CANCELLED)
   * tetap miliknya sampai ada yang membeli, jadi harus tetap muncul di Vault.
   */
  async listPurchases(userId: string): Promise<ListingDto[]> {
    const rows = await this.prisma.listing.findMany({
      where: { buyerId: userId },
      include: { nft: true },
      orderBy: { soldAt: 'desc' },
    });
    return rows.map(toListingDto);
  }

  /**
   * Bundel detail satu listing (cermin getCardDetail frontend).
   * READ-ONLY: GET tidak lagi menambah view (dulu `views++` di sini bikin
   * counter membengkak tiap refresh / prefetch / StrictMode double-fetch).
   * Penambahan view dipindah ke `registerView` (POST /:id/view, dedupe per sesi).
   */
  async detail(id: string) {
    const row = await this.prisma.listing.findUnique({
      where: { id },
      include: { nft: true, offerRecords: { orderBy: { createdAt: 'desc' } } },
    });
    if (!row) throw new NotFoundException('Listing not found.');
    const related = await this.prisma.listing.findMany({
      where: { status: ListingStatus.ACTIVE, id: { not: id } },
      include: { nft: true },
      orderBy: { listedAt: 'desc' },
      take: 4,
    });
    return toCardDetailDto(row, related);
  }

  /**
   * Tambah 1 view (atomik). Dipanggil client SEKALI per sesi (dedupe via
   * sessionStorage), jadi refresh/StrictMode tidak menggandakan. Return total baru.
   */
  async registerView(id: string): Promise<{ views: number }> {
    try {
      const row = await this.prisma.listing.update({
        where: { id },
        data: { views: { increment: 1 } },
        select: { views: true },
      });
      return { views: row.views };
    } catch {
      throw new NotFoundException('Listing tidak ditemukan.');
    }
  }

  /**
   * Pembeli mengajukan penawaran. WAJIB login: `buyerId` inilah yang bikin tab
   * "Offers Made"/"Offers Received" bisa menampilkan data nyata (dulu client
   * mengirim string "You", jadi offer tidak tertaut ke siapa pun).
   */
  async submitOffer(
    id: string,
    buyer: AuthUser,
    amount: number,
  ): Promise<OfferDto> {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        image: true,
        category: true,
        set: true,
        status: true,
        source: true,
        sellerId: true,
        sellerAddress: true,
        seller: { select: USER_LABEL_SELECT },
      },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');
    if (listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException('Listing is no longer active.');
    }
    // Sama seperti buy(): hanya kartu KATALOG-SYNC (sellerId null) yang diblokir.
    // Kartu CC hasil pull milik user (sellerId terisi) boleh menerima penawaran.
    if (listing.source === ListingSource.COLLECTORCRYPT && !listing.sellerId) {
      throw new BadRequestException(
        'Kartu katalog CollectorCrypt belum menerima penawaran lewat Hoshi.',
      );
    }
    if (listing.sellerId && listing.sellerId === buyer.id) {
      throw new BadRequestException(
        'Cannot make an offer on your own listing.',
      );
    }

    const buyerLabel = displayLabel(buyer, shortWallet(buyer.walletAddress));
    const offer = await this.prisma.offer.create({
      data: {
        listingId: id,
        buyerId: buyer.id,
        user: buyerLabel,
        amount: Math.round(amount),
      },
      include: OFFER_INCLUDE,
    });

    await this.recordActivity({
      type: ActivityType.OFFER_MADE,
      listing,
      amount: offer.amount,
      fromId: buyer.id,
      fromLabel: buyerLabel,
      toId: listing.sellerId,
      toLabel: displayLabel(listing.seller, listing.sellerAddress),
    });

    return toOfferDto(offer);
  }

  /* ---------------------- offers: profile tabs ---------------------- */

  /** Penawaran yang DIBUAT user ini (tab "Offers Made"). */
  async listOffersMade(userId: string): Promise<OfferDto[]> {
    const rows = await this.prisma.offer.findMany({
      where: { buyerId: userId },
      include: OFFER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toOfferDto);
  }

  /** Penawaran yang MASUK ke listing milik user ini (tab "Offers Received"). */
  async listOffersReceived(userId: string): Promise<OfferDto[]> {
    const rows = await this.prisma.offer.findMany({
      where: { listing: { sellerId: userId } },
      include: OFFER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toOfferDto);
  }

  /** Pembuat offer menarik penawarannya sendiri (PENDING → CANCELED). */
  async cancelOffer(offerId: string, user: AuthUser): Promise<OfferDto> {
    const offer = await this.loadOffer(offerId);
    if (offer.buyerId !== user.id) {
      throw new ForbiddenException('Only the buyer can cancel this offer.');
    }
    const done = await this.prisma.offer.updateMany({
      where: { id: offerId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.CANCELED },
    });
    if (done.count !== 1) {
      throw new BadRequestException('Offer is no longer pending.');
    }

    await this.recordActivity({
      type: ActivityType.OFFER_CANCELED,
      listing: offer.listing,
      // Penawaran yang ditarik tidak punya nominal berlaku → UI render "----".
      amount: null,
      fromId: offer.buyerId,
      fromLabel: offer.user,
      toId: offer.listing.sellerId,
      toLabel: displayLabel(offer.listing.seller, offer.listing.sellerAddress),
    });

    return toOfferDto(await this.loadOffer(offerId));
  }

  /** Penjual menolak penawaran (PENDING → REJECTED). */
  async rejectOffer(offerId: string, user: AuthUser): Promise<OfferDto> {
    const offer = await this.loadOffer(offerId);
    this.assertSeller(offer.listing.sellerId, user);

    const done = await this.prisma.offer.updateMany({
      where: { id: offerId, status: OfferStatus.PENDING },
      data: { status: OfferStatus.REJECTED },
    });
    if (done.count !== 1) {
      throw new BadRequestException('Offer is no longer pending.');
    }

    await this.recordActivity({
      type: ActivityType.OFFER_REJECTED,
      listing: offer.listing,
      amount: null,
      fromId: user.id,
      fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
      toId: offer.buyerId,
      toLabel: offer.user,
    });

    return toOfferDto(await this.loadOffer(offerId));
  }

  /**
   * Penjual menerima penawaran → kartu LANGSUNG terjual seharga offer
   * (mengikuti Collector Crypt: accept = settle seketika pada harga penawaran).
   *
   * Alur ini menggantikan "accept lewat admin": penjual & pembeli menyelesaikan
   * transaksinya sendiri. Sisa offer PENDING pada listing yang sama otomatis
   * ditolak — kartunya cuma satu, offer lain sudah tidak mungkin dipenuhi.
   *
   * TODO(pembayaran): tanpa escrow, penerimaan offer belum menarik dana pembeli.
   */
  async acceptOffer(offerId: string, user: AuthUser): Promise<OfferDto> {
    // Menerima offer memindahkan kartu tanpa settlement, persis seperti buy().
    // Ditaruh DI SINI, bukan di controller: acceptOfferAsAdmin() masuk lewat pintu
    // lain ke metode yang sama, jadi penjagaan di controller akan terlewat.
    assertDemoOnly('Menerima penawaran marketplace');

    const offer = await this.loadOffer(offerId);
    this.assertSeller(offer.listing.sellerId, user);

    if (offer.status !== OfferStatus.PENDING) {
      throw new BadRequestException('Offer is no longer pending.');
    }
    if (!offer.buyerId) {
      throw new BadRequestException(
        'This offer predates wallet-linked offers and cannot be accepted.',
      );
    }
    const buyer = await this.prisma.user.findUnique({
      where: { id: offer.buyerId },
      select: { id: true, walletAddress: true },
    });
    if (!buyer) throw new NotFoundException('Buyer account not found.');

    const listingId = offer.listingId;
    const existing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');

    // Snapshot pra-jual untuk kompensasi kalau mint gagal (lihat buy()).
    const prev = {
      status: existing.status,
      buyerId: existing.buyerId,
      soldAt: existing.soldAt,
      nftId: existing.nftId,
    };

    // Flip ATOMIK ACTIVE→SOLD: hanya satu accept yang menang walau ada race
    // dengan buy() atau accept offer lain pada listing yang sama.
    const sold = await this.prisma.listing.updateMany({
      where: { id: listingId, status: ListingStatus.ACTIVE },
      data: {
        status: ListingStatus.SOLD,
        buyerId: buyer.id,
        soldAt: new Date(),
      },
    });
    if (sold.count !== 1) {
      throw new BadRequestException('Listing already sold / inactive.');
    }

    try {
      await this.mintAndLink(listingId, buyer, prev.nftId);
    } catch (err) {
      await this.prisma.listing.updateMany({
        where: {
          id: listingId,
          status: ListingStatus.SOLD,
          buyerId: buyer.id,
          nftId: prev.nftId,
        },
        data: {
          status: prev.status,
          buyerId: prev.buyerId,
          soldAt: prev.soldAt,
        },
      });
      throw err;
    }

    // Sale sudah settle. Tandai offer diterima & tutup offer lain yang bersaing.
    await this.prisma.$transaction([
      this.prisma.offer.update({
        where: { id: offerId },
        data: { status: OfferStatus.ACCEPTED },
      }),
      this.prisma.offer.updateMany({
        where: {
          listingId,
          status: OfferStatus.PENDING,
          id: { not: offerId },
        },
        data: { status: OfferStatus.REJECTED },
      }),
    ]);

    await this.recordActivity({
      type: ActivityType.SALE_CARD,
      listing: offer.listing,
      amount: offer.amount,
      fromId: user.id,
      fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
      toId: buyer.id,
      toLabel: offer.user,
    });

    return toOfferDto(await this.loadOffer(offerId));
  }

  /**
   * Admin bertindak ATAS NAMA penjual. Bukan jalur utama — penjual & pembeli
   * menyelesaikan sendiri lewat profil — tapi tombol admin harus memakai
   * penyelesaian yang SAMA. Kalau tidak, admin cuma menandai offer ACCEPTED
   * sementara kartunya tidak pernah terjual dan pembeli tidak menerima apa pun.
   */
  async acceptOfferAsAdmin(offerId: string): Promise<OfferDto> {
    return this.acceptOffer(offerId, await this.sellerOf(offerId));
  }

  async rejectOfferAsAdmin(offerId: string): Promise<OfferDto> {
    return this.rejectOffer(offerId, await this.sellerOf(offerId));
  }

  /** Penjual listing di balik sebuah offer, dibentuk jadi AuthUser. */
  private async sellerOf(offerId: string): Promise<AuthUser> {
    const offer = await this.loadOffer(offerId);
    if (!offer.listing.sellerId) {
      throw new BadRequestException(
        'This listing has no seller account, so an offer on it cannot be settled.',
      );
    }
    const seller = await this.prisma.user.findUnique({
      where: { id: offer.listing.sellerId },
      select: { id: true, walletAddress: true, displayName: true, role: true },
    });
    if (!seller) throw new NotFoundException('Seller account not found.');
    return seller;
  }

  private async loadOffer(offerId: string) {
    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: {
        ...OFFER_INCLUDE,
        listing: {
          select: {
            ...OFFER_INCLUDE.listing.select,
            sellerId: true,
          },
        },
      },
    });
    if (!offer) throw new NotFoundException('Offer tidak ditemukan.');
    return offer;
  }

  private assertSeller(sellerId: string | null, user: AuthUser) {
    if (!sellerId || sellerId !== user.id) {
      throw new ForbiddenException('Only the seller can act on this offer.');
    }
  }

  /** User memajang kartu miliknya. sellerId = user login. */
  async create(dto: CreateListingDto, user: AuthUser): Promise<ListingDto> {
    if (dto.cardId) {
      const card = await this.prisma.card.findUnique({
        where: { id: dto.cardId },
      });
      if (!card) throw new NotFoundException('Card not found.');
    }

    // Kartu hasil PACK yang mau dijual: verifikasi user benar-benar memiliki
    // pull-nya (baris CcPackPurchase miliknya, status OPENED), lalu tautkan
    // listing ke NFT aslinya. Ini yang membedakan "jual kartu hasil pull" dari
    // sekadar mengetik kartu baru: listing mewakili aset on-chain yang nyata.
    let source: ListingSource = ListingSource.HOSHI;
    let ccNftAddress: string | undefined;
    if (dto.fromPackMemo) {
      const pack = await this.prisma.ccPackPurchase.findFirst({
        where: {
          memo: dto.fromPackMemo,
          userId: user.id,
          status: CcPackStatus.OPENED,
        },
      });
      if (!pack?.nftAddress) {
        throw new ForbiddenException(
          'Pull tidak ditemukan, belum dibuka, atau bukan milik Anda.',
        );
      }
      // Satu NFT hanya boleh punya satu listing (ccNftAddress @unique). Kalau
      // sudah pernah dipajang: aktif ⇒ tolak; sudah tidak aktif & milik user ⇒
      // pajang ulang (relist) alih-alih menabrak unique index dengan 500.
      const existing = await this.prisma.listing.findUnique({
        where: { ccNftAddress: pack.nftAddress },
      });
      if (existing) {
        if (existing.status === ListingStatus.ACTIVE) {
          throw new ConflictException(
            'Kartu ini sudah dipajang di marketplace.',
          );
        }
        if (existing.sellerId !== user.id) {
          throw new ForbiddenException('Kartu ini bukan milik Anda.');
        }
        const relisted = await this.prisma.listing.update({
          where: { id: existing.id },
          data: {
            status: ListingStatus.ACTIVE,
            priceIdrx: dto.price,
            expectedValueIdrx: dto.expectedValue,
            buybackIdrx: dto.buyback ?? 0,
            buyerId: null,
            soldAt: null,
          },
          include: { nft: true },
        });
        await this.recordActivity({
          type: ActivityType.LISTED_CARD,
          listing: relisted,
          amount: relisted.priceIdrx,
          fromId: user.id,
          fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
          toId: null,
          toLabel: null,
        });
        return toListingDto(relisted);
      }
      source = ListingSource.COLLECTORCRYPT;
      ccNftAddress = pack.nftAddress;
    }

    const row = await this.prisma.listing.create({
      data: {
        name: dto.name,
        set: dto.set,
        rarity: dto.rarity,
        image: dto.image,
        imageBack: dto.imageBack,
        priceIdrx: dto.price,
        expectedValueIdrx: dto.expectedValue,
        buybackIdrx: dto.buyback ?? 0,
        grade: dto.grade,
        grader: dto.grader,
        gradeScore: dto.gradeScore,
        language: dto.language,
        era: dto.era,
        element: dto.element,
        category: dto.category,
        certificate: dto.certificate,
        vaultLocation: dto.vaultLocation,
        cardNumber: dto.cardNumber,
        // On-chain address of the real pulled NFT (falls back to any address the
        // caller supplied for a plain Hoshi listing).
        contractAddress: ccNftAddress ?? dto.contractAddress,
        variant: dto.variant,
        source,
        ccNftAddress,
        priceHistory:
          dto.priceHistory ??
          ([dto.expectedValue, dto.price] satisfies number[]),
        offers: [],
        sellerId: user.id,
        sellerAddress: shortWallet(user.walletAddress),
        cardId: dto.cardId,
      },
      include: { nft: true },
    });

    await this.recordActivity({
      type: ActivityType.LISTED_CARD,
      listing: row,
      amount: row.priceIdrx,
      fromId: user.id,
      fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
      toId: null,
      toLabel: null,
    });

    return toListingDto(row);
  }

  /**
   * Penjual mengubah harga listing yang masih ACTIVE. Aksi tersendiri, bukan
   * cancel + list ulang: `listedAt`, jumlah view, dan offer yang sedang berjalan
   * tetap utuh. Offer lama sengaja TIDAK dibatalkan — pembeli boleh menariknya
   * sendiri kalau harga baru tidak cocok.
   */
  async updateListing(
    id: string,
    dto: UpdateListingDto,
    user: AuthUser,
  ): Promise<ListingDto> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    if (existing.sellerId !== user.id) {
      throw new ForbiddenException('Only the seller can edit this listing.');
    }
    if (existing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException('Only an active listing can be edited.');
    }
    if (
      dto.price === undefined &&
      dto.expectedValue === undefined &&
      dto.buyback === undefined
    ) {
      throw new BadRequestException('Nothing to update.');
    }

    const row = await this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.price !== undefined && { priceIdrx: dto.price }),
        ...(dto.expectedValue !== undefined && {
          expectedValueIdrx: dto.expectedValue,
        }),
        ...(dto.buyback !== undefined && { buybackIdrx: dto.buyback }),
      },
      include: { nft: true },
    });
    return toListingDto(row);
  }

  /**
   * Beli listing. Flip status ATOMIK ACTIVE→SOLD (cermin VaultService.claim):
   * hanya satu request yang menang, cegah double-buy walau ada race/double-click.
   *
   * TODO(pembayaran): settle harga dalam IDRX (escrow) SEBELUM flip status.
   * POC mengasumsikan pembayaran beres, lalu mint NFT ke wallet buyer.
   */
  async buy(id: string, user: AuthUser): Promise<ListingDto> {
    // Lihat TODO(pembayaran) di atas: metode ini me-mint TANPA settlement apa pun.
    // Sah di demo devnet, tapi di mainnet berarti kartu asli bisa diambil gratis
    // oleh siapa pun yang login — dan login itu gratis.
    assertDemoOnly('Pembelian marketplace');

    const existing = await this.prisma.listing.findUnique({
      where: { id },
      include: { seller: { select: USER_LABEL_SELECT } },
    });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    // Blokir HANYA kartu KATALOG-SYNC CollectorCrypt (sellerId null): fisiknya di
    // custody CC, masih dijual di collectorcrypt.com, tanpa mekanisme settlement —
    // membelinya akan me-mint NFT Hoshi palsu & menandai SOLD (jual barang bukan
    // milik kita). Kartu CC yang di-PULL lalu dipajang seorang user (sellerId
    // terisi) MEMANG miliknya untuk dijual, jadi tidak diblokir di sini.
    if (
      existing.source === ListingSource.COLLECTORCRYPT &&
      !existing.sellerId
    ) {
      throw new BadRequestException(
        'Kartu katalog CollectorCrypt belum bisa dibeli lewat Hoshi. ' +
          'Pembelian kartu katalog CC akan tersedia setelah integrasi settlement CC.',
      );
    }
    if (existing.sellerId && existing.sellerId === user.id) {
      throw new BadRequestException('Cannot buy your own listing.');
    }

    // Snapshot state pra-beli. Kartu yang di-relist sudah punya buyerId (owner
    // lama) dan nftId (mint sebelumnya), jadi kompensasi harus mengembalikan
    // state INI — bukan reset ke "seed" (buyerId null, nftId null).
    const prev = {
      status: existing.status,
      buyerId: existing.buyerId,
      soldAt: existing.soldAt,
      nftId: existing.nftId,
    };

    const bought = await this.prisma.listing.updateMany({
      where: { id, status: ListingStatus.ACTIVE },
      data: {
        status: ListingStatus.SOLD,
        buyerId: user.id,
        soldAt: new Date(),
      },
    });
    if (bought.count !== 1) {
      throw new BadRequestException('Listing already sold / inactive.');
    }
    let row: Prisma.ListingGetPayload<{ include: { nft: true } }>;
    try {
      row = await this.mintAndLink(id, user, prev.nftId);
    } catch (err) {
      // Kompensasi: kembalikan OWNER SEBELUMNYA (bukan null). Untuk kartu relist,
      // prev membawa nftId & buyerId lama, sehingga guard cocok & owner terjaga.
      await this.prisma.listing.updateMany({
        where: {
          id,
          status: ListingStatus.SOLD,
          buyerId: user.id,
          nftId: prev.nftId,
        },
        data: {
          status: prev.status,
          buyerId: prev.buyerId,
          soldAt: prev.soldAt,
        },
      });
      throw err;
    }

    // Beli langsung menutup semua penawaran yang masih menggantung di listing ini.
    await this.prisma.offer.updateMany({
      where: { listingId: id, status: OfferStatus.PENDING },
      data: { status: OfferStatus.REJECTED },
    });

    await this.recordActivity({
      type: ActivityType.SALE_CARD,
      listing: existing,
      amount: existing.priceIdrx,
      fromId: existing.sellerId,
      fromLabel: displayLabel(existing.seller, existing.sellerAddress),
      toId: user.id,
      toLabel: displayLabel(user, shortWallet(user.walletAddress)),
    });

    return toListingDto(row);
  }

  /**
   * Settle bagian on-chain dari sebuah penjualan: mint Core asset ke wallet
   * pembeli lalu tautkan ke listing. Dipakai `buy()` DAN `acceptOffer()` supaya
   * kedua jalur penjualan tidak bisa menyimpang satu sama lain.
   */
  private async mintAndLink(
    listingId: string,
    buyer: { id: string; walletAddress: string },
    prevNftId: string | null,
  ) {
    const locked = await this.prisma.listing.findUniqueOrThrow({
      where: { id: listingId },
      include: { nft: true },
    });
    const cardId = await this.ensureCardForListing(locked);
    const minted = await this.nft.mintForUser({
      userId: buyer.id,
      ownerAddress: buyer.walletAddress,
      cardId,
    });

    const row = await this.prisma.listing.update({
      where: { id: listingId },
      data: { cardId, nftId: minted.id },
      include: { nft: true },
    });

    // TODO(transfer): on-chain this mints a SECOND Core asset for the same
    // physical card; the old owner still holds the first one. A real transfer
    // needs the owner's signature or a TransferDelegate plugin set on the
    // asset at mint time.
    if (prevNftId && prevNftId !== minted.id) {
      try {
        await this.prisma.nft.updateMany({
          where: { id: prevNftId, status: NftStatus.MINTED },
          data: { status: NftStatus.TRANSFERRED },
        });
      } catch {
        /* best-effort bookkeeping; the sale already settled */
      }
    }
    return row;
  }

  /**
   * Penjual menarik listing miliknya (ACTIVE→CANCELLED, atomik). Kartunya tetap
   * milik penjual — yang dicabut hanya pajangannya. Offer yang masih PENDING
   * ikut ditutup: tidak ada lagi listing yang bisa mereka beli.
   */
  async cancel(id: string, user: AuthUser): Promise<ListingDto> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    if (existing.sellerId !== user.id) {
      throw new ForbiddenException('Only the seller can cancel this listing.');
    }
    const cancelled = await this.prisma.listing.updateMany({
      where: { id, status: ListingStatus.ACTIVE },
      data: { status: ListingStatus.CANCELLED },
    });
    if (cancelled.count !== 1) {
      throw new BadRequestException('Listing is no longer active.');
    }

    await this.prisma.offer.updateMany({
      where: { listingId: id, status: OfferStatus.PENDING },
      data: { status: OfferStatus.REJECTED },
    });

    await this.recordActivity({
      type: ActivityType.LISTING_CANCELED,
      listing: existing,
      amount: existing.priceIdrx,
      fromId: user.id,
      fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
      toId: null,
      toLabel: null,
    });

    const row = await this.prisma.listing.findUniqueOrThrow({
      where: { id },
      include: { nft: true },
    });
    return toListingDto(row);
  }

  /**
   * Owner menjual ulang kartu miliknya (SOLD/CANCELLED → ACTIVE, atomik).
   * Kepemilikan = buyerId; sellerId dipindah ke owner supaya listMine & guard
   * anti-self-buy mengacu ke pemilik saat ini. buyerId/nftId/soldAt DIPERTAHANKAN
   * (owner masih memegang kartu sampai ada yang membeli).
   */
  async relist(
    id: string,
    dto: RelistListingDto,
    user: AuthUser,
  ): Promise<ListingDto> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    if (existing.buyerId !== user.id) {
      throw new BadRequestException('Only the owner can list this card.');
    }
    if (existing.status === ListingStatus.ACTIVE) {
      throw new BadRequestException('Listing is already active.');
    }

    const relisted = await this.prisma.listing.updateMany({
      where: {
        id,
        buyerId: user.id,
        status: { in: [ListingStatus.SOLD, ListingStatus.CANCELLED] },
      },
      data: {
        status: ListingStatus.ACTIVE,
        sellerId: user.id,
        sellerAddress: shortWallet(user.walletAddress),
        priceIdrx: dto.price,
        expectedValueIdrx: dto.expectedValue ?? existing.expectedValueIdrx,
        buybackIdrx: dto.buyback ?? existing.buybackIdrx,
        listedAt: new Date(),
      },
    });
    if (relisted.count !== 1) {
      throw new BadRequestException('Listing is no longer relistable.');
    }

    await this.recordActivity({
      type: ActivityType.LISTED_CARD,
      listing: existing,
      amount: dto.price,
      fromId: user.id,
      fromLabel: displayLabel(user, shortWallet(user.walletAddress)),
      toId: null,
      toLabel: null,
    });

    return toListingDto(
      await this.prisma.listing.findUniqueOrThrow({
        where: { id },
        include: { nft: true },
      }),
    );
  }

  /* --------------------------- activity feed ---------------------------- */

  /**
   * Feed profil: semua event di mana user jadi aktor (`from`) ATAU lawan (`to`).
   * Dibaca dari tabel `activities`, bukan direkonstruksi dari status listing —
   * status cuma menyimpan keadaan terakhir, jadi riwayat "pernah dipajang, ditarik,
   * lalu dipajang lagi" tidak bisa dipulihkan dari sana.
   */
  async listActivity(
    userId: string,
    query: QueryActivityDto = {},
  ): Promise<ActivityDto[]> {
    const where: Prisma.ActivityWhereInput = {
      OR: [{ fromId: userId }, { toId: userId }],
    };
    if (query.type) where.type = query.type;
    if (query.set) where.set = query.set;
    if (query.search)
      where.itemName = { contains: query.search, mode: 'insensitive' };

    const rows = await this.prisma.activity.findMany({
      where,
      orderBy: { createdAt: query.sort === 'oldest' ? 'asc' : 'desc' },
      take: query.limit ?? 100,
    });
    return rows.map(toActivityDto);
  }

  /**
   * Tulis satu baris feed. Sengaja best-effort: baris audit yang gagal ditulis
   * tidak boleh menggagalkan penjualan/offer yang SUDAH settle. Kegagalan
   * di-log supaya tidak hilang diam-diam.
   */
  private async recordActivity(params: {
    type: ActivityType;
    listing: {
      id: string;
      name: string;
      image: string;
      category: string;
      set: string;
    };
    amount: number | null;
    fromId: string | null;
    fromLabel: string | null;
    toId: string | null;
    toLabel: string | null;
  }): Promise<void> {
    try {
      await this.prisma.activity.create({
        data: {
          type: params.type,
          listingId: params.listing.id,
          itemName: params.listing.name,
          itemImage: params.listing.image,
          category: params.listing.category,
          set: params.listing.set,
          amount: params.amount,
          fromId: params.fromId,
          fromLabel: params.fromLabel,
          toId: params.toId,
          toLabel: params.toLabel,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Failed to record ${params.type} activity for listing ${params.listing.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async ensureCardForListing(row: Row): Promise<string> {
    if (row.cardId) return row.cardId;

    const card = await this.prisma.card.create({
      data: {
        name: row.name,
        description: `${row.grade} ${row.category} marketplace snapshot`,
        imageUrl: row.image,
        set: row.set,
        rarity: row.rarity,
        attributes: [
          { trait_type: 'Grade', value: row.grade },
          { trait_type: 'Grader', value: row.grader },
          { trait_type: 'Language', value: row.language },
          { trait_type: 'Era', value: row.era },
          { trait_type: 'Element', value: row.element },
          { trait_type: 'Category', value: row.category },
        ] satisfies Prisma.InputJsonValue,
      },
    });

    await this.prisma.listing.update({
      where: { id: row.id },
      data: { cardId: card.id },
    });

    return card.id;
  }
}
