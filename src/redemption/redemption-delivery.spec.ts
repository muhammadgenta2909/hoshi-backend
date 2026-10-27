import { HttpException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import type { CcShippingService } from '../collectorcrypt/cc-shipping.service';
import type { PaymentsService } from '../payments/payments.service';
import type { ShipmentNotifyService } from '../mail/shipment-notify.service';
import { RedemptionService } from './redemption.service';

jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
  clusterApiUrl: () => 'http://localhost:8899',
}));

/**
 * "Pesanan Diterima" + konfirmasi otomatis 7 hari. Nol uang, tapi tetap ada dua hal yang tidak
 * boleh salah: orang lain tidak boleh menutup paket kita, dan paket yang BELUM dikirim tidak
 * boleh bisa "diterima" (itu akan menghapusnya dari antrean kirim admin).
 */
describe('Penerimaan paket domestik', () => {
  const buyer: AuthUser = {
    id: 'buyer-1',
    walletAddress: 'BuyerWallet',
    displayName: null,
    role: 'USER',
  };
  const DAY = 24 * 60 * 60 * 1000;

  const baseRow = {
    id: 'red-1',
    userId: buyer.id,
    listingId: 'listing-1',
    nftAddress: 'hoshi-listing:listing-1',
    cardName: 'Charizard',
    cardImage: null,
    cardSet: null,
    recipientName: 'Genta',
    city: 'Tasikmalaya',
    country: 'ID',
    status: RedemptionStatus.SHIPPED,
    note: null,
    trackingIds: ['JNE123'],
    trackingUrls: [],
    createdAt: new Date('2026-10-01'),
    shippedAt: new Date('2026-10-20'),
    deliveredAt: null,
    deliveredBy: null,
  };

  const make = (row: Record<string, unknown> | null) => {
    let current = row ? { ...row } : null;
    const prisma = {
      cardRedemption: {
        findUnique: jest.fn(() => Promise.resolve(current)),
        findMany: jest.fn(),
        updateMany: jest.fn(
          (args: { where: { status: RedemptionStatus }; data: object }) => {
            if (current && current.status === args.where.status) {
              current = { ...current, ...args.data };
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          },
        ),
      },
    };
    const notify = { delivered: jest.fn(), shipped: jest.fn() };
    const service = new RedemptionService(
      prisma as unknown as PrismaService,
      {} as unknown as CcShippingService,
      {} as unknown as PaymentsService,
      notify as unknown as ShipmentNotifyService,
    );
    return { service, prisma, notify };
  };

  it('pembeli menekan "Pesanan Diterima" → DELIVERED oleh BUYER, pemilik & admin diberi tahu', async () => {
    const { service, notify } = make(baseRow);

    const dto = await service.confirmReceived('red-1', buyer);

    expect(dto.status).toBe(RedemptionStatus.DELIVERED);
    expect(dto.deliveredBy).toBe('BUYER');
    expect(dto.deliveredAt).toBeInstanceOf(Date);
    expect(notify.delivered).toHaveBeenCalledWith('red-1', 'BUYER');
  });

  it('ditekan dua kali → jawaban sama, email TIDAK terkirim dua kali', async () => {
    const { service, notify } = make(baseRow);
    await service.confirmReceived('red-1', buyer);
    const again = await service.confirmReceived('red-1', buyer);

    expect(again.status).toBe(RedemptionStatus.DELIVERED);
    expect(notify.delivered).toHaveBeenCalledTimes(1);
  });

  it('orang lain → ditolak, baris tidak berubah', async () => {
    const { service, prisma } = make(baseRow);
    await expect(
      service.confirmReceived('red-1', { ...buyer, id: 'stranger' }),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it.each([RedemptionStatus.PACKING, RedemptionStatus.REQUESTED])(
    'paket yang belum dikirim (%s) → TIDAK bisa diterima',
    async (status) => {
      const { service, prisma } = make({ ...baseRow, status });
      await expect(service.confirmReceived('red-1', buyer)).rejects.toThrow(
        /belum dikirim/,
      );
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    },
  );

  it('kiriman jalur CollectorCrypt → ditolak (statusnya dari pelacakan CC)', async () => {
    const { service, prisma } = make({ ...baseRow, listingId: null });
    await expect(service.confirmReceived('red-1', buyer)).rejects.toBeInstanceOf(
      HttpException,
    );
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('DTO memberi tahu kapan konfirmasi otomatis jatuh (shippedAt + 7 hari)', async () => {
    const { service, prisma } = make(baseRow);
    prisma.cardRedemption.findMany.mockResolvedValue([baseRow]);
    const [dto] = await service.listMine(buyer.id);
    expect(dto.autoConfirmAt?.getTime()).toBe(
      baseRow.shippedAt.getTime() + 7 * DAY,
    );
  });

  describe('konfirmasi otomatis', () => {
    it('hanya baris domestik SHIPPED yang lewat 7 hari yang ditanyakan', async () => {
      const { service, prisma } = make(baseRow);
      prisma.cardRedemption.findMany.mockResolvedValue([]);
      const now = new Date('2026-10-30T00:00:00Z');

      await service.autoConfirmDelivered(now);

      const where = (
        prisma.cardRedemption.findMany.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0].where;
      const cutoff = new Date(now.getTime() - 7 * DAY);
      expect(where).toEqual({
        status: RedemptionStatus.SHIPPED,
        listingId: { not: null },
        OR: [
          { shippedAt: { lte: cutoff } },
          { shippedAt: null, updatedAt: { lte: cutoff } },
        ],
      });
    });

    it('baris yang jatuh tempo → DELIVERED oleh AUTO + email', async () => {
      const { service, prisma, notify } = make(baseRow);
      prisma.cardRedemption.findMany.mockResolvedValue([
        { id: 'red-1', note: null },
      ]);

      const n = await service.autoConfirmDelivered(
        new Date('2026-10-30T00:00:00Z'),
      );

      expect(n).toBe(1);
      expect(notify.delivered).toHaveBeenCalledWith('red-1', 'AUTO');
    });

    it('pembeli sudah menekan tombol duluan → sapuan tidak menimpa, tidak ada email kedua', async () => {
      const { service, prisma, notify } = make({
        ...baseRow,
        status: RedemptionStatus.DELIVERED,
      });
      prisma.cardRedemption.findMany.mockResolvedValue([
        { id: 'red-1', note: null },
      ]);

      const n = await service.autoConfirmDelivered();

      expect(n).toBe(0);
      expect(notify.delivered).not.toHaveBeenCalled();
    });
  });
});
