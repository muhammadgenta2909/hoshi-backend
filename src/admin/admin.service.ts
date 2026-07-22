import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary } from 'cloudinary';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import {
  ActivityType,
  ListingSource,
  ListingStatus,
  OfferStatus,
  Prisma,
  StorageProvider,
  VaultStatus,
} from '@prisma/client';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { PrismaService } from '../prisma/prisma.service';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { CreateContactMessageDto } from './dto/contact-message.dto';
import { ImportListingsDto } from './dto/import-listings.dto';
import {
  QueryAdminActivityDto,
  QueryAdminCardsDto,
  QueryAdminListingsDto,
} from './dto/query-admin.dto';
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
    private readonly marketplace: MarketplaceService,
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
    const [
      totalListings,
      activeListings,
      soldListings,
      totalUsers,
      totalCards,
    ] = await Promise.all([
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

  /**
   * Field yang MILIK CollectorCrypt pada listing hasil sync: nilainya di-refresh
   * setiap re-sync, jadi edit admin di sini pasti tertimpa lagi — lebih jujur
   * menolaknya dengan 400 daripada menerima edit yang umurnya sampai sync
   * berikutnya. Model bisnisnya "kita hanya edit harga di atas katalog mereka":
   * price / expectedValue / buyback / priceHistory tetap boleh.
   */
  private static readonly CC_LOCKED_FIELDS = [
    'name',
    'set',
    'rarity',
    'image',
    'imageBack',
    'grade',
    'grader',
    'gradeScore',
    'language',
    'era',
    'element',
    'category',
    'certificate',
    'vaultLocation',
    'cardNumber',
    'variant',
    'contractAddress',
  ] as const satisfies readonly (keyof AdminUpdateListingDto)[];

  async updateListing(id: string, dto: AdminUpdateListingDto) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    if (existing.source === ListingSource.COLLECTORCRYPT) {
      const locked = AdminService.CC_LOCKED_FIELDS.filter(
        (field) => dto[field] !== undefined,
      );
      if (locked.length > 0) {
        throw new BadRequestException(
          `Listing ini hasil sync CollectorCrypt — metadata milik mereka dan akan ` +
            `ditimpa re-sync. Field terkunci: ${locked.join(', ')}. ` +
            `Yang bisa diedit: price, expectedValue, buyback, priceHistory.`,
        );
      }
    }
    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.set !== undefined && { set: dto.set }),
        ...(dto.rarity !== undefined && { rarity: dto.rarity }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.imageBack !== undefined && { imageBack: dto.imageBack }),
        ...(dto.price !== undefined && { priceIdrx: dto.price }),
        ...(dto.expectedValue !== undefined && {
          expectedValueIdrx: dto.expectedValue,
        }),
        ...(dto.buyback !== undefined && { buybackIdrx: dto.buyback }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
        ...(dto.grader !== undefined && { grader: dto.grader }),
        ...(dto.gradeScore !== undefined && { gradeScore: dto.gradeScore }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.era !== undefined && { era: dto.era }),
        ...(dto.element !== undefined && { element: dto.element }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.certificate !== undefined && { certificate: dto.certificate }),
        ...(dto.vaultLocation !== undefined && {
          vaultLocation: dto.vaultLocation,
        }),
        ...(dto.cardNumber !== undefined && { cardNumber: dto.cardNumber }),
        ...(dto.variant !== undefined && { variant: dto.variant }),
        ...(dto.contractAddress !== undefined && {
          contractAddress: dto.contractAddress,
        }),
        ...(dto.priceHistory !== undefined && {
          priceHistory: dto.priceHistory,
        }),
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
      items.map((data) =>
        this.prisma.listing.create({ data, include: { nft: true } }),
      ),
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

  /**
   * Feed aktivitas admin dibaca dari tabel `Activity` (event log append-only yang
   * ditulis real-time oleh MarketplaceService) — BUKAN lagi direkonstruksi dari
   * status listing terkini. Rekonstruksi lama menghilangkan riwayat (listed→cancel
   * →listed lagi jadi satu baris) dan membuat re-sync CC memunculkan event palsu.
   */
  async listActivity(query: QueryAdminActivityDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ActivityWhereInput = {};
    // `action` = salah satu nilai ActivityType (mis. SALE_CARD). Nilai lain diabaikan.
    if (query.action && query.action in ActivityType)
      where.type = query.action as ActivityType;
    if (query.search)
      where.itemName = { contains: query.search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          itemName: true,
          itemImage: true,
          category: true,
          set: true,
          amount: true,
          fromLabel: true,
          toLabel: true,
          listingId: true,
          createdAt: true,
        },
      }),
      this.prisma.activity.count({ where }),
    ]);

    const mapped = data.map((a) => ({
      id: a.id,
      type: a.type,
      itemName: a.itemName,
      itemImage: a.itemImage,
      category: a.category,
      set: a.set,
      amount: a.amount,
      fromLabel: a.fromLabel,
      toLabel: a.toLabel,
      listingId: a.listingId,
      createdAt: a.createdAt.toISOString(),
    }));

    return { data: mapped, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  private readonly logger = new Logger(AdminService.name);
  private readonly uploadDir = path.join(__dirname, '..', '..', 'uploads');

  /* ---------- Contact Messages ---------- */

  async listMessages(query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
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
    return this.prisma.contactMessage.update({
      where: { id },
      data: { isRead },
    });
  }

  /* ---------- Offers (aggregate from Listing JSON) ---------- */
  async listOffers(query: {
    page?: number;
    limit?: number;
    listingId?: string;
    search?: string;
    status?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.OfferWhereInput = {};
    if (query.listingId) where.listingId = query.listingId;
    if (query.search)
      where.listing = { name: { contains: query.search, mode: 'insensitive' } };
    // Filter status opsional. Hanya nilai enum yang valid diterima; nilai lain
    // (mis. "ALL" atau typo) diabaikan agar tidak melempar 500.
    if (query.status && query.status in OfferStatus)
      where.status = query.status as OfferStatus;

    const [data, total] = await Promise.all([
      this.prisma.offer.findMany({
        where,
        // Ambil sekalian data yang SUDAH ada di DB supaya admin bisa menilai
        // offer tanpa membuka listing: thumbnail, harga ask, status listing,
        // dan wallet pembeli. Jangan pernah ikutkan `nonce` user.
        include: {
          listing: {
            select: {
              id: true,
              name: true,
              image: true,
              priceIdrx: true,
              status: true,
            },
          },
          buyer: { select: { id: true, displayName: true, walletAddress: true } },
        },
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
      listingImage: o.listing?.image ?? null,
      listingStatus: o.listing?.status ?? null,
      askPrice: o.listing?.priceIdrx ?? null,
      user: o.user,
      buyerWallet: o.buyer?.walletAddress ?? null,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      // updatedAt = kapan offer di-resolve (accept/reject/cancel) untuk baris
      // non-PENDING. Untuk PENDING nilainya sama dengan createdAt.
      updatedAt: o.updatedAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /* ---------- Vault / Inventory (custody location) ---------- */

  /**
   * Daftar item vault untuk admin — menjawab "inventory kita ada di vault mana".
   * Bisa difilter per status (STORED/MINTING/MINTED/REDEEMED) dan per provider
   * custody, plus cari via serial / nama kartu / label lokasi.
   */
  async listVaultItems(query: {
    page?: number;
    limit?: number;
    status?: string;
    provider?: string;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.VaultItemWhereInput = {};
    if (query.status && query.status in VaultStatus)
      where.status = query.status as VaultStatus;
    if (query.provider && query.provider in StorageProvider)
      where.storageProvider = query.provider as StorageProvider;
    if (query.search)
      where.OR = [
        { serialNumber: { contains: query.search, mode: 'insensitive' } },
        { vaultLocation: { contains: query.search, mode: 'insensitive' } },
        { card: { name: { contains: query.search, mode: 'insensitive' } } },
      ];

    const [data, total] = await Promise.all([
      this.prisma.vaultItem.findMany({
        where,
        include: {
          card: { select: { id: true, name: true, imageUrl: true, set: true } },
          owner: { select: { id: true, displayName: true, walletAddress: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.vaultItem.count({ where }),
    ]);

    const mapped = data.map((v) => ({
      id: v.id,
      serialNumber: v.serialNumber,
      status: v.status,
      storageProvider: v.storageProvider,
      vaultLocation: v.vaultLocation,
      cardId: v.cardId,
      cardName: v.card?.name ?? '',
      cardImage: v.card?.imageUrl ?? null,
      cardSet: v.card?.set ?? null,
      ownerWallet: v.owner?.walletAddress ?? null,
      ownerLabel: v.owner?.displayName ?? null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    return { data: mapped, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Admin memindahkan/mengoreksi lokasi custody sebuah item vault. */
  async updateVaultItem(
    id: string,
    dto: { storageProvider?: string; vaultLocation?: string | null },
  ) {
    const data: Prisma.VaultItemUpdateInput = {};
    if (dto.storageProvider !== undefined) {
      if (!(dto.storageProvider in StorageProvider))
        throw new BadRequestException('storageProvider tidak valid');
      data.storageProvider = dto.storageProvider as StorageProvider;
    }
    if (dto.vaultLocation !== undefined) data.vaultLocation = dto.vaultLocation;
    // P2025 (row tidak ada) dipetakan ke 404 oleh PrismaExceptionFilter global.
    return this.prisma.vaultItem.update({ where: { id }, data });
  }

  /* ---------- Daily Stats (Charts) ---------- */

  async dailyStats(days = 30) {
    const now = new Date();
    const since = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - days,
      ),
    );

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
      {
        status: 'ACTIVE',
        count: await this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      },
      {
        status: 'SOLD',
        count: await this.prisma.listing.count({ where: { status: 'SOLD' } }),
      },
      {
        status: 'CANCELLED',
        count: await this.prisma.listing.count({
          where: { status: 'CANCELLED' },
        }),
      },
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
    const conversionRate =
      totalListings > 0 ? (conversionAgg._count / totalListings) * 100 : 0;

    return {
      dailyListings,
      dailyRevenue,
      statusDistribution: statusDist,
      topListings,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  }

  /* ---------- Image Upload ---------- */

  /**
   * Accept/reject dari admin DIDELEGASIKAN ke MarketplaceService — jalur yang
   * sama dengan tombol penjual di halaman profil. Dulu method ini cuma menulis
   * `status: ACCEPTED` tanpa menjual listing atau mint NFT: offer tampak diterima
   * padahal kartunya tidak pernah pindah tangan, dan penjual kehilangan tombol
   * accept-nya (status bukan PENDING lagi). Admin = moderasi, bukan alur utama.
   */
  acceptOffer(id: string) {
    return this.marketplace.acceptOfferAsAdmin(id);
  }

  rejectOffer(id: string) {
    return this.marketplace.rejectOfferAsAdmin(id);
  }

  /**
   * Upload gambar listing.
   *
   * PRODUKSI: kalau `CLOUDINARY_URL` di-set, byte diunggah ke Cloudinary dan yang
   * dikembalikan adalah URL CDN ABSOLUT (secure_url). Ini penting karena:
   *   1) disk container Render bersifat EPHEMERAL — file lokal hilang tiap redeploy;
   *   2) URL relatif `/uploads/...` tidak resolve dari origin frontend (Vercel).
   *
   * DEV: kalau env belum di-set, jatuh balik ke disk lokal (URL relatif) supaya
   * pengembangan lokal tetap jalan tanpa akun Cloudinary. JANGAN andalkan jalur ini
   * di produksi. Set `CLOUDINARY_URL` di env Render.
   */
  /**
   * Kredensial Cloudinary boleh diisi lewat SALAH SATU dari:
   *   a) CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>  (1 baris), atau
   *   b) CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET (3 baris).
   * Dua-duanya didukung supaya tidak tergantung format yang ditampilkan dashboard.
   */
  private cloudinaryReady(): boolean {
    // SDK otomatis membaca process.env.CLOUDINARY_URL saat config() dipanggil.
    if (cloudinary.config().cloud_name) return true;
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (cloudName && apiKey && apiSecret) {
      cloudinary.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      return true;
    }
    return false;
  }

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/'))
      throw new BadRequestException('Hanya file gambar yang diperbolehkan');

    const configured = this.cloudinaryReady();
    if (configured) {
      const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      const uploaded = await cloudinary.uploader.upload(dataUri, {
        folder: 'hoshi/listings',
        resource_type: 'image',
      });
      return { url: uploaded.secure_url };
    }

    // Di PRODUCTION jangan pernah diam-diam jatuh ke disk: URL yang dihasilkan
    // relatif (`/uploads/...`) sehingga di-resolve ke origin FRONTEND dan selalu
    // 404, sementara filenya hilang tiap redeploy (disk Render ephemeral). Admin
    // akan melihat "upload sukses" lalu menyimpan gambar yang rusak permanen.
    // Lebih baik gagal keras dan terlihat.
    if (this.config.get<string>('NODE_ENV') === 'production')
      throw new BadRequestException(
        'Upload gambar belum dikonfigurasi: set CLOUDINARY_URL (atau CLOUDINARY_CLOUD_NAME + ' +
          'CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET) di environment server.',
      );

    // Fallback dev-only: tulis ke disk lokal (URL relatif — hanya berguna lokal).
    this.logger.warn(
      'Kredensial Cloudinary belum di-set (CLOUDINARY_URL, atau CLOUDINARY_CLOUD_NAME + ' +
        'CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET) — upload jatuh ke disk lokal (ephemeral, dev-only).',
    );
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const filename = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(this.uploadDir, filename);
    if (!fs.existsSync(this.uploadDir))
      fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return { url: `/uploads/${filename}` };
  }

  async seedAdmin(email: string, password: string, secret?: string) {
    // Fail closed: tanpa ADMIN_SECRET di env, seed tidak bisa dipakai sama
    // sekali — endpoint ini membuat akun ADMIN, bukan sekadar data demo.
    const expected = this.config.get<string>('ADMIN_SECRET');
    if (!expected || secret !== expected) {
      throw new ForbiddenException(
        'Seed admin butuh header x-admin-secret yang cocok dengan env ADMIN_SECRET.',
      );
    }
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
    // Guard: endpoint ini menulis 91 listing demo langsung ke tabel `listings`
    // yang dipakai dashboard. Dilarang di production agar angka riil tidak
    // tercemar data palsu.
    if (this.config.get<string>('NODE_ENV') === 'production')
      throw new ForbiddenException('Seed chart data dilarang di production.');
    const SEED_CARDS = [
      {
        name: 'Pikachu VMAX',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Lightning',
        category: 'Special Illustration',
        priceIdrx: 45000000,
        expectedValueIdrx: 48000000,
        image: 'https://placehold.co/400x560/3a2e0e/ffd700?text=Pikachu+VMAX',
      },
      {
        name: 'Charizard VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Fire',
        category: 'Character Illustration',
        priceIdrx: 52000000,
        expectedValueIdrx: 55000000,
        image: 'https://placehold.co/400x560/4a0e0e/ffd700?text=Charizard+VMAX',
      },
      {
        name: 'Mewtwo VSTAR',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Psychic',
        category: 'Special Illustration',
        priceIdrx: 28000000,
        expectedValueIdrx: 30000000,
        image: 'https://placehold.co/400x560/2e0e4a/ffd700?text=Mewtwo+VSTAR',
      },
      {
        name: 'Gengar VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'CGC 9',
        grader: 'CGC' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Classic',
        element: 'Darkness',
        category: 'Special Illustration',
        priceIdrx: 35000000,
        expectedValueIdrx: 38000000,
        image: 'https://placehold.co/400x560/2e0e0e/ffd700?text=Gengar+VMAX',
      },
      {
        name: 'Eevee V',
        set: 'Promo',
        rarity: 'Epic',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Modern',
        element: 'Normal',
        category: 'Illustration',
        priceIdrx: 8500000,
        expectedValueIdrx: 9200000,
        image: 'https://placehold.co/400x560/3a2e0e/c8a84e?text=Eevee+V',
      },
      {
        name: 'Umbreon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 10',
        grader: 'BGS' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Darkness',
        category: 'Character Illustration',
        priceIdrx: 62000000,
        expectedValueIdrx: 65000000,
        image: 'https://placehold.co/400x560/1a1a2e/ffd700?text=Umbreon+VMAX',
      },
      {
        name: 'Rayquaza V',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'CGC 9.5',
        grader: 'CGC' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Classic',
        element: 'Dragon',
        category: 'Special Illustration',
        priceIdrx: 38000000,
        expectedValueIdrx: 40000000,
        image: 'https://placehold.co/400x560/0e3a2e/ffd700?text=Rayquaza+V',
      },
      {
        name: 'Glaceon VSTAR',
        set: 'Jungle',
        rarity: 'Epic',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Water',
        category: 'Illustration',
        priceIdrx: 18000000,
        expectedValueIdrx: 20000000,
        image: 'https://placehold.co/400x560/0e1a4a/aaccff?text=Glaceon+VSTAR',
      },
      {
        name: 'Lucario V',
        set: 'Rare',
        rarity: 'Rare',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'Japan',
        era: 'Modern',
        element: 'Fighting',
        category: 'Character Illustration',
        priceIdrx: 6500000,
        expectedValueIdrx: 7200000,
        image: 'https://placehold.co/400x560/4a2e0e/d4a64e?text=Lucario+V',
      },
      {
        name: 'Sylveon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Fairy',
        category: 'Character Illustration',
        priceIdrx: 42000000,
        expectedValueIdrx: 45000000,
        image: 'https://placehold.co/400x560/2e1a3a/ffb6c1?text=Sylveon+VMAX',
      },
    ];

    const now = new Date();
    let created = 0;

    for (let dayOffset = 90; dayOffset >= 0; dayOffset--) {
      const card = SEED_CARDS[dayOffset % SEED_CARDS.length];
      const createdAt = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - dayOffset,
          8,
          0,
          0,
        ),
      );
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
      dateRange: {
        to: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 0,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
        from: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 90,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
      },
    };
  }
}
