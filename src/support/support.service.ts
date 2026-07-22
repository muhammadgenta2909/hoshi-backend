import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SupportSenderType,
  SupportThreadStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const USER_LABEL = {
  id: true,
  displayName: true,
  walletAddress: true,
} as const;

// Bentuk baris thread untuk daftar inbox (ringkas: pesan terakhir + jumlah unread).
type ThreadRow = {
  id: string;
  subject: string | null;
  listingId: string | null;
  status: SupportThreadStatus;
  createdAt: Date;
  updatedAt: Date;
  messages: { body: string; senderType: SupportSenderType; createdAt: Date }[];
  user?: { id: string; displayName: string | null; walletAddress: string } | null;
};

@Injectable()
export class SupportService {
  constructor(private readonly prisma: PrismaService) {}

  private summary(t: ThreadRow, unread: number) {
    const last = t.messages[0];
    return {
      id: t.id,
      subject: t.subject,
      listingId: t.listingId,
      status: t.status,
      unread,
      lastMessage: last
        ? {
            body: last.body,
            senderType: last.senderType,
            createdAt: last.createdAt.toISOString(),
          }
        : null,
      user: t.user
        ? {
            id: t.user.id,
            label: t.user.displayName ?? t.user.walletAddress,
            walletAddress: t.user.walletAddress,
          }
        : undefined,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    };
  }

  /** Hitung unread per thread (untuk daftar yang sudah difetch). */
  private async unreadMap(threadIds: string[], side: 'user' | 'admin') {
    if (threadIds.length === 0) return new Map<string, number>();
    const groups = await this.prisma.supportMessage.groupBy({
      by: ['threadId'],
      where: {
        threadId: { in: threadIds },
        ...(side === 'user' ? { readByUser: false } : { readByAdmin: false }),
      },
      _count: { _all: true },
    });
    return new Map(groups.map((g) => [g.threadId, g._count._all]));
  }

  /* ---------------------------------- USER --------------------------------- */

  async listUserThreads(userId: string) {
    const threads = await this.prisma.supportThread.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    const unread = await this.unreadMap(
      threads.map((t) => t.id),
      'user',
    );
    return threads.map((t) => this.summary(t, unread.get(t.id) ?? 0));
  }

  async createThread(
    userId: string,
    dto: { subject?: string; listingId?: string; body: string },
  ) {
    return this.prisma.supportThread.create({
      data: {
        userId,
        subject: dto.subject,
        listingId: dto.listingId,
        messages: {
          create: {
            senderType: SupportSenderType.USER,
            body: dto.body,
            readByUser: true,
            readByAdmin: false,
          },
        },
      },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async getUserThread(userId: string, threadId: string) {
    await this.assertOwner(userId, threadId);
    await this.prisma.supportMessage.updateMany({
      where: { threadId, readByUser: false },
      data: { readByUser: true },
    });
    return this.prisma.supportThread.findUnique({
      where: { id: threadId },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
  }

  async addUserMessage(userId: string, threadId: string, body: string) {
    await this.assertOwner(userId, threadId);
    const msg = await this.prisma.supportMessage.create({
      data: {
        threadId,
        senderType: SupportSenderType.USER,
        body,
        readByUser: true,
        readByAdmin: false,
      },
    });
    // Pesan baru dari user → thread di-OPEN-kan lagi + updatedAt naik (urut inbox).
    await this.prisma.supportThread.update({
      where: { id: threadId },
      data: { status: SupportThreadStatus.OPEN },
    });
    return msg;
  }

  async userUnreadCount(userId: string) {
    const unread = await this.prisma.supportMessage.count({
      where: { thread: { userId }, readByUser: false },
    });
    return { unread };
  }

  private async assertOwner(userId: string, threadId: string) {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      select: { userId: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    if (thread.userId !== userId)
      throw new ForbiddenException('Bukan thread Anda');
  }

  /* --------------------------------- ADMIN --------------------------------- */

  async listAdminThreads(query: {
    page?: number;
    limit?: number;
    status?: string;
    unread?: boolean;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.SupportThreadWhereInput = {};
    if (query.status && query.status in SupportThreadStatus)
      where.status = query.status as SupportThreadStatus;
    if (query.unread) where.messages = { some: { readByAdmin: false } };
    if (query.search)
      where.OR = [
        { subject: { contains: query.search, mode: 'insensitive' } },
        { user: { walletAddress: { contains: query.search, mode: 'insensitive' } } },
        { user: { displayName: { contains: query.search, mode: 'insensitive' } } },
      ];

    const [threads, total] = await Promise.all([
      this.prisma.supportThread.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          user: { select: USER_LABEL },
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.supportThread.count({ where }),
    ]);
    const unread = await this.unreadMap(
      threads.map((t) => t.id),
      'admin',
    );
    return {
      data: threads.map((t) => this.summary(t, unread.get(t.id) ?? 0)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getAdminThread(threadId: string) {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        user: { select: USER_LABEL },
      },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    await this.prisma.supportMessage.updateMany({
      where: { threadId, readByAdmin: false },
      data: { readByAdmin: true },
    });
    return thread;
  }

  async adminReply(threadId: string, body: string) {
    const thread = await this.prisma.supportThread.findUnique({
      where: { id: threadId },
      select: { id: true },
    });
    if (!thread) throw new NotFoundException('Thread not found');
    const msg = await this.prisma.supportMessage.create({
      data: {
        threadId,
        senderType: SupportSenderType.ADMIN,
        body,
        readByAdmin: true,
        readByUser: false,
      },
    });
    // Balasan admin → thread tetap OPEN + updatedAt naik.
    await this.prisma.supportThread.update({
      where: { id: threadId },
      data: { status: SupportThreadStatus.OPEN },
    });
    return msg;
  }

  async setStatus(threadId: string, status: SupportThreadStatus) {
    // P2025 (tidak ada) dipetakan ke 404 oleh PrismaExceptionFilter global.
    return this.prisma.supportThread.update({
      where: { id: threadId },
      data: { status },
    });
  }

  async adminUnreadCount() {
    const unread = await this.prisma.supportThread.count({
      where: { messages: { some: { readByAdmin: false } } },
    });
    return { unread };
  }
}
