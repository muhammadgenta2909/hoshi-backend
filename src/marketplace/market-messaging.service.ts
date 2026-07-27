import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MarketSenderType, MarketThreadStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/jwt.strategy';

const USER_LABEL = {
  id: true,
  displayName: true,
  walletAddress: true,
} as const;

function label(u: { displayName: string | null; walletAddress: string }): string {
  const n = u.displayName?.trim();
  if (n) return n;
  const a = u.walletAddress;
  return a.length <= 11 ? a : `${a.slice(0, 5)}..${a.slice(-4)}`;
}

/**
 * Pesan marketplace pembeli ↔ penjual. Beda dari SupportService (user↔admin):
 * ini antara DUA user untuk satu listing, sehingga "Message Seller" benar-benar
 * sampai ke penjual dan bisa dibalas — bukan lagi mendarat di inbox admin.
 */
@Injectable()
export class MarketMessagingService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pembeli membuka / melanjutkan percakapan pada sebuah listing. */
  async postToListing(listingId: string, user: AuthUser, body: string) {
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { id: true, sellerId: true },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');
    // Kartu katalog CC (sellerId null) tidak punya penjual user untuk dihubungi.
    if (!listing.sellerId)
      throw new BadRequestException(
        'Kartu katalog CollectorCrypt tidak punya penjual untuk dihubungi lewat Hoshi.',
      );
    if (listing.sellerId === user.id)
      throw new BadRequestException('Ini listing Anda sendiri.');

    const thread = await this.prisma.marketThread.upsert({
      where: { listingId_buyerId: { listingId, buyerId: user.id } },
      create: { listingId, buyerId: user.id, sellerId: listing.sellerId },
      update: { status: MarketThreadStatus.OPEN },
    });
    await this.prisma.marketMessage.create({
      data: {
        threadId: thread.id,
        senderType: MarketSenderType.BUYER,
        body,
        readByBuyer: true,
        readBySeller: false,
      },
    });
    // Bump updatedAt agar naik ke atas inbox.
    await this.prisma.marketThread.update({
      where: { id: thread.id },
      data: { status: MarketThreadStatus.OPEN },
    });
    return { threadId: thread.id };
  }

  /** Semua thread di mana user ini jadi pembeli ATAU penjual. */
  async listMyThreads(user: AuthUser) {
    const threads = await this.prisma.marketThread.findMany({
      where: { OR: [{ buyerId: user.id }, { sellerId: user.id }] },
      orderBy: { updatedAt: 'desc' },
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        listing: { select: { id: true, name: true, image: true, priceIdrx: true, status: true } },
        buyer: { select: USER_LABEL },
        seller: { select: USER_LABEL },
      },
    });

    const ids = threads.map((t) => t.id);
    const unreadMap = new Map<string, number>();
    if (ids.length) {
      const [asBuyer, asSeller] = await Promise.all([
        this.prisma.marketMessage.groupBy({
          by: ['threadId'],
          where: { threadId: { in: ids }, readByBuyer: false, thread: { buyerId: user.id } },
          _count: { _all: true },
        }),
        this.prisma.marketMessage.groupBy({
          by: ['threadId'],
          where: { threadId: { in: ids }, readBySeller: false, thread: { sellerId: user.id } },
          _count: { _all: true },
        }),
      ]);
      for (const g of [...asBuyer, ...asSeller]) unreadMap.set(g.threadId, g._count._all);
    }

    return threads.map((t) => {
      const iAmBuyer = t.buyerId === user.id;
      const last = t.messages[0];
      return {
        id: t.id,
        listingId: t.listingId,
        listingName: t.listing?.name ?? '',
        listingImage: t.listing?.image ?? null,
        listingStatus: t.listing?.status ?? null,
        role: iAmBuyer ? 'BUYER' : 'SELLER',
        counterparty: iAmBuyer ? label(t.seller) : label(t.buyer),
        status: t.status,
        unread: unreadMap.get(t.id) ?? 0,
        lastMessage: last
          ? { body: last.body, senderType: last.senderType, createdAt: last.createdAt.toISOString() }
          : null,
        updatedAt: t.updatedAt.toISOString(),
      };
    });
  }

  async getThread(threadId: string, user: AuthUser) {
    const thread = await this.prisma.marketThread.findUnique({
      where: { id: threadId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        listing: { select: { id: true, name: true, image: true, priceIdrx: true, status: true } },
        buyer: { select: USER_LABEL },
        seller: { select: USER_LABEL },
      },
    });
    if (!thread) throw new NotFoundException('Percakapan tidak ditemukan.');
    const iAmBuyer = thread.buyerId === user.id;
    if (!iAmBuyer && thread.sellerId !== user.id)
      throw new ForbiddenException('Bukan percakapan Anda.');

    // Tandai pesan yang ditujukan ke sisi saya sebagai sudah dibaca.
    await this.prisma.marketMessage.updateMany({
      where: iAmBuyer
        ? { threadId, readByBuyer: false }
        : { threadId, readBySeller: false },
      data: iAmBuyer ? { readByBuyer: true } : { readBySeller: true },
    });

    return {
      id: thread.id,
      listingId: thread.listingId,
      listingName: thread.listing?.name ?? '',
      listingImage: thread.listing?.image ?? null,
      listingPriceIdrx: thread.listing?.priceIdrx ?? null,
      listingStatus: thread.listing?.status ?? null,
      role: iAmBuyer ? 'BUYER' : 'SELLER',
      counterparty: iAmBuyer ? label(thread.seller) : label(thread.buyer),
      status: thread.status,
      messages: thread.messages.map((m) => ({
        id: m.id,
        senderType: m.senderType,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      })),
    };
  }

  /** Balas dalam thread. senderType ditentukan dari sisi user (buyer/seller). */
  async reply(threadId: string, user: AuthUser, body: string) {
    const thread = await this.prisma.marketThread.findUnique({
      where: { id: threadId },
      select: { id: true, buyerId: true, sellerId: true },
    });
    if (!thread) throw new NotFoundException('Percakapan tidak ditemukan.');
    const iAmBuyer = thread.buyerId === user.id;
    if (!iAmBuyer && thread.sellerId !== user.id)
      throw new ForbiddenException('Bukan percakapan Anda.');

    await this.prisma.marketMessage.create({
      data: {
        threadId,
        senderType: iAmBuyer ? MarketSenderType.BUYER : MarketSenderType.SELLER,
        body,
        readByBuyer: iAmBuyer,
        readBySeller: !iAmBuyer,
      },
    });
    await this.prisma.marketThread.update({
      where: { id: threadId },
      data: { status: MarketThreadStatus.OPEN },
    });
    return { ok: true };
  }

  /** Jumlah thread yang punya pesan belum dibaca untuk sisi user (badge). */
  async unreadCount(user: AuthUser) {
    const unread = await this.prisma.marketThread.count({
      where: {
        OR: [
          { buyerId: user.id, messages: { some: { readByBuyer: false } } },
          { sellerId: user.id, messages: { some: { readBySeller: false } } },
        ],
      },
    });
    return { unread };
  }
}
