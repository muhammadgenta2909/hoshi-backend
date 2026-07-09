import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { ListingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { CreateContactMessageDto } from './dto/contact-message.dto';
import { ImportListingsDto } from './dto/import-listings.dto';
import { QueryAdminActivityDto, QueryAdminCardsDto, QueryAdminListingsDto } from './dto/query-admin.dto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface AdminStatsResponse {
  totalListings: number;
  activeListings: number;
  soldListings: number;
  totalUsers: number;
  totalCards: number;
  totalRevenue: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new BadRequestException('Invalid email or password.');
    }
    const valid = await verify(user.passwordHash, password);
    if (!valid) {
      throw new BadRequestException('Invalid email or password.');
    }
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: 'ADMIN',
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async stats(): Promise<AdminStatsResponse> {
    const [totalListings, activeListings, soldListings, totalUsers, totalCards] =
      await Promise.all([
        this.prisma.listing.count(),
        this.prisma.listing.count({ where: { status: ListingStatus.ACTIVE } }),
        this.prisma.listing.count({ where: { status: ListingStatus.SOLD } }),
        this.prisma.user.count(),
        this.prisma.card.count(),
      ]);
    const revenueAgg = await this.prisma.listing.aggregate({
      where: { status: ListingStatus.SOLD },
      _sum: { priceIdrx: true },
    });
    return {
      totalListings,
      activeListings,
      soldListings,
      totalUsers,
      totalCards,
      totalRevenue: revenueAgg._sum.priceIdrx ?? 0,
    };
  }

  async listListings(query: QueryAdminListingsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ListingWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sellerAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const orderBy: Prisma.ListingOrderByWithRelationInput =
      query.sort === 'price-asc'
        ? { priceIdrx: 'asc' }
        : query.sort === 'price-desc'
          ? { priceIdrx: 'desc' }
          : { listedAt: 'desc' };
    const [data, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { nft: true },
      }),
      this.prisma.listing.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async getListing(id: string) {
    const row = await this.prisma.listing.findUnique({
      where: { id },
      include: { nft: true },
    });
    if (!row) throw new NotFoundException('Listing not found.');
    return row;
  }

  async createListing(dto: AdminCreateListingDto) {
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
        sellerAddress: dto.sellerAddress ?? 'admin',
        certificate: dto.certificate,
        vaultLocation: dto.vaultLocation,
        cardNumber: dto.cardNumber,
        variant: dto.variant,
        priceHistory: dto.priceHistory ?? [dto.expectedValue, dto.price],
        offers: [],
      },
      include: { nft: true },
    });
    return row;
  }

  async updateListing(id: string, dto: AdminUpdateListingDto) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.set !== undefined && { set: dto.set }),
        ...(dto.rarity !== undefined && { rarity: dto.rarity }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.imageBack !== undefined && { imageBack: dto.imageBack }),
        ...(dto.price !== undefined && { priceIdrx: dto.price }),
        ...(dto.expectedValue !== undefined && { expectedValueIdrx: dto.expectedValue }),
        ...(dto.buyback !== undefined && { buybackIdrx: dto.buyback }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
        ...(dto.grader !== undefined && { grader: dto.grader }),
        ...(dto.gradeScore !== undefined && { gradeScore: dto.gradeScore }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.era !== undefined && { era: dto.era }),
        ...(dto.element !== undefined && { element: dto.element }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.certificate !== undefined && { certificate: dto.certificate }),
        ...(dto.vaultLocation !== undefined && { vaultLocation: dto.vaultLocation }),
        ...(dto.cardNumber !== undefined && { cardNumber: dto.cardNumber }),
        ...(dto.variant !== undefined && { variant: dto.variant }),
        ...(dto.contractAddress !== undefined && { contractAddress: dto.contractAddress }),
        ...(dto.priceHistory !== undefined && { priceHistory: dto.priceHistory }),
      },
      include: { nft: true },
    });
  }

  async importListings(dto: ImportListingsDto) {
    const seller = dto.sellerOverride ?? 'admin';
    const items = dto.items.map((item) => ({
      name: item.name,
      set: item.set,
      rarity: item.rarity,
      image: item.image,
      priceIdrx: item.price,
      expectedValueIdrx: item.expectedValue ?? item.price,
      buybackIdrx: item.buyback ?? 0,
      grade: item.grade,
      grader: item.grader,
      gradeScore: item.gradeScore,
      language: item.language ?? 'EN',
      era: item.era ?? '',
      element: item.element ?? '',
      category: item.category ?? '',
      sellerAddress: seller,
      certificate: item.certificate,
      vaultLocation: item.vaultLocation,
      cardNumber: item.cardNumber,
      variant: item.variant,
      priceHistory: [item.expectedValue ?? item.price, item.price],
      offers: [],
    }));
    const created = await this.prisma.$transaction(
      items.map((data) => this.prisma.listing.create({ data, include: { nft: true } })),
    );
    return { imported: created.length, items: created };
  }

  async deleteListing(id: string) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    await this.prisma.listing.delete({ where: { id } });
    return { deleted: true, id };
  }

  async listCards(query: QueryAdminCardsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CardWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.set) where.set = query.set;
    if (query.rarity) where.rarity = query.rarity;
    const [data, total] = await Promise.all([
      this.prisma.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.card.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async listActivity(query: QueryAdminActivityDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ListingWhereInput = {};
    if (query.action === 'sold') where.status = ListingStatus.SOLD;
    else if (query.action === 'cancelled') where.status = ListingStatus.CANCELLED;
    if (query.search) where.name = { contains: query.search, mode: 'insensitive' };

    const orderBy: Prisma.ListingOrderByWithRelationInput = { updatedAt: 'desc' };
    const [data, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          name: true,
          priceIdrx: true,
          status: true,
          sellerAddress: true,
          createdAt: true,
          updatedAt: true,
          soldAt: true,
        },
      }),
      this.prisma.listing.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private readonly uploadDir = path.join(__dirname, '..', '..', 'uploads');

  /* ---------- Contact Messages ---------- */

  async listMessages(query: { page?: number; limit?: number; search?: string; status?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ContactMessageWhereInput = {};
    if (query.status === 'read') where.isRead = true;
    else if (query.status === 'unread') where.isRead = false;
    if (query.search) {
      where.OR = [
        { listingName: { contains: query.search, mode: 'insensitive' } },
        { senderName: { contains: query.search, mode: 'insensitive' } },
        { senderEmail: { contains: query.search, mode: 'insensitive' } },
        { text: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createMessage(dto: CreateContactMessageDto) {
    return this.prisma.contactMessage.create({ data: dto });
  }

  async markMessageRead(id: string, isRead: boolean) {
    const row = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Message not found');
    return this.prisma.contactMessage.update({ where: { id }, data: { isRead } });
  }

  /* ---------- Offers (aggregate from Listing JSON) ---------- */
  async listOffers(query: { page?: number; limit?: number; listingId?: string; search?: string }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.OfferWhereInput = {};
    if (query.listingId) where.listingId = query.listingId;
    if (query.search) where.listing = { name: { contains: query.search, mode: 'insensitive' } };

    const [data, total] = await Promise.all([
      this.prisma.offer.findMany({
        where,
        include: { listing: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offer.count({ where }),
    ]);

    const mapped = data.map((o) => ({
      id: o.id,
      listingId: o.listingId,
      listingName: o.listing?.name ?? '',
      user: o.user,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
    }));

    return { data: mapped, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /* ---------- Daily Stats (Charts) ---------- */

  async dailyStats(days = 30) {
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days));

    const listings = await this.prisma.listing.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, priceIdrx: true, status: true, soldAt: true },
    });

    const dateMap = new Map<string, { listings: number; revenue: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dateMap.set(key, { listings: 0, revenue: 0 });
    }

    for (const l of listings) {
      const key = l.createdAt.toISOString().slice(0, 10);
      if (dateMap.has(key)) dateMap.get(key)!.listings++;
      if (l.status === 'SOLD' && l.soldAt) {
        const soldKey = l.soldAt.toISOString().slice(0, 10);
        if (dateMap.has(soldKey)) dateMap.get(soldKey)!.revenue += l.priceIdrx;
      }
    }

    const dailyListings: { date: string; count: number }[] = [];
    const dailyRevenue: { date: string; amount: number }[] = [];
    for (const [date, vals] of dateMap) {
      dailyListings.push({ date, count: vals.listings });
      dailyRevenue.push({ date, amount: vals.revenue });
    }
    dailyListings.sort((a, b) => a.date.localeCompare(b.date));
    dailyRevenue.sort((a, b) => a.date.localeCompare(b.date));

    const statusDist = [
      { status: 'ACTIVE', count: await this.prisma.listing.count({ where: { status: 'ACTIVE' } }) },
      { status: 'SOLD', count: await this.prisma.listing.count({ where: { status: 'SOLD' } }) },
      { status: 'CANCELLED', count: await this.prisma.listing.count({ where: { status: 'CANCELLED' } }) },
    ];

    const topListings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { views: 'desc' },
      take: 5,
      select: { id: true, name: true, views: true, priceIdrx: true },
    });

    const conversionAgg = await this.prisma.listing.aggregate({
      _count: true,
      where: { status: 'SOLD' },
    });
    const totalListings = await this.prisma.listing.count();
    const conversionRate = totalListings > 0 ? (conversionAgg._count / totalListings) * 100 : 0;

    return {
      dailyListings,
      dailyRevenue,
      statusDistribution: statusDist,
      topListings,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  }

  /* ---------- Image Upload ---------- */

  async acceptOffer(id: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundException('Offer not found.');
    if (offer.status !== 'PENDING') throw new BadRequestException('Offer already processed.');

    return this.prisma.offer.update({
      where: { id },
      data: { status: 'ACCEPTED' },
      include: { listing: { select: { id: true, name: true } } },
    });
  }

  async rejectOffer(id: string) {
    const offer = await this.prisma.offer.findUnique({ where: { id } });
    if (!offer) throw new NotFoundException('Offer not found.');
    if (offer.status !== 'PENDING') throw new BadRequestException('Offer already processed.');

    return this.prisma.offer.update({
      where: { id },
      data: { status: 'REJECTED' },
      include: { listing: { select: { id: true, name: true } } },
    });
  }

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const filename = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(this.uploadDir, filename);
    if (!fs.existsSync(this.uploadDir)) fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return { url: `/uploads/${filename}` };
  }

  async seedAdmin(email: string, password: string) {
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) throw new ConflictException('Admin already exists');
    const passwordHash = await hash(password);
    return this.prisma.user.create({
      data: {
        walletAddress: `admin-${email.replace(/[^a-zA-Z0-9]/g, '')}`,
        email,
        passwordHash,
        role: 'ADMIN',
        displayName: 'Admin',
      },
    });
  }

  async seedChartData() {
    const SEED_CARDS = [
      { name: 'Pikachu VMAX', set: 'Classic', rarity: 'Legendary', grade: 'PSA 10', grader: 'PSA' as const, gradeScore: 10, language: 'English', era: 'Classic', element: 'Lightning', category: 'Special Illustration', priceIdrx: 45000000, expectedValueIdrx: 48000000, image: 'https://placehold.co/400x560/3a2e0e/ffd700?text=Pikachu+VMAX' },
      { name: 'Charizard VMAX', set: 'Classic', rarity: 'Legendary Rare', grade: 'PSA 10', grader: 'PSA' as const, gradeScore: 10, language: 'English', era: 'Classic', element: 'Fire', category: 'Character Illustration', priceIdrx: 52000000, expectedValueIdrx: 55000000, image: 'https://placehold.co/400x560/4a0e0e/ffd700?text=Charizard+VMAX' },
      { name: 'Mewtwo VSTAR', set: 'Evolving', rarity: 'Legendary', grade: 'BGS 9.5', grader: 'BGS' as const, gradeScore: 9.5, language: 'English', era: 'Modern', element: 'Psychic', category: 'Special Illustration', priceIdrx: 28000000, expectedValueIdrx: 30000000, image: 'https://placehold.co/400x560/2e0e4a/ffd700?text=Mewtwo+VSTAR' },
      { name: 'Gengar VMAX', set: 'Classic', rarity: 'Legendary Rare', grade: 'CGC 9', grader: 'CGC' as const, gradeScore: 9, language: 'English', era: 'Classic', element: 'Darkness', category: 'Special Illustration', priceIdrx: 35000000, expectedValueIdrx: 38000000, image: 'https://placehold.co/400x560/2e0e0e/ffd700?text=Gengar+VMAX' },
      { name: 'Eevee V', set: 'Promo', rarity: 'Epic', grade: 'PSA 9', grader: 'PSA' as const, gradeScore: 9, language: 'English', era: 'Modern', element: 'Normal', category: 'Illustration', priceIdrx: 8500000, expectedValueIdrx: 9200000, image: 'https://placehold.co/400x560/3a2e0e/c8a84e?text=Eevee+V' },
      { name: 'Umbreon VMAX', set: 'Evolving', rarity: 'Legendary', grade: 'BGS 10', grader: 'BGS' as const, gradeScore: 10, language: 'English', era: 'Modern', element: 'Darkness', category: 'Character Illustration', priceIdrx: 62000000, expectedValueIdrx: 65000000, image: 'https://placehold.co/400x560/1a1a2e/ffd700?text=Umbreon+VMAX' },
      { name: 'Rayquaza V', set: 'Classic', rarity: 'Legendary', grade: 'CGC 9.5', grader: 'CGC' as const, gradeScore: 9.5, language: 'English', era: 'Classic', element: 'Dragon', category: 'Special Illustration', priceIdrx: 38000000, expectedValueIdrx: 40000000, image: 'https://placehold.co/400x560/0e3a2e/ffd700?text=Rayquaza+V' },
      { name: 'Glaceon VSTAR', set: 'Jungle', rarity: 'Epic', grade: 'PSA 10', grader: 'PSA' as const, gradeScore: 10, language: 'English', era: 'Modern', element: 'Water', category: 'Illustration', priceIdrx: 18000000, expectedValueIdrx: 20000000, image: 'https://placehold.co/400x560/0e1a4a/aaccff?text=Glaceon+VSTAR' },
      { name: 'Lucario V', set: 'Rare', rarity: 'Rare', grade: 'PSA 9', grader: 'PSA' as const, gradeScore: 9, language: 'Japan', era: 'Modern', element: 'Fighting', category: 'Character Illustration', priceIdrx: 6500000, expectedValueIdrx: 7200000, image: 'https://placehold.co/400x560/4a2e0e/d4a64e?text=Lucario+V' },
      { name: 'Sylveon VMAX', set: 'Evolving', rarity: 'Legendary', grade: 'BGS 9.5', grader: 'BGS' as const, gradeScore: 9.5, language: 'English', era: 'Modern', element: 'Fairy', category: 'Character Illustration', priceIdrx: 42000000, expectedValueIdrx: 45000000, image: 'https://placehold.co/400x560/2e1a3a/ffb6c1?text=Sylveon+VMAX' },
    ];

    const now = new Date();
    let created = 0;

    for (let dayOffset = 90; dayOffset >= 0; dayOffset--) {
      const card = SEED_CARDS[dayOffset % SEED_CARDS.length];
      const createdAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - dayOffset, 8, 0, 0));
      await this.prisma.listing.create({
        data: {
          ...card,
          buybackIdrx: Math.round(card.priceIdrx * 0.7),
          sellerAddress: 'seed-admin',
          status: 'ACTIVE',
          createdAt,
          listedAt: createdAt,
          updatedAt: createdAt,
          priceHistory: [card.expectedValueIdrx, card.priceIdrx],
          offers: [],
        },
      });
      created++;
    }

    return {
      listingsCreated: created,
      dateRange: { to: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 0, 8, 0, 0)).toISOString().slice(0, 10), from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 90, 8, 0, 0)).toISOString().slice(0, 10) },
    };
  }
}
