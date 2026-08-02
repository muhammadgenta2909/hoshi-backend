import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type BalanceEntryDto = {
  id: string;
  deltaIdrx: number;
  reason: string;
  refId: string | null;
  createdAt: Date;
};

export type BalanceDto = {
  balanceIdrx: number;
  entries: BalanceEntryDto[];
};

/**
 * Saldo in-app (Rupiah) milik user. SATU-SATUNYA jalur yang boleh mengubah `User.balanceIdrx`.
 *
 * Kebenaran uang dijaga dua hal:
 *   1. Increment field + insert baris ledger `BalanceEntry` SELALU dalam SATU $transaction —
 *      saldo dan riwayat tidak mungkin menyimpang.
 *   2. Idempotensi lewat unique (reason, refId): kredit yang di-refId (mis. merchantOrderId
 *      penjualan) tidak bisa dobel walau callback/reconciler mengulang pemanggilan.
 */
@Injectable()
export class BalanceService {
  private readonly logger = new Logger(BalanceService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Kredit saldo user (mis. hasil jual kartu P2P). IDEMPOTEN per (reason, refId): panggilan
   * kedua dengan refId sama TIDAK menambah saldo lagi. Kembalikan { credited } — false berarti
   * sudah pernah dikredit (duplikat diabaikan), bukan error.
   *
   * @param amountIdrx rupiah utuh, HARUS > 0.
   */
  async credit(params: {
    userId: string;
    amountIdrx: number;
    reason: string;
    refId?: string | null;
  }): Promise<{ credited: boolean }> {
    if (!Number.isInteger(params.amountIdrx) || params.amountIdrx <= 0) {
      throw new Error(
        `Jumlah kredit saldo tidak sah: ${params.amountIdrx} (harus integer > 0).`,
      );
    }
    const delta = BigInt(params.amountIdrx);
    try {
      await this.prisma.$transaction(async (tx) => {
        // Ledger DULU: unique (reason, refId) = gerbang idempotensi. Kalau baris kembar,
        // create ini melempar P2002 → seluruh transaksi rollback → saldo TIDAK di-increment.
        await tx.balanceEntry.create({
          data: {
            userId: params.userId,
            deltaIdrx: delta,
            reason: params.reason,
            refId: params.refId ?? null,
          },
        });
        await tx.user.update({
          where: { id: params.userId },
          data: { balanceIdrx: { increment: delta } },
        });
      });
      return { credited: true };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Sudah pernah dikredit untuk (reason, refId) ini → aman, bukan kegagalan.
        this.logger.warn(
          `Kredit saldo duplikat diabaikan (user ${params.userId}, reason ${params.reason}, refId ${params.refId}).`,
        );
        return { credited: false };
      }
      throw err;
    }
  }

  /** Saldo + 50 mutasi terakhir. BigInt → Number (rupiah aman di 2^53). */
  async getBalance(userId: string): Promise<BalanceDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { balanceIdrx: true },
    });
    const entries = await this.prisma.balanceEntry.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      balanceIdrx: Number(user?.balanceIdrx ?? 0n),
      entries: entries.map((e) => ({
        id: e.id,
        deltaIdrx: Number(e.deltaIdrx),
        reason: e.reason,
        refId: e.refId,
        createdAt: e.createdAt,
      })),
    };
  }
}
