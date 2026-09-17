import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import type { MarketplaceService } from '../marketplace/marketplace.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from '../auth/admin.guard';
import { AdminService } from './admin.service';

// AdminService -> MarketplaceService -> EscrowService/NftService menarik rantai ESM Solana v1
// (umi-bundle-defaults -> web3.js -> rpc-websockets/uuid) yang bikin jest gagal parse. Pola sama
// dengan marketplace.service.spec.ts: MarketplaceService di sini cuma token DI yang di-mock kosong,
// jadi tak ada key dibaca / tx ditandatangani.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));
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
 * B3 — PEMULIHAN OPERATOR untuk baris yang nyangkut di BURN_SUBMITTED.
 *
 * `updateRedemptionStatus` SENGAJA tidak bisa menggerakkan BURN_SUBMITTED (itu tetap berlaku).
 * Rute pemulihan ini adalah SATU-SATUNYA jalan keluar tanpa mengedit Postgres — dan ia sempit
 * dengan sengaja: hanya BURN_SUBMITTED -> FUNDED, wajib beralasan, refundSafe tetap false.
 */
describe('AdminService.recoverBurnSubmittedToFunded (B3)', () => {
  const admin = {
    id: 'admin-1',
    walletAddress: 'AdminWalletBase58',
    role: 'ADMIN',
  };
  const REDEMPTION_ID = 'red-1';
  const NOTE = 'Verified with CC support ticket #4821: shipment never burned.';

  const row = (
    status: RedemptionStatus,
    over: Partial<{
      note: string | null;
      fundingSignature: string | null;
      refundSafe: boolean;
      paymentOrderId: string | null;
    }> = {},
  ) => ({
    id: REDEMPTION_ID,
    status,
    userId: 'user-1',
    nftAddress: 'NftAddrBase58',
    outboundShipmentId: 'ship-1',
    refundSafe: false,
    note: null as string | null,
    fundingSignature: null as string | null,
    paymentOrderId: null as string | null,
    ...over,
  });

  const make = () => {
    const prisma = {
      cardRedemption: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
    };
    const service = new AdminService(
      prisma as unknown as PrismaService,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
      {} as unknown as MarketplaceService,
    );
    return { service, prisma };
  };

  it('moves BURN_SUBMITTED -> FUNDED atomically, keeps refundSafe FALSE, and persists the operator note', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(row(RedemptionStatus.BURN_SUBMITTED))
      .mockResolvedValueOnce(row(RedemptionStatus.FUNDED));

    const res = await service.recoverBurnSubmittedToFunded(
      REDEMPTION_ID,
      NOTE,
      admin,
    );

    expect(prisma.cardRedemption.updateMany).toHaveBeenCalledTimes(1);
    const calls = prisma.cardRedemption.updateMany.mock
      .calls as unknown as Array<
      [
        {
          where: { id: string; status: RedemptionStatus };
          data: { status: RedemptionStatus; refundSafe: boolean; note: string };
        },
      ]
    >;
    const call = calls[0][0];
    // Berpagar status: balapan dengan poll CC tidak bisa memundurkan IN_TRANSIT/DELIVERED.
    expect(call.where).toEqual({
      id: REDEMPTION_ID,
      status: RedemptionStatus.BURN_SUBMITTED,
    });
    expect(call.data.status).toBe(RedemptionStatus.FUNDED);
    // TIDAK PERNAH membuat uang bisa di-refund.
    expect(call.data.refundSafe).toBe(false);
    // Alasan operator + siapa + kapan ikut tersimpan di baris.
    expect(call.data.note).toContain(NOTE);
    expect(call.data.note).toContain(admin.id);
    expect(call.data.note).toContain('BURN_SUBMITTED->FUNDED');
    expect(call.data.note.length).toBeLessThanOrEqual(500);

    // Response memuat peringatan bahwa operator MENYATAKAN sudah verifikasi ke CC.
    expect(res.warning).toContain('CollectorCrypt');
    expect(res.warning).toContain('refundSafe');
  });

  it('refuses any source status other than BURN_SUBMITTED, and writes nothing', async () => {
    for (const status of [
      RedemptionStatus.FUNDED,
      RedemptionStatus.FUNDING,
      RedemptionStatus.READY_TO_FUND,
      RedemptionStatus.IN_TRANSIT,
      RedemptionStatus.DELIVERED,
      RedemptionStatus.RECLAIM_DUE,
      RedemptionStatus.REQUESTED,
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(row(status));

      await expect(
        service.recoverBurnSubmittedToFunded(REDEMPTION_ID, NOTE, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
    }
  });

  it('requires an explicit operator reason and never touches the row without one', async () => {
    for (const note of ['', '   ', 'too short']) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(
        row(RedemptionStatus.BURN_SUBMITTED),
      );

      await expect(
        service.recoverBurnSubmittedToFunded(REDEMPTION_ID, note, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    }
  });

  it('404s for an unknown redemption', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(null);

    await expect(
      service.recoverBurnSubmittedToFunded(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('409s when the row moved between the read and the guarded write (no silent walk-back)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(
      row(RedemptionStatus.BURN_SUBMITTED),
    );
    prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.recoverBurnSubmittedToFunded(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  /* ────────────────────────────────── B2 ──────────────────────────────────
     `note` adalah SATU-SATUNYA string DURABEL yang membedakan "submitBurn LEG GAGAL" /
     "submitBurn INDETERMINATE" / "submitBurn DITOLAK CC tanpa membakar apa pun" (log droplet
     dirotasi; baris DB tidak). Kalau attestation operator MENIMPA-nya, aksi pemulihan ini
     menghapus penyebab baris nyangkut — itulah cara ia bisa MENUTUPI kerugian nyata: lewat efek
     samping, bukan lewat desain. Dua test berikut MEMAKU perilaku menambah + aturan pemotongan,
     karena fixture tanpa `note` membuat assertion "toContain(NOTE)" saja tetap lolos meski
     kodenya dikembalikan ke `persistedNote.slice(0, 500)`. */
  it('B2: APPENDS the attestation — the prior failure reason that explains the stuck row survives', async () => {
    const { service, prisma } = make();
    const PRIOR =
      '[submitBurn INDETERMINATE 2026-09-16T10:00:00.000Z] CC menjawab 500 SESUDAH burn dikirim; ' +
      'hasil TIDAK DIKETAHUI. JANGAN refund.';
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(
        row(RedemptionStatus.BURN_SUBMITTED, { note: PRIOR }),
      )
      .mockResolvedValueOnce(row(RedemptionStatus.FUNDED));

    await service.recoverBurnSubmittedToFunded(REDEMPTION_ID, NOTE, admin);

    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      data: { note: string };
    };
    // Bukti LAMA tidak boleh hilang, dan bukti BARU ikut tercatat — dua-duanya, berurutan.
    expect(call.data.note).toContain(PRIOR);
    expect(call.data.note).toContain(NOTE);
    expect(call.data.note.indexOf(PRIOR)).toBeLessThan(
      call.data.note.indexOf(NOTE),
    );
  });

  it('B2: on overflow the OLDEST part is dropped — the NEWEST failure reason is never the casualty', async () => {
    const { service, prisma } = make();
    const OLDEST = 'PALING-TUA-boleh-hilang';
    const PRIOR = `${OLDEST}${'x'.repeat(600)}PALING-BARU-DARI-YANG-LAMA`;
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(
        row(RedemptionStatus.BURN_SUBMITTED, { note: PRIOR }),
      )
      .mockResolvedValueOnce(row(RedemptionStatus.FUNDED));

    await service.recoverBurnSubmittedToFunded(REDEMPTION_ID, NOTE, admin);

    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      data: { note: string };
    };
    expect(call.data.note.length).toBeLessThanOrEqual(500);
    // Yang TERBARU utuh...
    expect(call.data.note).toContain(NOTE);
    // ...ekor catatan lama bertahan...
    expect(call.data.note).toContain('PALING-BARU-DARI-YANG-LAMA');
    // ...dan yang dibuang adalah KEPALA (paling tua), ditandai elipsis.
    expect(call.data.note).not.toContain(OLDEST);
    expect(call.data.note.startsWith('…')).toBe(true);
  });

  it('is NOT reachable through the generic status endpoint (BURN_SUBMITTED stays immovable there)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(
      row(RedemptionStatus.BURN_SUBMITTED),
    );

    await expect(
      service.updateRedemptionStatus(REDEMPTION_ID, RedemptionStatus.FUNDED),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
  });
});

/**
 * B1#4 — SATU-SATUNYA JALAN KELUAR untuk READY_TO_FUND, dan SATU-SATUNYA PENULIS
 * RedemptionStatus.REFUND_DUE di seluruh repo.
 *
 * READY_TO_FUND = ongkir Rupiah SUDAH LUNAS, USDC BELUM dikirim. Sebelum aksi ini baris seperti
 * itu tersangkut SELAMANYA (tak ada transisi admin, tak ada rute user) dan kartunya ikut terkunci,
 * sementara copy error-nya menjanjikan refund yang tak ada kodenya. Aksi ini sempit DENGAN SENGAJA:
 * satu transisi, wajib beralasan, dan tiga syarat uang ikut jadi PREDIKAT tulisan berpagarnya.
 */
describe('AdminService.settleReadyToFundAsRefundDue (B1#4)', () => {
  const admin = {
    id: 'admin-1',
    walletAddress: 'AdminWalletBase58',
    role: 'ADMIN',
  };
  const REDEMPTION_ID = 'red-1';
  const NOTE = 'Harga CC naik 22% dan tidak turun lagi; ongkir Rupiah dikembalikan manual.';

  /** Baris READY_TO_FUND yang SEHAT: Rupiah lunas, NOL jejak pasca-danai. */
  const readyRow = (
    over: Partial<{
      status: RedemptionStatus;
      note: string | null;
      fundingSignature: string | null;
      refundSafe: boolean;
      paymentOrderId: string | null;
    }> = {},
  ) => ({
    id: REDEMPTION_ID,
    status: RedemptionStatus.READY_TO_FUND,
    userId: 'user-1',
    nftAddress: 'NftAddrBase58',
    outboundShipmentId: null,
    // Dua kolom jejak PASCA-danai, pada nilai "belum pernah didanai".
    fundingSignature: null as string | null,
    refundSafe: true,
    note: null as string | null,
    paymentOrderId: 'order-row-1' as string | null,
    ...over,
  });

  const ORDER = {
    id: 'order-row-1',
    merchantOrderId: 'HOSHI-SHIP-001',
    priceIdr: 125_000,
    status: 'FULFILLED',
    paidAt: new Date('2026-09-16T09:00:00.000Z'),
  };

  const make = () => {
    const prisma = {
      cardRedemption: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue(ORDER),
        findFirst: jest.fn().mockResolvedValue(ORDER),
      },
    };
    const service = new AdminService(
      prisma as unknown as PrismaService,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
      {} as unknown as MarketplaceService,
    );
    return { service, prisma };
  };

  it('moves READY_TO_FUND -> REFUND_DUE and NEVER writes refundSafe (it is a PREDICATE, not a write)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(readyRow())
      .mockResolvedValueOnce(readyRow({ status: RedemptionStatus.REFUND_DUE }));

    await service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin);

    expect(prisma.cardRedemption.updateMany).toHaveBeenCalledTimes(1);
    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Tulisan BERPAGAR: KETIGA syarat uang diulang di predikat, jadi keputusan di atas tidak bisa
    // basi karena balapan (mis. fundAndPrepare yang menang klaim READY_TO_FUND -> FUNDING).
    expect(call.where).toEqual({
      id: REDEMPTION_ID,
      status: RedemptionStatus.READY_TO_FUND,
      fundingSignature: null,
      refundSafe: true,
    });
    expect(call.data.status).toBe(RedemptionStatus.REFUND_DUE);
    // ATURAN MUTLAK REPO INI: tidak ada satu pun tempat yang boleh MENULIS refundSafe.
    expect(call.data).not.toHaveProperty('refundSafe');
    expect(String(call.data.note)).toContain(NOTE);
    expect(String(call.data.note)).toContain('READY_TO_FUND->REFUND_DUE');
    expect(String(call.data.note).length).toBeLessThanOrEqual(500);
  });

  it('tells the operator PLAINLY that the Rupiah really is refundable and that THEY must send it', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(readyRow())
      .mockResolvedValueOnce(readyRow({ status: RedemptionStatus.REFUND_DUE }));

    const res = await service.settleReadyToFundAsRefundDue(
      REDEMPTION_ID,
      NOTE,
      admin,
    );

    // Di READY_TO_FUND nol USDC pernah bergerak → Rupiah BENAR-BENAR aman di-refund, dan itu
    // dinyatakan sebagai hasil VERIFIKASI, bukan asumsi. Refundnya manual: tak ada kode pengirim.
    expect(res.warning).toContain('refundSafe');
    expect(res.warning).toContain('DI LUAR');
    // Operator harus tahu PERSIS apa yang dikembalikan.
    expect(res.rupiahOrder).toEqual({
      merchantOrderId: ORDER.merchantOrderId,
      priceIdr: ORDER.priceIdr,
      status: ORDER.status,
      paidAt: ORDER.paidAt,
    });
  });

  it('refuses every source status except READY_TO_FUND, and writes nothing', async () => {
    for (const status of [
      RedemptionStatus.REQUESTED,
      RedemptionStatus.AWAITING_PAYMENT,
      RedemptionStatus.FUNDING,
      RedemptionStatus.FUNDED,
      RedemptionStatus.BURN_SUBMITTED,
      RedemptionStatus.IN_TRANSIT,
      RedemptionStatus.DELIVERED,
      RedemptionStatus.RECLAIM_DUE,
      RedemptionStatus.REFUND_DUE,
      RedemptionStatus.CANCELED,
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(readyRow({ status }));

      await expect(
        service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
    }
  });

  /* FAIL-CLOSED — inti keamanan uangnya. Kalau baris READY_TO_FUND toh membawa jejak pasca-danai,
     USDC mungkin SUDAH keluar: me-refund Rupiah-nya = rugi DOBEL. Ditolak, bukan "diperiksa
     sambil jalan". */
  it('FAIL-CLOSED: refuses a READY_TO_FUND row carrying post-fund traces (double-loss guard)', async () => {
    for (const over of [
      { fundingSignature: 'SIG_ALREADY_SENT' },
      { refundSafe: false },
      { fundingSignature: 'SIG_ALREADY_SENT', refundSafe: false },
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(readyRow(over));

      await expect(
        service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    }
  });

  it('requires an explicit operator reason and never reads or touches the row without one', async () => {
    for (const note of ['', '   ', 'too short']) {
      const { service, prisma } = make();

      await expect(
        service.settleReadyToFundAsRefundDue(REDEMPTION_ID, note, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    }
  });

  it('404s for an unknown redemption', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(null);

    await expect(
      service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('409s when funding claimed the row a moment earlier (never declares a refund over moving money)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(readyRow());
    prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('B2: APPENDS to the row note rather than overwriting the earlier record', async () => {
    const { service, prisma } = make();
    const PRIOR = '[fundAndPrepare 2026-09-16T11:00:00.000Z] guard biaya MENOLAK: ongkir CC naik.';
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(readyRow({ note: PRIOR }))
      .mockResolvedValueOnce(readyRow({ status: RedemptionStatus.REFUND_DUE }));

    await service.settleReadyToFundAsRefundDue(REDEMPTION_ID, NOTE, admin);

    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      data: { note: string };
    };
    expect(call.data.note).toContain(PRIOR);
    expect(call.data.note).toContain(NOTE);
  });

  it('is NOT reachable through the generic status endpoint (READY_TO_FUND stays immovable there)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(readyRow());

    await expect(
      service.updateRedemptionStatus(
        REDEMPTION_ID,
        RedemptionStatus.REFUND_DUE,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
  });
});

/**
 * B1 (kambuh ke-3) — JALAN KELUAR TERAKHIR untuk AWAITING_PAYMENT.
 *
 * Sebelum ini, `allowed` di updateRedemptionStatus tidak punya kunci AWAITING_PAYMENT dan kedua
 * rute pemulihan lain hanya menerima BURN_SUBMITTED / READY_TO_FUND — jadi admin TIDAK PUNYA satu
 * pun cara menggerakkan baris AWAITING_PAYMENT. Digabung dengan tombol user yang menolak order
 * FULFILLING/REFUND_DUE, hasilnya kunci kartu PERMANEN yang hanya bisa dibuka lewat edit Postgres.
 */
describe('AdminService.cancelAwaitingPayment (B1 — last-resort exit)', () => {
  const admin = {
    id: 'admin-1',
    walletAddress: 'AdminWalletBase58',
    role: 'ADMIN',
  };
  const REDEMPTION_ID = 'red-1';
  const NOTE = 'User tidak pernah kembali sejak deploy 16 Sep; order ongkirnya macet di FULFILLING.';

  const awaitingRow = (
    over: Partial<{
      status: RedemptionStatus;
      note: string | null;
      fundingSignature: string | null;
      refundSafe: boolean;
    }> = {},
  ) => ({
    id: REDEMPTION_ID,
    status: RedemptionStatus.AWAITING_PAYMENT,
    userId: 'user-1',
    nftAddress: 'NftAddrBase58',
    outboundShipmentId: null,
    fundingSignature: null as string | null,
    refundSafe: true,
    note: null as string | null,
    paymentOrderId: 'order-row-1' as string | null,
    ...over,
  });

  const make = (orders: unknown[] = []) => {
    const prisma = {
      cardRedemption: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn(),
      },
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue(orders),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AdminService(
      prisma as unknown as PrismaService,
      {} as unknown as JwtService,
      {} as unknown as ConfigService,
      {} as unknown as MarketplaceService,
    );
    return { service, prisma };
  };

  it('moves AWAITING_PAYMENT -> CANCELED with a guarded write and NEVER writes refundSafe', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(awaitingRow())
      .mockResolvedValueOnce(awaitingRow({ status: RedemptionStatus.CANCELED }));

    await service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin);

    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({
      id: REDEMPTION_ID,
      status: RedemptionStatus.AWAITING_PAYMENT,
      fundingSignature: null,
      refundSafe: true,
    });
    expect(call.data.status).toBe(RedemptionStatus.CANCELED);
    expect('refundSafe' in call.data).toBe(false);
    expect(String(call.data.note)).toContain('ADMIN CANCEL AWAITING_PAYMENT->CANCELED');
    expect(String(call.data.note)).toContain(NOTE);
  });

  it('turns a shipping order stuck in FULFILLING into a RECORDED debt and reports it', async () => {
    const { service, prisma } = make([
      {
        merchantOrderId: 'HOSHI-SHIP-1',
        priceIdr: 125_000,
        status: PaymentStatus.FULFILLING,
        refundSafe: true,
        userId: 'user-1',
      },
    ]);
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(awaitingRow())
      .mockResolvedValueOnce(awaitingRow({ status: RedemptionStatus.CANCELED }));

    const res = await service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin);

    const debt = prisma.paymentOrder.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(debt.where).toEqual({
      merchantOrderId: 'HOSHI-SHIP-1',
      status: PaymentStatus.FULFILLING,
    });
    expect(debt.data.status).toBe(PaymentStatus.REFUND_DUE);
    expect('refundSafe' in debt.data).toBe(false);
    expect(res.shippingDebts).toEqual([
      expect.objectContaining({
        merchantOrderId: 'HOSHI-SHIP-1',
        priceIdr: 125_000,
        statusAfter: PaymentStatus.REFUND_DUE,
        recordedNow: true,
      }),
    ]);
    expect(res.warning).toContain('shippingDebts');
  });

  it('leaves a PAID order alone (the reconciler still converts it) but REPORTS it', async () => {
    const { service, prisma } = make([
      {
        merchantOrderId: 'HOSHI-SHIP-2',
        priceIdr: 99_000,
        status: PaymentStatus.PAID,
        refundSafe: true,
        userId: 'user-1',
      },
    ]);
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(awaitingRow())
      .mockResolvedValueOnce(awaitingRow({ status: RedemptionStatus.CANCELED }));

    const res = await service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin);

    expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    expect(res.shippingDebts[0]).toEqual(
      expect.objectContaining({
        merchantOrderId: 'HOSHI-SHIP-2',
        statusBefore: PaymentStatus.PAID,
        statusAfter: PaymentStatus.PAID,
        recordedNow: false,
      }),
    );
  });

  it('refuses every source status except AWAITING_PAYMENT, and writes nothing', async () => {
    for (const status of [
      RedemptionStatus.REQUESTED,
      RedemptionStatus.READY_TO_FUND,
      RedemptionStatus.FUNDING,
      RedemptionStatus.FUNDED,
      RedemptionStatus.BURN_SUBMITTED,
      RedemptionStatus.IN_TRANSIT,
      RedemptionStatus.RECLAIM_DUE,
      RedemptionStatus.DELIVERED,
      RedemptionStatus.CANCELED,
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(awaitingRow({ status }));
      await expect(
        service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    }
  });

  it('FAIL-CLOSED: refuses a row carrying post-fund traces (that is a RECLAIM_DUE case)', async () => {
    for (const over of [{ fundingSignature: 'FUNDSIG' }, { refundSafe: false }]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(awaitingRow(over));
      await expect(
        service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    }
  });

  it('requires an explicit operator reason and never reads or touches the row without one', async () => {
    const { service, prisma } = make();
    await expect(
      service.cancelAwaitingPayment(REDEMPTION_ID, 'pendek', admin),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('409s when the payment landed a moment earlier and fulfilShipping won the claim', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(awaitingRow());
    prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(ConflictException);
    // Dan TIDAK ada utang yang dideklarasikan atas baris yang ternyata tidak jadi dibatalkan.
    expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
  });

  it('404s for an unknown redemption', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(null);
    await expect(
      service.cancelAwaitingPayment(REDEMPTION_ID, NOTE, admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is NOT reachable through the generic status endpoint (AWAITING_PAYMENT stays immovable there)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(awaitingRow());
    await expect(
      service.updateRedemptionStatus(REDEMPTION_ID, RedemptionStatus.CANCELED),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
  });
});

/** Rute-nya dijaga AdminGuard yang sama dengan mutasi admin lain: non-admin ditolak 403. */
describe('AdminGuard — the recovery route is admin-only', () => {
  const guard = new AdminGuard();
  const ctx = {} as never;

  it('rejects a normal logged-in user', () => {
    expect(() =>
      guard.handleRequest(null, { role: 'USER' }, undefined, ctx),
    ).toThrow(ForbiddenException);
  });

  it('allows an ADMIN', () => {
    expect(
      guard.handleRequest(null, { role: 'ADMIN' }, undefined, ctx),
    ).toEqual({ role: 'ADMIN' });
  });
});
