import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  ConsignmentPhotoKind,
  ConsignmentStatus,
  Prisma,
} from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { BalanceService } from '../balance/balance.service';
import {
  CLAIM_CODE_TTL_DAYS,
  hashClaimCode,
  normalizeClaimCode,
} from '../common/consignment-claim-code';
import { assertConsignmentSaleAvailable } from '../common/consignment.gate';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConsignmentNotifyService } from './consignment-notify.service';
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
    /**
     * Tabel tarif ongkir yang SUDAH ADA — dibaca `resolveDomesticShippingIdr` saat menaksir
     * ongkir balik. Ada di mock ini justru untuk MEMBUKTIKAN bahwa jalur pengembalian memakai
     * tarif yang SAMA dengan kirim domestik, bukan daftar keduanya sendiri.
     */
    domesticShippingRate: { findMany: Mock };
    /**
     * Ledger saldo. Dibaca DUA tempat sejak ganti rugi berhenti bisa gagal diam-diam:
     * `compensate` (pra-cek "sudah pernah tercatat?") dan `adminList` (titipan LOST yang ganti
     * ruginya belum ada sama sekali harus TETAP muncul di "Perlu tindakan").
     */
    balanceEntry: { findFirst: Mock; findMany: Mock };
    /**
     * Baris pembayaran PEMBELI. Rail utang yang SUDAH ADA (PaymentStatus.REFUND_DUE) — dipakai
     * saat kartu yang SUDAH TERJUAL hilang di rak: yang tidak menerima apa pun adalah pembelinya.
     */
    paymentOrder: { findUnique: Mock; updateMany: Mock };
    /** Jalur kirim: dibaca untuk menemukan paket yang sudah berangkat tapi custody-nya menggantung. */
    cardRedemption: { findMany: Mock };
    listing: { create: Mock; updateMany: Mock };
    offer: { updateMany: Mock };
    activity: { create: Mock };
    user: {
      findUnique: Mock;
      findUniqueOrThrow: Mock;
      findMany: Mock;
      count: Mock;
    };
    $transaction: Mock;
  };
  let balance: { credit: Mock };
  /**
   * Notifier pemilik kartu. DI-MOCK, bukan dimatikan: beberapa test di bawah memang MEMERIKSA
   * bahwa pemiliknya diberi tahu — halaman titipan menjanjikannya secara tertulis, jadi "tidak
   * ada email yang dikirim" adalah regresi produk, bukan detail implementasi.
   */
  let notify: { notifyListed: Mock; notifySold: Mock; notifyLost: Mock };
  /** Pembaca env — dipakai HANYA untuk menaksir ongkir balik (lihat `beforeEach`). */
  let config: { get: Mock };
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
    /**
     * RENCANA PENGEMBALIAN — KOSONG di fixture dasar, dan itu memang keadaan awal setiap kartu:
     * selama pemiliknya belum meminta kartunya kembali, tidak ada alamat tujuan yang benar untuk
     * disimpan. Test yang bicara soal pengembalian menimpanya sendiri.
     */
    returnMethod: null,
    returnRecipientName: null,
    returnPhoneCountryCode: null,
    returnPhoneNumber: null,
    returnStreet: null,
    returnApt: null,
    returnCity: null,
    returnState: null,
    returnZip: null,
    returnCountry: null,
    returnCourier: null,
    returnTrackingNo: null,
    returnPickedUpBy: null,
    returnShippingPayer: null,
    returnShippingFeeIdr: null,
    /**
     * Bukti LENGKAP menurut gerbang hari ini: keadaan barangnya (FRONT/BACK/CERT) DAN adanya
     * kesepakatan (HANDOVER = foto struk serah terima bertanda tangan).
     *
     * `p4` ada di fixture DASAR, bukan cuma di test yang memeriksanya, karena fixture ini juga
     * dipakai oleh test lain yang kebetulan melewati acceptCustody dan tidak sedang bicara soal
     * bukti sama sekali. Test yang memeriksa bukti KURANG menimpa daftar ini sendiri.
     */
    photos: [
      { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
      { id: 'p2', kind: ConsignmentPhotoKind.BACK },
      { id: 'p3', kind: ConsignmentPhotoKind.CERT },
      { id: 'p4', kind: ConsignmentPhotoKind.HANDOVER },
    ],
    listing: null as Record<string, unknown> | null,
    events: [],
    ...over,
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ BUKTI SERAH-TERIMA PENGEMBALIAN YANG PALING SEDERHANA YANG SAH: DIAMBIL SENDIRI.       ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Dipakai test-test yang TIDAK sedang bicara soal pengembalian tapi kebetulan melewati
   * `release` — sama seperti foto `p4` di fixture dasar. Sengaja PICKUP dan bukan COURIER: ia
   * bentuk terpendek yang lolos gerbang, jadi test yang memakainya tidak ikut menguji alamat
   * tanpa sadar. Test yang MEMANG menguji alamat menuliskannya sendiri.
   */
  const PICKUP_HANDOVER = {
    returnPlan: { returnMethod: 'PICKUP' },
    returnPickedUpBy:
      'Budi Santoso (pemilik), KTP dicocokkan dengan catatan intake',
  };

  /** Alamat pengembalian LENGKAP — bentuk yang sama dengan alamat kirim domestik. */
  const RETURN_ADDRESS = {
    recipientName: 'Budi Santoso',
    phoneNumber: '081234567890',
    street: 'Jl. Merdeka No. 10',
    city: 'Kota Bandung',
    state: 'Jawa Barat',
    zip: '40115',
  };

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
      domesticShippingRate: { findMany: jest.fn().mockResolvedValue([]) },
      balanceEntry: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      cardRedemption: { findMany: jest.fn().mockResolvedValue([]) },
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
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
    };
    balance = { credit: jest.fn().mockResolvedValue({ credited: true }) };
    notify = {
      notifyListed: jest.fn(),
      notifySold: jest.fn(),
      notifyLost: jest.fn(),
    };
    // Pembaca env. DI-MOCK KOSONG dengan sengaja: satu-satunya env yang dibaca service ini
    // adalah HOSHI_DOMESTIC_SHIPPING_FLAT_IDR saat MENAKSIR ongkir balik, dan membiarkannya
    // kosong memaksa taksirannya jatuh ke tier PENAMPUNG di kode — lapis yang tidak butuh DB
    // maupun env, jadi test tidak pernah bergantung pada isi mesin yang menjalankannya.
    config = { get: jest.fn().mockReturnValue(undefined) };
    service = new ConsignmentService(
      prisma as unknown as PrismaService,
      balance as unknown as BalanceService,
      notify as unknown as ConsignmentNotifyService,
      config as unknown as ConfigService,
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
            { id: 'p4', kind: ConsignmentPhotoKind.HANDOVER },
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

    it('kartu MENTAH (tanpa nomor sertifikat) cukup DEPAN/BELAKANG + STRUK', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          certNumber: null,
          grader: null,
          photos: [
            { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
            { id: 'p2', kind: ConsignmentPhotoKind.BACK },
            { id: 'p4', kind: ConsignmentPhotoKind.HANDOVER },
          ],
        }),
      );

      await expect(
        service.acceptCustody(ID, dto, admin),
      ).resolves.toBeDefined();
    });

    /* ═══════════ STRUK SERAH TERIMA BERTANDA TANGAN: BUKTI ADANYA KESEPAKATAN ═══════════
       Foto kartu membuktikan KEADAAN BARANGNYA. Tidak satu pun dari FRONT/BACK/CERT
       membuktikan bahwa orangnya MEMANG SETUJU menitipkan kartu itu, dengan harga dan komisi
       itu, pada hari itu — dan persis itulah yang dipersoalkan kalau ia ternyata sudah menjual
       kartu yang sama ke orang lain. Yang menjawabnya cuma selembar kertas bertanda tangan dua
       pihak yang salinannya ada DI TANGAN PEMILIKNYA. */

    it('BUKTI WAJIB: tanpa foto STRUK bertanda tangan (HANDOVER), serah-terima DITOLAK dan kartu tidak masuk rak', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          // Bukti barangnya LENGKAP — dan itu justru intinya: kelengkapan foto kartu tidak
          // pernah menjadi bukti bahwa ada perjanjian.
          photos: [
            { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
            { id: 'p2', kind: ConsignmentPhotoKind.BACK },
            { id: 'p3', kind: ConsignmentPhotoKind.CERT },
          ],
        }),
      );

      await expect(service.acceptCustody(ID, dto, admin)).rejects.toMatchObject(
        {
          response: expect.objectContaining({
            code: 'CONSIGNMENT_EVIDENCE_REQUIRED',
            message: expect.stringContaining('HANDOVER') as unknown,
          }) as unknown,
        },
      );
      // NOL tulisan. Stempel custody tidak boleh ada untuk kartu tanpa perjanjian tertulis.
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('foto STRUK yang diunggah DI PERMINTAAN YANG SAMA sudah menutup syaratnya', async () => {
      // Jalur yang sebenarnya dipakai operator: ia memotret struk yang baru ditandatangani lalu
      // menekan "Terima kartu" — fotonya ikut di body, belum pernah ada sebagai baris.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.INTAKE,
          custodyAcceptedAt: null,
          photos: [
            { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
            { id: 'p2', kind: ConsignmentPhotoKind.BACK },
            { id: 'p3', kind: ConsignmentPhotoKind.CERT },
          ],
        }),
      );

      await expect(
        service.acceptCustody(
          ID,
          {
            ...dto,
            photos: [
              {
                url: '/uploads/consign/struk-ttd.jpg',
                kind: ConsignmentPhotoKind.HANDOVER,
              },
            ],
          },
          admin,
        ),
      ).resolves.toBeDefined();

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ConsignmentStatus.IN_CUSTODY,
            custodyAcceptedAt: expect.any(Date) as unknown,
          }) as unknown,
        }),
      );
    });

    it('BUKTI LENGKAP (kartu + struk bertanda tangan) → DITERIMA, stempel custody ditulis', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await expect(
        service.acceptCustody(ID, dto, admin),
      ).resolves.toBeDefined();

      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          status: ConsignmentStatus.IN_CUSTODY,
          custodyAcceptedAt: expect.any(Date) as unknown,
        }),
      );
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
            // Belum punya listing, ATAU listing lamanya sudah CANCELLED (lihat blok
            // "memajang ULANG" di bawah). Yang dijaga di sini: baris yang SUDAH punya listing
            // hidup tetap tidak bisa lahir dua kali.
            OR: [
              { listing: { is: null } },
              { listing: { is: { status: 'CANCELLED' } } },
            ],
          }) as unknown,
          data: {
            status: ConsignmentStatus.LISTED,
            withdrawRequestedAt: null,
          },
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

  /* ═══════════ MEMAJANG ULANG: "BERUBAH PIKIRAN" BUKAN JALAN BUNTU ═══════════ */

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ KEGAGALAN YANG DIUJI DI SINI: kartu titipan yang DITARIK DARI PAJANGAN terkunci           ║
   * ║ SELAMANYA — tidak bisa dipajang lagi lewat rute mana pun di repo ini.                     ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Urutannya jalur NORMAL, bukan kasus tepi: pemilik menekan "minta kartu saya kembali" dari
   * HP-nya → `takeDown` menurunkan Listing ke CANCELLED dan titipan kembali ke IN_CUSTODY
   * (kartunya MASIH di rak, custody sengaja tidak dilepas) → pemilik berubah pikiran atau sadar
   * salah pencet → admin menekan Pajang.
   *
   * Dulu langkah terakhir itu ditolak SELAMANYA (`if (c.listing) throw`), karena baris Listing
   * CANCELLED masih memegang `consignmentId` yang `@unique`. Satu-satunya "pemulihan" adalah
   * menyuruh pemiliknya menarik kartunya sungguhan lalu menitipkannya lagi dari nol — untuk
   * sesuatu yang tidak pernah ia lakukan salah.
   */
  describe('createListingFor — memajang ULANG kartu yang pernah ditarik dari pajangan', () => {
    const dto = { image: '/consign/front.jpg' };

    /** Titipan yang kembali ke rak, dengan baris listing lamanya yang sudah DIBATALKAN. */
    const withCancelledListing = (over: Record<string, unknown> = {}) =>
      rowWith({
        status: ConsignmentStatus.IN_CUSTODY,
        withdrawRequestedAt: new Date('2026-09-05T00:00:00.000Z'),
        listing: {
          id: 'listing-1',
          status: 'CANCELLED',
          image: '/lama.png',
          category: 'Consignment',
          set: 'Base',
        },
        ...over,
      });

    it('BISA dipajang ulang: baris CANCELLED DIHIDUPKAN KEMBALI, bukan baris baru yang dibuat', async () => {
      prisma.consignment.findUnique.mockResolvedValue(withCancelledListing());

      await expect(
        service.createListingFor(ID, dto, admin),
      ).resolves.toBeDefined();

      // `Listing.consignmentId` @unique → baris baru MUSTAHIL. Dan itu kebetulan yang benar:
      // riwayat satu kartu titipan tinggal di SATU baris listing, jadi order/offer/activity lama
      // yang menunjuk id itu tidak mendadak menunjuk kartu yang "lain".
      expect(prisma.listing.create).not.toHaveBeenCalled();
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // KLAIM ATOMIK: predikatnya menyebut CANCELLED, jadi baris yang sudah dihidupkan
          // permintaan lain sedetik lalu cocok NOL baris. `consignmentId` menjaga baris milik
          // titipan LAIN tidak bisa tersentuh.
          where: {
            id: 'listing-1',
            consignmentId: ID,
            status: 'CANCELLED',
          },
          data: expect.objectContaining({
            status: 'ACTIVE',
            priceIdrx: 1_000_000,
            sellerId: consignor.id,
            // Jejak pembeli dari kehidupan sebelumnya DIBERSIHKAN — kartu yang sedang tayang
            // tidak boleh membawa nama pembeli yang tidak pernah membelinya.
            buyerId: null,
            soldAt: null,
          }) as unknown,
        }),
      );
      // Titipannya ikut kembali ke LISTED, di transaksi yang SAMA — DAN permintaan penarikannya
      // dicabut. Kalau `withdrawRequestedAt` tertinggal, kartunya tayang di marketplace sambil
      // duduk SELAMANYA di `actionRequired` admin sebagai "pemilik minta kartunya kembali" —
      // peringatan yang tindakannya mustahil dari status LISTED, jadi tidak akan pernah hilang.
      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            status: ConsignmentStatus.LISTED,
            withdrawRequestedAt: null,
          },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('listing yang sudah SOLD TIDAK PERNAH bisa dihidupkan lagi — kartunya milik pembeli', async () => {
      // Ini batas yang tidak boleh punya celah. Menghidupkan baris SOLD berarti menjual kartu
      // yang sama kepada orang KEDUA — persis risiko yang seluruh fitur titipan dibangun untuk
      // menutupnya, dan kali ini dengan kartu yang sudah dibayar orang lain.
      prisma.consignment.findUnique.mockResolvedValue(
        withCancelledListing({
          listing: { id: 'listing-1', status: 'SOLD' },
        }),
      );

      await expect(service.createListingFor(ID, dto, admin)).rejects.toThrow(
        ConflictException,
      );
      // NOL tulisan: tidak ada baris yang dibuat, tidak ada yang dihidupkan, status titipan
      // tidak berubah.
      expect(prisma.listing.create).not.toHaveBeenCalled();
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('listing yang masih ACTIVE juga ditolak — tidak ada yang perlu dihidupkan', async () => {
      // Menimpanya diam-diam akan menyembunyikan keadaan yang justru harus diperiksa manusia
      // (titipan IN_CUSTODY dengan listing ACTIVE adalah keadaan yang membuat pembeli bisa
      // membayar kartu yang mustahil di-settle — lihat `isConsignmentSellableNow`).
      prisma.consignment.findUnique.mockResolvedValue(
        withCancelledListing({
          listing: { id: 'listing-1', status: 'ACTIVE' },
        }),
      );

      await expect(service.createListingFor(ID, dto, admin)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('KLAIM MENGHIDUPKAN yang KALAH membatalkan seluruhnya — tidak ada setengah keadaan', async () => {
      // Baris listing-nya berubah di antara pembacaan dan penulisan (permintaan lain menghidupkan
      // lebih dulu, atau kartunya terjual). Klaim atomiknya cocok 0 baris → melempar di dalam
      // transaksi → klaim titipan IN_CUSTODY→LISTED yang sudah menang ikut ter-rollback.
      prisma.consignment.findUnique.mockResolvedValue(withCancelledListing());
      prisma.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.createListingFor(ID, dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
    });

    it('predikat klaim titipan MENERIMA baris yang listing-nya CANCELLED — di situlah kuncinya dibuka', async () => {
      prisma.consignment.findUnique.mockResolvedValue(withCancelledListing());

      await service.createListingFor(ID, dto, admin);

      const where = (
        prisma.consignment.updateMany.mock.calls[0] as [
          { where: { OR?: unknown[] } },
        ]
      )[0].where;
      expect(where.OR).toContainEqual({
        listing: { is: { status: 'CANCELLED' } },
      });
    });
  });

  /* ══════════ SYARAT BARU TIDAK BOLEH MENGUNCI KARTU YANG SUDAH TERLANJUR DI RAK ══════════ */

  describe('titipan LAMA (diterima sebelum foto struk jadi syarat) tetap utuh', () => {
    /**
     * ┌──────────────────────────────────────────────────────────────────────────────────────┐
     * │ KEGAGALAN YANG DIUJI DI SINI: memperketat syarat MASUK lalu diam-diam memakainya      │
     * │ sebagai syarat TINGGAL. Kartu orang yang sudah berbulan-bulan ada di rak kami tidak    │
     * │ boleh mendadak jadi tidak bisa dipajang, tidak bisa dijual, atau — yang paling buruk — │
     * │ tidak bisa DIAMBIL KEMBALI, hanya karena hari ini kami memutuskan struk bertanda       │
     * │ tangan itu wajib. Pemiliknya tidak melakukan apa pun yang salah.                       │
     * └──────────────────────────────────────────────────────────────────────────────────────┘
     *
     * Yang menjaganya bukan pengecualian bertanggal melainkan BENTUK rutenya: gerbang bukti
     * hanya ada di `acceptCustody`, yang cuma bisa dilewati dari INTAKE dengan predikat
     * `custodyAcceptedAt: null` — dan tidak ada satu pun penulis di repo ini yang mengosongkan
     * kolom itu kembali. Test di bawah membuktikan itu dari sisi akibatnya.
     */
    const legacy = (over: Record<string, unknown> = {}) =>
      rowWith({
        // Bukti menurut aturan LAMA: lengkap pada zamannya, tanpa HANDOVER.
        photos: [
          { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
          { id: 'p2', kind: ConsignmentPhotoKind.BACK },
          { id: 'p3', kind: ConsignmentPhotoKind.CERT },
        ],
        ...over,
      });

    it('tetap bisa DIPAJANG — gerbang pajang membaca fakta custody, tidak pernah foto', async () => {
      prisma.consignment.findUnique.mockResolvedValue(legacy());

      await expect(
        service.createListingFor(ID, { image: '/x.png' }, admin),
      ).resolves.toBeDefined();
      expect(prisma.listing.create).toHaveBeenCalledTimes(1);
    });

    it('tetap bisa DIJUAL — gerbang penjualan tidak menyebut foto sama sekali', () => {
      // Gerbang yang dipanggil SEBELUM tagihan terbit (dipakai juga oleh PaymentsService).
      // Ia hanya membaca tiga fakta custody; foto tidak punya tempat di sana, dan memang
      // seharusnya begitu — pembeli yang sudah bayar tidak boleh tersandung syarat internal
      // yang lahir sesudah kartunya masuk rak.
      expect(() =>
        assertConsignmentSaleAvailable(
          {
            id: ID,
            status: ConsignmentStatus.LISTED,
            custodyAcceptedAt: ACCEPTED,
            custodyReleasedAt: null,
          },
          'listing-1',
        ),
      ).not.toThrow();
    });

    it('tetap bisa DIMINTA KEMBALI oleh pemiliknya — jalan pulang kartunya tidak pernah boleh tertutup', async () => {
      // Ini yang paling tidak boleh rusak dari ketiganya. Kartu yang tidak bisa dipajang masih
      // bisa dijelaskan ke pemiliknya; kartu yang tidak bisa DIAMBIL KEMBALI tidak bisa.
      prisma.consignment.findUnique.mockResolvedValue(legacy());

      await expect(
        service.requestWithdrawal(ID, {}, consignor),
      ).resolves.toBeDefined();
      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          withdrawRequestedAt: expect.any(Date) as unknown,
        }),
      );
    });

    it('dan syarat barunya memang tidak pernah bisa menyentuhnya lagi: acceptCustody menolak baris yang custody-nya sudah tercatat', async () => {
      prisma.consignment.findUnique.mockResolvedValue(legacy());

      await expect(
        service.acceptCustody(ID, { storageLocation: 'Rak A-3' }, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          // BAD_TRANSITION (statusnya bukan INTAKE), BUKAN EVIDENCE_REQUIRED. Bedanya penting:
          // baris ini tidak pernah sampai ke pemeriksaan bukti, jadi tidak ada cara apa pun
          // syarat foto baru bisa menjadi gerbang baginya.
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
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
          // Bukti serah-terimanya WAJIB sejak pengembalian punya bentuk: tanpa ini, gerbangnya
          // menolak — dan test sendirinya di bawah ("tidak bisa ditandai keluar tanpa alamat").
          ...PICKUP_HANDOVER,
        },
        admin,
      );

      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Predikat klaimnya sekarang IKUT MENYEBUT rencana pengembaliannya (OR: PICKUP, atau
          // COURIER dengan alamat lengkap) — itulah lapis yang membuat "tidak bisa ditandai
          // keluar tanpa alamat" ditegakkan Postgres, bukan oleh urutan kode.
          where: expect.objectContaining({
            id: ID,
            status: ConsignmentStatus.IN_CUSTODY,
            custodyReleasedAt: null,
          }) as unknown,
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
        { note: 'kesepakatan ganti rugi dengan pemilik' },
        admin,
      );

      expect(balance.credit).toHaveBeenCalledWith(
        {
          userId: consignor.id,
          // Dasarnya `askPriceIdr` (fixture: Rp 1.000.000) — harga jual yang disepakati dan
          // TERCETAK di struk serah terima. Bukan angka yang diketik ulang operator.
          amountIdrx: 1_000_000,
          reason: 'CONSIGNMENT_COMPENSATION',
          refId: ID,
        },
        // Argumen KEDUA: transaksinya. Lihat blok "kredit dan baris auditnya satu transaksi".
        expect.anything(),
      );
    });
  });

  /* ═══════════════════════ GANTI RUGI: SIAPA, BERAPA, DAN SEKALI ═══════════════════════ */

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ Satu kartu hilang punya DUA korban yang mungkin, dan hanya SATU yang benar.              ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `fulfilConsignment` mengkredit pemilik 95% DI DALAM transaksi settlement — jadi begitu kartu
   * terjual, pemiliknya SUDAH dibayar sementara kartunya masih di rak menunggu dikirim. Kartu
   * yang hilang di jendela itu meninggalkan PEMBELI dengan nol kartu dan nol Rupiah.
   */
  describe('compensate — yang dipulihkan adalah orang yang benar-benar kehilangan', () => {
    const SOLD_ORDER = 'HOSHI-ORDER-9';

    /** LOST, tapi sebelum hilang kartunya SUDAH terjual dan pemiliknya SUDAH dibayar. */
    const lostAfterSold = (over: Record<string, unknown> = {}) =>
      rowWith({
        status: ConsignmentStatus.LOST,
        custodyReleasedAt: new Date(),
        soldOrderId: SOLD_ORDER,
        payoutIdrx: 950_000,
        commissionIdrx: 50_000,
        listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
        ...over,
      });

    it('BELUM terjual → pemilik dikredit sebesar askPriceIdr (angka di struk), bukan angka yang diketik', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          askPriceIdr: 24_000_000,
        }),
      );

      const out = await service.compensate(
        ID,
        { note: 'kartu hilang saat pemindahan rak; ganti rugi sesuai struk' },
        admin,
      );

      expect(balance.credit).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: consignor.id,
          amountIdrx: 24_000_000,
          refId: ID,
        }),
        expect.anything(),
      );
      expect(out.credited).toBe(true);
      expect(out.compensationIdr).toBe(24_000_000);
      // Pembeli tidak ada → NOL baris pembayaran disentuh.
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });

    it('nominal konfirmasi yang BERBEDA dari struk DITOLAK — "kurang satu nol" tidak pernah masuk ledger', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          askPriceIdr: 24_000_000,
        }),
      );

      await expect(
        service.compensate(
          ID,
          { amountIdr: 2_400_000, note: 'salah ketik kurang satu nol' },
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('SUDAH TERJUAL → kredit ke PEMILIK DITOLAK, dan utangnya dicatat di baris pembayaran PEMBELI', async () => {
      prisma.consignment.findUnique.mockResolvedValue(lostAfterSold());
      prisma.paymentOrder.findUnique.mockResolvedValue({
        merchantOrderId: SOLD_ORDER,
        userId: 'buyer-3',
        priceIdr: 1_007_000,
        status: 'FULFILLED',
      });

      await expect(
        service.compensate(
          ID,
          { note: 'kartu hilang padahal sudah dibayar pembeli' },
          admin,
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // NOL saldo pemilik bergerak — ia sudah menerima payout-nya di detik settlement.
      expect(balance.credit).not.toHaveBeenCalled();
      // Utangnya dicatat lewat rail yang SUDAH ADA, berpagar status yang dibaca, refundSafe=false.
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantOrderId: SOLD_ORDER, status: 'FULFILLED' },
          data: expect.objectContaining({
            status: 'REFUND_DUE',
            refundSafe: false,
          }) as unknown,
        }),
      );
    });

    it('"sudah terjual" dibaca dari FAKTA TERSIMPAN, bukan dari status yang sudah ditimpa LOST', async () => {
      // `status` sudah LOST dan `soldOrderId` kosong — yang tersisa cuma jejak pembeli di listing.
      prisma.consignment.findUnique.mockResolvedValue(
        lostAfterSold({ soldOrderId: null }),
      );

      await expect(
        service.compensate(ID, { note: 'periksa jejak pembeli' }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('markLost pada kartu yang SUDAH TERJUAL mencatat utang pembeli SAAT ITU JUGA', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.SOLD,
          soldOrderId: SOLD_ORDER,
          payoutIdrx: 950_000,
          commissionIdrx: 50_000,
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
        }),
      );
      prisma.paymentOrder.findUnique.mockResolvedValue({
        merchantOrderId: SOLD_ORDER,
        userId: 'buyer-3',
        priceIdr: 1_007_000,
        status: 'FULFILLED',
      });

      const out = await service.markLost(
        ID,
        { note: 'hilang saat menunggu permintaan kirim dari pembeli' },
        admin,
      );

      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantOrderId: SOLD_ORDER, status: 'FULFILLED' },
        }),
      );
      expect(out.buyerRefundDebt?.recordedNow).toBe(true);
      expect(out.buyerRefundDebt?.statusAfter).toBe('REFUND_DUE');
    });

    it('pembukuan utang pembeli TIDAK PERNAH menggagalkan markLost — LOST-nya sudah commit', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.SOLD,
          soldOrderId: SOLD_ORDER,
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
        }),
      );
      prisma.paymentOrder.findUnique.mockRejectedValue(
        new Error('koneksi putus'),
      );

      const out = await service.markLost(ID, { note: 'hilang di rak' }, admin);

      expect(out.buyerRefundDebt?.recordedNow).toBe(false);
      expect(out.buyerRefundDebt?.operatorAction).toContain('manual');
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ GANTI RUGI KEDUA TIDAK BOLEH TERLIHAT HIJAU. Nol rupiah bergerak = bukan keberhasilan.  ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   */
  describe('compensate — "sudah pernah tercatat" adalah PENOLAKAN, bukan 200', () => {
    beforeEach(() => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          askPriceIdr: 24_000_000,
        }),
      );
    });

    it('baris ledger sudah ada → 409 yang MENYEBUT nominal yang sudah tercatat; NOL kredit kedua', async () => {
      prisma.balanceEntry.findFirst.mockResolvedValue({
        id: 'entry-1',
        userId: consignor.id,
        deltaIdrx: BigInt(2_400_000),
        createdAt: new Date('2026-09-20T03:00:00.000Z'),
      });

      const err: unknown = await service
        .compensate(ID, { note: 'coba bayar ulang dengan angka benar' }, admin)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      // Nominal yang SUDAH tercatat harus ada di kalimatnya: tanpa itu operator tidak punya apa
      // pun untuk memutuskan langkah berikutnya.
      expect(String((err as Error).message)).toContain('2.400.000');
      expect(balance.credit).not.toHaveBeenCalled();
      expect(prisma.consignmentEvent.create).not.toHaveBeenCalled();
    });

    it('kalah BALAPAN (P2002 dari unique (reason, refId)) → penolakan yang SAMA, bukan sukses palsu', async () => {
      // Pra-cek lolos (belum ada baris), lalu permintaan lain menang di dalam transaksi.
      prisma.balanceEntry.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValue({
          id: 'entry-1',
          userId: consignor.id,
          deltaIdrx: BigInt(24_000_000),
          createdAt: new Date('2026-09-20T03:00:00.000Z'),
        });
      balance.credit.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dobel', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.compensate(ID, { note: 'klik kedua yang beradu' }, admin),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ SALDO BERTAMBAH TANPA BARIS AUDIT = OPERATOR BERIKUTNYA MEMBAYAR LAGI.                  ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   */
  describe('compensate — kredit dan baris auditnya SATU transaksi', () => {
    it('balance.credit menerima transaksi yang SAMA dengan writeEvent', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
        }),
      );

      await service.compensate(ID, { note: 'ganti rugi sesuai struk' }, admin);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const txPassedToCredit = (balance.credit.mock.calls as unknown[][])[0][1];
      // Mock `$transaction` memanggil callback-nya dengan objek prisma yang sama, jadi
      // "transaksi yang sama" di sini berarti: credit TIDAK dipanggil tanpa tx.
      expect(txPassedToCredit).toBeDefined();
      expect(prisma.consignmentEvent.create).toHaveBeenCalledTimes(1);
    });

    it('baris audit GAGAL → kreditnya ikut batal (satu transaksi, bukan dua)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
        }),
      );
      prisma.consignmentEvent.create.mockRejectedValue(
        new Error('koneksi putus sesudah kredit'),
      );

      await expect(
        service.compensate(ID, { note: 'ganti rugi sesuai struk' }, admin),
      ).rejects.toThrow('koneksi putus sesudah kredit');
      // Kalau keduanya dipisah, error ini terbit SESUDAH saldo bertambah dan tidak pernah
      // membatalkannya. Yang membuat test ini bermakna adalah `credit` dipanggil DENGAN tx.
      expect(balance.credit).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
      );
    });
  });

  /* ══════════════ PENGEMBALIAN KARTU: KE MANA, SIAPA YANG BAYAR, DAN APAKAH SAMPAI ═══════════ */

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ "DITARIK" ≠ "SUDAH PULANG". Itu satu kalimat yang diuji seluruh blok ini.                ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Sebelum bagian ini ada, penarikan hanya menerima sebuah `note` bebas — jadi sebuah kartu bisa
   * tercatat "ditarik" sementara ia masih tergeletak di rak, atau sudah dikirim ke alamat yang
   * tidak pernah ditulis siapa pun. Untuk barang senilai puluhan juta milik orang lain, keduanya
   * adalah kegagalan custody.
   */
  describe('pengembalian kartu: alamat, ongkir balik, dan resi', () => {
    /** Rencana kirim kurir yang LENGKAP — bentuk yang dipakai operator di layar titipan. */
    const courierPlan = {
      returnMethod: 'COURIER',
      returnAddress: RETURN_ADDRESS,
      returnShippingPayer: 'HOSHI',
    };

    /* ── (a) TIDAK BISA DITANDAI TERKIRIM TANPA ALAMAT ──────────────────────────────────── */

    it('TIDAK BISA ditandai keluar kalau cara pengembaliannya belum dicatat sama sekali', async () => {
      // Fixture dasar: kartu di rak, tidak ada satu pun kolom pengembalian yang terisi.
      await expect(
        service.release(
          ID,
          { releaseReason: 'WITHDRAWN', note: 'kartunya sudah saya kirim kok' },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_RETURN_INCOMPLETE',
        }) as unknown,
      });

      // DAN TIDAK ADA APA PUN YANG DITULIS. Inilah bagian yang benar-benar penting: penolakan
      // yang tetap menyentuh baris akan meninggalkan kartu dalam keadaan setengah-keluar.
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('KURIR TANPA ALAMAT LENGKAP ditolak, dan pesannya MENYEBUT kolom mana yang kurang', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          withdrawRequestedAt: new Date(),
          returnMethod: 'COURIER',
          returnRecipientName: 'Budi Santoso',
          returnPhoneNumber: '081234567890',
          returnStreet: 'Jl. Merdeka No. 10',
          returnCity: 'Kota Bandung',
          // provinsi & kode pos HILANG — persis bentuk alamat setengah jadi yang paling sering
          // terjadi: dicatat terburu-buru lewat telepon.
          returnState: null,
          returnZip: null,
          returnCountry: 'Indonesia',
        }),
      );

      await expect(
        service.release(
          ID,
          {
            releaseReason: 'WITHDRAWN',
            note: 'dikirim hari ini',
            returnCourier: 'JNE REG',
            returnTrackingNo: 'JNE0123456789',
          },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_RETURN_INCOMPLETE',
          // Menyebut APA yang kurang, bukan sekadar "tidak lengkap": operator sedang menelepon
          // pemiliknya, dan daftar inilah yang membuat satu telepon cukup.
          message: expect.stringContaining('returnState') as unknown,
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('KURIR TANPA RESI ditolak — "sudah dikirim" harus bisa diperiksa PEMILIKNYA sendiri', async () => {
      await expect(
        service.release(
          ID,
          {
            releaseReason: 'WITHDRAWN',
            note: 'dikirim hari ini',
            returnPlan: courierPlan,
            // returnCourier / returnTrackingNo sengaja tidak ada.
          },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_RETURN_INCOMPLETE',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('DIAMBIL SENDIRI tanpa catatan SIAPA yang mengambil ditolak', async () => {
      await expect(
        service.release(
          ID,
          {
            releaseReason: 'WITHDRAWN',
            note: 'diambil pemiliknya tadi siang',
            returnPlan: { returnMethod: 'PICKUP' },
          },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_RETURN_INCOMPLETE',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('PREDIKAT KLAIMNYA ikut menyebut alamat — jadi yang menolak Postgres, bukan urutan kode', async () => {
      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'dikirim hari ini',
          returnPlan: courierPlan,
          returnCourier: 'JNE REG',
          returnTrackingNo: 'JNE0123456789',
        },
        admin,
      );

      // Klaim pelepasan custody (tulisan yang membawa `status: RELEASED`) HARUS berpredikat
      // alamat lengkap. Kalau pemeriksaan di service suatu hari dihapus, baris ini yang tetap
      // menahan — dan test ini yang memberi tahu kalau pagar itu ikut hilang.
      const releaseCall = (
        prisma.consignment.updateMany.mock.calls as [
          {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          },
        ][]
      ).find(([a]) => a.data.status === ConsignmentStatus.RELEASED);
      expect(releaseCall).toBeDefined();
      expect(releaseCall?.[0].where).toMatchObject({
        id: ID,
        status: ConsignmentStatus.IN_CUSTODY,
        custodyReleasedAt: null,
        OR: [
          { returnMethod: 'PICKUP' },
          expect.objectContaining({
            returnMethod: 'COURIER',
            returnState: { not: null },
            returnZip: { not: null },
          }) as unknown,
        ],
      });
    });

    /* ── (b) KUSTODI TIDAK LEPAS SAAT PENARIKAN BARU DIMINTA ────────────────────────────── */

    it('PENARIKAN DIMINTA: alamat tersimpan, tapi custody TIDAK dilepas — kartunya masih di rak', async () => {
      await service.requestWithdrawal(
        ID,
        { note: 'pemilik minta dikirim balik', returnPlan: courierPlan },
        consignor,
      );

      const writes = allConsignmentWrites();
      // Alamatnya memang tercatat...
      expect(writes).toContainEqual(
        expect.objectContaining({
          withdrawRequestedAt: expect.any(Date) as unknown,
          returnMethod: 'COURIER',
          returnCity: 'Kota Bandung',
          returnState: 'Jawa Barat',
          returnZip: '40115',
          returnShippingPayer: 'HOSHI',
        }),
      );
      // ...DAN TIDAK SATU PUN tulisan menyentuh custody. Selama kartunya di rak, ia masih
      // tanggung jawab Hoshi: masih bisa hilang, masih harus terhitung di stok opname.
      for (const data of writes) {
        expect(data).not.toHaveProperty('custodyReleasedAt');
        expect(data.status).not.toBe(ConsignmentStatus.RELEASED);
      }
    });

    it('dari LISTED: listing turun, alamat tercatat, custody TETAP tidak dilepas', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.LISTED,
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1_000_000 },
        }),
      );

      await service.requestWithdrawal(
        ID,
        { returnPlan: { returnMethod: 'PICKUP' } },
        consignor,
      );

      const writes = allConsignmentWrites();
      expect(writes).toContainEqual(
        expect.objectContaining({
          status: ConsignmentStatus.IN_CUSTODY,
          returnMethod: 'PICKUP',
        }),
      );
      for (const data of writes) {
        expect(data).not.toHaveProperty('custodyReleasedAt');
      }
    });

    it('rencana pengembalian DITOLAK untuk baris INTAKE — kartunya tidak pernah kami pegang', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
      );

      await expect(
        service.requestWithdrawal(ID, { returnPlan: courierPlan }, consignor),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_RETURN_INCOMPLETE',
        }) as unknown,
      });
      // Ditolak, BUKAN diabaikan diam-diam: operator yang mengetik alamat lengkap lalu tidak
      // melihatnya tersimpan di mana pun akan mengetiknya lagi, lalu lagi.
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    /* ── (c) KUSTODI LEPAS SETELAH RESI TERCATAT / KARTU DIAMBIL SENDIRI ────────────────── */

    it('RESI TERCATAT → custody LEPAS, dan nomor resinya ikut tersimpan di baris', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          withdrawRequestedAt: new Date(),
          returnMethod: 'COURIER',
          returnRecipientName: 'Budi Santoso',
          returnPhoneNumber: '081234567890',
          returnStreet: 'Jl. Merdeka No. 10',
          returnCity: 'Kota Bandung',
          returnState: 'Jawa Barat',
          returnZip: '40115',
          returnCountry: 'Indonesia',
        }),
      );

      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'dikirim balik ke pemiliknya hari ini',
          returnCourier: 'JNE REG',
          returnTrackingNo: 'JNE0123456789',
        },
        admin,
      );

      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          status: ConsignmentStatus.RELEASED,
          custodyReleasedAt: expect.any(Date) as unknown,
          releaseReason: 'WITHDRAWN',
          returnCourier: 'JNE REG',
          returnTrackingNo: 'JNE0123456789',
        }),
      );
    });

    it('DIAMBIL SENDIRI + nama pengambil → custody LEPAS, tanpa pernah butuh alamat', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ withdrawRequestedAt: new Date(), returnMethod: 'PICKUP' }),
      );

      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'diambil sendiri di kantor Hoshi',
          returnPickedUpBy: 'Budi Santoso (pemilik), KTP dicocokkan',
        },
        admin,
      );

      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          status: ConsignmentStatus.RELEASED,
          custodyReleasedAt: expect.any(Date) as unknown,
          returnPickedUpBy: 'Budi Santoso (pemilik), KTP dicocokkan',
        }),
      );
      // "KAPAN"-nya adalah `custodyReleasedAt` — tidak ada stempel kedua yang bisa berbeda.
      for (const data of allConsignmentWrites()) {
        expect(data).not.toHaveProperty('returnPickedUpAt');
      }
    });

    it('alamat yang baru dicatat DI PERMINTAAN YANG SAMA ditulis LEBIH DULU, di transaksi yang sama', async () => {
      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'pemiliknya datang tanpa pemberitahuan',
          returnPlan: courierPlan,
          returnCourier: 'SiCepat BEST',
          returnTrackingNo: 'SC998877',
        },
        admin,
      );

      const writes = allConsignmentWrites();
      const planIdx = writes.findIndex((d) => d.returnMethod === 'COURIER');
      const releaseIdx = writes.findIndex(
        (d) => d.status === ConsignmentStatus.RELEASED,
      );
      expect(planIdx).toBeGreaterThanOrEqual(0);
      expect(releaseIdx).toBeGreaterThanOrEqual(0);
      // URUTANNYA yang membuat gerbang tetap membaca FAKTA TERSIMPAN alih-alih body permintaan.
      expect(planIdx).toBeLessThan(releaseIdx);
      // Dan keduanya di SATU transaksi: kalau klaimnya kalah, alamatnya ikut hilang — tidak ada
      // alamat yang tertinggal untuk pelepasan yang tidak pernah terjadi.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    /* ── ONGKIR BALIK: DICATAT, TIDAK DITAGIHKAN ────────────────────────────────────────── */

    it('ONGKIR BALIK ditaksir dari TARIF WILAYAH YANG SUDAH ADA, bukan dari daftar kedua', async () => {
      // Tabel tarif kosong → resolusi jatuh ke tier PENAMPUNG di kode. Yang diuji BUKAN
      // angkanya melainkan bahwa jalur ini MEMBACA tabel yang sama dengan kirim domestik.
      await service.requestWithdrawal(ID, { returnPlan: courierPlan }, admin);

      expect(prisma.domesticShippingRate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } }),
      );
      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          returnShippingFeeIdr: expect.any(Number) as unknown,
        }),
      );
    });

    it('nominal yang DIKETIK operator menang atas taksiran — yang benar adalah struk kurir', async () => {
      await service.requestWithdrawal(
        ID,
        {
          returnPlan: {
            ...courierPlan,
            returnShippingFeeIdr: 37_500,
            returnShippingPayer: 'OWNER',
          },
        },
        admin,
      );

      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          returnShippingFeeIdr: 37_500,
          returnShippingPayer: 'OWNER',
        }),
      );
      // Tidak ada taksiran yang dihitung sama sekali kalau angkanya sudah diketik.
      expect(prisma.domesticShippingRate.findMany).not.toHaveBeenCalled();
    });

    it('NOL RUPIAH BERGERAK: mencatat ongkir balik TIDAK menagih apa pun', async () => {
      await service.requestWithdrawal(
        ID,
        { returnPlan: { ...courierPlan, returnShippingFeeIdr: 50_000 } },
        admin,
      );
      await service.release(
        ID,
        {
          releaseReason: 'WITHDRAWN',
          note: 'dikirim balik',
          returnPlan: courierPlan,
          returnCourier: 'JNE REG',
          returnTrackingNo: 'JNE0123456789',
        },
        admin,
      );

      // Ledger saldo TIDAK PERNAH disentuh jalur ini. `returnShippingPayer` adalah CATATAN,
      // bukan tagihan — dan itu janji produknya: menarik kartu GRATIS bagi pemiliknya.
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('SIAPA yang menanggung ongkir ikut masuk JEJAK AUDIT, berikut catatan bahwa ia belum ditagihkan', async () => {
      await service.requestWithdrawal(
        ID,
        {
          returnPlan: {
            ...courierPlan,
            returnShippingPayer: 'HOSHI',
            returnShippingFeeIdr: 50_000,
          },
        },
        admin,
      );

      const notes = (
        prisma.consignmentEvent.create.mock.calls as [
          { data: { note?: string } },
        ][]
      ).map(([a]) => a.data.note ?? '');
      expect(notes.join(' ')).toContain('Ditanggung HOSHI');
      expect(notes.join(' ')).toContain('BELUM otomatis');
    });

    /* ── (d) KARTU YANG SUDAH TERJUAL TIDAK BISA DITARIK ────────────────────────────────── */

    it('SOLD: TIDAK BISA ditarik, bahkan dengan alamat pengembalian yang lengkap', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.SOLD }),
      );

      await expect(
        service.requestWithdrawal(
          ID,
          { note: 'pemilik berubah pikiran', returnPlan: courierPlan },
          consignor,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      // Kartunya SUDAH MILIK PEMBELI. Tidak ada satu kolom pun yang boleh berubah karena
      // permintaan ini — termasuk alamat pengembalian, yang kalau tersimpan akan membuat baris
      // ini terlihat seperti pengembalian yang sedang diproses.
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('SOLD: pelepasan ke pembeli TIDAK ikut dipagari syarat pengembalian — itu jalur lain', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ status: ConsignmentStatus.SOLD }),
      );

      // Tidak ada satu pun kolom pengembalian yang terisi, dan itu BENAR: resi pengiriman ke
      // pembeli hidup di `CardRedemption`, bukan di sini. Dua tempat untuk satu resi = dua jawaban.
      await service.release(
        ID,
        { releaseReason: 'SHIPPED_TO_BUYER', note: 'diserahkan ke kurir CC' },
        admin,
      );

      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({
          status: ConsignmentStatus.RELEASED,
          releaseReason: 'SHIPPED_TO_BUYER',
        }),
      );
    });

    /* ── YANG DILIHAT LAYAR ─────────────────────────────────────────────────────────────── */

    it('adminList menyebut APA yang kurang, bukan sekadar "belum dicatat"', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'c-kurang-alamat',
          withdrawRequestedAt: new Date(),
          returnMethod: 'COURIER',
          returnRecipientName: 'Budi',
          returnPhoneNumber: '0812',
          returnStreet: 'Jl. Merdeka 10',
          returnCity: 'Bandung',
          listing: null,
          photos: [],
        }),
        rowWith({
          id: 'c-belum-pilih',
          withdrawRequestedAt: new Date(),
          listing: null,
          photos: [],
        }),
      ]);

      const out = await service.adminList();
      const reasonsOf = (id: string) =>
        out.actionRequired.find((r) => r.id === id)?.reasons.join(' ');
      const kurang = reasonsOf('c-kurang-alamat');
      const belum = reasonsOf('c-belum-pilih');

      expect(kurang).toContain('BELUM LENGKAP');
      expect(kurang).toContain('returnState');
      expect(belum).toContain('belum ditentukan');
      // Dan keduanya tetap menyebut fakta yang paling penting: kartunya MASIH di rak kita.
      expect(kurang).toContain('MASIH di rak Hoshi');
      expect(belum).toContain('MASIH di rak Hoshi');
    });

    it('bendera `returnPlanReady` dikirim SERVER — layar tidak menghitung ulang aturannya', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          withdrawRequestedAt: new Date(),
          returnMethod: 'COURIER',
          returnRecipientName: 'Budi Santoso',
          returnPhoneNumber: '081234567890',
          returnStreet: 'Jl. Merdeka No. 10',
          returnCity: 'Kota Bandung',
          returnState: 'Jawa Barat',
          returnZip: '40115',
          returnCountry: 'Indonesia',
          consignor: null,
          receivedBy: null,
          events: [],
        }),
      );

      const row = await service.byId(ID);
      expect(row).toMatchObject({
        returnAddressComplete: true,
        returnPlanReady: true,
        returnPending: true,
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
        {
          releaseReason: 'WITHDRAWN',
          note: 'dikembalikan ke pemilik',
          ...PICKUP_HANDOVER,
        },
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

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ TAB BERLABEL "SELESAI" TIDAK BOLEH MEMUAT UTANG YANG BELUM DIBAYAR.                      ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Begitu admin mencatat LOST, barisnya hilang dari "Perlu tindakan" dan masuk "Selesai /
   * hilang" — padahal LOST justru titik ketika Hoshi MULAI BERUTANG kepada pemilik kartunya.
   */
  describe('adminList — LOST yang ganti ruginya belum dibayar tetap "perlu tindakan"', () => {
    it('LOST tanpa baris ledger ganti rugi → muncul, dan kalimatnya MENYEBUT nominal struk', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'hilang',
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          askPriceIdr: 24_000_000,
          createdAt: new Date(),
        }),
      ]);

      const out = await service.adminList();

      const row = out.actionRequired.find((r) => r.id === 'hilang');
      expect(row).toBeDefined();
      expect(row?.reasons.join(' ')).toContain('24.000.000');
      expect(prisma.balanceEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            reason: 'CONSIGNMENT_COMPENSATION',
            refId: { in: ['hilang'] },
          }) as unknown,
        }),
      );
    });

    it('LOST yang ganti ruginya SUDAH tercatat → berhenti menuntut tindakan', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'hilang',
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          createdAt: new Date(),
        }),
      ]);
      prisma.balanceEntry.findMany.mockResolvedValue([{ refId: 'hilang' }]);

      const out = await service.adminList();

      expect(out.actionRequired.find((r) => r.id === 'hilang')).toBeUndefined();
    });

    it('LOST SESUDAH TERJUAL → kalimatnya menunjuk PEMBELI, bukan menyuruh mengkredit pemilik', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'hilang',
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          soldOrderId: 'HOSHI-ORDER-9',
          payoutIdrx: 950_000,
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
          createdAt: new Date(),
        }),
      ]);

      const out = await service.adminList();

      const reasons =
        out.actionRequired.find((r) => r.id === 'hilang')?.reasons.join(' ') ??
        '';
      expect(reasons).toContain('PEMBELI');
      expect(reasons).toContain('JANGAN mengkredit pemilik');
    });

    it('SOLD yang paketnya SUDAH berangkat tapi custody-nya tak pernah ditutup ikut disorot', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'terkirim',
          status: ConsignmentStatus.SOLD,
          custodyReleasedAt: null,
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
          createdAt: new Date(),
        }),
      ]);
      prisma.cardRedemption.findMany.mockResolvedValue([
        { id: 'red-1', listingId: 'listing-1', status: 'SHIPPED' },
      ]);

      const out = await service.adminList();

      const reasons =
        out.actionRequired
          .find((r) => r.id === 'terkirim')
          ?.reasons.join(' ') ?? '';
      expect(reasons).toContain('red-1');
      expect(reasons).toContain('custodyReleasedAt');
      // Kalimat lama ("pembeli belum minta kirim") justru SALAH untuk baris ini.
      expect(reasons).not.toContain('pembeli belum minta kirim');
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

  /* ═══════════════════════════════════════════════════════════════════════════════════════════
   * TITIPAN DARI ORANG YANG BELUM PUNYA AKUN
   *
   * PM mendatangi kolektor lokal DI RUMAH MEREKA. Kebanyakan belum punya akun Hoshi, dan tidak
   * ada seorang pun yang bisa mengetikkan id database di ponsel sambil pemilik kartunya berdiri
   * di depannya. Yang diuji di bawah ini: kartunya BISA diterima hari itu juga, DAN ia tetap
   * tidak bisa dijual sampai kita tahu siapa yang harus dibayar.
   * ═══════════════════════════════════════════════════════════════════════════════════════════ */

  const intakeDto = (over: Record<string, unknown> = {}) => ({
    consignorNameAtIntake: 'Budi Santoso',
    consignorPhoneAtIntake: '+628111234567',
    receivedAtPlace: 'Rumah pemilik, Bandung',
    cardName: 'Charizard',
    conditionNote: 'Slab utuh, label lurus.',
    askPriceIdr: 1_000_000,
    ...over,
  });

  const createData = (): Record<string, unknown> =>
    (
      prisma.consignment.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ]
    )[0].data;

  /** Setiap `note` yang pernah ditulis ke jejak audit. */
  const allEventNotes = (): string[] =>
    (
      prisma.consignmentEvent.create.mock.calls as [
        { data: { note?: string | null } },
      ][]
    ).map(([a]) => a.data.note ?? '');

  describe('intake TANPA akun (Path B) — kode klaim di tanda terima', () => {
    it('consignorId boleh kosong: baris lahir TANPA pemilik, dan users TIDAK dicari', async () => {
      const out = await service.createIntake(intakeDto(), admin);

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(createData().consignorId).toBeNull();
      expect(out).toBeDefined();
    });

    it('SNAPSHOT nama & telepon TETAP WAJIB ditulis — di sinilah justru paling penting', async () => {
      // Tanpa akun untuk dirujuk, dua kolom inilah SATU-SATUNYA cara operator dan pemilik kartu
      // bisa saling mengenali lagi nanti (dan satu-satunya cara ganti rugi bisa sampai orangnya).
      await service.createIntake(intakeDto(), admin);
      expect(createData().consignorNameAtIntake).toBe('Budi Santoso');
      expect(createData().consignorPhoneAtIntake).toBe('+628111234567');
    });

    it('menerbitkan kode klaim: yang DISIMPAN hanya hash-nya, yang DIKEMBALIKAN teksnya — sekali', async () => {
      const out = (await service.createIntake(intakeDto(), admin)) as {
        claimCode?: string;
      };

      expect(out.claimCode).toBeDefined();
      const normalized = normalizeClaimCode(out.claimCode!);
      expect(normalized).not.toBeNull();

      const data = createData();
      // Yang masuk database adalah hash dari bentuk KANONIK kodenya — bukan kodenya.
      expect(data.claimCodeHash).toBe(hashClaimCode(normalized!));
      expect(data.claimCodeIssuedAt).toBeInstanceOf(Date);
      expect(data.claimCodeExpiresAt).toBeInstanceOf(Date);
      // 30 hari, dihitung dari saat penerbitan.
      expect(
        (data.claimCodeExpiresAt as Date).getTime() -
          (data.claimCodeIssuedAt as Date).getTime(),
      ).toBe(CLAIM_CODE_TTL_DAYS * 24 * 60 * 60 * 1000);
    });

    it('TEKS KODENYA tidak pernah masuk kolom mana pun maupun jejak audit', async () => {
      // Jejak audit adalah tempat yang paling sering dibaca ulang di seluruh fitur ini. Rahasia
      // tidak ditaruh di sana — yang dicatat adalah KEBERADAAN kode, bukan kodenya.
      const out = (await service.createIntake(intakeDto(), admin)) as {
        claimCode: string;
      };
      const bare = normalizeClaimCode(out.claimCode)!;

      const serialized = JSON.stringify(createData());
      expect(serialized).not.toContain(bare);
      expect(serialized).not.toContain(out.claimCode);
      for (const note of allEventNotes()) {
        expect(note).not.toContain(bare);
        expect(note).not.toContain(out.claimCode);
      }
      // ...tapi jejaknya TETAP menyebut bahwa kartu ini belum bisa dipajang.
      expect(allEventNotes().join(' ')).toMatch(/TIDAK BISA dipajang/i);
    });

    it('Path A (consignorId diberikan): TIDAK ada kode, dan cara penautannya ikut dicatat', async () => {
      const out = (await service.createIntake(
        intakeDto({ consignorId: consignor.id }),
        admin,
      )) as { claimCode?: string };

      expect(out.claimCode).toBeUndefined();
      const data = createData();
      expect(data.claimCodeHash).toBeUndefined();
      expect(data.consignorId).toBe(consignor.id);
      expect(data.consignorLinkedAt).toBeInstanceOf(Date);
      expect(data.consignorLinkMethod).toBe('AT_INTAKE');
    });

    it('consignorId yang diberikan tapi TIDAK ADA: menolak, dan menyuruh pakai kode klaim', async () => {
      // Bukan "buatkan akunnya" dan bukan "abaikan saja": mengarang id akan menautkan kartu orang
      // ke baris yang salah, dan pesan ini menyebut jalan yang benar.
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.createIntake(intakeDto({ consignorId: 'tidak-ada' }), admin),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.consignment.create).not.toHaveBeenCalled();
    });
  });

  /* ══════════════ GERBANG "TIDAK TAHU SIAPA YANG DIBAYAR" — TERPISAH DARI CUSTODY ══════════ */

  describe('kartu di rak TANPA pemilik tertaut: tidak bisa dipajang, tapi tetap tercatat', () => {
    const heldUnlinked = () =>
      rowWith({ consignorId: null, status: ConsignmentStatus.IN_CUSTODY });

    it('createListingFor MENOLAK — dan kodenya OWNER_UNLINKED, BUKAN NOT_IN_CUSTODY', async () => {
      // Kedua kode itu sama-sama berarti "belum bisa dipajang", tapi pemulihannya BERLAWANAN.
      // NOT_IN_CUSTODY menyuruh operator mencatat serah-terima untuk kartu yang SUDAH ada di
      // raknya — nasihat yang tidak bisa berhasil dan akan dicoba berulang kali.
      prisma.consignment.findUnique.mockResolvedValue(heldUnlinked());

      await expect(
        service.createListingFor('consign-1', { image: '/x.png' }, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_OWNER_UNLINKED',
        }) as unknown,
      });

      // TIDAK ADA baris listing, dan TIDAK ADA klaim yang diambil.
      expect(prisma.listing.create).not.toHaveBeenCalled();
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('yang MENEGAKKAN aturannya adalah predikat klaimnya, bukan pesan di atas', async () => {
      // Kalau pemeriksaan penjelas di service dihapus, aturan ini TETAP tidak bisa dilanggar:
      // klaim IN_CUSTODY→LISTED menyebut `consignorId: { not: null }` dan `Listing.create` ada di
      // transaksi yang SAMA dengannya.
      await service.createListingFor('consign-1', { image: '/x.png' }, admin);
      const where = (
        prisma.consignment.updateMany.mock.calls as [
          { where: Record<string, unknown> },
        ][]
      )[0][0].where;
      expect(where.consignorId).toEqual({ not: null });
      expect(where.custodyAcceptedAt).toEqual({ not: null });
    });

    it('custody-nya TIDAK DISENTUH: kartunya tetap tercatat ada di rak', async () => {
      // Ini bukan penolakan custody. Kartunya memang ada, buktinya ada, dan ia tetap bisa ditarik
      // kembali kapan saja — yang tidak bisa hanyalah DIJUAL.
      const row = heldUnlinked();
      prisma.consignment.findUnique.mockResolvedValue(row);
      const view = await service.byId('consign-1');
      expect(view.inCustody).toBe(true);
      expect(view.ownerLinked).toBe(false);
      expect(view.listable).toBe(false);
      expect(view.awaitingOwnerClaim).toBe(true);
    });

    it('compensate MENOLAK: ganti rugi tanpa pemilik = uang tanpa tujuan', async () => {
      // Kartu yang HILANG bisa saja kartu yang pemiliknya belum sempat menukarkan kodenya.
      // Mengkredit saldo di keadaan itu mustahil, dan yang benar adalah berhenti — bukan
      // memanggil ledger dengan id yang tidak menunjuk siapa pun.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null, status: ConsignmentStatus.LOST }),
      );
      await expect(
        service.compensate(
          'consign-1',
          { amountIdr: 20_000_000, note: 'Ganti rugi penuh.' },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_OWNER_UNLINKED',
        }) as unknown,
      });
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('JALAN KELUARNYA UTUH: kartu tanpa pemilik tetap bisa DIKEMBALIKAN dan tetap bisa HILANG', async () => {
      // Yang ditambahkan aturan "belum diklaim" HANYALAH larangan MEMAJANG. Kalau ia juga
      // memblokir RELEASED/LOST, seseorang yang menyerahkan kartunya tanpa punya akun akan
      // terkunci: kartunya ada di rak kami, dan tidak ada satu pun jalan mengeluarkannya. Itu
      // kelas kegagalan yang `consignment-exit-reachability` ada untuk mencegahnya, dan ia harus
      // tetap benar untuk baris yang belum bertuan.
      prisma.consignment.findUnique.mockResolvedValue(heldUnlinked());
      await service.release(
        'consign-1',
        {
          releaseReason: 'WITHDRAWN',
          note: 'Dikembalikan ke pemiliknya.',
          ...PICKUP_HANDOVER,
        },
        admin,
      );
      // Dibaca dari SELURUH tulisan, bukan dari `calls[0]`: sejak pengembalian punya bentuk,
      // rencananya ditulis LEBIH DULU di transaksi yang sama (supaya predikat klaim bisa
      // membacanya dari BARIS, bukan dari body). Menguncinya ke tulisan pertama berarti test ini
      // menguji URUTAN INTERNAL, bukan hal yang sedang ia klaim.
      expect(allConsignmentWrites()).toContainEqual(
        expect.objectContaining({ status: ConsignmentStatus.RELEASED }),
      );

      prisma.consignment.updateMany.mockClear();
      prisma.consignment.findUnique.mockResolvedValue(heldUnlinked());
      await service.markLost(
        'consign-1',
        { note: 'Hilang saat pindah rak.' },
        admin,
      );
      expect(
        (
          prisma.consignment.updateMany.mock.calls[0] as [
            { data: { status?: unknown } },
          ]
        )[0].data.status,
      ).toBe(ConsignmentStatus.LOST);
    });

    it('user biasa TIDAK bisa menariknya — tapi JALAN PULANGNYA tidak hilang: admin bisa', async () => {
      // Kalau titipan tanpa pemilik boleh ditarik siapa saja yang meminta, siapa pun bisa membawa
      // pulang kartu orang lain. Tapi orang yang menyerahkannya HARUS tetap bisa mengambilnya:
      // jalannya lewat operator, yang mencocokkan nama/telepon snapshot dan tanda terimanya.
      prisma.consignment.findUnique.mockResolvedValue(heldUnlinked());

      await expect(
        service.requestWithdrawal('consign-1', {}, consignor),
      ).rejects.toThrow(ForbiddenException);

      await service.requestWithdrawal(
        'consign-1',
        { note: 'Diambil pemilik' },
        admin,
      );
      expect(prisma.consignment.updateMany).toHaveBeenCalled();
    });
  });

  /* ═════════════════════════ PENUKARAN KODE KLAIM (RUTE PUBLIK) ════════════════════════════ */

  describe('claimByCode — satu penolakan untuk semua sebab', () => {
    const CODE = 'ABCDE-FGHJK';
    const HASH = hashClaimCode(normalizeClaimCode(CODE)!);

    it('menautkan ATOMIK, dan MENGOSONGKAN hash di transaksi yang sama (sekali pakai)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null }),
      );

      await service.claimByCode({ code: CODE }, consignor);

      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      // Gerbangnya ADALAH predikatnya: hash + belum bertuan + belum kedaluwarsa.
      expect(call[0].where).toMatchObject({
        claimCodeHash: HASH,
        consignorId: null,
      });
      expect(call[0].data.consignorId).toBe(consignor.id);
      expect(call[0].data.consignorLinkMethod).toBe('CLAIM_CODE');
      // "Sekali pakai" jadi BENTUK BARIS: sesudah ini kodenya tidak cocok dengan apa pun.
      expect(call[0].data.claimCodeHash).toBeNull();
      expect(call[0].data.claimCodeExpiresAt).toBeNull();
    });

    it('huruf kecil & tanpa tanda hubung tetap diterima — kertas ke ponsel', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null }),
      );
      await service.claimByCode({ code: 'abcdefghjk' }, consignor);
      expect(
        (
          prisma.consignment.updateMany.mock.calls[0] as [
            { where: { claimCodeHash?: string } },
          ]
        )[0].where.claimCodeHash,
      ).toBe(HASH);
    });

    it('bentuk salah: ditolak TANPA menyentuh database sama sekali', async () => {
      await expect(
        service.claimByCode({ code: 'U-bukan-kode' }, consignor),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_CLAIM_CODE_INVALID',
        }) as unknown,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('SEMUA sebab kegagalan dijawab IDENTIK — rute ini tidak pernah mengonfirmasi tebakan', async () => {
      // Membedakan "tidak ada" dari "kedaluwarsa" memberi penebak kabar bahwa tebakannya
      // MENGENAI SESUATU, dan itulah satu-satunya hal yang membuat menebak ada gunanya.
      const bodies: unknown[] = [];

      // (a) bentuknya salah — ditolak sebelum query
      // (b) hash-nya tidak ada di tabel
      prisma.consignment.findUnique.mockResolvedValue(null);
      // (c) ada, tapi klaimnya cocok 0 baris (kedaluwarsa / sudah bertuan / CANCELLED / kalah balapan)
      for (const scenario of ['format', 'missing', 'claim-lost'] as const) {
        if (scenario === 'claim-lost') {
          prisma.consignment.findUnique.mockResolvedValue(
            rowWith({ consignorId: null }),
          );
          prisma.consignment.updateMany.mockResolvedValue({ count: 0 });
        }
        try {
          await service.claimByCode(
            { code: scenario === 'format' ? '@@@' : CODE },
            consignor,
          );
          throw new Error('seharusnya ditolak');
        } catch (e) {
          bodies.push((e as { response?: unknown }).response);
        }
      }

      expect(bodies).toHaveLength(3);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      expect(bodies[0]).toMatchObject({
        statusCode: 404,
        code: 'CONSIGNMENT_CLAIM_CODE_INVALID',
      });
    });

    it('jejak audit mencatat penautannya, TANPA kodenya', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null }),
      );
      await service.claimByCode({ code: CODE }, consignor);

      const [ev] = prisma.consignmentEvent.create.mock.calls as [
        { data: { kind: string; actorId: string; note: string } },
      ][];
      expect(ev[0].data.kind).toBe('CLAIM_CODE_REDEEMED');
      expect(ev[0].data.actorId).toBe(consignor.id);
      expect(ev[0].data.note).not.toContain('ABCDE');
      expect(ev[0].data.note).toContain(consignor.id);
    });
  });

  /* ═══════════════════ PENERBITAN ULANG & PENAUTAN OLEH ADMIN ═══════════════════ */

  describe('issueClaimCode — jawaban untuk "tanda terimanya hilang"', () => {
    const dto = { note: 'Tanda terima hilang; dikonfirmasi lewat telepon.' };

    it('menerbitkan ulang MENIMPA hash lama dalam satu tulisan — kertas lama langsung mati', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null, claimCodeHash: 'hash-lama' }),
      );

      const out = (await service.issueClaimCode('consign-1', dto, admin)) as {
        claimCode: string;
        reissued: boolean;
      };

      expect(out.reissued).toBe(true);
      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      // Gerbangnya sama dengan penautan: kalau barisnya bertuan barusan, tidak ada kode yang
      // lahir. DAN syarat statusnya ada DI DALAM klaim — pembatalan yang mendarat di antara
      // pembacaan dan penulisan tidak boleh bisa melahirkan kode yang tidak akan pernah bisa
      // ditukarkan (predikat penukaran mengecualikan CANCELLED).
      expect(call[0].where).toEqual({
        id: 'consign-1',
        consignorId: null,
        status: { not: ConsignmentStatus.CANCELLED },
      });
      expect(call[0].data.claimCodeHash).toBe(
        hashClaimCode(normalizeClaimCode(out.claimCode)!),
      );
      expect(call[0].data.claimCodeHash).not.toBe('hash-lama');
      // Auditnya menyebut bahwa yang lama mati — tanpa menyebut kode mana pun.
      const note = allEventNotes()[0];
      expect(note).toMatch(/DITERBITKAN ULANG/);
      expect(note).toContain(dto.note);
      expect(note).not.toContain(normalizeClaimCode(out.claimCode)!);
    });

    it('MENOLAK kalau titipannya sudah bertuan — kunci yang tak membuka apa pun tidak dibuat', async () => {
      prisma.consignment.findUnique.mockResolvedValue(rowWith());
      await expect(
        service.issueClaimCode('consign-1', dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('linkConsignor — admin menautkan, dan TIDAK PERNAH menimpa', () => {
    const dto = {
      consignorId: consignor.id,
      note: 'Pemilik datang membawa tanda terima; wallet dicocokkan di layarnya.',
    };

    it('klaim atomik berpredikat consignorId: null, dan kode yang beredar ikut DIMATIKAN', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null, claimCodeHash: 'hash-lama' }),
      );

      await service.linkConsignor('consign-1', dto, admin);

      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      // Syarat statusnya DI DALAM klaim, bukan sekadar di pembacaan sebelumnya: kesepakatan yang
      // dibatalkan di antara keduanya tidak boleh bisa mendapat pemilik.
      expect(call[0].where).toEqual({
        id: 'consign-1',
        consignorId: null,
        status: { not: ConsignmentStatus.CANCELLED },
      });
      expect(call[0].data.consignorId).toBe(consignor.id);
      expect(call[0].data.consignorLinkMethod).toBe('ADMIN_LINK');
      // Kartunya sudah bertuan, jadi kertas di saku siapa pun tidak boleh lagi menunjuk ke sini.
      expect(call[0].data.claimCodeHash).toBeNull();
      expect(allEventNotes()[0]).toContain(dto.note);
    });

    it('MENOLAK kalau sudah bertuan — kartu orang tidak berpindah karena satu salah ketik', async () => {
      prisma.consignment.findUnique.mockResolvedValue(rowWith());
      await expect(
        service.linkConsignor('consign-1', dto, admin),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('akun tujuan tidak ada → 404, dan TIDAK ADA yang ditulis', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null }),
      );
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.linkConsignor('consign-1', dto, admin),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });
  });

  /* ══════════════════════ MENCARI PEMILIK — DAFTAR, BUKAN JAWABAN ═════════════════════════ */

  describe('searchConsignors — tidak pernah mencocokkan sendiri', () => {
    const two = [
      {
        id: 'u-1',
        walletAddress: 'WalletAAA111',
        displayName: 'Budi',
        email: 'budi@example.com',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        _count: { consignmentsConsigned: 0 },
      },
      {
        id: 'u-2',
        walletAddress: 'WalletBBB222',
        displayName: 'Budi',
        email: 'budi@example.com',
        createdAt: new Date('2026-02-01T00:00:00.000Z'),
        _count: { consignmentsConsigned: 3 },
      },
    ];

    it('dua orang dengan NAMA dan EMAIL yang sama → ambiguous, dan KEDUANYA dikembalikan', async () => {
      // Inilah kasus yang membuat rute ini ada. `displayName` boleh kembar dan `email` TIDAK
      // PERNAH diverifikasi — siapa pun bisa mengetik alamat orang lain di setelan profilnya.
      // Rute yang memilihkan satu dari dua ini akan, cepat atau lambat, menautkan kartu senilai
      // puluhan juta Rupiah ke orang yang salah, dan akan melakukannya diam-diam.
      prisma.user.findMany.mockResolvedValue(two);
      prisma.user.count.mockResolvedValue(2);

      const out = await service.searchConsignors('budi@example.com');

      expect(out.ambiguous).toBe(true);
      expect(out.matches).toHaveLength(2);
      expect(out.matches.map((m) => m.id)).toEqual(['u-1', 'u-2']);
      // Tidak satu pun ditandai sebagai identitas: yang cocok cuma nama dan email.
      expect(out.matches.every((m) => !m.exactWalletMatch)).toBe(true);
      expect(out.matches[0].matchedOn).toEqual(['email']);
      expect(out.advice).toMatch(/TIDAK PERNAH diverifikasi/);
    });

    it('cocok PERSIS pada walletAddress ditandai — itu satu-satunya kolom unik', async () => {
      prisma.user.findMany.mockResolvedValue([two[0]]);
      prisma.user.count.mockResolvedValue(1);

      const out = await service.searchConsignors('walletaaa111');
      expect(out.ambiguous).toBe(false);
      expect(out.matches[0].exactWalletMatch).toBe(true);
      // Alamatnya dikembalikan UTUH: operator sedang membandingkannya dengan layar orang lain,
      // dan bentuk pendek membuat dua alamat berbeda tampak sama persis.
      expect(out.matches[0].walletAddress).toBe('WalletAAA111');
    });

    it('hasil yang terpotong DIBERITAHUKAN — jangan memilih dari daftar yang tidak lengkap', async () => {
      prisma.user.findMany.mockResolvedValue(two);
      prisma.user.count.mockResolvedValue(57);
      const out = await service.searchConsignors('bud');
      expect(out.truncated).toBe(true);
      expect(out.total).toBe(57);
    });

    it('kata kunci terlalu pendek ditolak — daftar sepanjang tabel akan dipilih asal-asalan', async () => {
      await expect(service.searchConsignors('bu')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('TIDAK MENULIS APA PUN', async () => {
      prisma.user.findMany.mockResolvedValue(two);
      prisma.user.count.mockResolvedValue(2);
      await service.searchConsignors('budi');
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
      expect(prisma.consignment.create).not.toHaveBeenCalled();
    });
  });

  /* ═════════════════════ DASHBOARD: TERLIHAT, ATAU TIDAK ADA ═════════════════════ */

  describe('adminList — kartu yang menunggu pemiliknya harus TERLIHAT', () => {
    it('awaitingOwner memuat nama & telepon serah-terima: satu-satunya cara menghubungi orangnya', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          consignorId: null,
          status: ConsignmentStatus.IN_CUSTODY,
          claimCodeIssuedAt: new Date('2026-09-01T00:00:00.000Z'),
          claimCodeExpiresAt: new Date('2026-08-01T00:00:00.000Z'), // sudah lewat
          createdAt: new Date('2026-08-01T00:00:00.000Z'),
        }),
      ]);

      const out = await service.adminList();

      expect(out.awaitingOwnerCount).toBe(1);
      expect(out.awaitingOwner[0]).toMatchObject({
        heldByHoshi: true,
        consignorNameAtIntake: 'Budi',
        consignorPhoneAtIntake: '+62811',
        claimCodeExpired: true,
      });
      // Dan ia juga muncul di actionRequired, dengan alasan yang menyebut pemulihannya.
      const reasons = out.actionRequired[0].reasons.join(' ');
      expect(reasons).toMatch(/kode klaim/i);
      expect(reasons).toMatch(/Terbitkan ulang|tautkan akunnya/i);
    });

    it('titipan yang CANCELLED tidak menunggu siapa pun', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          consignorId: null,
          status: ConsignmentStatus.CANCELLED,
          custodyAcceptedAt: null,
        }),
      ]);
      const out = await service.adminList();
      expect(out.awaitingOwnerCount).toBe(0);
    });

    it('hash kode klaim TIDAK PERNAH ikut keluar dari server', async () => {
      // `include` mengembalikan SELURUH kolom skalar, jadi tanpa `omit` hash-nya terbang ke
      // browser — di rute admin MAUPUN di rute pemilik.
      prisma.consignment.findMany.mockResolvedValue([]);
      await service.adminList();
      await service.listMine(consignor.id);
      await service.byId('consign-1');

      type ReadArgs = [{ omit?: Record<string, unknown>; include?: unknown }];
      const calls: ReadArgs[] = [
        ...(prisma.consignment.findMany.mock.calls as ReadArgs[]),
        ...(prisma.consignment.findUnique.mock.calls as ReadArgs[]),
      ];
      expect(calls.length).toBeGreaterThan(0);
      for (const [arg] of calls) {
        if (arg.include) expect(arg.omit).toEqual({ claimCodeHash: true });
      }
    });
  });

  /* ═════════ B1 — "MENUNGGU PEMILIKNYA" BERHENTI DI KARTU YANG SUDAH PULANG ═════════ */

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ ARTI HIMPUNANNYA: "kami MASIH memegang sesuatu milik orang ini dan belum tahu siapa dia."║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Kartu yang DITARIK dan diserahkan kembali ke tangan pemiliknya memenuhi janjinya SELURUHNYA.
   * Selama ia tetap dihitung "menunggu pemiliknya", badge-nya tidak pernah bisa turun dan
   * `actionRequired` menawarkan tombol yang hanya menyetel ulang jam 30 hari — peringatan yang
   * mengajari orang mengabaikan seluruh daftarnya, dan daftar itulah satu-satunya alat yang
   * menjaga barang orang lain tetap terlihat.
   */
  describe('adminList — RELEASED tidak lagi menunggu siapa pun; LOST masih', () => {
    const unlinked = (
      id: string,
      status: ConsignmentStatus,
      over: Record<string, unknown> = {},
    ) =>
      rowWith({
        id,
        status,
        consignorId: null,
        claimCodeIssuedAt: new Date('2026-08-01T00:00:00.000Z'),
        // Sudah kedaluwarsa: inilah alasan `actionRequired` yang dulu tidak bisa dibersihkan.
        claimCodeExpiresAt: new Date('2026-08-15T00:00:00.000Z'),
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
        ...over,
      });

    it('RELEASED tanpa pemilik: keluar dari badge, dari daftar, DAN dari actionRequired', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        unlinked('released', ConsignmentStatus.RELEASED, {
          custodyReleasedAt: new Date('2026-08-20T00:00:00.000Z'),
        }),
      ]);

      const out = await service.adminList();

      expect(out.awaitingOwnerCount).toBe(0);
      expect(out.awaitingOwner).toEqual([]);
      expect(out.actionRequired).toEqual([]);
      // Dan bendera per barisnya ikut — kalau tidak, layar akan menampilkan lencana "menunggu
      // pemilik" di baris yang tidak ada di daftar "menunggu pemilik".
      expect(out.rows[0].awaitingOwnerClaim).toBe(false);
    });

    it('LOST tanpa pemilik TETAP di dalam: ganti rugi butuh tujuan', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        unlinked('lost', ConsignmentStatus.LOST, {
          custodyReleasedAt: new Date('2026-08-20T00:00:00.000Z'),
        }),
      ]);

      const out = await service.adminList();

      expect(out.awaitingOwnerCount).toBe(1);
      expect(out.awaitingOwner[0].id).toBe('lost');
      expect(out.rows[0].awaitingOwnerClaim).toBe(true);
      expect(
        out.actionRequired.find((r) => r.id === 'lost')?.reasons.join(' '),
      ).toMatch(/Terbitkan ulang/);
    });

    it('filter SQL memakai definisi yang SAMA dengan hitungan di memori', async () => {
      // Dua salinan aturan berarti salah satunya akan diam-diam salah, dan yang terlihat di
      // layar adalah angka badge yang tidak cocok dengan isi daftarnya.
      prisma.consignment.findMany.mockResolvedValue([]);
      await service.adminList(undefined, 'AWAITING_OWNER');
      const arg = (
        prisma.consignment.findMany.mock.calls[0] as [
          { where: Record<string, unknown> },
        ]
      )[0];
      expect(arg.where).toMatchObject({
        consignorId: null,
        status: {
          notIn: [ConsignmentStatus.CANCELLED, ConsignmentStatus.RELEASED],
        },
      });
    });
  });

  /* ═════════ B3 — LABEL BISA DIPERBAIKI, BUKTI TIDAK ═════════ */

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ GARISNYA: `conditionNote`/foto = BUKTI (tak bisa ditimpa). `cardName` dkk = LABEL.       ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `createListingFor` menyalin `cardName` LANGSUNG ke `Listing.name`. Satu huruf yang terlewat
   * di ponsel menjadi judul publik permanen kartu orang lain senilai puluhan juta, dengan
   * koreksinya terkubur di jejak audit yang tidak dibaca satu pun calon pembeli.
   */
  describe('correctLabel — judul publik bisa diperbaiki; bukti tetap tidak', () => {
    const NOTE =
      'Salah ketik saat intake di lokasi; dicocokkan ulang dengan slab dan cert PSA 12345678.';

    it('memperbaiki cardName DAN judul listing yang masih tayang, dalam SATU transaksi', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          cardName: 'Charizad VMAX',
          status: ConsignmentStatus.LISTED,
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 24_000_000 },
        }),
      );

      const out = await service.correctLabel(
        ID,
        { cardName: 'Charizard VMAX', note: NOTE },
        admin,
      );

      // KLAIMNYA MEMBAWA NILAI LAMA: dua koreksi serentak tidak bisa dua-duanya menang, dan
      // "sebelum" yang tertulis di baris audit TIDAK PERNAH karangan.
      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      expect(call[0].where).toEqual({ id: ID, cardName: 'Charizad VMAX' });
      expect(call[0].data).toEqual({ cardName: 'Charizard VMAX' });

      // Judul publiknya ikut, di transaksi yang SAMA — tidak ada jendela ketika catatan sudah
      // benar dan yang dilihat publik masih salah.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith({
        where: { id: 'listing-1', consignmentId: ID, status: 'ACTIVE' },
        data: { name: 'Charizard VMAX' },
      });
      expect(out.listingUpdated).toBe(true);
      expect(out.corrected).toEqual([
        {
          field: 'cardName',
          before: 'Charizad VMAX',
          after: 'Charizard VMAX',
        },
      ]);

      const [ev] = prisma.consignmentEvent.create.mock.calls as [
        { data: { kind: string; note: string } },
      ][];
      expect(ev[0].data.kind).toBe('LABEL_CORRECTION');
      const note = allEventNotes()[0];
      expect(note).toContain('Charizad VMAX'); // SEBELUM
      expect(note).toContain('Charizard VMAX'); // SESUDAH
      expect(note).toContain(NOTE); // ALASAN
    });

    it('BUKTI tidak ikut: tidak ada jalan masuk untuk conditionNote maupun foto', async () => {
      // Field yang tidak dikenal tidak diam-diam lolos: rute ini hanya membaca enam kolom label,
      // jadi permintaan yang cuma membawa `conditionNote` berakhir sebagai "tidak ada yang
      // disebut" — dan TIDAK ADA satu tulisan pun yang terjadi.
      await expect(
        service.correctLabel(
          ID,
          { conditionNote: 'diubah diam-diam', note: NOTE } as never,
          admin,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
      expect(prisma.consignmentPhoto.createMany).not.toHaveBeenCalled();
      expect(prisma.consignmentEvent.create).not.toHaveBeenCalled();
    });

    it('conditionNote TIDAK PERNAH ikut ke dalam data yang ditulis', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ cardName: 'Charizad VMAX' }),
      );
      await service.correctLabel(
        ID,
        { cardName: 'Charizard VMAX', note: NOTE },
        admin,
      );
      for (const data of allConsignmentWrites()) {
        expect(data).not.toHaveProperty('conditionNote');
        expect(data).not.toHaveProperty('rawCondition');
      }
    });

    it('string kosong MENGOSONGKAN kolom nullable (cert untuk kartu yang ternyata mentah)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ certNumber: '12345678', grader: null }),
      );

      await service.correctLabel(ID, { certNumber: '', note: NOTE }, admin);

      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      expect(call[0].data).toEqual({ certNumber: null });
      expect(call[0].where).toEqual({ id: ID, certNumber: '12345678' });
    });

    it('nomor sertifikat yang dikoreksi ikut diperiksa terhadap kunci anti-dobel-titip', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ certNumber: '11111111' }),
      );
      prisma.consignment.findFirst.mockResolvedValue({
        id: 'other',
        status: ConsignmentStatus.IN_CUSTODY,
      });

      await expect(
        service.correctLabel(ID, { certNumber: '12345678', note: NOTE }, admin),
      ).rejects.toThrow(ConflictException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('mengosongkan gradeLabel MENGHITUNG ULANG grade listing — bukan memulihkan label lama', async () => {
      // Jebakan yang nyaris terpasang: membaca nilai baru dengan `data.gradeLabel ?? c.gradeLabel`
      // berarti `null` (= "kosongkan") jatuh kembali ke label LAMA, dan label palsu yang koreksi
      // ini ada untuk menghapus justru DITULIS ULANG ke judul publik. Skornya sengaja 9 sementara
      // labelnya "PSA 10", jadi kedua jawaban itu tidak mungkin tertukar.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          gradeLabel: 'PSA 10',
          gradeScore: 9,
          grader: 'PSA',
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1 },
        }),
      );

      await service.correctLabel(ID, { gradeLabel: '', note: NOTE }, admin);

      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          // Rumusnya SAMA PERSIS dengan `createListingFor`: label kalau ada, kalau tidak
          // grader + skor. "PSA 10" tidak boleh muncul di mana pun lagi.
          data: { grade: 'PSA 9', gradeScore: 9 },
        }),
      );
    });

    it('mengoreksi gradeScore ikut memperbarui gradeScore listing', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          gradeLabel: null,
          gradeScore: 9,
          grader: 'PSA',
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1 },
        }),
      );

      await service.correctLabel(ID, { gradeScore: 10, note: NOTE }, admin);

      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { grade: 'PSA 10', gradeScore: 10 },
        }),
      );
    });

    it('nilai yang sudah sama persis: tidak ada baris audit untuk perubahan yang tidak terjadi', async () => {
      await expect(
        service.correctLabel(ID, { cardName: 'Charizard', note: NOTE }, admin),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.consignmentEvent.create).not.toHaveBeenCalled();
    });

    it('KALAH klaim (nilainya berubah sejak layar dimuat) → 409, listing tidak disentuh', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          cardName: 'Charizad VMAX',
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1 },
        }),
      );
      prisma.consignment.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.correctLabel(
          ID,
          { cardName: 'Charizard VMAX', note: NOTE },
          admin,
        ),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'CONSIGNMENT_BAD_TRANSITION',
        }) as unknown,
      });
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    });

    it('listing yang SUDAH TERJUAL tidak disentuh — ia snapshot apa yang dibeli pembeli', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          cardName: 'Charizad VMAX',
          status: ConsignmentStatus.SOLD,
          listing: { id: 'listing-1', status: 'SOLD', priceIdrx: 1 },
        }),
      );
      // Predikat `status: ACTIVE` tidak cocok → 0 baris.
      prisma.listing.updateMany.mockResolvedValue({ count: 0 });

      const out = await service.correctLabel(
        ID,
        { cardName: 'Charizard VMAX', note: NOTE },
        admin,
      );

      expect(out.listingUpdated).toBe(false);
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: 'ACTIVE' }) as unknown,
        }),
      );
      // Catatan titipannya TETAP diperbaiki: arsip yang salah nama tetap salah selamanya.
      expect(out.corrected).toEqual([
        {
          field: 'cardName',
          before: 'Charizad VMAX',
          after: 'Charizard VMAX',
        },
      ]);
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ GRADER YANG TERTINGGAL KOSONG SAAT INTAKE PERNAH BERARTI KARTU TERKUNCI SELAMANYA.       ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `createListingFor` menolak SELAMANYA kartu tanpa grader, dan sebelum blok ini tidak ada SATU
   * rute pun yang bisa mengisi kolom itu sesudah serah-terima: kartu fisik milik orang lain duduk
   * di rak tanpa bisa dijual, dan satu-satunya jalan keluar dari IN_CUSTODY adalah RELEASE atau
   * LOST — dua-duanya fakta PALSU di buku besar yang sengaja append-only.
   */
  describe('correctLabel — grader bisa dikoreksi sesudah intake', () => {
    const NOTE =
      'Dropdown grader tertinggal kosong saat intake; dicocokkan ulang dengan slab.';

    it('mengisi grader yang tertinggal kosong: kolomnya ditulis, berpagar nilai LAMA', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ grader: null, certNumber: '12345678', listing: null }),
      );

      const out = await service.correctLabel(
        ID,
        { grader: 'PSA', note: NOTE },
        admin,
      );

      const [call] = prisma.consignment.updateMany.mock.calls as [
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ][];
      expect(call[0].data).toEqual({ grader: 'PSA' });
      expect(call[0].where).toEqual({ id: ID, grader: null });
      expect(out.corrected).toEqual([
        { field: 'grader', before: null, after: 'PSA' },
      ]);
    });

    it('grader yang dikoreksi IKUT memicu pra-cek bentrok nomor sertifikat', async () => {
      // Nomor sertifikatnya TIDAK berubah; yang berubah grader-nya. Kuncinya pasangan
      // (grader, certNumber), jadi mengubah separuhnya sama dengan memindahkan barisnya ke kunci
      // lain — yang bisa saja sudah dipakai titipan hidup lain.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ grader: null, certNumber: '12345678' }),
      );
      prisma.consignment.findFirst.mockResolvedValue({
        id: 'other',
        status: ConsignmentStatus.IN_CUSTODY,
      });

      await expect(
        service.correctLabel(ID, { grader: 'PSA', note: NOTE }, admin),
      ).rejects.toThrow(ConflictException);
      expect(prisma.consignment.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            grader: 'PSA',
            certNumber: '12345678',
          }) as unknown,
        }),
      );
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('listing yang masih ACTIVE ikut diperbarui DI TRANSAKSI YANG SAMA (grader + grade)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          grader: 'CGC',
          gradeLabel: null,
          gradeScore: 10,
          certNumber: null,
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1 },
        }),
      );

      const out = await service.correctLabel(
        ID,
        { grader: 'PSA', note: NOTE },
        admin,
      );

      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'listing-1', consignmentId: ID, status: 'ACTIVE' },
          data: expect.objectContaining({
            grader: 'PSA',
            // Rumus cadangannya memakai grader BARU, bukan yang lama.
            grade: 'PSA 10',
          }) as unknown,
        }),
      );
      expect(out.listingUpdated).toBe(true);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('DITOLAK kalau titipannya sudah punya pembeli — grading yang dibaca pembeli tidak boleh berubah', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.SOLD,
          soldOrderId: 'HOSHI-ORDER-9',
          grader: 'PSA',
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
        }),
      );

      await expect(
        service.correctLabel(ID, { grader: 'CGC', note: NOTE }, admin),
      ).rejects.toThrow(ConflictException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('field label LAIN tetap boleh dikoreksi sesudah terjual — hanya grader yang dikunci', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          status: ConsignmentStatus.SOLD,
          soldOrderId: 'HOSHI-ORDER-9',
          cardName: 'Charizad VMAX',
          listing: { id: 'listing-1', status: 'SOLD', buyerId: 'buyer-3' },
        }),
      );
      prisma.listing.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.correctLabel(
          ID,
          { cardName: 'Charizard VMAX', note: NOTE },
          admin,
        ),
      ).resolves.toBeDefined();
    });

    it('MENGOSONGKAN grader ditolak selagi listing-nya masih tayang (Listing.grader NOT NULL)', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          grader: 'PSA',
          certNumber: null,
          listing: { id: 'listing-1', status: 'ACTIVE', priceIdrx: 1 },
        }),
      );

      await expect(
        service.correctLabel(ID, { grader: '', note: NOTE }, admin),
      ).rejects.toThrow(ConflictException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ certNumber TANPA grader MEMATIKAN PENJAGA DOBEL-TITIP — di Postgres, NULL ≠ NULL.       ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   */
  describe('certNumber tanpa grader ditolak di KEDUA pintu', () => {
    it('createIntake: nomor sertifikat terisi + grader kosong → 400 yang menyebut KEDUANYA', async () => {
      const err: unknown = await service
        .createIntake(intakeDto({ certNumber: '12345678' }), admin)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      const msg = String((err as Error).message);
      expect(msg).toContain('sertifikat');
      expect(msg).toContain('GRADER');
      expect(prisma.consignment.create).not.toHaveBeenCalled();
    });

    it('createIntake: nomor sertifikat + grader lengkap tetap jalan', async () => {
      await expect(
        service.createIntake(
          intakeDto({ certNumber: '12345678', grader: 'PSA' }),
          admin,
        ),
      ).resolves.toBeDefined();
      expect(prisma.consignment.create).toHaveBeenCalled();
    });

    it('correctLabel: mengisi nomor sertifikat pada kartu tanpa grader DITOLAK', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ grader: null, certNumber: null }),
      );

      await expect(
        service.correctLabel(
          ID,
          { certNumber: '12345678', note: 'dibaca ulang dari slab-nya' },
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('correctLabel: MENGOSONGKAN grader pada kartu bernomor sertifikat juga DITOLAK', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ grader: 'PSA', certNumber: '12345678', listing: null }),
      );

      await expect(
        service.correctLabel(
          ID,
          { grader: '', note: 'katanya kartunya mentah' },
          admin,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.consignment.updateMany).not.toHaveBeenCalled();
    });

    it('correctLabel: baris WARISAN yang sudah berbentuk begitu tetap boleh dikoreksi namanya', async () => {
      // Koreksi yang TIDAK menyentuh pasangan (grader, certNumber) tidak ikut diblokir —
      // memblokirnya hanya membuat rute perbaikan ikut buntu untuk data lama.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          grader: null,
          certNumber: '12345678',
          cardName: 'Charizad VMAX',
          listing: null,
        }),
      );

      await expect(
        service.correctLabel(
          ID,
          { cardName: 'Charizard VMAX', note: 'salah ketik saat intake' },
          admin,
        ),
      ).resolves.toBeDefined();
    });
  });

  /* ═════════ B5 — PEMILIKNYA DIBERI TAHU (PRODUKNYA MENJANJIKANNYA DUA KALI) ═════════ */

  describe('pemberitahuan ke pemilik kartu', () => {
    it('kartu DIPAJANG → pemiliknya diberi tahu, dengan harga yang benar-benar dipajang', async () => {
      await service.createListingFor(
        ID,
        { image: '/x.png', priceIdrx: 24_000_000 },
        admin,
      );

      expect(notify.notifyListed).toHaveBeenCalledWith(
        expect.objectContaining({
          consignmentId: ID,
          consignorId: consignor.id,
          cardName: 'Charizard',
        }),
        { priceIdr: 24_000_000 },
      );
    });

    it('kartu HILANG → pemiliknya diberi tahu; ini yang paling tidak boleh senyap', async () => {
      await service.markLost(
        ID,
        { note: 'Hilang saat pemindahan rak; sedang diselidiki.' },
        admin,
      );
      expect(notify.notifyLost).toHaveBeenCalledWith(
        expect.objectContaining({ consignmentId: ID }),
      );
    });

    it('Path B (pemilik belum punya akun): tetap dipanggil, dan targetnya membawa nama + telepon', async () => {
      // Banyak pemilik memang tidak punya email, dan itu JALUR NORMAL — bukan kegagalan. Yang
      // dibawa ke notifier adalah satu-satunya cara menghubunginya: snapshot serah-terima.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ consignorId: null }),
      );
      await service.markLost(ID, { note: 'Hilang saat audit rak.' }, admin);

      expect(notify.notifyLost).toHaveBeenCalledWith(
        expect.objectContaining({
          consignorId: null,
          consignorNameAtIntake: 'Budi',
          consignorPhoneAtIntake: '+62811',
        }),
      );
    });
  });

  /* ═════════ B6 — LANTAI HARGA YANG DISEPAKATI: MEMPERINGATKAN, BUKAN MEMBLOKIR ═════════ */

  describe('reservePriceIdr — data yang akhirnya dibaca', () => {
    it('turun di bawah reserve TETAP dilakukan, tapi memperingatkan DAN mencatatnya', async () => {
      // Memblokir akan memaksa operator mengubah angka reserve-nya sendiri — dan pagar yang bisa
      // dilangkahi dengan mengubah pagarnya bukan pagar, cuma gesekan yang diajari untuk
      // diabaikan. Yang benar: tetap jalan, tapi tidak pernah diam-diam.
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ reservePriceIdr: 20_000_000, askPriceIdr: 24_000_000 }),
      );

      const out = await service.updatePrice(
        ID,
        {
          askPriceIdr: 18_000_000,
          note: 'Pemilik minta turun lewat telepon, sudah disetujui.',
        },
        admin,
      );

      expect(out.belowReserveWarning).toMatch(/DI BAWAH HARGA TERENDAH/);
      expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { askPriceIdr: 18_000_000 },
        }),
      );
      expect(allEventNotes()[0]).toMatch(/reserve Rp 20000000/);
    });

    /* ══════════════════════════════════════════════════════════════════════════════════════
       MENURUNKAN HARGA TIDAK BOLEH MENGARANG RIWAYAT PASAR.

       `createListingFor` menyamakan `expectedValueIdrx` dengan harga saat kartu pertama
       dipajang — memang tidak ada taksiran pasar independen untuk kartu titipan; yang kita
       punya hanya harga yang disepakati.

       Kalau `updatePrice` hanya menurunkan `priceIdrx`, keduanya berpisah, dan serializer
       marketplace MENGARANG riwayat dari selisih itu: panah merah "-40% 30D" untuk kartu yang
       tidak pernah diperdagangkan sekali pun, plus lompatan ke puncak sortir "Best Value"
       semata-mata karena harganya pernah diturunkan. Kartu orang lain tidak boleh diberi
       riwayat pasar palsu demi tampak menarik.
       ══════════════════════════════════════════════════════════════════════════════════════ */
    it('menurunkan harga ikut menurunkan taksiran — tidak ada "-40% 30D" yang dikarang', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({
          askPriceIdr: 20_000_000,
          listing: { id: 'listing-1', status: 'ACTIVE' },
        }),
      );

      await service.updatePrice(
        ID,
        {
          askPriceIdr: 12_000_000,
          note: 'Pemilik minta turun; sudah disetujui lewat telepon.',
        },
        admin,
      );

      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            priceIdrx: 12_000_000,
            expectedValueIdrx: 12_000_000,
          },
        }),
      );
    });

    it('di ATAS reserve: tidak ada peringatan sama sekali', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ reservePriceIdr: 20_000_000 }),
      );
      const out = await service.updatePrice(
        ID,
        {
          askPriceIdr: 21_000_000,
          note: 'Harga pasar naik; disepakati pemilik.',
        },
        admin,
      );
      expect(out.belowReserveWarning).toBeNull();
    });

    it('memajang di bawah reserve ikut diperingatkan dan tercatat di jejak audit', async () => {
      prisma.consignment.findUnique.mockResolvedValue(
        rowWith({ reservePriceIdr: 20_000_000 }),
      );
      const out = await service.createListingFor(
        ID,
        { image: '/x.png', priceIdrx: 18_000_000 },
        admin,
      );
      expect(out.belowReserveWarning).toMatch(/DI BAWAH HARGA TERENDAH/);
      expect(allEventNotes().join(' ')).toMatch(/reserve Rp 20000000/);
    });

    it('nilainya SAMPAI ke layar: angka reserve, harga berlaku, dan benderanya', async () => {
      prisma.consignment.findMany.mockResolvedValue([
        rowWith({
          id: 'x',
          status: ConsignmentStatus.LISTED,
          reservePriceIdr: 20_000_000,
          listing: { id: 'l1', status: 'ACTIVE', priceIdrx: 18_000_000 },
        }),
      ]);

      const out = await service.adminList();

      expect(out.rows[0].reservePriceIdr).toBe(20_000_000);
      expect(out.rows[0].belowReserve).toBe(true);
      expect(out.rows[0].effectivePriceIdr).toBe(18_000_000);
      expect(out.actionRequired[0].reasons.join(' ')).toMatch(
        /DI BAWAH harga terendah/,
      );
    });
  });
});
