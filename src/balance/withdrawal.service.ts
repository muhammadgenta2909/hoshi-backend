import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, WithdrawalStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceService } from './balance.service';
import { RequestWithdrawalDto } from './dto/request-withdrawal.dto';

/** Minimal tarik Rp 10.000 — hindari request receh yang membebani payout manual. */
const MIN_WITHDRAWAL_IDR = 10_000;

function shortWallet(w: string): string {
  return w.length <= 11 ? w : `${w.slice(0, 5)}..${w.slice(-4)}`;
}

type WithdrawalRow = {
  id: string;
  amountIdr: bigint;
  method: string;
  destBank: string;
  destAccount: string;
  destName: string;
  status: WithdrawalStatus;
  note: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

/**
 * Penarikan saldo penjual → rekening bank / e-wallet. Payout MANUAL (fase awal):
 *   • request(): buat baris REQUESTED + DEBIT saldo (hold) dalam SATU transaksi. Saldo kurang →
 *     debit melempar → rollback → tak ada baris tercipta. Hold ini yang mencegah dobel-tarik.
 *   • admin approve(): admin sudah transfer manual → tandai PAID (saldo sudah turun saat request).
 *   • admin reject(): tandai REJECTED + KEMBALIKAN saldo (credit refund, idempoten per withdrawal).
 * Disiplin uang: saldo hanya berubah lewat BalanceService (atomik + ledger); status di-flip lewat
 * updateMany bersyarat (gerbang konkurensi) supaya satu penarikan tak diproses dua kali.
 */
@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balance: BalanceService,
  ) {}

  async request(userId: string, dto: RequestWithdrawalDto): Promise<WithdrawalDto> {
    const amount = Math.floor(dto.amount);
    if (!Number.isInteger(amount) || amount < MIN_WITHDRAWAL_IDR) {
      throw new BadRequestException(
        `Minimal penarikan Rp ${MIN_WITHDRAWAL_IDR.toLocaleString('id-ID')}.`,
      );
    }
    const withdrawal = await this.prisma.$transaction(async (tx) => {
      const w = await tx.withdrawal.create({
        data: {
          userId,
          amountIdr: BigInt(amount),
          method: dto.method,
          destBank: dto.destBank.trim(),
          destAccount: dto.destAccount.trim(),
          destName: dto.destName.trim(),
        },
      });
      // Hold saldo. refId = withdrawal.id → (WITHDRAW, id) unik = idempoten. Saldo kurang → throw.
      await this.balance.debit(
        { userId, amountIdrx: amount, reason: 'WITHDRAW', refId: w.id },
        tx,
      );
      return w;
    });
    this.logger.log(
      `Withdrawal ${withdrawal.id} REQUESTED user ${userId} Rp ${amount} → ${dto.method} ${dto.destBank}`,
    );
    return toDto(withdrawal);
  }

  async listMine(userId: string): Promise<WithdrawalDto[]> {
    const rows = await this.prisma.withdrawal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toDto);
  }

  /* ─────────────────────────── admin ─────────────────────────── */

  async adminList(status?: string): Promise<AdminWithdrawalDto[]> {
    const where: Prisma.WithdrawalWhereInput =
      status && status in WithdrawalStatus
        ? { status: status as WithdrawalStatus }
        : {};
    const rows = await this.prisma.withdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        user: { select: { walletAddress: true, displayName: true } },
      },
    });
    return rows.map((w) => ({
      ...toDto(w),
      userWallet: w.user.walletAddress,
      userLabel: w.user.displayName ?? shortWallet(w.user.walletAddress),
    }));
  }

  /** Admin sudah transfer manual → tandai PAID. Saldo sudah di-hold saat request; tak berubah. */
  async adminApprove(id: string, note?: string): Promise<WithdrawalDto> {
    const res = await this.prisma.withdrawal.updateMany({
      where: { id, status: WithdrawalStatus.REQUESTED },
      data: {
        status: WithdrawalStatus.PAID,
        processedAt: new Date(),
        note: note ?? null,
      },
    });
    if (res.count !== 1) {
      throw new BadRequestException(
        'Penarikan tidak ditemukan atau sudah diproses.',
      );
    }
    return this.getOne(id);
  }

  /** Admin tolak → REJECTED + kembalikan saldo yang di-hold (credit refund, idempoten). */
  async adminReject(id: string, note?: string): Promise<WithdrawalDto> {
    const existing = await this.prisma.withdrawal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Penarikan tidak ditemukan.');
    if (existing.status !== WithdrawalStatus.REQUESTED) {
      throw new BadRequestException('Penarikan sudah diproses.');
    }
    await this.prisma.$transaction(async (tx) => {
      const res = await tx.withdrawal.updateMany({
        where: { id, status: WithdrawalStatus.REQUESTED },
        data: {
          status: WithdrawalStatus.REJECTED,
          processedAt: new Date(),
          note: note ?? null,
        },
      });
      if (res.count !== 1) {
        throw new BadRequestException('Penarikan sudah diproses.');
      }
      // Kembalikan saldo yang di-hold. reason WITHDRAW_REFUND + refId = id → idempoten & terpisah
      // dari baris debit WITHDRAW (reason beda), jadi keduanya bisa hidup untuk id yang sama.
      await this.balance.credit(
        {
          userId: existing.userId,
          amountIdrx: Number(existing.amountIdr),
          reason: 'WITHDRAW_REFUND',
          refId: id,
        },
        tx,
      );
    });
    this.logger.log(
      `Withdrawal ${id} REJECTED — saldo Rp ${Number(existing.amountIdr)} dikembalikan ke user ${existing.userId}.`,
    );
    return this.getOne(id);
  }

  private async getOne(id: string): Promise<WithdrawalDto> {
    const w = await this.prisma.withdrawal.findUniqueOrThrow({ where: { id } });
    return toDto(w);
  }
}

export type WithdrawalDto = {
  id: string;
  amountIdr: number;
  method: string;
  destBank: string;
  destAccount: string;
  destName: string;
  status: WithdrawalStatus;
  note: string | null;
  createdAt: Date;
  processedAt: Date | null;
};

export type AdminWithdrawalDto = WithdrawalDto & {
  userWallet: string;
  userLabel: string;
};

function toDto(w: WithdrawalRow): WithdrawalDto {
  return {
    id: w.id,
    amountIdr: Number(w.amountIdr),
    method: w.method,
    destBank: w.destBank,
    destAccount: w.destAccount,
    destName: w.destName,
    status: w.status,
    note: w.note,
    createdAt: w.createdAt,
    processedAt: w.processedAt,
  };
}
