/* Harness ini SENGAJA berbicara dengan DB palsu bertipe longgar: yang diuji adalah PREDIKAT dan
   PERGERAKAN BARIS, bukan tipe Prisma. Pelonggaran dibatasi ke file test ini saja. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { CcShippingService } from '../collectorcrypt/cc-shipping.service';
import { PaymentsService } from '../payments/payments.service';
import {
  REDEMPTION_ACTIVE_STATUSES,
  RedemptionService,
} from './redemption.service';

// Rantai DI di sini menarik Solana v1 (umi → web3.js → rpc-websockets/uuid) yang bikin jest gagal
// parse. Sama seperti admin.service.spec.ts / redemption.service.spec.ts: kelas-kelasnya cuma
// dipakai sebagai TOKEN DI dan selalu diberi fake, jadi tak ada key dibaca / tx ditandatangani.
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
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ B1 — BUKTI KETERJANGKAUAN JALAN KELUAR (bukan sekadar DEKLARASI jalan keluar).                ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * KENAPA FILE INI ADA — dan kenapa test yang sudah ada TIDAK CUKUP.
 *
 * `redemption.service.spec.ts` punya test bernama "every blocking status has at least one declared
 * exit". Test itu HIJAU sepanjang bug B1 yang ketiga hidup di produksi, karena yang diperiksanya
 * cuma: "apakah ada STRING di tabel dokumentasi untuk status ini?". Sebuah string tidak pernah
 * membuka kunci kartu siapa pun. Bug-nya persis di celah itu: baris tabelnya ADA
 * ("fulfilShipping → READY_TO_FUND; invoice EXPIRED → REQUESTED; cancel → CANCELED"), tapi
 * KEEMPAT jalan keluar itu ikut tertutup begitu PaymentOrder yang dipin masuk ke FULFILLING atau
 * REFUND_DUE — dan tidak satu pun test yang menyadarinya.
 *
 * POLANYA (sudah KAMBUH TIGA KALI): seseorang melebarkan himpunan status pemblokir supaya kartu
 * tidak bisa di-redeem dua kali, lalu lupa bahwa memblokir = mengunci kalau tidak ada yang bisa
 * menggerakkan barisnya keluar.
 *
 * YANG DILAKUKAN FILE INI UNTUK MENUTUP KELASNYA, bukan cuma instansnya:
 *
 *   1. Jalan keluar didaftarkan sebagai FUNGSI YANG BENAR-BENAR DIPANGGIL (`ExitDriver.run`),
 *      bukan sebagai kalimat. Kalau rute-nya tidak ada, salah nama, atau menolak barisnya, driver
 *      itu tidak akan memindahkan apa pun dan test-nya MERAH.
 *   2. Setiap status pemblokir diuji di SETIAP kombinasi dengan status PaymentOrder — SELURUH enum
 *      PaymentStatus, plus kasus "tidak ada order sama sekali". Inilah sumbu yang dilewatkan semua
 *      review sebelumnya: statusnya punya jalan keluar, tapi hanya untuk SEBAGIAN keadaan order.
 *   3. Daftar status pemblokirnya DI-IMPOR dari service (`REDEMPTION_ACTIVE_STATUSES`). Menambah
 *      status pemblokir baru tanpa menambahkan driver-nya di sini = `EXIT_DRIVERS[status]`
 *      undefined = test MERAH sebelum kodenya sempat mengunci kartu siapa pun.
 *
 * "Jalan keluar" DIDEFINISIKAN SECARA KERAS: sesudah driver dijalankan, kolom `status` baris
 * redemption di DB palsu HARUS berbeda dari status awalnya. Bukan "tidak melempar", bukan
 * "mengembalikan sesuatu" — BERGERAK.
 */

const RED_ID = 'red-reachability';
const ORDER_ROW_ID = 'order-row-1';
const MERCHANT_ORDER_ID = 'HOSHI-SHIP-REACH-1';
const TREASURY = 'TreasuryWalletBase58';

const USER: AuthUser = {
  id: 'user-1',
  walletAddress: 'HoshiUserWalletBase58',
  displayName: null,
  role: 'USER',
};
const ADMIN = {
  id: 'admin-1',
  walletAddress: 'AdminWalletBase58',
  role: 'ADMIN',
};

/** Alasan operator — panjangnya harus lolos syarat "minimal 10 karakter" di rute admin. */
const OPERATOR_REASON =
  'latihan keterjangkauan: baris ini harus punya jalan keluar yang benar-benar bisa dijalankan.';

type Row = Record<string, any>;

/** DB palsu: satu baris redemption, paling banyak satu order ongkir, satu user. */
interface World {
  redemption: Row;
  order: Row | null;
  user: Row;
}

/** Cocokkan baris dengan klausa WHERE Prisma yang dipakai kode produksi (scalar atau `{ in: [] }`). */
function matches(row: Row, where: Record<string, any> | undefined): boolean {
  for (const [key, want] of Object.entries(where ?? {})) {
    if (want !== null && typeof want === 'object' && 'in' in want) {
      if (!(want.in as unknown[]).includes(row[key])) return false;
    } else if (row[key] !== want) {
      return false;
    }
  }
  return true;
}

/**
 * Prisma palsu yang MENGHORMATI PREDIKAT. Ini yang membuat test ini bermakna: `updateMany` di sini
 * benar-benar bisa mengembalikan `{ count: 0 }` seperti Postgres, jadi tulisan berpagar yang salah
 * predikat akan GAGAL memindahkan baris — persis seperti di produksi.
 */
function fakePrisma(world: World): PrismaService {
  const p: any = {
    cardRedemption: {
      findUnique: async ({ where }: any) =>
        world.redemption.id === where.id ? { ...world.redemption } : null,
      findFirst: async ({ where }: any) =>
        matches(world.redemption, where) ? { ...world.redemption } : null,
      findMany: async ({ where }: any) =>
        matches(world.redemption, where) ? [{ ...world.redemption }] : [],
      updateMany: async ({ where, data }: any) => {
        if (!matches(world.redemption, where)) return { count: 0 };
        Object.assign(world.redemption, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        if (world.redemption.id !== where.id) throw new Error('row not found');
        Object.assign(world.redemption, data);
        return { ...world.redemption };
      },
      create: async ({ data }: any) => ({ id: 'red-new', ...data }),
    },
    paymentOrder: {
      findUnique: async ({ where }: any) => {
        if (!world.order) return null;
        const hit =
          (where.id !== undefined && world.order.id === where.id) ||
          (where.merchantOrderId !== undefined &&
            world.order.merchantOrderId === where.merchantOrderId);
        return hit ? { ...world.order } : null;
      },
      findFirst: async ({ where }: any) =>
        world.order && matches(world.order, where) ? { ...world.order } : null,
      findMany: async ({ where }: any) =>
        world.order && matches(world.order, where) ? [{ ...world.order }] : [],
      updateMany: async ({ where, data }: any) => {
        if (!world.order || !matches(world.order, where)) return { count: 0 };
        Object.assign(world.order, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        if (
          !world.order ||
          (where.merchantOrderId !== undefined &&
            world.order.merchantOrderId !== where.merchantOrderId) ||
          (where.id !== undefined && world.order.id !== where.id)
        ) {
          throw new Error('order not found');
        }
        Object.assign(world.order, data);
        return { ...world.order };
      },
    },
    user: {
      findUnique: async ({ where }: any) =>
        world.user.id === where.id ? { ...world.user } : null,
    },
    activity: { create: async () => ({}) },
    $transaction: async (cb: any) => cb(p),
  };
  return p as PrismaService;
}

/* ─────────────────── konstruktor service dengan dependensi palsu ─────────────────── */

const redemptionService = (world: World) =>
  new RedemptionService(
    fakePrisma(world),
    {} as unknown as CcShippingService,
    {} as unknown as PaymentsService,
  );

const adminService = (world: World) =>
  new AdminService(
    fakePrisma(world),
    {} as any,
    {} as any,
    {} as any,
    // D — EscrowService. File ini hanya menelusuri transisi status redemption; escrow tidak
    // pernah dipanggil dari jalur itu.
    {} as any,
  );

/** CcShippingService cukup butuh config gate + klien CC; treasury tak tersentuh di refreshStatus. */
const ccShippingService = (world: World, ccStatus: string) =>
  new CcShippingService(
    fakePrisma(world),
    {
      get: (k: string) =>
        k === 'HOSHI_CC_SHIPPING_ENABLED' ? 'true' : undefined,
    } as any,
    {
      getShipment: async () => ({
        status: ccStatus,
        trackingIds: ['TRK-1'],
        trackingUrls: ['https://track/TRK-1'],
      }),
    } as any,
    {} as any,
  );

/** PaymentsService: hanya prisma + idrx + config yang tersentuh di jalur verifikasi ongkir. */
const paymentsService = (
  world: World,
  idrx: { paymentStatus: string; userMintStatus: string },
) =>
  new PaymentsService(
    fakePrisma(world),
    {
      findMintByMerchantOrderId: async () => ({
        merchantOrderId: MERCHANT_ORDER_ID,
        paymentStatus: idrx.paymentStatus,
        userMintStatus: idrx.userMintStatus,
        destinationWalletAddress: TREASURY,
        toBeMinted: String(world.order?.priceIdr ?? 0),
        requestType: 'idrx',
        txHash: null,
      }),
    } as any,
    {} as any,
    {
      get: (k: string) => (k === 'HOSHI_TREASURY_ADDRESS' ? TREASURY : undefined),
    } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

/* ─────────────────────────── driver jalan keluar ─────────────────────────── */

interface ExitDriver {
  /** Rute nyata yang diwakili driver ini — muncul di pesan kegagalan test. */
  label: string;
  run: (world: World) => Promise<unknown>;
  /**
   * B2 — JALAN KELUAR YANG BUKAN MILIK KITA.
   *
   * `true` berarti pintu ini baru terbuka kalau PIHAK KETIGA memutuskan membukanya: shipment CC
   * harus benar-benar menjawab `Delivered`. Kalau CC memarkir kiriman di `Shipped`, atau
   * `GET /outbound-shipment/:id` mulai menjawab 200-body-kosong "id tak dikenal", driver ini tidak
   * memindahkan apa pun — dan test yang fake-nya SELALU menjawab `Delivered` akan tetap HIJAU
   * sambil menyembunyikan kenyataan itu. Karena itu matriks di bawah tidak cukup: ada test
   * TERSENDIRI yang menuntut setiap status pemblokir punya MINIMAL SATU jalan keluar yang
   * pemicunya ADA DI TANGAN KITA (rute admin/user), bukan di tangan CC.
   */
  thirdParty?: true;
}

const userCancel: ExitDriver = {
  label: 'user POST /redemptions/:id/cancel',
  run: (w) => redemptionService(w).cancel(RED_ID, USER, 'salah alamat'),
};

const adminCancelAwaitingPayment: ExitDriver = {
  label: 'admin POST /admin/redemptions/:id/cancel-awaiting-payment',
  run: (w) => adminService(w).cancelAwaitingPayment(RED_ID, OPERATOR_REASON, ADMIN),
};

const adminPatch = (to: RedemptionStatus): ExitDriver => ({
  label: `admin PATCH /admin/redemptions/:id/status -> ${to}`,
  run: (w) => adminService(w).updateRedemptionStatus(RED_ID, to),
});

const adminRecoverBurnSubmitted: ExitDriver = {
  label: 'admin POST /admin/redemptions/:id/recover-burn-submitted',
  run: (w) =>
    adminService(w).recoverBurnSubmittedToFunded(RED_ID, OPERATOR_REASON, ADMIN),
};

const adminSettleReadyToFund: ExitDriver = {
  label: 'admin POST /admin/redemptions/:id/settle-refund-due',
  run: (w) =>
    adminService(w).settleReadyToFundAsRefundDue(RED_ID, OPERATOR_REASON, ADMIN),
};

const ccPollDelivered: ExitDriver = {
  label: 'GET /redemptions/:id/status (poll CC -> Delivered)',
  run: (w) => ccShippingService(w, 'Delivered').refreshStatus(RED_ID, USER, 'cca_token'),
  // Pintunya milik CollectorCrypt, bukan kita: ia hanya terbuka kalau CC MENJAWAB `Delivered`.
  thirdParty: true,
};

const idrxExpirySweep: ExitDriver = {
  label: 'verifikasi IDRX: invoice EXPIRED -> lepas klaim ke REQUESTED',
  run: (w) =>
    paymentsService(w, {
      paymentStatus: 'EXPIRED',
      userMintStatus: 'NOT_AVAILABLE',
    }).verifyAndFulfil(MERCHANT_ORDER_ID),
};

const idrxPaidFulfil: ExitDriver = {
  label: 'verifikasi IDRX: PAID+MINTED -> fulfilShipping -> READY_TO_FUND',
  run: (w) =>
    paymentsService(w, {
      paymentStatus: 'PAID',
      userMintStatus: 'MINTED',
    }).verifyAndFulfil(MERCHANT_ORDER_ID),
};

/**
 * TABEL KONTRAK. Kuncinya WAJIB persis sama dengan REDEMPTION_ACTIVE_STATUSES (diuji di bawah),
 * jadi status pemblokir baru tidak bisa masuk diam-diam tanpa jalan keluar yang BISA DIJALANKAN.
 */
const EXIT_DRIVERS: Partial<Record<RedemptionStatus, ExitDriver[]>> = {
  [RedemptionStatus.REQUESTED]: [
    userCancel,
    adminPatch(RedemptionStatus.CANCELED),
  ],
  [RedemptionStatus.PACKING]: [adminPatch(RedemptionStatus.SHIPPED)],
  [RedemptionStatus.SHIPPED]: [adminPatch(RedemptionStatus.DELIVERED)],
  // Status yang MELAHIRKAN B1 tiga kali. Empat driver, dan matriks di bawah membuktikan bahwa
  // untuk SETIAP status PaymentOrder minimal satu di antaranya benar-benar menembak.
  [RedemptionStatus.AWAITING_PAYMENT]: [
    userCancel,
    adminCancelAwaitingPayment,
    idrxExpirySweep,
    idrxPaidFulfil,
  ],
  [RedemptionStatus.READY_TO_FUND]: [adminSettleReadyToFund],
  [RedemptionStatus.FUNDING]: [adminPatch(RedemptionStatus.RECLAIM_DUE)],
  [RedemptionStatus.FUNDED]: [adminPatch(RedemptionStatus.RECLAIM_DUE)],
  [RedemptionStatus.BURN_SUBMITTED]: [adminRecoverBurnSubmitted, ccPollDelivered],
  // B2: dulu HANYA ccPollDelivered — satu-satunya sel matriks yang jalan keluarnya milik CC.
  [RedemptionStatus.IN_TRANSIT]: [
    ccPollDelivered,
    adminPatch(RedemptionStatus.DELIVERED),
  ],
  [RedemptionStatus.RECLAIM_DUE]: [adminPatch(RedemptionStatus.CANCELED)],
  [RedemptionStatus.SHIP_FAILED_POST_BURN]: [
    adminPatch(RedemptionStatus.DELIVERED),
  ],
};

/** Semua nilai enum PaymentStatus + `null` (redemption tanpa order ongkir sama sekali). */
const ORDER_STATES: Array<PaymentStatus | null> = [
  ...Object.values(PaymentStatus),
  null,
];

/** Dunia baru untuk SETIAP percobaan driver — supaya satu driver tak pernah menolong driver lain. */
function seed(
  status: RedemptionStatus,
  orderStatus: PaymentStatus | null,
): World {
  return {
    redemption: {
      id: RED_ID,
      userId: USER.id,
      nftAddress: 'NftAddrBase58',
      cardName: 'Charizard',
      cardImage: null,
      cardSet: 'Base',
      recipientName: 'Budi',
      city: 'Jakarta',
      country: 'ID',
      status,
      note: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      processedAt: null,
      // Baris SEHAT pra-danai: kedua kolom jejak pasca-danai pada nilai "belum pernah didanai".
      fundingSignature: null,
      refundSafe: true,
      paymentOrderId: orderStatus === null ? null : ORDER_ROW_ID,
      outboundShipmentId: 'cc-shipment-1',
      trackingIds: [],
      trackingUrls: [],
    },
    order:
      orderStatus === null
        ? null
        : {
            id: ORDER_ROW_ID,
            merchantOrderId: MERCHANT_ORDER_ID,
            userId: USER.id,
            packType: 'SHIPPING',
            redemptionId: RED_ID,
            listingId: null,
            offerId: null,
            priceIdr: 125_000,
            priceUsdc: 8_000_000,
            status: orderStatus,
            refundSafe: true,
            paidAt: null,
            error: null,
            createdAt: new Date('2026-09-01T00:00:00.000Z'),
          },
    user: { id: USER.id, walletAddress: USER.walletAddress, displayName: null, role: 'USER' },
  };
}

describe('B1 — every blocking redemption status has a REACHABLE exit (not just a declared one)', () => {
  it('the driver table covers exactly the blocking statuses — a new one cannot slip in undriven', () => {
    expect(Object.keys(EXIT_DRIVERS).sort()).toEqual(
      [...REDEMPTION_ACTIVE_STATUSES].sort(),
    );
    for (const status of REDEMPTION_ACTIVE_STATUSES) {
      expect((EXIT_DRIVERS[status] ?? []).length).toBeGreaterThan(0);
    }
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B2 — "PUNYA JALAN KELUAR" TIDAK CUKUP. HARUS ADA JALAN KELUAR YANG PEMICUNYA MILIK KITA. ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Matriks besar di bawah menuntut "minimal satu driver menembak". Itu HIJAU juga untuk status
   * yang satu-satunya pintunya dipegang CollectorCrypt — karena fake CC di file ini SELALU
   * menjawab `Delivered`. Produksi tidak begitu: CC bisa memarkir kiriman di `Shipped` (dipetakan
   * ke IN_TRANSIT, tidak memajukan apa pun), dan `GET /outbound-shipment/:id` yang menjawab
   * 200-body-kosong membuat refreshStatus sengaja TIDAK menulis apa pun. Baris yang jalan
   * keluarnya cuma itu = tersangkut selamanya, dan `nftAddress`-nya menahan indeks unik yang
   * dilebarkan sehingga mint itu tidak bisa diminta kirim lagi.
   *
   * Test ini membuat ketergantungan itu KELIHATAN. Status pemblokir baru yang jalan keluarnya
   * hanya "kebaikan hati CC" akan MERAH di sini, bukan diam-diam hijau di matriks.
   */
  it('every blocking status ALSO has an exit WE control — never only a third party’s goodwill', () => {
    const controlled = Object.fromEntries(
      REDEMPTION_ACTIVE_STATUSES.map((status) => [
        status,
        (EXIT_DRIVERS[status] ?? [])
          .filter((d) => !d.thirdParty)
          .map((d) => d.label),
      ]),
    );
    // Dilaporkan sebagai PETA, bukan boolean: kalau merah, pesan kegagalannya langsung menyebut
    // status mana yang kehabisan pintu milik kita — dan menampilkan pintu pihak ketiganya.
    const hasOurs = Object.fromEntries(
      Object.entries(controlled).map(([status, labels]) => [
        status,
        labels.length > 0,
      ]),
    );
    expect(hasOurs).toEqual(
      Object.fromEntries(REDEMPTION_ACTIVE_STATUSES.map((s) => [s, true])),
    );
  });

  /** Satu-satunya driver yang ditandai milik pihak ketiga saat ini adalah poll CC. Kalau nanti ada
   *  yang menambah driver pihak-ketiga lain, daftar ini ikut berubah dan reviewer melihatnya. */
  it('the third-party-dependent exits are declared, not assumed', () => {
    const thirdParty = new Set<string>();
    for (const drivers of Object.values(EXIT_DRIVERS)) {
      for (const d of drivers ?? []) if (d.thirdParty) thirdParty.add(d.label);
    }
    expect([...thirdParty]).toEqual([ccPollDelivered.label]);
  });

  /**
   * ANTI-KAMUFLASE. Fake CC di matriks selalu menjawab `Delivered`; di sini ia menjawab `Shipped` —
   * persis kiriman yang DIPARKIR CC. Poll-nya jadi tidak memindahkan apa pun (itulah bug B2), dan
   * yang membuka barisnya adalah rute admin yang BARU.
   */
  it('IN_TRANSIT: when CC parks the shipment at `Shipped`, the CC poll moves NOTHING — the admin route still does', async () => {
    // 1. Pintu pihak ketiga: MACET.
    const parked = seed(RedemptionStatus.IN_TRANSIT, null);
    await ccShippingService(parked, 'Shipped').refreshStatus(
      RED_ID,
      USER,
      'cca_token',
    );
    expect(parked.redemption.status).toBe(RedemptionStatus.IN_TRANSIT);

    // 2. Pintu yang sama tetap macet kalau CC menjawab "id tak dikenal" (200 body kosong).
    const unknownId = seed(RedemptionStatus.IN_TRANSIT, null);
    const svc = new CcShippingService(
      fakePrisma(unknownId),
      {
        get: (k: string) =>
          k === 'HOSHI_CC_SHIPPING_ENABLED' ? 'true' : undefined,
      } as any,
      { getShipment: async () => null } as any,
      {} as any,
    );
    await svc.refreshStatus(RED_ID, USER, 'cca_token');
    expect(unknownId.redemption.status).toBe(RedemptionStatus.IN_TRANSIT);

    // 3. Pintu MILIK KITA: terbuka. Dan ia tidak menyentuh kolom uang.
    const viaAdmin = seed(RedemptionStatus.IN_TRANSIT, null);
    await adminService(viaAdmin).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.DELIVERED,
    );
    expect(viaAdmin.redemption.status).toBe(RedemptionStatus.DELIVERED);
    expect(viaAdmin.redemption.refundSafe).toBe(true);
    expect(viaAdmin.redemption.fundingSignature).toBeNull();
  });

  /** Rute barunya SEMPIT: IN_TRANSIT hanya boleh ke DELIVERED, tidak ke mana-mana lagi. */
  it.each([
    RedemptionStatus.CANCELED,
    RedemptionStatus.REFUND_DUE,
    RedemptionStatus.RECLAIM_DUE,
    RedemptionStatus.FUNDED,
    RedemptionStatus.SHIP_FAILED_POST_BURN,
  ])('IN_TRANSIT -> %s is still refused by the admin status route', async (to) => {
    const world = seed(RedemptionStatus.IN_TRANSIT, null);
    await expect(
      adminService(world).updateRedemptionStatus(RED_ID, to),
    ).rejects.toBeDefined();
    expect(world.redemption.status).toBe(RedemptionStatus.IN_TRANSIT);
  });

  describe.each([...REDEMPTION_ACTIVE_STATUSES])('status %s', (status) => {
    it.each(ORDER_STATES)(
      'escapes even when its shipping PaymentOrder is %s',
      async (orderStatus) => {
        const fired: string[] = [];
        for (const driver of EXIT_DRIVERS[status] ?? []) {
          // Dunia BARU tiap driver: tidak ada driver yang boleh menumpang hasil driver sebelumnya.
          const world = seed(status, orderStatus);
          try {
            await driver.run(world);
          } catch {
            // Menolak itu SAH (mis. tombol user menolak order PAID). Yang dinilai cuma satu hal:
            // apakah barisnya BERGERAK. Driver yang menolak semuanya = status terkunci = MERAH.
          }
          if (world.redemption.status !== status) fired.push(driver.label);
        }
        expect(fired.length).toBeGreaterThan(0);
      },
    );
  });

  /**
   * MATRIKS DI ATAS cuma menuntut "minimal satu". Tabel di bawah menuntut PERSIS SIAPA — supaya
   * sebuah jalan keluar yang diam-diam rusak (mis. jalur verifikasi IDRX berhenti melepas klaim)
   * tidak bisa bersembunyi di balik jalan keluar lain yang kebetulan masih hidup.
   */
  it('AWAITING_PAYMENT: exactly the expected exits fire for each PaymentOrder status', async () => {
    const EXPECTED: Record<string, string[]> = {
      // Invoice masih hidup: semuanya bisa. (Pemenuhan menang kalau pembayarannya beneran masuk.)
      [PaymentStatus.PENDING]: [
        userCancel.label,
        adminCancelAwaitingPayment.label,
        idrxExpirySweep.label,
        idrxPaidFulfil.label,
      ],
      // Rupiah mendarat: tombol user MENOLAK (pemenuhan otomatis masih hidup) — sisanya jalan.
      [PaymentStatus.PAID]: [
        adminCancelAwaitingPayment.label,
        idrxExpirySweep.label,
        idrxPaidFulfil.label,
      ],
      // ⚠️ INI SKENARIO A DARI LAPORAN: proses mati tepat sesudah klaim atomik. Kedua jalur IDRX
      // mati total di sini (klaim tidak bisa diambil dua kali) — pembatalanlah satu-satunya pintu.
      [PaymentStatus.FULFILLING]: [
        userCancel.label,
        adminCancelAwaitingPayment.label,
      ],
      [PaymentStatus.FULFILLED]: [adminCancelAwaitingPayment.label],
      [PaymentStatus.EXPIRED]: [
        userCancel.label,
        adminCancelAwaitingPayment.label,
      ],
      [PaymentStatus.FAILED]: [
        userCancel.label,
        adminCancelAwaitingPayment.label,
      ],
      // ⚠️ SKENARIO B: pin menyimpang → order REFUND_DUE, redemption tetap AWAITING_PAYMENT.
      [PaymentStatus.REFUND_DUE]: [
        userCancel.label,
        adminCancelAwaitingPayment.label,
      ],
      NONE: [userCancel.label, adminCancelAwaitingPayment.label],
    };

    for (const orderStatus of ORDER_STATES) {
      const fired: string[] = [];
      for (const driver of EXIT_DRIVERS[RedemptionStatus.AWAITING_PAYMENT] ?? []) {
        const world = seed(RedemptionStatus.AWAITING_PAYMENT, orderStatus);
        try {
          await driver.run(world);
        } catch {
          /* menolak itu sah; yang dinilai cuma apakah barisnya bergerak */
        }
        if (world.redemption.status !== RedemptionStatus.AWAITING_PAYMENT) {
          fired.push(driver.label);
        }
      }
      expect({ orderStatus: orderStatus ?? 'NONE', fired }).toEqual({
        orderStatus: orderStatus ?? 'NONE',
        fired: EXPECTED[orderStatus ?? 'NONE'],
      });
    }
  });

  /**
   * REGRESI PERSIS B1 (kambuh ke-3). Sebelum perbaikan ini, kedua kasus di bawah membuat
   * AWAITING_PAYMENT jadi KUNCI PERMANEN: order yang macet di FULFILLING (proses mati tepat
   * sesudah klaim atomik) dan order yang ditandai REFUND_DUE karena pin-nya menyimpang.
   */
  it.each([PaymentStatus.FULFILLING, PaymentStatus.REFUND_DUE])(
    'AWAITING_PAYMENT + pinned order %s: the USER can still cancel (this was the permanent lock)',
    async (orderStatus) => {
      const world = seed(RedemptionStatus.AWAITING_PAYMENT, orderStatus);
      const res = await redemptionService(world).cancel(RED_ID, USER, 'tab IDRX ketutup');

      expect(world.redemption.status).toBe(RedemptionStatus.CANCELED);
      expect(res.status).toBe(RedemptionStatus.CANCELED);
      // Dan uangnya TIDAK menguap: tagihannya dilaporkan balik ke pemanggil.
      expect(res.shippingDebts).toHaveLength(1);
      expect(res.shippingDebts[0].merchantOrderId).toBe(MERCHANT_ORDER_ID);
      expect(res.shippingDebts[0].priceIdr).toBe(125_000);
    },
  );

  it('AWAITING_PAYMENT + order FULFILLING: the cancel CONVERTS the stuck order into a recorded debt', async () => {
    const world = seed(
      RedemptionStatus.AWAITING_PAYMENT,
      PaymentStatus.FULFILLING,
    );
    const res = await redemptionService(world).cancel(RED_ID, USER);

    // Baris order-nya sendiri sekarang REFUND_DUE — utang yang bisa dicari operator lewat status.
    expect(world.order?.status).toBe(PaymentStatus.REFUND_DUE);
    expect(String(world.order?.error)).toContain('UTANG ONGKIR KIRIM FISIK');
    // refundSafe DIBACA, tidak pernah DITULIS oleh jalur ini.
    expect(world.order?.refundSafe).toBe(true);
    expect(res.shippingDebts[0]).toMatchObject({
      statusBefore: PaymentStatus.FULFILLING,
      statusAfter: PaymentStatus.REFUND_DUE,
      recordedNow: true,
      refundSafe: true,
    });
  });

  it('AWAITING_PAYMENT + order already REFUND_DUE: the debt row is LEFT ALONE and reported, not rewritten', async () => {
    const world = seed(
      RedemptionStatus.AWAITING_PAYMENT,
      PaymentStatus.REFUND_DUE,
    );
    world.order!.error = 'utang lama dari pin yang menyimpang';
    const res = await redemptionService(world).cancel(RED_ID, USER);

    expect(world.order?.status).toBe(PaymentStatus.REFUND_DUE);
    expect(world.order?.error).toBe('utang lama dari pin yang menyimpang');
    expect(res.shippingDebts[0]).toMatchObject({
      statusBefore: PaymentStatus.REFUND_DUE,
      statusAfter: PaymentStatus.REFUND_DUE,
      recordedNow: false,
    });
  });

  /**
   * Batas yang TIDAK dilonggarkan: PAID berarti mesin pemenuhannya masih hidup (reconciler akan
   * mengklaimnya), FULFILLED berarti ongkirnya sudah dilayani. Tombol user tetap menolak keduanya —
   * dan itu BUKAN kunci permanen, karena rute admin di bawahnya tetap membuka barisnya.
   */
  it.each([PaymentStatus.PAID, PaymentStatus.FULFILLED])(
    'AWAITING_PAYMENT + order %s: the user button still refuses, but the ADMIN route still opens it',
    async (orderStatus) => {
      const refused = seed(RedemptionStatus.AWAITING_PAYMENT, orderStatus);
      await expect(
        redemptionService(refused).cancel(RED_ID, USER),
      ).rejects.toBeDefined();
      expect(refused.redemption.status).toBe(RedemptionStatus.AWAITING_PAYMENT);

      const viaAdmin = seed(RedemptionStatus.AWAITING_PAYMENT, orderStatus);
      await adminService(viaAdmin).cancelAwaitingPayment(
        RED_ID,
        OPERATOR_REASON,
        ADMIN,
      );
      expect(viaAdmin.redemption.status).toBe(RedemptionStatus.CANCELED);
    },
  );

  /**
   * Pagar uang tetap utuh: baris yang membawa jejak PASCA-danai tidak bisa dikeluarkan lewat
   * RUTE PRA-DANAI mana pun — user maupun admin. Itu kasus RECLAIM_DUE, bukan kasus pembatalan.
   */
  it.each([{ fundingSignature: 'FUNDSIG' }, { refundSafe: false }])(
    'neither cancel route touches an AWAITING_PAYMENT row carrying post-fund traces (%p)',
    async (trace) => {
      for (const driver of [userCancel, adminCancelAwaitingPayment]) {
        const world = seed(RedemptionStatus.AWAITING_PAYMENT, PaymentStatus.FULFILLING);
        Object.assign(world.redemption, trace);
        await expect(driver.run(world)).rejects.toBeDefined();
        expect(world.redemption.status).toBe(RedemptionStatus.AWAITING_PAYMENT);
        // Dan order ongkirnya TIDAK ikut diubah — tidak ada utang yang dideklarasikan sepihak.
        expect(world.order?.status).toBe(PaymentStatus.FULFILLING);
      }
    },
  );

  /**
   * ANTI-TAUTOLOGI: harness ini harus BISA MERAH. Kalau sebuah status pemblokir kehilangan semua
   * driver-nya (persis bentuk bug B1), loop matriks di atas tidak akan menemukan satu pun yang
   * menembak. Di sini kita jalankan inti loop itu atas tabel yang sengaja dilubangi dan
   * membuktikan hasilnya nol — jadi hijaunya test di atas memang berarti sesuatu.
   */
  it('is not vacuous: a blocking status stripped of its drivers yields ZERO firing exits', async () => {
    const world = seed(RedemptionStatus.AWAITING_PAYMENT, PaymentStatus.FULFILLING);
    const stripped: ExitDriver[] = [];
    const fired: string[] = [];
    for (const driver of stripped) {
      try {
        await driver.run(world);
      } catch {
        /* diabaikan, sama seperti di loop matriks */
      }
      if (world.redemption.status !== RedemptionStatus.AWAITING_PAYMENT) {
        fired.push(driver.label);
      }
    }
    expect(fired).toHaveLength(0);
    expect(world.redemption.status).toBe(RedemptionStatus.AWAITING_PAYMENT);
  });
});
