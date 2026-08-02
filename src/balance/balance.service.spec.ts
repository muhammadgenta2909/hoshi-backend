import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BalanceService } from './balance.service';

describe('BalanceService', () => {
  let service: BalanceService;
  let prisma: {
    $transaction: jest.Mock;
    balanceEntry: { create: jest.Mock; findMany: jest.Mock };
    user: { update: jest.Mock; findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      // Jalankan callback dengan prisma mock sebagai tx client.
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
      balanceEntry: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      user: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue({ balanceIdrx: 0n }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        BalanceService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(BalanceService);
  });

  it('credit: insert ledger + increment saldo dalam satu transaksi', async () => {
    const res = await service.credit({
      userId: 'u1',
      amountIdrx: 50_000,
      reason: 'P2P_SALE',
      refId: 'MOID-1',
    });

    expect(res.credited).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Ledger DULU (gerbang idempotensi) dengan delta BigInt.
    expect(prisma.balanceEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          deltaIdrx: 50000n,
          reason: 'P2P_SALE',
          refId: 'MOID-1',
        }) as unknown,
      }),
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'u1' },
        data: { balanceIdrx: { increment: 50000n } },
      }),
    );
  });

  it('credit IDEMPOTEN: (reason, refId) kembar → P2002 → tidak dobel-kredit', async () => {
    prisma.balanceEntry.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    );

    const res = await service.credit({
      userId: 'u1',
      amountIdrx: 50_000,
      reason: 'P2P_SALE',
      refId: 'MOID-1',
    });

    expect(res.credited).toBe(false); // sudah pernah dikredit
    // increment TIDAK terjadi (transaksi rollback saat create gagal).
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('credit menolak jumlah <= 0 (tak menyentuh DB)', async () => {
    await expect(
      service.credit({ userId: 'u1', amountIdrx: 0, reason: 'X' }),
    ).rejects.toThrow();
    await expect(
      service.credit({ userId: 'u1', amountIdrx: -5, reason: 'X' }),
    ).rejects.toThrow();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('getBalance: saldo BigInt→Number + mutasi', async () => {
    prisma.user.findUnique.mockResolvedValue({ balanceIdrx: 123_456n });
    prisma.balanceEntry.findMany.mockResolvedValue([
      {
        id: 'e1',
        deltaIdrx: 50_000n,
        reason: 'P2P_SALE',
        refId: 'MOID-1',
        createdAt: new Date('2026-08-02T00:00:00Z'),
      },
    ]);

    const bal = await service.getBalance('u1');

    expect(bal.balanceIdrx).toBe(123456);
    expect(bal.entries).toHaveLength(1);
    expect(bal.entries[0].deltaIdrx).toBe(50000);
    expect(typeof bal.entries[0].deltaIdrx).toBe('number');
  });
});
