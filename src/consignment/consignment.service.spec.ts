import { ConflictException, ForbiddenException } from '@nestjs/common';
import { ConsignmentPhotoKind, ConsignmentStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { BalanceService } from '../balance/balance.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ConsignmentService } from './consignment.service';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TITIPAN — KARTU ORANG LAIN DI TANGAN HOSHI. Yang diuji di sini adalah URUTAN-nya.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Risiko yang ditakutkan pemilik produk: "jangan sampai ada case misal kita jual kartu seseorang,
 * tapi dia ternyata jual pribadi ke orang lain." Yang menutupnya bukan kepintaran melainkan
 * URUTAN — kartunya sudah di tangan Hoshi SEBELUM listing-nya tayang — dan urutan itu ditegakkan
 * oleh satu hal: `createListingFor` adalah satu-satunya penulis `Listing.consignmentId`, dan ia
 * membuat baris listing di dalam transaksi yang SAMA dengan klaim berpredikat `custodyAcceptedAt`.
 */
describe('ConsignmentService', () => {
  const ID = 'consign-1';
  const ACCEPTED = new Date('2026-09-01T00:00:00.000Z');

  const admin: AuthUser = {
    id: 'admin-1',
    walletAddress: 'AdminWalletBase58Addr',
    displayName: 'PM Hoshi',
    role: 'ADMIN',
  };
  const consignor: AuthUser = {
    id: 'user-7',
    walletAddress: 'ConsignorWalletBase58',
    displayName: 'Budi',
    role: 'USER',
  };

  type Mock = jest.Mock;
  let prisma: {
    consignment: {
      findUnique: Mock;
      findFirst: Mock;
      findMany: Mock;
      create: Mock;
      updateMany: Mock;
    };
    consignmentPhoto: { createMany: Mock };
    consignmentEvent: { create: Mock };
    listing: { create: Mock; updateMany: Mock };
    offer: { updateMany: Mock };
    activity: { create: Mock };
    user: { findUnique: Mock; findUniqueOrThrow: Mock };
    $transaction: Mock;
  };
  let balance: { credit: Mock };
  let service: ConsignmentService;

  /** Baris titipan lengkap seperti dikembalikan `requireConsignment` (include photos + listing). */
  const rowWith = (over: Record<string, unknown> = {}) => ({
    id: ID,
    consignorId: consignor.id,
    consignorNameAtIntake: 'Budi',
    consignorPhoneAtIntake: '+62811',
    receivedById: admin.id,
    receivedAtPlace: 'Rumah pemilik, Bandung',
    cardName: 'Charizard',
    cardSet: 'Base',
    cardNumber: '4/102',
    language: 'English',
    tcg: 'Pokemon',
    grader: 'PSA',
    certNumber: '12345678',
    gradeLabel: 'PSA 10',
    gradeScore: 10,
    conditionNote: 'Slab utuh, tidak ada retak, label lurus.',
    askPriceIdr: 1_000_000,
    commissionBps: 500,
    status: ConsignmentStatus.IN_CUSTODY,
    custodyAcceptedAt: ACCEPTED,
    custodyReleasedAt: null,
    storageLocation: 'Rak A-3, Jakarta',
    withdrawRequestedAt: null,
    photos: [
      { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
      { id: 'p2', kind: ConsignmentPhotoKind.BACK },
      { id: 'p3', kind: ConsignmentPhotoKind.CERT },
    ],
    listing: null as Record<string, unknown> | null,
    events: [],
    ...over,
  });

  /** Setiap `data` yang pernah ditulis ke tabel consignment, lewat updateMany. */
  const allConsignmentWrites = (): Record<string, unknown>[] =>
    (
      prisma.consignment.updateMany.mock.calls as [
        { data: Record<string, unknown> },
      ][]
    ).map(([a]) => a.data);

  beforeEach(() => {
    prisma = {
      consignment: {
        findUnique: jest.fn().mockResolvedValue(rowWith()),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue(rowWith()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      consignmentPhoto: { createMany: jest.fn().mockResolvedValue({}) },
      consignmentEvent: { create: jest.fn().mockResolvedValue({}) },
      listing: {
        create: jest.fn().mockResolvedValue({
          id: 'listing-1',
          name: 'Charizard',
          image: '/x.png',
          category: 'Consignment',
          set: 'Base',
          priceIdrx: 1_000_000,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      offer: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      activity: { create: jest.fn().mockResolvedValue({}) },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: consignor.id,
          walletAddress: consignor.walletAddress,
          displayName: consignor.displayName,
        }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: consignor.id,
          walletAddress: consignor.walletAddress,
          displayName: consignor.displayName,
        }),
      },
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
    };
    balance = { credit: jest.fn().mockResolvedValue({ credited: true }) };
    service = new ConsignmentService(
      prisma as unknown as PrismaService,
      balance as unknown as BalanceService,
    );
  });

  /* ════════════════════════ MENERIMA CUSTODY: STEMPEL YANG TAK PERNAH DIHAPUS ═══════════════ */

  describe('acceptCustody — satu-satunya penulis custodyAcceptedAt', () => {
    const dto = { storageLocation: 'Rak A-3, Jakarta' };

    it('klaim ATOMIK dari INTAKE, berpredikat custodyAcceptedAt: null (ditulis SEKALI)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await service.acceptCustody(ID, dto, admin);

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: ID,
            status: ConsignmentStatus.INTAKE,
            custodyAcceptedAt: null,
          },
          data: expect.objectContaining({
            status: ConsignmentStatus.IN_CUSTODY,
            custodyAcceptedAt: expect.any(Date) as unknown,
            storageLocation: dto.storageLocation,
          }) as unknown,
        }),
      );
    });

    it('kalah klaim (sudah diterima permintaan lain) → CONFLICT, tidak ada stempel kedua', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );
      prisma.consignment.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.acceptCustody(ID, dto, admin)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: 'CONSIGNMENT_BAD_TRANSITION',
          }) as unknown,
        },
      );
    });

    it('menolak dari status mana pun selain INTAKE — stempelnya tidak bisa ditulis ulang', async () => {
      for (const status of [
        ConsignmentStatus.IN_CUSTODY,
        ConsignmentStatus.LISTED,
        ConsignmentStatus.SOLD,
        ConsignmentStatus.RELEASED,
        ConsignmentStatus.LOST,
        ConsignmentStatus.CANCELLED,
      ]) {
        prisma.consignment.findUnique.mockResolvedValue(rowWith({ status }));
        await expect(service.acceptCustody(ID, dto, admin)).rejects.toThrow();
      }
    });

    it('BUKTI WAJIB: tanpa foto DEPAN/BELAKANG, serah-terima TIDAK dicatat', async () => {
      // Menerima kartu orang lain tanpa foto membuat SETIAP sengketa nanti tidak bisa dimenangkan
      // oleh siapa pun — termasuk oleh pemiliknya.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          photos: [],
        }),
      );

      await expect(service.acceptCustody(ID, dto, admin)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: 'CONSIGNMENT_EVIDENCE_REQUIRED',
          }) as unknown,
        },
      );
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('BUKTI WAJIB: slab bernomor sertifikat menuntut foto CERT — identitas yang bisa dicek di situs grader', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          photos: [
            { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
            { id: 'p2', kind: ConsignmentPhotoKind.BACK },
          ],
        }),
      );

      await expect(service.acceptCustody(ID, dto, admin)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: 'CONSIGNMENT_EVIDENCE_REQUIRED',
            message: expect.stringContaining('CERT') as unknown,
          }) as unknown,
        },
      );
    });

    it('kartu MENTAH (tanpa nomor sertifikat) cukup DEPAN/BELAKANG', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          certNumber: null,
          grader: null,
          photos: [
            { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
            { id: 'p2', kind: ConsignmentPhotoKind.BACK },
          ],
        }),
      );

      await expect(
        service.acceptCustody(ID, dto, admin),
      ).resolves.toBeDefined();
    });

    it('LOKASI PENYIMPANAN wajib: kartu orang lain yang tak tercatat ada di rak mana belum benar-benar kita pegang', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await expect(
        service.acceptCustody(ID, { storageLocation: '   ' }, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_EVIDENCE_REQUIRED',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('SIAPA & KAPAN tercatat: baris audit menyebut pelakunya, di transaksi yang sama', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await service.acceptCustody(ID, dto, admin);

      expect(prisma.consignmentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consignmentId: ID,
            kind: 'ACCEPT_CUSTODY',
            fromStatus: ConsignmentStatus.INTAKE,
            toStatus: ConsignmentStatus.IN_CUSTODY,
            actorId: admin.id,
          }) as unknown,
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  /* ══════════════════════ MEMAJANG: URUTAN YANG MENUTUP RISIKO JUAL-GANDA ═════════════════════ */

  describe('createListingFor — satu-satunya penulis Listing.consignmentId', () => {
    const dto = { image: '/consign/front.jpg' };

    it('MENOLAK kalau serah-terima belum tercatat — TIDAK ADA baris listing yang dibuat', async () => {
      // Inilah kalimat intinya: orang yang belum menyerahkan kartunya masih memegangnya, jadi
      // ia masih bisa menjualnya sendiri. Listing yang tayang lebih dulu = dua pembeli, satu kartu.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await expect(
        service.createListingFor(ID, dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_NOT_IN_CUSTODY',
        }) as unknown,
      });
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('MENOLAK kalau kartunya sudah KELUAR (ditarik / dikirim / hilang)', async () => {
      for (const status of [
        ConsignmentStatus.RELEASED,
        ConsignmentStatus.LOST,
      ]) {
        prisma.listing.create.mockClear();
        prisma.consignment.findUnique.mockResolvedValue(
          rowWith({ status, custodyReleasedAt: new Date() }),
        );
        await expect(
          service.createListingFor(ID, dto, admin),
        ).rejects.toThrow();
        expect(prisma.listing.create).not.toHaveBeenCalled();
      }
    });

    it('klaim custody DULU; kalau klaimnya kalah, TIDAK ADA baris listing yang lahir', async () => {
      prisma.consignment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.createListingFor(ID, dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('klaimnya BERPREDIKAT fakta custody, dan Listing.create ada di transaksi yang SAMA', async () => {
      await service.createListingFor(ID, dto, admin);

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: ID,
            status: ConsignmentStatus.IN_CUSTODY,
            custodyAcceptedAt: { not: null },
            custodyReleasedAt: null,
            listing: { is: null },
          }) as unknown,
          data: { status: ConsignmentStatus.LISTED },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.listing.create).toHaveBeenCalledTimes(1);
    });

    it('baris Listing yang dibuat BERBENTUK sesuai CHECK constraint — tidak bisa menempuh escrow', async () => {
      await service.createListingFor(ID, dto, admin);

      const data = (
        prisma.listing.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      // consignmentId ADA; sellerId NON-NULL (selalu ada yang harus dibayar).
      expect(data.consignmentId).toBe(ID);
      expect(data.sellerId).toBe(consignor.id);
      // ccNftAddress & escrowedAt TIDAK PERNAH DITULIS → NULL di DB → `isEscrowBackedUserListing`
      // mustahil true → settlement escrow menolak SEBELUM klaim ACTIVE→SOLD diambil.
      expect(data.ccNftAddress).toBeUndefined();
      expect(data.escrowedAt).toBeUndefined();
      // sellable TIDAK di-set true → default false → tidak bisa masuk fulfilHoshiInventory
      // (jalur yang akan menyimpan 100% untuk Hoshi dan tidak membayar pemiliknya).
      expect(data.sellable).toBeUndefined();
      // source TIDAK di-set → default HOSHI → bukan COLLECTORCRYPT (fisiknya di rak kita).
      expect(data.source).toBeUndefined();
      expect(data.status).toBe('ACTIVE');
    });

    it('harga listing mengikuti harga yang DISEPAKATI kalau tidak ditimpa', async () => {
      await service.createListingFor(ID, dto, admin);
      const data = (
        prisma.listing.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(data.priceIdrx).toBe(1_000_000);
    });

    it('kartu MENTAH belum bisa dipajang: mengarang grader = memberi label palsu pada kartu orang lain', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ grader: null }),
      );

      await expect(
        service.createListingFor(ID, dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_UNSUPPORTED_ACTION',
        }) as unknown,
      });
      expect(prisma.listing.create).not.toHaveBeenCalled();
      // Titipannya TETAP tercatat dan TETAP bisa ditarik — yang ditunda hanya pemajangannya.
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════════════════ PENARIKAN: TUAS KEPERCAYAAN ═══════════════════════════ */

  describe('requestWithdrawal', () => {
    it('INTAKE → CANCELLED: kesepakatan batal, tidak ada kartu yang pernah berpindah', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await service.requestWithdrawal(ID, {}, consignor);

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ID, status: ConsignmentStatus.INTAKE },
          data: expect.objectContaining({
            status: ConsignmentStatus.CANCELLED,
          }) as unknown,
        }),
      );
    });

    it('IN_CUSTODY: permintaan TERCATAT; custody tidak dilepas sampai serah-terimanya nyata', async () => {
      await service.requestWithdrawal(
        ID,
        { note: 'mau dipakai turnamen' },
        consignor,
      );

      const data = allConsignmentWrites()[0];
      expect(data.withdrawRequestedAt).toEqual(expect.any(Date));
      // `custodyReleasedAt` TIDAK ditulis di sini: kartunya masih di rak sampai benar-benar
      // diserahkan kembali, dan yang mencatat penyerahan itu adalah manusia yang melakukannya.
      expect(data.custodyReleasedAt).toBeUndefined();
    });

    it('LISTED: pajangan dan catatan titipan turun BERSAMAAN, dalam SATU transaksi', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LISTED,
          listing: { id: 'listing-1', image: null, category: null, set: null },
        }),
      );

      await service.requestWithdrawal(ID, {}, consignor);

      // Gerbang ACTIVE→CANCELLED menutup jendela beli SEBELUM apa pun yang lain disentuh —
      // bentuk yang PERSIS sama dengan MarketplaceService.cancel di jalur P2P.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'listing-1', consignmentId: ID, status: 'ACTIVE' },
          data: { status: 'CANCELLED' },
        }),
      );
      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: ID,
            status: ConsignmentStatus.LISTED,
            custodyReleasedAt: null,
          }) as unknown,
          data: expect.objectContaining({
            status: ConsignmentStatus.IN_CUSTODY,
          }) as unknown,
        }),
      );
      expect(prisma.offer.updateMany).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('KALAH BALAPAN (listing sudah terjual): DITOLAK, dan catatan titipan TIDAK disentuh', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LISTED,
          listing: { id: 'listing-1', image: null, category: null, set: null },
        }),
      );
      prisma.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.requestWithdrawal(ID, {}, consignor),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
          message: expect.stringContaining('sudah terjual') as unknown,
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('SOLD: ditolak SELALU — kartunya sudah milik pembeli', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.SOLD }),
      );

      await expect(
        service.requestWithdrawal(ID, {}, consignor),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    });

    it('hanya PEMILIK kartunya (atau admin) yang bisa memintanya kembali', async () => {
      const stranger: AuthUser = {
        id: 'user-99',
        walletAddress: 'W',
        displayName: null,
        role: 'USER',
      };
      await expect(service.requestWithdrawal(ID, {}, stranger)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        service.requestWithdrawal(ID, {}, admin),
      ).resolves.toBeDefined();
    });

    it('GRATIS: tidak ada satu pun mutasi saldo di SETIAP jalur penarikan', async () => {
      // Itu SELURUH nilai tuas ini. Biaya penyimpanan/penanganan/listing akan menghapusnya.
      for (const status of [
        ConsignmentStatus.INTAKE,
        ConsignmentStatus.IN_CUSTODY,
        ConsignmentStatus.LISTED,
      ]) {
        prisma.consignment.findUnique.mockResolvedValue(
          rowWith({
            status,
            custodyAcceptedAt:
              status === ConsignmentStatus.INTAKE ? null : ACCEPTED,
            listing:
              status === ConsignmentStatus.LISTED
                ? { id: 'listing-1', image: null, category: null, set: null }
                : null,
          }),
        );
        await service.requestWithdrawal(ID, {}, consignor);
      }
      expect(balance.credit).not.toHaveBeenCalled();
    });
  });

  /* ════════════════ KARTU KELUAR: DUA FAKTA APPEND-ONLY, TIDAK ADA YANG DIHAPUS ════════════════ */

  describe('release / markLost', () => {
    it('release WITHDRAWN dari IN_CUSTODY menulis custodyReleasedAt sekali, berpagar null', async () => {
      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'dikembalikan ke pemilik langsung',
        },
        admin,
      );

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: ID,
            status: ConsignmentStatus.IN_CUSTODY,
            custodyReleasedAt: null,
          },
          data: expect.objectContaining({
            status: ConsignmentStatus.RELEASED,
            custodyReleasedAt: expect.any(Date) as unknown,
            releaseReason: 'WITHDRAWN',
          }) as unknown,
        }),
      );
    });

    it('SHIPPED_TO_BUYER hanya sah dari SOLD; WITHDRAWN hanya dari IN_CUSTODY', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.SOLD }),
      );
      await expect(
        service.release(
          ID,
          { releaseReason: 'WITHDRAWN', note: 'salah rute' },
          admin,
        ),
      ).rejects.toThrow();

      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.IN_CUSTODY }),
      );
      await expect(
        service.release(
          ID,
          { releaseReason: 'SHIPPED_TO_BUYER', note: 'salah rute' },
          admin,
        ),
      ).rejects.toThrow();
    });

    it('"hilang" TIDAK BISA dicatat sebagai pengembalian biasa — ia punya rutenya sendiri', async () => {
      await expect(
        service.release(
          ID,
          { releaseReason: 'LOST', note: 'kartunya hilang' },
          admin,
        ),
      ).rejects.toThrow();
    });

    it('markLost menurunkan listing yang masih hidup di transaksi yang SAMA', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LISTED,
          listing: { id: 'listing-1' },
        }),
      );

      await service.markLost(ID, { note: 'rusak saat pemindahan rak' }, admin);

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ConsignmentStatus.LOST,
            custodyReleasedAt: expect.any(Date) as unknown,
            releaseReason: 'LOST',
          }) as unknown,
        }),
      );
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'listing-1', consignmentId: ID, status: 'ACTIVE' },
          data: { status: 'CANCELLED' },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('kartu yang TIDAK PERNAH diserahkan tidak bisa "hilang" di tangan kita', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );
      await expect(
        service.markLost(ID, { note: 'tidak pernah kami pegang' }, admin),
      ).rejects.toThrow();
    });

    it('ganti rugi IDEMPOTEN per titipan: kunci ledger = id titipan, bukan stempel waktu', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
        }),
      );

      await service.compensate(
        ID,
        { amountIdr: 900_000, note: 'kesepakatan ganti rugi dengan pemilik' },
        admin,
      );

      expect(balance.credit).toHaveBeenCalledWith({
        userId: consignor.id,
        amountIdrx: 900_000,
        reason: 'CONSIGNMENT_COMPENSATION',
        refId: ID,
      });
    });
  });

  /* ═════════════════════ BUKTI: APPEND-ONLY, KOREKSI TERLIHAT SEBAGAI KOREKSI ═════════════════ */

  describe('bukti tidak bisa diubah diam-diam', () => {
    it('koreksi TIDAK menimpa kolom apa pun — ia menulis baris audit BARU', async () => {
      await service.addCorrection(
        ID,
        { note: 'Nomor sertifikat salah ketik: 12345678, bukan 12345679.' },
        admin,
      );

      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
      expect(prisma.consignmentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'CORRECTION',
            actorId: admin.id,
          }) as unknown,
        }),
      );
    });

    it('foto hanya bisa DITAMBAH; tidak ada satu pun method yang mengubah/menghapusnya', () => {
      // Foto yang bisa diam-diam diganti sesudah sengketa dimulai TIDAK ADA HARGANYA sebagai
      // bukti — bagi kedua pihak. Jadi tidak ada rute update/delete sama sekali, dan test ini
      // akan merah pada detik seseorang menambahkannya.
      const names = Object.getOwnPropertyNames(Object.getPrototypeOf(service));
      expect(names).toContain('addPhotos');
      expect(
        names.filter(
          (n) => /(update|delete|remove|edit)/i.test(n) && /photo/i.test(n),
        ),
      ).toEqual([]);
      // Dan tidak ada tulisan foto selain createMany di seluruh alur yang diuji suite ini.
      expect(Object.keys(prisma.consignmentPhoto)).toEqual(['createMany']);
    });

    it('TIDAK ADA satu pun tulisan di service ini yang MENGHAPUS fakta custody', async () => {
      // Ini peningkatan yang disengaja atas `escrowedAt`, yang MASIH bisa dihapus (dengan bukti
      // dari rantai). Di sini tidak ada rantai, jadi tidak ada penghapusan sama sekali: dua kolom
      // append-only. Kelas bug "satu aksi biasa menghapus satu-satunya petunjuk" jadi TIDAK ADA.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );
      await service.acceptCustody(ID, { storageLocation: 'Rak A-3' }, admin);
      prisma.consignment.findUnique.mockResolvedValue(rowWith());
      await service.createListingFor(ID, { image: '/x.png' }, admin);
      await service.requestWithdrawal(ID, {}, consignor);
      await service.release(
        ID,
        { releaseReason: 'WITHDRAWN', note: 'dikembalikan ke pemilik' },
        admin,
      );

      for (const data of allConsignmentWrites()) {
        expect(data.custodyAcceptedAt).not.toBeNull();
        expect(data.custodyReleasedAt).not.toBeNull();
      }
    });
  });

  /* ═════════════════════════════ DASHBOARD: TERLIHAT ATAU TIDAK ADA ══════════════════════════ */

  describe('adminList — actionRequired', () => {
    it('menyorot permintaan penarikan yang serah-terimanya belum dicatat, dan SOLD yang masih di rak', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'a',
          status: ConsignmentStatus.IN_CUSTODY,
          withdrawRequestedAt: new Date(),
          createdAt: new Date(),
        }),
        rowWith({
          id: 'b',
          status: ConsignmentStatus.SOLD,
          createdAt: new Date(),
        }),
        rowWith({
          id: 'c',
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          createdAt: new Date('2020-01-01T00:00:00.000Z'),
        }),
        rowWith({ id: 'd', createdAt: new Date() }),
      ]);

      const out = await service.adminList();

      expect(out.actionRequired.map((r) => r.id).sort()).toEqual([
        'a',
        'b',
        'c',
      ]);
      expect(out.rows.find((r) => r.id === 'd')?.inCustody).toBe(true);
      expect(out.rows.find((r) => r.id === 'b')?.inCustody).toBe(false);
    });
  });

  /* ═════════════════════════════ ANTI-DOBEL-TITIP ══════════════════════════ */

  describe('createIntake', () => {
    it('menolak slab bernomor sertifikat yang SUDAH jadi titipan hidup', async () => {
      prisma.consignment.findFirst.mockResolvedValue({
        id: 'other',
        status: ConsignmentStatus.IN_CUSTODY,
      });

      await expect(
        service.createIntake(
          {
            consignorId: consignor.id,
            consignorNameAtIntake: 'Budi',
            consignorPhoneAtIntake: '+62811',
            receivedAtPlace: 'Bandung',
            cardName: 'Charizard',
            grader: 'PSA',
            certNumber: '12345678',
            conditionNote: 'Slab utuh, label lurus.',
            askPriceIdr: 1_000_000,
          },
          admin,
        ),
      ).rejects.toThrow(ConflictException);
      expect(prisma.consignment.create).not.toHaveBeenCalled();
    });

    it('lahir di status INTAKE — belum boleh dipajang oleh apa pun', async () => {
      await service.createIntake(
        {
          consignorId: consignor.id,
          consignorNameAtIntake: 'Budi',
          consignorPhoneAtIntake: '+62811',
          receivedAtPlace: 'Bandung',
          cardName: 'Charizard',
          conditionNote: 'Slab utuh, label lurus.',
          askPriceIdr: 1_000_000,
        },
        admin,
      );

      const data = (
        prisma.consignment.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(data.status).toBe(ConsignmentStatus.INTAKE);
      expect(data.custodyAcceptedAt).toBeUndefined();
      // SNAPSHOT nama/telepon, bukan bacaan hidup dari tabel users.
      expect(data.consignorNameAtIntake).toBe('Budi');
      expect(data.consignorPhoneAtIntake).toBe('+62811');
      // Penerimanya = orang yang memanggil rute ini.
      expect(data.receivedById).toBe(admin.id);
    });

    it('komisi DI-SNAPSHOT saat intake (default 500 bps = 5%)', async () => {
      await service.createIntake(
        {
          consignorId: consignor.id,
          consignorNameAtIntake: 'Budi',
          consignorPhoneAtIntake: '+62811',
          receivedAtPlace: 'Bandung',
          cardName: 'Charizard',
          conditionNote: 'Slab utuh, label lurus.',
          askPriceIdr: 1_000_000,
          commissionBps: 500,
        },
        admin,
      );
      const data = (
        prisma.consignment.create.mock.calls[0] as [
          { data: Record<string, unknown> },
        ]
      )[0].data;
      expect(data.commissionBps).toBe(500);
    });
  });
});
