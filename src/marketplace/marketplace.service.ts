import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ListingStatus, Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { NftService } from '../nft/nft.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateListingDto } from './dto/create-listing.dto';
import { QueryListingDto, SortKey } from './dto/query-listing.dto';
import {
  ListingDto,
  toCardDetailDto,
  toListingDto,
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

/** Wallet panjang → bentuk pendek gaya TopNav (mis. "7xKXt..9c14"). */
function shortWallet(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 5)}..${address.slice(-4)}`;
}

@Injectable()
export class MarketplaceService {
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

  /** Kartu yang sudah DIBELI user login (SOLD + buyerId = user) — isi Vault/koleksi. */
  async listPurchases(userId: string): Promise<ListingDto[]> {
    const rows = await this.prisma.listing.findMany({
      where: { buyerId: userId, status: ListingStatus.SOLD },
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

  async submitOffer(id: string, user: string, amount: number) {
    const listing = await this.prisma.listing.findUnique({
      where: { id },
      select: { id: true, name: true, priceIdrx: true },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');

    const offer = await this.prisma.offer.create({
      data: { listingId: id, user, amount: Math.round(amount) },
    });
    return { submitted: true, listingId: listing.id, offer: { id: offer.id, user: offer.user, amount: offer.amount, status: offer.status, createdAt: offer.createdAt } };
  }

  /** User memajang kartu miliknya. sellerId = user login. */
  async create(dto: CreateListingDto, user: AuthUser): Promise<ListingDto> {
    if (dto.cardId) {
      const card = await this.prisma.card.findUnique({
        where: { id: dto.cardId },
      });
      if (!card) throw new NotFoundException('Card not found.');
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
        variant: dto.variant,
        contractAddress: dto.contractAddress,
        priceHistory:
          dto.priceHistory ?? ([dto.expectedValue, dto.price] satisfies number[]),
        offers: [],
        sellerId: user.id,
        sellerAddress: shortWallet(user.walletAddress),
        cardId: dto.cardId,
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
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    if (existing.sellerId && existing.sellerId === user.id) {
      throw new BadRequestException('Cannot buy your own listing.');
    }

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
    try {
      const locked = await this.prisma.listing.findUniqueOrThrow({
        where: { id },
        include: { nft: true },
      });
      const cardId = await this.ensureCardForListing(locked);
      const minted = await this.nft.mintForUser({
        userId: user.id,
        ownerAddress: user.walletAddress,
        cardId,
      });

      const row = await this.prisma.listing.update({
        where: { id },
        data: { cardId, nftId: minted.id },
        include: { nft: true },
      });
      return toListingDto(row);
    } catch (err) {
      await this.prisma.listing.updateMany({
        where: {
          id,
          status: ListingStatus.SOLD,
          buyerId: user.id,
          nftId: null,
        },
        data: {
          status: ListingStatus.ACTIVE,
          buyerId: null,
          soldAt: null,
        },
      });
      throw err;
    }
  }

  /** Penjual menarik listing miliknya (ACTIVE→CANCELLED, atomik). */
  async cancel(id: string, user: AuthUser): Promise<ListingDto> {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing tidak ditemukan.');
    if (existing.sellerId !== user.id) {
      throw new BadRequestException('Only the seller can cancel this listing.');
    }
    const cancelled = await this.prisma.listing.updateMany({
      where: { id, status: ListingStatus.ACTIVE },
      data: { status: ListingStatus.CANCELLED },
    });
    if (cancelled.count !== 1) {
      throw new BadRequestException('Listing is no longer active.');
    }
    const row = await this.prisma.listing.findUniqueOrThrow({
      where: { id },
      include: { nft: true },
    });
    return toListingDto(row);
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
