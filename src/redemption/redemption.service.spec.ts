import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CcPackStatus, PaymentStatus, RedemptionStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import type { CcShippingService } from '../collectorcrypt/cc-shipping.service';
import type { PaymentsService } from '../payments/payments.service';
import {
  REDEMPTION_ACTIVE_STATUSES,
  REDEMPTION_TERMINAL_STATUSES,
  RedemptionService,
} from './redemption.service';

// RedemptionService -> CcShippingService -> TreasuryService menarik @solana/web3.js (rantai ESM
// yang bikin jest gagal parse). CcShippingService di sini cuma token DI yang selalu di-mock.
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
 * B4 — ANTI DOBEL-REDEEM DI LEVEL API.
 *
 * Bug-nya: ACTIVE_STATUSES dulu hanya REQUESTED/PACKING/SHIPPED, jadi baris jalur REAL — termasuk
 * FUNDED, yang berarti USDC treasury SUDAH ada di wallet user — tidak memblokir redemption kedua
 * untuk mint yang sama. Satu-satunya yang menahan cuma UI, jadi panggilan API berulang bisa
 * mendanai kartu yang sama dua kali.
 */
describe('RedemptionService.request — in-flight statuses block a second redemption (B4)', () => {
  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };
  const dto = { nftAddress: 'NftAddrBase58', shippingAddressId: 'addr-1' };

  const make = () => {
    const tx = {
      cardRedemption: {
        create: jest.fn().mockResolvedValue({ id: 'red-new' }),
      },
      activity: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      ccPackPurchase: {
        findFirst: jest.fn().mockResolvedValue({
          userId: user.id,
          nftAddress: dto.nftAddress,
          status: CcPackStatus.OPENED,
          ccItemName: 'Charizard',
          nftName: 'Charizard',
          nftImage: null,
          ccSet: 'Base',
          ccCategory: null,
        }),
      },
      listing: { findFirst: jest.fn() },
      shippingAddress: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'addr-1',
          userId: user.id,
          fullName: 'Budi',
          country: 'ID',
          street: 'Jl. Merdeka 1',
          apt: null,
          city: 'Jakarta',
          state: 'DKI Jakarta',
          zip: '12345',
          phoneCountryCode: null,
          phoneNumber: null,
        }),
      },
      cardRedemption: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn(
        (cb: (t: typeof tx) => Promise<unknown>): Promise<unknown> => cb(tx),
      ),
    };
    const service = new RedemptionService(
      prisma as unknown as PrismaService,
      {} as unknown as CcShippingService,
      {} as unknown as PaymentsService,
    );
    return { service, prisma, tx };
  };

  /** Status yang HARUS memblokir — daftar ini DITULIS ULANG di sini dengan sengaja, bukan diimpor,
   *  supaya perubahan diam-diam di service ketahuan sebagai test yang gagal. */
  const MUST_BLOCK: RedemptionStatus[] = [
    RedemptionStatus.REQUESTED,
    RedemptionStatus.PACKING,
    RedemptionStatus.SHIPPED,
    RedemptionStatus.AWAITING_PAYMENT,
    RedemptionStatus.READY_TO_FUND,
    RedemptionStatus.FUNDING,
    RedemptionStatus.FUNDED,
    RedemptionStatus.BURN_SUBMITTED,
    RedemptionStatus.IN_TRANSIT,
    RedemptionStatus.RECLAIM_DUE,
    RedemptionStatus.SHIP_FAILED_POST_BURN,
  ];

  /** Status SELESAI/BATAL — redemption baru untuk mint yang sama harus tetap boleh. */
  const MUST_NOT_BLOCK: RedemptionStatus[] = [
    RedemptionStatus.CANCELED,
    RedemptionStatus.DELIVERED,
    RedemptionStatus.REFUND_DUE,
  ];

  it.each(MUST_BLOCK)(
    'blocks a second redemption while an existing row is %s',
    async (status) => {
      const { service, prisma, tx } = make();
      // findFirst dipanggil dengan filter status; kita tiru DB: baris ini cocok.
      prisma.cardRedemption.findFirst.mockResolvedValue({
        id: 'red-old',
        status,
      });

      await expect(service.request(dto, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(tx.cardRedemption.create).not.toHaveBeenCalled();

      // Dan yang PENTING: status itu memang ada di filter yang dikirim ke DB.
      const calls = prisma.cardRedemption.findFirst.mock
        .calls as unknown as Array<
        [{ where: { status: { in: RedemptionStatus[] } } }]
      >;
      expect(calls[0][0].where.status.in).toContain(status);
    },
  );

  it.each(MUST_NOT_BLOCK)(
    'does NOT block when the only existing row is %s (terminal/cancelled)',
    async (status) => {
      const { service, prisma, tx } = make();
      // Baris terminal TIDAK boleh ikut filter → DB tidak mengembalikan apa pun.
      const where = { status: { in: [] as RedemptionStatus[] } };
      prisma.cardRedemption.findFirst.mockImplementation(
        (args: { where: { status: { in: RedemptionStatus[] } } }) => {
          Object.assign(where, args.where);
          return Promise.resolve(null);
        },
      );

      await service.request(dto, user);

      expect(tx.cardRedemption.create).toHaveBeenCalled();
      expect(where.status.in).not.toContain(status);
    },
  );

  it('the FUNDED hole specifically: a funded row (treasury USDC already sent) now blocks', async () => {
    const { service, prisma, tx } = make();
    prisma.cardRedemption.findFirst.mockResolvedValue({
      id: 'red-old',
      status: RedemptionStatus.FUNDED,
    });

    await expect(service.request(dto, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.cardRedemption.create).not.toHaveBeenCalled();
  });

  it('every RedemptionStatus is classified exactly once (a new status defaults to blocking)', () => {
    const all = Object.values(RedemptionStatus);
    const active = [...REDEMPTION_ACTIVE_STATUSES];
    const terminal = [...REDEMPTION_TERMINAL_STATUSES];

    expect([...active].sort()).toEqual([...MUST_BLOCK].sort());
    expect([...terminal].sort()).toEqual([...MUST_NOT_BLOCK].sort());
    // Tidak ada yang tumpang tindih, dan tidak ada yang terlupa.
    expect(active.filter((s) => terminal.includes(s))).toEqual([]);
    expect([...active, ...terminal].sort()).toEqual([...all].sort());
  });

  /**
   * ⚠️ TEST INI HANYA MENJAGA DOKUMENTASINYA TETAP SINKRON — IA BUKAN BUKTI.
   *
   * Versi sebelumnya bernama "every blocking status has at least one declared exit" dan HIJAU
   * sepanjang bug B1 yang KETIGA hidup: yang diperiksanya cuma "ada STRING di tabel ini untuk
   * status tersebut?". Baris AWAITING_PAYMENT-nya ADA dan terbaca meyakinkan, sementara di
   * produksi KEEMPAT jalan keluar yang disebutnya tertutup serentak begitu PaymentOrder yang
   * dipin masuk ke FULFILLING/REFUND_DUE. Sebuah kalimat tidak pernah membuka kunci kartu.
   *
   * BUKTI YANG SEBENARNYA — jalan keluar sebagai FUNGSI yang benar-benar dipanggil, diuji pada
   * SETIAP kombinasi status redemption × status PaymentOrder — ada di:
   *     src/redemption/redemption-exit-reachability.spec.ts
   * Menambah status pemblokir baru tanpa jalan keluar yang BISA DIJALANKAN akan MERAH di sana.
   * Yang tetap dijaga di sini cuma satu: tabel dokumentasinya tidak boleh ketinggalan zaman.
   */
  it('the documented exit table stays in sync with the blocking set (docs only — proof lives in redemption-exit-reachability.spec.ts)', () => {
    const EXIT: Record<string, string> = {
      [RedemptionStatus.REQUESTED]:
        'POST /payments/shipping -> AWAITING_PAYMENT; POST /redemptions/:id/cancel -> CANCELED; PATCH admin -> PACKING/SHIPPED/CANCELED',
      [RedemptionStatus.PACKING]: 'PATCH admin -> SHIPPED/CANCELED',
      [RedemptionStatus.SHIPPED]: 'PATCH admin -> DELIVERED',
      [RedemptionStatus.AWAITING_PAYMENT]:
        'fulfilShipping -> READY_TO_FUND; invoice EXPIRED (recordUnfulfilled) -> REQUESTED; createShippingOrder ulang -> invoice sama / REQUESTED; POST /redemptions/:id/cancel -> CANCELED (berlaku juga saat order ongkirnya FULFILLING/REFUND_DUE); POST /admin/redemptions/:id/cancel-awaiting-payment -> CANCELED (berlaku untuk SETIAP status order)',
      [RedemptionStatus.READY_TO_FUND]:
        'fundAndPrepare -> FUNDING; POST /admin/redemptions/:id/settle-refund-due -> REFUND_DUE',
      [RedemptionStatus.FUNDING]:
        'fundAndPrepare sukses -> FUNDED; PATCH admin -> RECLAIM_DUE',
      [RedemptionStatus.FUNDED]:
        'submitBurn -> BURN_SUBMITTED; PATCH admin -> RECLAIM_DUE',
      [RedemptionStatus.BURN_SUBMITTED]:
        'refreshStatus (poll CC) -> IN_TRANSIT/DELIVERED/SHIP_FAILED_POST_BURN; POST /admin/redemptions/:id/recover-burn-submitted -> FUNDED',
      [RedemptionStatus.IN_TRANSIT]: 'refreshStatus (poll CC) -> DELIVERED',
      [RedemptionStatus.RECLAIM_DUE]: 'PATCH admin -> CANCELED (refundSafe TETAP false)',
      [RedemptionStatus.SHIP_FAILED_POST_BURN]: 'PATCH admin -> DELIVERED',
    };

    for (const status of REDEMPTION_ACTIVE_STATUSES) {
      expect(EXIT[status]).toBeDefined();
      expect((EXIT[status] ?? '').length).toBeGreaterThan(0);
    }
    // Dan tidak ada baris tabel yang tertinggal untuk status yang sudah tak memblokir.
    expect(Object.keys(EXIT).sort()).toEqual([...REDEMPTION_ACTIVE_STATUSES].sort());
  });
});

/**
 * B1 — BATAL SENDIRI untuk baris yang BELUM menyentuh uang.
 *
 * Ini setengah dari jalan keluar AWAITING_PAYMENT (setengah lainnya: kedaluwarsanya invoice, di
 * PaymentsService). Pagarnya tiga lapis dan SEMUANYA diuji di sini: status, ledger order, dan
 * jejak pasca-danai di baris (fundingSignature/refundSafe).
 */
describe('RedemptionService.cancel (B1)', () => {
  const user = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  } as const;
  const ID = 'red-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: ID,
    userId: user.id,
    nftAddress: 'NftAddrBase58',
    cardName: 'Charizard',
    cardImage: null,
    cardSet: null,
    recipientName: 'Budi',
    city: 'Jakarta',
    country: 'ID',
    status: RedemptionStatus.AWAITING_PAYMENT,
    note: null,
    createdAt: new Date('2026-08-20T00:00:00.000Z'),
    fundingSignature: null,
    refundSafe: true,
    ...over,
  });

  const make = () => {
    const prisma = {
      cardRedemption: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        // B1 — pembukuan pasca-batal (recordShippingRefundDebts): order ongkir yang macet di
        // FULFILLING diubah jadi utang tercatat. Default: tidak ada order sama sekali.
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const service = new RedemptionService(
      prisma as unknown as PrismaService,
      {} as unknown as CcShippingService,
      {} as unknown as PaymentsService,
    );
    return { service, prisma };
  };

  it('cancels a REQUESTED row atomically and never writes refundSafe', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(row({ status: RedemptionStatus.REQUESTED }))
      .mockResolvedValueOnce(row({ status: RedemptionStatus.CANCELED }));

    const res = await service.cancel(ID, user, 'salah alamat');

    expect(res.status).toBe(RedemptionStatus.CANCELED);
    const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Predikatnya mengulang KETIGA pagar → tidak bisa basi karena balapan.
    expect(call.where).toEqual({
      id: ID,
      userId: user.id,
      status: {
        in: [RedemptionStatus.REQUESTED, RedemptionStatus.AWAITING_PAYMENT],
      },
      fundingSignature: null,
      refundSafe: true,
    });
    expect(call.data.status).toBe(RedemptionStatus.CANCELED);
    // refundSafe DIBACA sebagai predikat, TIDAK PERNAH ditulis.
    expect('refundSafe' in call.data).toBe(false);
    expect(String(call.data.note)).toContain('salah alamat');
  });

  it('cancels an AWAITING_PAYMENT row whose invoice was never paid', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: RedemptionStatus.CANCELED }));

    await service.cancel(ID, user);

    expect(prisma.cardRedemption.updateMany).toHaveBeenCalledTimes(1);
    // Ledger order DIPERIKSA — bukan diasumsikan.
    const q = prisma.paymentOrder.findFirst.mock.calls[0][0] as {
      where: { status: { in: PaymentStatus[] } };
    };
    // B1 (kambuh ke-3): daftarnya SEMPIT dengan sengaja. FULFILLING dan REFUND_DUE SENGAJA TIDAK
    // di sini — memblokir keduanya menutup SETIAP jalan keluar AWAITING_PAYMENT sekaligus, dan
    // membiarkannya lewat tidak menghilangkan uang (utangnya pindah ke baris PaymentOrder).
    expect(q.where.status.in).toEqual([
      PaymentStatus.PAID,
      PaymentStatus.FULFILLED,
    ]);
  });

  it('B1: cancels even when the pinned shipping order is stuck FULFILLING, and records the debt', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ status: RedemptionStatus.CANCELED }));
    // Order yang macet: klaim atomik sudah diambil lalu prosesnya mati (deploy/OOM/restart).
    prisma.paymentOrder.findMany.mockResolvedValue([
      {
        merchantOrderId: 'HOSHI-SHIP-1',
        priceIdr: 125_000,
        status: PaymentStatus.FULFILLING,
        refundSafe: true,
        userId: user.id,
      },
    ]);

    const res = await service.cancel(ID, user, 'tab IDRX ketutup');

    expect(res.status).toBe(RedemptionStatus.CANCELED);
    // Order-nya jadi utang TERCATAT — bukan hilang bersama redemption-nya.
    const debtWrite = prisma.paymentOrder.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(debtWrite.where).toEqual({
      merchantOrderId: 'HOSHI-SHIP-1',
      status: PaymentStatus.FULFILLING,
    });
    expect(debtWrite.data.status).toBe(PaymentStatus.REFUND_DUE);
    // refundSafe DIBACA & dilaporkan, TIDAK PERNAH ditulis oleh jalur ini.
    expect('refundSafe' in debtWrite.data).toBe(false);
    expect(res.shippingDebts).toEqual([
      expect.objectContaining({
        merchantOrderId: 'HOSHI-SHIP-1',
        priceIdr: 125_000,
        statusBefore: PaymentStatus.FULFILLING,
        statusAfter: PaymentStatus.REFUND_DUE,
        recordedNow: true,
        refundSafe: true,
      }),
    ]);
  });

  it('REFUSES every status where money has moved or the shipment is under way', async () => {
    for (const status of [
      RedemptionStatus.READY_TO_FUND,
      RedemptionStatus.FUNDING,
      RedemptionStatus.FUNDED,
      RedemptionStatus.BURN_SUBMITTED,
      RedemptionStatus.IN_TRANSIT,
      RedemptionStatus.RECLAIM_DUE,
      RedemptionStatus.SHIP_FAILED_POST_BURN,
      RedemptionStatus.PACKING,
      RedemptionStatus.SHIPPED,
      RedemptionStatus.DELIVERED,
      RedemptionStatus.REFUND_DUE,
      RedemptionStatus.CANCELED,
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(row({ status }));

      await expect(service.cancel(ID, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    }
  });

  it('REFUSES when a shipping payment has already landed (that is a refund decision, not a button)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(row());
    prisma.paymentOrder.findFirst.mockResolvedValue({
      merchantOrderId: 'ORDER-1',
      status: PaymentStatus.PAID,
    });

    await expect(service.cancel(ID, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });

  it('REFUSES a row carrying post-fund traces even if its status still looks cancellable', async () => {
    for (const over of [
      { fundingSignature: 'FUNDSIG' },
      { refundSafe: false },
    ]) {
      const { service, prisma } = make();
      prisma.cardRedemption.findUnique.mockResolvedValue(row(over));

      await expect(service.cancel(ID, user)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      // Bahkan ledger order tidak perlu dibaca — jejak di baris sudah cukup untuk menolak.
      expect(prisma.paymentOrder.findFirst).not.toHaveBeenCalled();
    }
  });

  it('409s when the guarded write loses a race (e.g. the payment landed a moment ago)', async () => {
    const { service, prisma } = make();
    prisma.cardRedemption.findUnique.mockResolvedValue(row());
    prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.cancel(ID, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('404s for an unknown redemption and 403s for someone else\'s', async () => {
    const missing = make();
    missing.prisma.cardRedemption.findUnique.mockResolvedValue(null);
    await expect(missing.service.cancel(ID, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const foreign = make();
    foreign.prisma.cardRedemption.findUnique.mockResolvedValue(
      row({ userId: 'someone-else' }),
    );
    await expect(foreign.service.cancel(ID, user)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(foreign.prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ RESI HARUS SAMPAI KE PEMBELI — `GET /redemptions/me` yang membawanya.                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Bug-nya BUKAN di database dan BUKAN di frontend. Admin mengisi resi dan menandai SHIPPED; resinya
 * TERSIMPAN di kolom `trackingIds`. Frontend `/withdraw` dan `/withdraw/history` SUDAH merender
 * baris "Resi: …". Yang putus ada di tengah: `CardRedemptionDto` tidak membawa kolom itu, jadi
 * nilainya selalu `undefined` dan barisnya tidak pernah muncul.
 *
 * Pada saat yang sama kartunya sudah hilang dari Vault (status SHIPPED). Jadi sesudah membayar dua
 * kali — kartu + ongkir — pembeli melihat kartunya lenyap dan tidak punya SATU PUN cara melacak
 * paketnya. (Sisi Vault-nya ditutup terpisah: `SHIPPED` tidak lagi menyembunyikan kartu.)
 *
 * KEDUANYA KOLOM BIASA di baris `CardRedemption` — BUKAN hasil panggilan ke CollectorCrypt. Jadi
 * `listMine` TIDAK BOLEH menuntut sesi CC, token, header, atau flag apa pun untuk mengembalikannya.
 */
describe('RedemptionService.listMine — resi ikut terbawa (kolom biasa, bukan panggilan CC)', () => {
  const USER_ID = 'user-1';

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'red-1',
    userId: USER_ID,
    nftAddress: 'hoshi-listing:listing-1',
    listingId: 'listing-1',
    cardName: 'Charizard',
    cardImage: null,
    cardSet: 'Base',
    recipientName: 'Budi',
    city: 'Jakarta',
    country: 'ID',
    status: RedemptionStatus.SHIPPED,
    trackingIds: ['JNE-0012345678'],
    trackingUrls: ['https://jne.co.id/track/JNE-0012345678'],
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    ...over,
  });

  const make = (rows: Record<string, unknown>[]) => {
    const prisma = {
      cardRedemption: { findMany: jest.fn().mockResolvedValue(rows) },
    };
    const ccShipping = {};
    const service = new RedemptionService(
      prisma as unknown as PrismaService,
      // Stub KOSONG dengan sengaja: kalau jalur ini diam-diam mulai memanggil CollectorCrypt,
      // test ini meledak keras alih-alih lulus sambil menyeret rail yang salah.
      ccShipping as unknown as CcShippingService,
      {} as unknown as PaymentsService,
    );
    return { service, prisma };
  };

  it('membawa trackingIds dan trackingUrls APA ADANYA dari baris', async () => {
    const { service } = make([row()]);

    const [out] = await service.listMine(USER_ID);

    expect(out.trackingIds).toEqual(['JNE-0012345678']);
    expect(out.trackingUrls).toEqual([
      'https://jne.co.id/track/JNE-0012345678',
    ]);
  });

  it('baris tanpa resi mengembalikan array KOSONG, bukan undefined', async () => {
    // Array kosong adalah jawaban yang jujur ("resinya memang belum ada"); `undefined` tidak bisa
    // dibedakan dari "field-nya hilang lagi" dan itulah bug yang sedang ditutup.
    const { service } = make([row({ trackingIds: [], trackingUrls: [] })]);

    const [out] = await service.listMine(USER_ID);

    expect(out.trackingIds).toEqual([]);
    expect(out.trackingUrls).toEqual([]);
  });

  it('nol panggilan CollectorCrypt dan nol header sesi yang dituntut', async () => {
    const { service, prisma } = make([row()]);

    await service.listMine(USER_ID);

    // Satu query, ke tabelnya sendiri. Tidak ada argumen kredensial di tanda tangan `listMine`.
    expect(prisma.cardRedemption.findMany).toHaveBeenCalledTimes(1);
    expect(service.listMine.length).toBe(1);
  });
});
