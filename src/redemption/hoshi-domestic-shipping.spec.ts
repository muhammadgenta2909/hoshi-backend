/* Harness ini SENGAJA berbicara dengan DB palsu bertipe longgar: yang diuji adalah PREDIKAT dan
   PERGERAKAN BARIS, bukan tipe Prisma. Pelonggaran dibatasi ke file test ini saja. */
/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-explicit-any, @typescript-eslint/require-await */
import { Logger } from '@nestjs/common';
import { ListingStatus, PaymentStatus, RedemptionStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import { AdminService } from '../admin/admin.service';
import { CcShippingService } from '../collectorcrypt/cc-shipping.service';
import { SHIPPING_STAGE } from '../collectorcrypt/cc-shipping.errors';
import { PaymentsService } from '../payments/payments.service';
import {
  DOMESTIC_ALLOWED_STATUSES,
  DOMESTIC_ERROR_CODE,
  DOMESTIC_FORBIDDEN_STATUSES,
  HOSHI_LISTING_REF_PREFIX,
  hoshiListingRef,
  isDomesticRedemption,
  isHoshiListingRef,
} from '../common/hoshi-domestic-shipping';
import { isHoshiSellableStock } from '../common/hoshi-stock';
import {
  DOMESTIC_DEFAULT_TIERS,
  DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER,
  DOMESTIC_RATE_SCOPE_NATIONWIDE,
  DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
  DOMESTIC_TIER_JAWA,
  DOMESTIC_TIER_LUAR_JAWA,
  JAWA_PROVINCE_ALIASES,
  assertSaneRate,
  isIndonesianDestination,
  normalizeRegionKey,
  normalizeScope,
  pickTier,
  resolveDomesticShippingIdr,
} from '../payments/domestic-shipping-rate';
import {
  IDRX_MAX_MINT_IDR,
  IDRX_MIN_MINT_IDR,
} from '../payments/idrx-mint-bounds';
import { RedemptionService } from './redemption.service';

// Rantai DI menarik Solana v1 (umi → web3.js) yang bikin jest gagal parse. Kelas-kelasnya cuma
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
 * ║ JALUR KIRIM DOMESTIK (STOK HOSHI) — kontraknya, dan PEMISAHANNYA dari jalur CC.              ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Yang dijaga file ini, dan kenapa masing-masing penting:
 *
 *  1. KEPEMILIKAN: hanya stok Hoshi yang sellable DAN sudah SOLD ke pemanggil yang bisa diminta
 *     kirim. Baris seed/placeholder, listing user lain, dan katalog CC harus DITOLAK — kalau tidak,
 *     jalur ini menjanjikan pengiriman barang yang tidak ada.
 *  2. IDENTITAS: satu kartu fisik = SATU kunci anti-dobel. Termasuk saat kliennya mengirim alamat
 *     NFT warisan alih-alih listingId (normalisasi identitas).
 *  3. PEMISAHAN RAIL DUA ARAH: rute CC menolak baris domestik dan sebaliknya. "Tidak bisa tertukar"
 *     hanya benar kalau KEDUA arah ditolak.
 *  4. STATUS: baris domestik tidak boleh pernah menyentuh kosakata uang treasury jalur CC
 *     (READY_TO_FUND/FUNDING/FUNDED/...). Kalau ia bisa, fundAndPrepare akan diundang memindahkan
 *     USDC untuk kartu yang tidak punya NFT untuk dibakar.
 *  5. refundSafe: TIDAK ADA satu pun titik di jalur ini yang menulisnya. Itulah yang membuat ongkir
 *     Rupiah SELALU aman di-refund — jalur ini tidak punya langkah pasca-belanja sama sekali.
 *  6. TARIF: resolusinya berlapis dan SETIAP lapis divalidasi ke batas mint IDRX.
 *  7. JALAN KELUAR: setiap status pemblokir yang bisa dicapai baris domestik punya jalan keluar
 *     yang BISA DIJALANKAN (bukan sekadar didokumentasikan) — invariant yang sama dengan
 *     redemption-exit-reachability.spec.ts, di sini untuk siklus hidup domestik.
 */

const USER: AuthUser = {
  id: 'user-dom-1',
  walletAddress: 'HoshiUserWalletBase58',
  displayName: null,
  role: 'USER',
};
const ADMIN = {
  id: 'admin-dom-1',
  walletAddress: 'AdminWalletBase58',
  role: 'ADMIN',
};
const LISTING_ID = 'listing-stok-1';
const RED_ID = 'red-dom-1';
const ORDER_ROW_ID = 'order-dom-row';
const MERCHANT_ORDER_ID = 'HOSHI-SHIP-DOM-1';
const TREASURY = 'TreasuryWalletBase58';
const ADDR_ID = 'addr-1';

type Row = Record<string, any>;

interface World {
  listing: Row | null;
  redemption: Row | null;
  order: Row | null;
  address: Row | null;
  user: Row;
  rates: Row[];
  created: Row[];
  activities: Row[];
}

/** Cocokkan baris dengan klausa WHERE Prisma yang dipakai kode produksi. */
function matches(row: Row, where: Record<string, any> | undefined): boolean {
  for (const [key, want] of Object.entries(where ?? {})) {
    if (key === 'OR') {
      if (!(want as any[]).some((clause) => matches(row, clause))) return false;
      continue;
    }
    if (want !== null && typeof want === 'object') {
      if ('in' in want) {
        if (!(want.in as unknown[]).includes(row[key])) return false;
        continue;
      }
      if ('not' in want) {
        const n = (want as any).not;
        if (n === null) {
          if (row[key] === null || row[key] === undefined) return false;
        } else if (row[key] === n) {
          return false;
        }
        continue;
      }
      if ('gt' in want) {
        if (!(row[key] > (want as any).gt)) return false;
        continue;
      }
      // Relasi bersarang (mis. { nft: { assetAddress: x } }) — cukup untuk harness ini.
      if (!matches((row[key] ?? {}) as Row, want as Record<string, any>)) {
        return false;
      }
      continue;
    }
    if (row[key] !== want) return false;
  }
  return true;
}

function fakePrisma(world: World): PrismaService {
  const p: any = {
    listing: {
      findFirst: async ({ where }: any) =>
        world.listing && matches(world.listing, where)
          ? { ...world.listing }
          : null,
      findMany: async ({ where }: any) =>
        world.listing && matches(world.listing, where)
          ? [{ ...world.listing }]
          : [],
      count: async ({ where }: any) =>
        world.listing && matches(world.listing, where) ? 1 : 0,
      updateMany: async ({ where, data }: any) => {
        if (!world.listing || !matches(world.listing, where)) {
          return { count: 0 };
        }
        Object.assign(world.listing, data);
        return { count: 1 };
      },
    },
    ccPackPurchase: { findFirst: async () => null },
    shippingAddress: {
      findFirst: async ({ where }: any) =>
        world.address && matches(world.address, where)
          ? { ...world.address }
          : null,
    },
    cardRedemption: {
      findUnique: async ({ where }: any) =>
        world.redemption && world.redemption.id === where.id
          ? { ...world.redemption }
          : null,
      findFirst: async ({ where }: any) =>
        world.redemption && matches(world.redemption, where)
          ? { ...world.redemption }
          : null,
      findMany: async ({ where }: any) =>
        world.redemption && matches(world.redemption, where)
          ? [{ ...world.redemption }]
          : [],
      updateMany: async ({ where, data }: any) => {
        if (!world.redemption || !matches(world.redemption, where)) {
          return { count: 0 };
        }
        Object.assign(world.redemption, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        if (!world.redemption || world.redemption.id !== where.id) {
          throw new Error('row not found');
        }
        Object.assign(world.redemption, data);
        return { ...world.redemption };
      },
      create: async ({ data }: any) => {
        const row = { id: 'red-new', trackingIds: [], trackingUrls: [], ...data };
        world.created.push(row);
        world.redemption = row;
        return row;
      },
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
        world.order && matches(world.order, where)
          ? [{ ...world.order }]
          : [],
      count: async () => (world.order ? 1 : 0),
      create: async ({ data }: any) => {
        world.order = { id: ORDER_ROW_ID, ...data };
        return { ...world.order };
      },
      updateMany: async ({ where, data }: any) => {
        if (!world.order || !matches(world.order, where)) return { count: 0 };
        Object.assign(world.order, data);
        return { count: 1 };
      },
      update: async ({ where, data }: any) => {
        if (!world.order) throw new Error('order not found');
        if (
          where.merchantOrderId !== undefined &&
          world.order.merchantOrderId !== where.merchantOrderId
        ) {
          throw new Error('order not found');
        }
        Object.assign(world.order, data);
        return { ...world.order };
      },
    },
    domesticShippingRate: {
      findMany: async ({ where }: any) =>
        world.rates.filter((r) => matches(r, where)),
      findUnique: async ({ where }: any) =>
        world.rates.find((r) => r.scope === where.scope) ?? null,
      // Dipakai penegakan "penampung TUNGGAL": menyalakan fallback di satu tier mematikannya di
      // tier lain, dalam transaksi yang sama.
      updateMany: async ({ where, data }: any) => {
        const hits = world.rates.filter((r) => matches(r, where));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      },
      upsert: async ({ where, create, update }: any) => {
        const hit = world.rates.find((r) => r.scope === where.scope);
        if (hit) {
          Object.assign(hit, update);
          return { ...hit };
        }
        const row = { id: 'rate-1', ...create };
        world.rates.push(row);
        return { ...row };
      },
    },
    user: {
      findUnique: async ({ where }: any) =>
        world.user.id === where.id ? { ...world.user } : null,
    },
    activity: {
      create: async ({ data }: any) => {
        world.activities.push(data);
        return {};
      },
    },
    $transaction: async (cb: any) => cb(p),
  };
  return p as PrismaService;
}

const CONFIG = {
  get: (k: string) =>
    k === 'HOSHI_TREASURY_ADDRESS'
      ? TREASURY
      : k === 'HOSHI_PAYMENT_RETURN_URL'
        ? 'https://hoshimarket.xyz'
        : k === 'IDRX_NETWORK_CHAIN_ID'
          ? '8453'
          : undefined,
} as any;

const IDRX_FAKE = {
  mintRequest: async () => ({
    data: {
      merchantOrderId: MERCHANT_ORDER_ID,
      id: 99,
      reference: 'ref-1',
      paymentUrl: 'https://idrx.test/pay/1',
    },
  }),
  findMintByMerchantOrderId: async () => ({
    merchantOrderId: MERCHANT_ORDER_ID,
    paymentStatus: 'PAID',
    userMintStatus: 'MINTED',
    destinationWalletAddress: TREASURY,
    toBeMinted: String(DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER),
    requestType: 'idrx',
    txHash: null,
  }),
} as any;

/**
 * PaymentsService dengan CcShippingService PALSU YANG MELEMPAR.
 *
 * Ini bukan kemalasan harness — ini ASERSI. `assertEnabled` dan `estimateForRedemption` tidak
 * boleh PERNAH tersentuh dari jalur domestik: yang pertama akan membuat pengiriman domestik ikut
 * mati bersama gerbang CC (dan ikut terblokir oleh kredensial CC yang masih ditunggu), yang kedua
 * akan menagih ongkir CollectorCrypt untuk paket kurir lokal. Kalau salah satunya dipanggil,
 * test-nya MERAH dengan pesan yang menyebut kebocorannya.
 *
 * `ccEnabled: true` HANYA untuk test yang sengaja menempuh rute CC (untuk membuktikan rute itu
 * MENOLAK baris domestik): di sana gerbang CC memang harus lolos supaya yang teruji adalah
 * gerbang RAIL-nya, bukan gerbang fiturnya.
 */
const payments = (world: World, opts: { ccEnabled?: boolean } = {}) =>
  new PaymentsService(
    fakePrisma(world),
    IDRX_FAKE,
    {} as any,
    CONFIG,
    {} as any,
    {} as any,
    {} as any,
    {
      assertEnabled: () => {
        if (opts.ccEnabled) return;
        throw new Error(
          'GERBANG CC BOCOR: jalur domestik memanggil ccShipping.assertEnabled()',
        );
      },
      estimateForRedemption: () => {
        throw new Error(
          'ONGKIR CC BOCOR: estimateForRedemption() dipanggil untuk paket kurir domestik',
        );
      },
    } as any,
  );

const redemptions = (world: World) =>
  new RedemptionService(
    fakePrisma(world),
    {} as unknown as CcShippingService,
    payments(world) as unknown as PaymentsService,
  );

const admin = (world: World) =>
  new AdminService(
    fakePrisma(world),
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

/** Listing stok Hoshi yang SUDAH dibeli user — bentuk yang sah untuk jalur domestik. */
function hoshiStockListing(over: Row = {}): Row {
  return {
    id: LISTING_ID,
    name: 'Charizard Base Set',
    set: 'Base',
    category: 'Special Illustration',
    image: 'https://img/charizard.png',
    priceIdrx: 1_500_000,
    status: ListingStatus.SOLD,
    source: 'HOSHI',
    sellable: true,
    sellerId: null,
    buyerId: USER.id,
    ccNftAddress: null,
    nft: null,
    escrowedAt: null,
    ...over,
  };
}

function baseWorld(over: Partial<World> = {}): World {
  return {
    listing: hoshiStockListing(),
    redemption: null,
    order: null,
    address: {
      id: ADDR_ID,
      userId: USER.id,
      fullName: 'Budi',
      country: 'ID',
      street: 'Jl. Merdeka 1',
      apt: null,
      city: 'Jakarta',
      state: 'DKI Jakarta',
      zip: '12345',
      phoneCountryCode: '+62',
      phoneNumber: '81200000000',
      isDefault: true,
    },
    user: {
      id: USER.id,
      walletAddress: USER.walletAddress,
      displayName: null,
      role: 'USER',
    },
    rates: [],
    created: [],
    activities: [],
    ...over,
  };
}

/** Baris redemption DOMESTIK di status tertentu. */
function domesticRow(status: RedemptionStatus, over: Row = {}): Row {
  return {
    id: RED_ID,
    userId: USER.id,
    nftAddress: hoshiListingRef(LISTING_ID),
    listingId: LISTING_ID,
    cardName: 'Charizard Base Set',
    cardImage: null,
    cardSet: 'Base',
    source: 'HOSHI',
    recipientName: 'Budi',
    country: 'ID',
    street: 'Jl. Merdeka 1',
    apt: null,
    city: 'Jakarta',
    state: 'DKI Jakarta',
    zip: '12345',
    status,
    note: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    processedAt: null,
    fundingSignature: null,
    refundSafe: true,
    paymentOrderId: null,
    outboundShipmentId: null,
    trackingIds: [],
    trackingUrls: [],
    ...over,
  };
}

/** Baris order ongkir domestik. */
function shippingOrder(status: PaymentStatus, over: Row = {}): Row {
  return {
    id: ORDER_ROW_ID,
    merchantOrderId: MERCHANT_ORDER_ID,
    userId: USER.id,
    packType: 'SHIPPING',
    redemptionId: RED_ID,
    listingId: null,
    offerId: null,
    priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
    priceUsdc: 0,
    status,
    refundSafe: true,
    paidAt: null,
    error: null,
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    ...over,
  };
}

/* ═════════════════════════════ 1. IDENTITAS ═════════════════════════════ */

describe('identitas kartu stok Hoshi', () => {
  it('turunannya deterministik dan dikenali kembali', () => {
    expect(hoshiListingRef(LISTING_ID)).toBe(
      `${HOSHI_LISTING_REF_PREFIX}${LISTING_ID}`,
    );
    expect(isHoshiListingRef(hoshiListingRef(LISTING_ID))).toBe(true);
  });

  /**
   * INI yang membuat sentinel aman dipakai di kolom yang sama dengan alamat NFT sungguhan:
   * alfabet base58 Solana tidak memuat '-' maupun ':'. Kalau suatu hari prefixnya diubah menjadi
   * sesuatu yang base58-legal, test ini MERAH sebelum dua identitas bisa saling menyamar.
   */
  it('TIDAK MUNGKIN bentrok dengan alamat NFT base58 Solana', () => {
    const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
    expect(BASE58.test(HOSHI_LISTING_REF_PREFIX)).toBe(false);
    expect(isHoshiListingRef('6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy')).toBe(
      false,
    );
  });

  it('rail dibaca dari listingId, BUKAN dari source', () => {
    expect(isDomesticRedemption({ listingId: LISTING_ID })).toBe(true);
    expect(isDomesticRedemption({ listingId: null })).toBe(false);
  });
});

/* ══════════════════════ 2. PREDIKAT STOK YANG DIPAKAI BERSAMA ══════════════════════ */

describe('isHoshiSellableStock — satu definisi untuk jalur BELI dan jalur KIRIM', () => {
  it('menerima stok Hoshi yang ditandai sellable', () => {
    expect(
      isHoshiSellableStock({ source: 'HOSHI', sellerId: null, sellable: true }),
    ).toBe(true);
  });

  /** Ketiga syarat, satu per satu. Masing-masing menutup satu kelas kesalahan. */
  it.each([
    [
      'baris seed/placeholder (sellable=false — bentuk DEFAULT setiap listing)',
      { source: 'HOSHI', sellerId: null, sellable: false },
    ],
    [
      'listing milik user lain (P2P)',
      { source: 'HOSHI', sellerId: 'user-lain', sellable: true },
    ],
    [
      'katalog CollectorCrypt (fisiknya di gudang CC → jalur CC, bukan kurir domestik)',
      { source: 'COLLECTORCRYPT', sellerId: null, sellable: true },
    ],
  ])('menolak %s', (_label, shape) => {
    expect(isHoshiSellableStock(shape as any)).toBe(false);
  });
});

/* ══════════════════════════ 3. STATUS: KOSAKATA TERPISAH ══════════════════════════ */

describe('status jalur domestik', () => {
  /**
   * Daftar terlarang dihitung sebagai KOMPLEMEN, jadi status enum BARU otomatis terlarang sampai
   * seseorang sadar-sadar memasukkannya. Test ini membuktikan partisinya total dan disjoint.
   */
  it('membagi seluruh enum RedemptionStatus jadi DUA himpunan disjoint', () => {
    const all = Object.values(RedemptionStatus).sort();
    expect(
      [...DOMESTIC_ALLOWED_STATUSES, ...DOMESTIC_FORBIDDEN_STATUSES].sort(),
    ).toEqual(all);
    for (const s of DOMESTIC_ALLOWED_STATUSES) {
      expect(DOMESTIC_FORBIDDEN_STATUSES).not.toContain(s);
    }
  });

  /**
   * SETIAP status yang membawa kosakata UANG TREASURY jalur CC harus terlarang di jalur domestik.
   * READY_TO_FUND yang paling penting: ia berarti "siap danai USDC", dan menuliskannya ke baris
   * domestik akan mengundang fundAndPrepare memindahkan USDC untuk kartu tanpa NFT.
   */
  it('melarang SETIAP status uang-treasury jalur CC', () => {
    for (const s of [
      RedemptionStatus.READY_TO_FUND,
      RedemptionStatus.FUNDING,
      RedemptionStatus.FUNDED,
      RedemptionStatus.BURN_SUBMITTED,
      RedemptionStatus.IN_TRANSIT,
      RedemptionStatus.RECLAIM_DUE,
      RedemptionStatus.SHIP_FAILED_POST_BURN,
      RedemptionStatus.REFUND_DUE,
    ]) {
      expect(DOMESTIC_FORBIDDEN_STATUSES).toContain(s);
    }
  });
});

/* ══════════════════════════ 4. KEPEMILIKAN & PEMBUATAN ══════════════════════════ */

describe('POST /redemptions — jalur DOMESTIK (listingId)', () => {
  it('menerima stok Hoshi yang SOLD ke pemanggil, dan identitasnya diputuskan SERVER', async () => {
    const world = baseWorld();
    const dto = await redemptions(world).request(
      { listingId: LISTING_ID, shippingAddressId: ADDR_ID },
      USER,
    );
    expect(dto.listingId).toBe(LISTING_ID);
    expect(dto.nftAddress).toBe(hoshiListingRef(LISTING_ID));
    expect(world.created).toHaveLength(1);
    expect(world.created[0]).toMatchObject({
      listingId: LISTING_ID,
      nftAddress: hoshiListingRef(LISTING_ID),
      source: 'HOSHI',
      status: RedemptionStatus.REQUESTED,
    });
    // NOL uang di titik ini, dan refundSafe TIDAK ikut ditulis (default true dari DB).
    expect(world.created[0].refundSafe).toBeUndefined();
  });

  it.each([
    ['baris seed/placeholder', { sellable: false }],
    ['listing milik user lain', { sellerId: 'user-lain' }],
    ['katalog CollectorCrypt', { source: 'COLLECTORCRYPT' }],
    ['bukan pembelian pemanggil', { buyerId: 'user-lain' }],
    ['belum terjual', { status: ListingStatus.ACTIVE }],
  ])('MENOLAK %s', async (_label, over) => {
    const world = baseWorld({ listing: hoshiStockListing(over) });
    await expect(
      redemptions(world).request(
        { listingId: LISTING_ID, shippingAddressId: ADDR_ID },
        USER,
      ),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.NOT_YOUR_STOCK },
    });
    expect(world.created).toHaveLength(0);
  });

  it('menolak body yang tidak menyebut target, dan body yang menyebut KEDUANYA', async () => {
    const world = baseWorld();
    for (const body of [
      { shippingAddressId: ADDR_ID },
      { nftAddress: 'NftAddr', listingId: LISTING_ID, shippingAddressId: ADDR_ID },
    ]) {
      await expect(
        redemptions(world).request(body as any, USER),
      ).rejects.toMatchObject({
        response: { code: DOMESTIC_ERROR_CODE.TARGET_REQUIRED },
      });
    }
    expect(world.created).toHaveLength(0);
  });

  /**
   * NORMALISASI IDENTITAS. Sebuah baris stok Hoshi bisa (dari jalur demo/warisan) punya alamat
   * NFT. Kalau permintaan lewat alamat itu dibiarkan jadi baris jalur CC, kartu FISIK yang sama
   * punya DUA kunci anti-dobel — dua permintaan aktif, dua paket, satu kartu.
   */
  it('menormalkan permintaan lewat alamat NFT WARISAN menjadi identitas domestik', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        nft: { assetAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy' },
      }),
    });
    const dto = await redemptions(world).request(
      {
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
        shippingAddressId: ADDR_ID,
      },
      USER,
    );
    expect(dto.listingId).toBe(LISTING_ID);
    expect(dto.nftAddress).toBe(hoshiListingRef(LISTING_ID));
  });

  /** Anti-dobel: satu kartu fisik, satu permintaan aktif — dicek GLOBAL (bukan per-user). */
  it('menolak permintaan kedua selagi ada baris domestik yang masih aktif', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.PACKING, { userId: 'user-lain' }),
    });
    await expect(
      redemptions(world).request(
        { listingId: LISTING_ID, shippingAddressId: ADDR_ID },
        USER,
      ),
    ).rejects.toMatchObject({
      response: { code: 'REDEMPTION_ALREADY_ACTIVE' },
    });
    expect(world.created).toHaveLength(0);
  });
});

/* ══════════════════════════ 5. PEMISAHAN RAIL (DUA ARAH) ══════════════════════════ */

describe('dua rail tidak bisa tertukar', () => {
  it('rute ongkir CC MENOLAK baris domestik (dan tidak menyentuh gerbang/estimate CC)', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
    });
    // ccEnabled: gerbang FITUR-nya dilewatkan dengan sengaja, supaya yang benar-benar diuji
    // adalah gerbang RAIL (assertCcRail di ownedRedemption / di depan createShippingOrder).
    // estimateForRedemption tetap fake-yang-melempar: kalau ia tersentuh, artinya penolakannya
    // terjadi TERLALU LAMBAT — sesudah kita menanyakan ongkir CC untuk paket kurir lokal.
    await expect(
      payments(world, { ccEnabled: true }).createShippingOrder(
        RED_ID,
        USER,
        'cca_token',
      ),
    ).rejects.toMatchObject({ response: { code: 'REDEMPTION_CARD_NOT_YOURS' } });
    expect(world.order).toBeNull();
  });

  it('rute ongkir DOMESTIK menolak baris jalur CC', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, {
        listingId: null,
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
      }),
    });
    await expect(
      payments(world).createDomesticShippingOrder(RED_ID, USER),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.WRONG_RAIL },
    });
    expect(world.order).toBeNull();
  });

  it('taksiran domestik juga menolak baris jalur CC', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, { listingId: null }),
    });
    await expect(
      payments(world).quoteDomesticShipping(RED_ID, USER),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.WRONG_RAIL },
    });
  });

  /**
   * KONTRAK ERROR TIDAK BOLEH BOCOR. `FUNDED` / `POST_FUND` / `UNKNOWN` adalah kosakata uang
   * treasury jalur CC; membiarkannya terbit dari jalur domestik akan membuat UI dan operator
   * mengambil keputusan refund berdasarkan bahaya yang tidak ada — atau, lebih buruk, MENAHAN
   * refund ongkir yang sebenarnya wajib dibalikkan.
   */
  it('error domestik TIDAK PERNAH membawa stage uang jalur CC', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, { listingId: null }),
    });
    const err = await payments(world)
      .createDomesticShippingOrder(RED_ID, USER)
      .catch((e) => e);
    const body = (err as any).response;
    expect([SHIPPING_STAGE.NO_EFFECT, SHIPPING_STAGE.PRE_FUND]).toContain(
      body.stage,
    );
    expect(body.code.startsWith('HOSHI_DOMESTIC_')).toBe(true);
  });
});

/* ══════════════════════════ 6. TAGIHAN ONGKIR ══════════════════════════ */

describe('POST /payments/shipping/domestic', () => {
  it('menerbitkan invoice Rupiah TANPA menyentuh CC, dan priceUsdc-nya 0', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
    });
    const dto = await payments(world).createDomesticShippingOrder(RED_ID, USER);
    expect(dto.merchantOrderId).toBe(MERCHANT_ORDER_ID);
    expect(world.order).toMatchObject({
      packType: 'SHIPPING',
      redemptionId: RED_ID,
      priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      // NOL, dan itu JUJUR: jalur ini tidak pernah mendanai USDC.
      priceUsdc: 0,
      status: PaymentStatus.PENDING,
    });
    // Baris redemption diklaim ke AWAITING_PAYMENT, dan refundSafe TIDAK disentuh.
    expect(world.redemption!.status).toBe(RedemptionStatus.AWAITING_PAYMENT);
    expect(world.redemption!.refundSafe).toBe(true);
    expect(world.redemption!.fundingSignature).toBeNull();
  });

  it('idempoten: invoice PENDING yang masih hidup dikembalikan apa adanya', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.AWAITING_PAYMENT, {
        paymentOrderId: ORDER_ROW_ID,
      }),
      order: shippingOrder(PaymentStatus.PENDING),
    });
    const dto = await payments(world).createDomesticShippingOrder(RED_ID, USER);
    expect(dto.merchantOrderId).toBe(MERCHANT_ORDER_ID);
    expect(world.redemption!.status).toBe(RedemptionStatus.AWAITING_PAYMENT);
  });

  it('menolak status yang bukan REQUESTED/AWAITING_PAYMENT', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.SHIPPED),
    });
    await expect(
      payments(world).createDomesticShippingOrder(RED_ID, USER),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.NOT_BILLABLE },
    });
  });
});

/* ══════════════════════════ 7. PELUNASAN → PACKING ══════════════════════════ */

describe('ongkir domestik LUNAS → PACKING (bukan READY_TO_FUND)', () => {
  it('memindahkan baris domestik ke PACKING dan menandai order FULFILLED', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.AWAITING_PAYMENT, {
        paymentOrderId: ORDER_ROW_ID,
      }),
      order: shippingOrder(PaymentStatus.PENDING),
    });
    const outcome = await payments(world).verifyAndFulfil(MERCHANT_ORDER_ID);
    expect(outcome).toBe('FULFILLED');
    expect(world.redemption!.status).toBe(RedemptionStatus.PACKING);
    expect(world.order!.status).toBe(PaymentStatus.FULFILLED);
    // TIDAK PERNAH READY_TO_FUND: itu akan mengundang pendanaan USDC untuk kartu tanpa NFT.
    expect(world.redemption!.status).not.toBe(RedemptionStatus.READY_TO_FUND);
    // Pelunasan ongkir BUKAN langkah pasca-belanja → refundSafe tetap apa adanya.
    expect(world.redemption!.refundSafe).toBe(true);
    expect(world.order!.refundSafe).toBe(true);
  });

  it('baris jalur CC tetap ke READY_TO_FUND (perilaku lama tak berubah)', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.AWAITING_PAYMENT, {
        listingId: null,
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
        paymentOrderId: ORDER_ROW_ID,
      }),
      order: shippingOrder(PaymentStatus.PENDING),
    });
    await payments(world).verifyAndFulfil(MERCHANT_ORDER_ID);
    expect(world.redemption!.status).toBe(RedemptionStatus.READY_TO_FUND);
  });
});

/* ══════════════════════════ 8. PEMENUHAN ADMIN ══════════════════════════ */

describe('antrean admin — pemenuhan domestik', () => {
  it('PACKING → SHIPPED menerima resi kurir', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.PACKING),
    });
    await admin(world).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.SHIPPED,
      { trackingIds: ['JP1234567890'], trackingUrls: ['https://jne/JP123'] },
    );
    expect(world.redemption!.status).toBe(RedemptionStatus.SHIPPED);
    expect(world.redemption!.trackingIds).toEqual(['JP1234567890']);
  });

  /**
   * Pada baris jalur CC, trackingIds MILIK poll shipment CC. Menulisnya tangan akan menimpa resi
   * asli dengan angka yang kita karang, tanpa jejak apa pun bahwa itu terjadi.
   */
  it('MENOLAK resi manual pada baris jalur CC', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.SHIPPED, { listingId: null }),
    });
    await expect(
      admin(world).updateRedemptionStatus(RED_ID, RedemptionStatus.DELIVERED, {
        trackingIds: ['PALSU-1'],
      }),
    ).rejects.toThrow(/DOMESTIK/);
    expect(world.redemption!.status).toBe(RedemptionStatus.SHIPPED);
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B1 — TEST INI DULU HIJAU DI ATAS PERILAKU YANG RUSAK. Itu kegagalannya sendiri.        ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   * Judulnya berbunyi "MENCATAT utang refundnya" tapi asersinya cuma `shippingDebts.length===1`
   * dan `refundSafe: true` — dua hal yang BENAR walaupun helper-nya tidak menulis APA PUN
   * (order yang tak tersentuh tetap DILAPORKAN, dan refundSafe-nya memang true). Jadi ia lolos
   * sementara Rupiah ongkir user menghilang dari setiap daftar kerja refund.
   *
   * Sekarang yang dipaku adalah TULISANNYA: `statusAfter`, `recordedNow`, dan BARIS DB-nya.
   */
  it('membatalkan baris DOMESTIK yang ongkirnya lunas MENCATAT utang refundnya', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.PACKING),
      order: shippingOrder(PaymentStatus.FULFILLED),
    });
    const res = await admin(world).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.CANCELED,
    );
    expect(world.redemption!.status).toBe(RedemptionStatus.CANCELED);
    expect(res.shippingDebts).toHaveLength(1);
    expect(res.shippingDebts[0]).toMatchObject({
      merchantOrderId: MERCHANT_ORDER_ID,
      rail: 'HOSHI_DOMESTIC',
      statusBefore: PaymentStatus.FULFILLED,
      // INI yang dulu tidak pernah terjadi: tulisannya.
      statusAfter: PaymentStatus.REFUND_DUE,
      recordedNow: true,
      refundSafe: true,
    });
    // BARIS DB-nya, bukan cuma laporannya — utang yang cuma ada di respons bukan utang.
    expect(world.order!.status).toBe(PaymentStatus.REFUND_DUE);
    expect(world.order!.error).toContain('UTANG ONGKIR KIRIM DOMESTIK');
    // refundSafe DIBACA, TIDAK ditulis (tidak ada `refundSafe` di `data` mana pun).
    expect(world.order!.refundSafe).toBe(true);
    // Kalimat operatornya TIDAK BOLEH lagi menyuruh memperlakukan ini sebagai anomali.
    expect(res.shippingDebts[0].operatorAction).toContain('KEMBALIKAN');
    expect(res.shippingDebts[0].operatorAction).not.toContain('mustahil');
    expect(world.order!.error).not.toContain('mustahil');
    // Dan ia muncul di daftar kerja baris ini, bukan cuma di satu baris log.
    expect(res.ongkir.refundDue).toBe(true);
    expect(res.actionRequired.join(' ')).toContain('REFUND_DUE');
  });

  /**
   * B1 — refundSafe=false TIDAK BOLEH dinaikkan oleh pembukuan ini. Satu-satunya sebabnya di rail
   * domestik adalah pin IDRX yang TERBUKTI menyimpang (Rupiah-nya tidak terbukti kami terima),
   * dan menulis `true` di sini akan menyuruh operator mengirim uang yang belum tentu pernah masuk.
   */
  it('utang tetap dicatat TAPI refundSafe=false tidak pernah dinaikkan', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.PACKING),
      order: shippingOrder(PaymentStatus.FULFILLED, { refundSafe: false }),
    });
    const res = await admin(world).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.CANCELED,
    );
    expect(world.order!.status).toBe(PaymentStatus.REFUND_DUE);
    expect(world.order!.refundSafe).toBe(false);
    expect(res.shippingDebts[0]).toMatchObject({
      recordedNow: true,
      refundSafe: false,
    });
    expect(res.shippingDebts[0].operatorAction).toContain('JANGAN refund');
    // Rail domestik nol USDC → kalimatnya tidak boleh menyuruh mengecek on-chain.
    expect(res.shippingDebts[0].operatorAction).toContain('IDRX');
  });

  /**
   * B1 — PEMISAHAN RAIL DI PEMBUKUAN. Di rail CC, order FULFILLED + redemption yang dibatalkan
   * MEMANG kombinasi yang tidak bisa dihasilkan jalur normal (fulfilShipping rail CC memindahkan
   * barisnya ke READY_TO_FUND). Jadi di sana ia TIDAK BOLEH diubah diam-diam jadi REFUND_DUE, dan
   * kalimat "seharusnya mustahil" harus tetap utuh.
   */
  it('rail CC: order FULFILLED TIDAK diubah, kalimat "mustahil" tetap utuh', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.AWAITING_PAYMENT, {
        listingId: null,
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
      }),
      order: shippingOrder(PaymentStatus.FULFILLED),
    });
    const res = await admin(world).cancelAwaitingPayment(
      RED_ID,
      'operator menutup baris ini karena usernya sudah tidak bisa dihubungi',
      ADMIN,
    );
    expect(world.order!.status).toBe(PaymentStatus.FULFILLED);
    expect(res.shippingDebts[0]).toMatchObject({
      rail: 'CC_VAULT',
      statusBefore: PaymentStatus.FULFILLED,
      statusAfter: PaymentStatus.FULFILLED,
      recordedNow: false,
    });
    expect(res.shippingDebts[0].operatorAction).toContain('mustahil');
  });

  it('bentuk responsnya stabil: shippingDebts selalu ada (array kosong kalau tak ada)', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.PACKING),
    });
    const res = await admin(world).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.SHIPPED,
    );
    expect(res.shippingDebts).toEqual([]);
  });
});

/* ══════ 8b. B2 — PEMENUHAN DOMESTIK TANPA ONGKIR LUNAS: DITOLAK, BUKAN DI-WARN ══════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SEBUAH PERINGATAN YANG TIDAK SAMPAI KE SIAPA PUN BUKAN PENGAMAN.                             ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 * Baris DOMESTIK di REQUESTED yang ongkirnya belum ditagih dulu bisa dimajukan ke PACKING/SHIPPED
 * dengan satu klik; satu-satunya jejaknya `logger.warn` yang tidak dibaca dashboard, tidak muncul
 * di respons, dan tidak tersimpan di baris. Tiap kejadian = satu paket yang ongkirnya ditanggung
 * Hoshi tanpa seorang pun memutuskannya.
 *
 * Sekarang: DITOLAK secara default, LOLOS hanya lewat pernyataan eksplisit yang DISIMPAN di baris.
 */
describe('B2 — REQUESTED → PACKING/SHIPPED menolak baris domestik yang ongkirnya belum lunas', () => {
  it.each([RedemptionStatus.PACKING, RedemptionStatus.SHIPPED])(
    'MENOLAK %s tanpa pernyataan menanggung ongkir',
    async (target) => {
      const world = baseWorld({
        redemption: domesticRow(RedemptionStatus.REQUESTED),
      });
      await expect(
        admin(world).updateRedemptionStatus(RED_ID, target),
      ).rejects.toThrow(/absorbShippingFee/);
      // Barisnya TIDAK bergerak — penolakan yang membiarkan tulisannya lewat bukan penolakan.
      expect(world.redemption!.status).toBe(RedemptionStatus.REQUESTED);
    },
  );

  it('MENOLAK juga kalau flag-nya ada tapi alasannya terlalu pendek', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
    });
    await expect(
      admin(world).updateRedemptionStatus(
        RED_ID,
        RedemptionStatus.PACKING,
        undefined,
        { absorbShippingFee: true, note: 'ok' },
      ),
    ).rejects.toThrow(/alasan/i);
    expect(world.redemption!.status).toBe(RedemptionStatus.REQUESTED);
  });

  it('LOLOS dengan pernyataan lengkap — dan pernyataannya DISIMPAN di baris, bukan cuma di log', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
    });
    await admin(world).updateRedemptionStatus(
      RED_ID,
      RedemptionStatus.PACKING,
      undefined,
      { absorbShippingFee: true, note: 'promo grand opening, disetujui pemilik produk' },
    );
    expect(world.redemption!.status).toBe(RedemptionStatus.PACKING);
    expect(world.redemption!.note).toContain('ONGKIR DITANGGUNG HOSHI');
    expect(world.redemption!.note).toContain('promo grand opening');
    // Pagar uang lain TIDAK ikut longgar.
    expect(world.redemption!.refundSafe).toBe(true);
    expect(world.redemption!.fundingSignature).toBeNull();
  });

  it('TIDAK menghalangi baris yang ongkirnya memang sudah LUNAS', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
      order: shippingOrder(PaymentStatus.FULFILLED),
    });
    await admin(world).updateRedemptionStatus(RED_ID, RedemptionStatus.PACKING);
    expect(world.redemption!.status).toBe(RedemptionStatus.PACKING);
    // Tidak ada pernyataan menanggung ongkir yang ditulis — tidak ada yang ditanggung.
    expect(world.redemption!.note ?? '').not.toContain('DITANGGUNG');
  });

  it('pagar ini HANYA untuk rail domestik — baris CC tidak tersentuh', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, {
        listingId: null,
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
      }),
    });
    await admin(world).updateRedemptionStatus(RED_ID, RedemptionStatus.PACKING);
    expect(world.redemption!.status).toBe(RedemptionStatus.PACKING);
  });
});

/* ══════ 8c. B2 — DASHBOARD BISA MEMBEDAKAN RAIL DAN MELIHAT KEADAAN ONGKIR ══════ */

describe('B2 — GET /admin/redemptions menyajikan rail + keadaan ongkir + tombol yang sah', () => {
  it('baris DOMESTIK tanpa ongkir: tombol Kemas/Kirim DIBLOKIR dan alasannya ikut', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
    });
    const [row] = await admin(world).listRedemptions();
    expect(row.rail).toBe('HOSHI_DOMESTIC');
    expect(row.ongkir).toMatchObject({
      required: true,
      paid: false,
      inFlight: false,
      refundDue: false,
      paidIdr: 0,
    });
    expect(row.blockedNextStatuses).toEqual(
      expect.arrayContaining([
        RedemptionStatus.PACKING,
        RedemptionStatus.SHIPPED,
      ]),
    );
    // Membatalkan tidak pernah ikut diblokir: keterjangkauan jalan keluar tidak boleh berkurang.
    expect(row.allowedNextStatuses).toContain(RedemptionStatus.CANCELED);
    expect(row.actionRequired.join(' ')).toContain('ONGKIR BELUM LUNAS');
  });

  it('baris DOMESTIK yang ongkirnya LUNAS: tombolnya terbuka, nominalnya kelihatan', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
      order: shippingOrder(PaymentStatus.FULFILLED),
    });
    const [row] = await admin(world).listRedemptions();
    expect(row.ongkir.paid).toBe(true);
    expect(row.ongkir.paidIdr).toBe(DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER);
    expect(row.ongkir.orders).toHaveLength(1);
    expect(row.blockedNextStatuses).toEqual([]);
    expect(row.allowedNextStatuses).toContain(RedemptionStatus.PACKING);
    expect(row.actionRequired).toEqual([]);
  });

  it('pembayaran yang MASIH DIPROSES menyuruh menunggu, bukan menanggung ongkir', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED),
      order: shippingOrder(PaymentStatus.PAID),
    });
    const [row] = await admin(world).listRedemptions();
    expect(row.ongkir).toMatchObject({ paid: false, inFlight: true });
    expect(row.actionRequired.join(' ')).toContain('TUNGGU');
  });

  it('baris rail CC tidak pernah mengaku butuh ongkir domestik', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, {
        listingId: null,
        nftAddress: '6dKq1s9TvQZ8H2oXk3WcNbY5ePfR7uAJmL4tGhVnDzXy',
      }),
    });
    const [row] = await admin(world).listRedemptions();
    expect(row.rail).toBe('CC_VAULT');
    expect(row.ongkir.required).toBe(false);
    expect(row.blockedNextStatuses).toEqual([]);
  });

  /**
   * Tombol yang disajikan HARUS yang benar-benar diterima penulisnya. Kalau dua daftar itu
   * menyimpang, dashboard kembali menebak — dan menebak itulah B2.
   */
  it('allowedNextStatuses BENAR-BENAR diterima PATCH (bukan daftar hiasan)', async () => {
    for (const status of [
      RedemptionStatus.REQUESTED,
      RedemptionStatus.PACKING,
      RedemptionStatus.SHIPPED,
    ]) {
      const listed = await admin(
        baseWorld({
          redemption: domesticRow(status),
          order: shippingOrder(PaymentStatus.FULFILLED),
        }),
      ).listRedemptions();
      for (const next of listed[0].allowedNextStatuses) {
        const w = baseWorld({
          redemption: domesticRow(status),
          order: shippingOrder(PaymentStatus.FULFILLED),
        });
        await admin(w).updateRedemptionStatus(RED_ID, next);
        expect(w.redemption!.status).toBe(next);
      }
    }
  });
});

/* ══════════════ 9. JALAN KELUAR: setiap status pemblokir bisa digerakkan ══════════════ */

/**
 * Invariant yang sama dengan redemption-exit-reachability.spec.ts, untuk siklus hidup DOMESTIK.
 * Jalur ini SENGAJA tidak menambah status enum baru — tapi "tidak menambah status" saja tidak
 * membuktikan bahwa baris domestik BISA digerakkan keluar dari setiap status pemblokirnya, karena
 * gerbang rail bisa saja menolak rute yang di jalur CC berfungsi. Jadi diuji terpisah, dan
 * "bergerak" DIDEFINISIKAN KERAS: status di DB palsu harus BERBEDA sesudah driver dijalankan.
 */
describe('setiap status pemblokir DOMESTIK punya jalan keluar yang BISA DIJALANKAN', () => {
  const DRIVERS: Array<{
    status: RedemptionStatus;
    label: string;
    run: (w: World) => Promise<unknown>;
  }> = [
    {
      status: RedemptionStatus.REQUESTED,
      label: 'user POST /redemptions/:id/cancel',
      run: (w) => redemptions(w).cancel(RED_ID, USER, 'salah alamat'),
    },
    {
      status: RedemptionStatus.REQUESTED,
      label: 'admin PATCH status -> CANCELED',
      run: (w) =>
        admin(w).updateRedemptionStatus(RED_ID, RedemptionStatus.CANCELED),
    },
    {
      /**
       * B2 — REQUESTED → PACKING kini DITOLAK selama ongkirnya belum lunas (dulu cuma
       * `logger.warn`). Jalan keluarnya TIDAK hilang: ia tetap MILIK KITA, cuma sekarang harus
       * dinyatakan — Hoshi menanggung ongkirnya, dengan alasan yang disimpan di baris. Driver ini
       * membuktikan pintunya benar-benar terbuka, bukan sekadar terdokumentasi.
       */
      status: RedemptionStatus.REQUESTED,
      label: 'admin PATCH status -> PACKING (ongkir ditanggung Hoshi)',
      run: (w) =>
        admin(w).updateRedemptionStatus(
          RED_ID,
          RedemptionStatus.PACKING,
          undefined,
          {
            absorbShippingFee: true,
            note: 'kompensasi keterlambatan, disetujui pemilik produk',
          },
        ),
    },
    {
      status: RedemptionStatus.AWAITING_PAYMENT,
      label: 'user POST /redemptions/:id/cancel',
      run: (w) => redemptions(w).cancel(RED_ID, USER, 'batal'),
    },
    {
      status: RedemptionStatus.AWAITING_PAYMENT,
      label: 'admin POST :id/cancel-awaiting-payment',
      run: (w) =>
        admin(w).cancelAwaitingPayment(
          RED_ID,
          'operator menutup baris ini karena usernya sudah tidak bisa dihubungi',
          ADMIN,
        ),
    },
    {
      status: RedemptionStatus.PACKING,
      label: 'admin PATCH status -> SHIPPED',
      run: (w) =>
        admin(w).updateRedemptionStatus(RED_ID, RedemptionStatus.SHIPPED),
    },
    {
      status: RedemptionStatus.PACKING,
      label: 'admin PATCH status -> CANCELED',
      run: (w) =>
        admin(w).updateRedemptionStatus(RED_ID, RedemptionStatus.CANCELED),
    },
    {
      status: RedemptionStatus.SHIPPED,
      label: 'admin PATCH status -> DELIVERED',
      run: (w) =>
        admin(w).updateRedemptionStatus(RED_ID, RedemptionStatus.DELIVERED),
    },
  ];

  /** Status pemblokir yang benar-benar bisa dicapai baris DOMESTIK. */
  const BLOCKING: RedemptionStatus[] = [
    RedemptionStatus.REQUESTED,
    RedemptionStatus.AWAITING_PAYMENT,
    RedemptionStatus.PACKING,
    RedemptionStatus.SHIPPED,
  ];

  it('tabel driver menutupi SETIAP status pemblokir domestik', () => {
    for (const status of BLOCKING) {
      expect(DRIVERS.filter((d) => d.status === status).length).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(DRIVERS.map((d) => [d.status, d.label, d] as const))(
    '%s: %s benar-benar MEMINDAHKAN barisnya',
    async (status, _label, driver) => {
      const world = baseWorld({ redemption: domesticRow(status) });
      try {
        await driver.run(world);
      } catch {
        /* menolak boleh; yang dinilai cuma apakah barisnya BERGERAK */
      }
      expect(world.redemption!.status).not.toBe(status);
    },
  );

  /**
   * POSISI refundSafe DI SELURUH JALUR: tidak ada satu pun driver di atas yang menulisnya.
   * Itulah pernyataan intinya — jalur domestik tidak punya langkah pasca-belanja, jadi ongkir
   * Rupiah-nya SELALU aman di-refund dan tidak ada yang boleh mengklaim sebaliknya.
   */
  it.each(DRIVERS.map((d) => [d.status, d.label, d] as const))(
    '%s: %s TIDAK menulis refundSafe',
    async (status, _label, driver) => {
      const world = baseWorld({ redemption: domesticRow(status) });
      try {
        await driver.run(world);
      } catch {
        /* diabaikan */
      }
      expect(world.redemption!.refundSafe).toBe(true);
      expect(world.redemption!.fundingSignature).toBeNull();
    },
  );
});

/* ══════════════════════════ 10. TARIF ONGKIR ══════════════════════════ */

describe('resolusi tarif ongkir domestik', () => {
  const logger = new Logger('test');
  const dest = { city: 'Jakarta', state: 'DKI Jakarta', country: 'ID' };

  it('memakai baris DB aktif lebih dulu', async () => {
    const world = baseWorld({
      rates: [
        { scope: DOMESTIC_RATE_SCOPE_NATIONWIDE, priceIdr: 37_000, active: true },
      ],
    });
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest,
        env: () => '99000',
      }),
    ).resolves.toMatchObject({
      priceIdr: 37_000,
      scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
      source: 'DB',
      // Baris '*' warisan tetap berlaku sebagai FLAT NASIONAL persis seperti sebelum tier ada —
      // tapi ia dilaporkan sebagai wilayah yang TIDAK terselesaikan, karena memang begitu: tidak
      // ada tier yang cocok, cuma jaring nasional.
      region: 'NATIONWIDE',
      regionUnresolved: true,
    });
  });

  it('baris NON-AKTIF dilewati → jatuh ke env', async () => {
    const world = baseWorld({
      rates: [
        {
          scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
          priceIdr: 37_000,
          active: false,
        },
      ],
    });
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest,
        env: () => '45000',
      }),
    ).resolves.toMatchObject({ priceIdr: 45_000, source: 'ENV' });
  });

  it('tanpa baris dan tanpa env → TIER PENAMPUNG di kode (bukan flat nasional)', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld()),
        logger,
        dest,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({
      priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      scope: DOMESTIC_TIER_JAWA,
      source: 'DEFAULT_TIER',
      region: 'TIER',
      province: 'dki jakarta',
      regionUnresolved: false,
    });
  });

  /**
   * Tarif di BAWAH minimum mint IDRX menghasilkan baris yang kelihatan benar di dashboard tapi
   * invoice-nya TIDAK PERNAH BISA TERBIT — kegagalan yang baru terlihat saat user pertama menekan
   * "Bayar ongkir". Ditolak di titik tulis DAN di titik baca.
   */
  it.each([0, -1, 19_999, IDRX_MAX_MINT_IDR + 1, 25_000.5])(
    'menolak tarif tak masuk akal: %s',
    (bad) => {
      expect(() => assertSaneRate(bad as number)).toThrow();
    },
  );

  it('menerima tepat di batas mint IDRX', () => {
    expect(() => assertSaneRate(IDRX_MIN_MINT_IDR)).not.toThrow();
    expect(() => assertSaneRate(IDRX_MAX_MINT_IDR)).not.toThrow();
  });

  it('penampung sementara berada DI DALAM batas yang bisa ditagih', () => {
    expect(DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER).toBeGreaterThanOrEqual(
      IDRX_MIN_MINT_IDR,
    );
    expect(DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER).toBeLessThanOrEqual(
      IDRX_MAX_MINT_IDR,
    );
  });

  it('admin bisa mengubahnya tanpa deploy (upsert per scope)', async () => {
    const world = baseWorld();
    const res = await admin(world).setDomesticShippingRate(
      { priceIdr: 30_000, note: 'flat JNE REG' },
      ADMIN,
    );
    expect(res.rate).toMatchObject({
      scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
      priceIdr: 30_000,
    });
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({ priceIdr: 30_000, source: 'DB' });
  });

  it('admin TIDAK bisa menyimpan tarif yang mustahil ditagih', async () => {
    const world = baseWorld();
    await expect(
      admin(world).setDomesticShippingRate({ priceIdr: 5_000 }, ADMIN),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.RATE_UNAVAILABLE },
    });
    expect(world.rates).toHaveLength(0);
  });
});


/* ══════════════════════ 10b. TIER ONGKIR PER-WILAYAH ══════════════════════
   Yang dijaga blok ini, dan kenapa masing-masing penting:

    • TIER ADALAH DATA. Menambah tier / memindah provinsi / memberi satu provinsi harga sendiri
      harus cukup lewat BARIS DB — kalau salah satunya butuh perubahan kode, syarat pemilik
      produk ("saya mungkin mau pembelahan yang lebih halus nanti") tidak terpenuhi.
    • ARAH GAGAL. Provinsi yang tidak dikenali dan alamat tanpa provinsi TIDAK BOLEH menjadi
      "gratis" atau "tarif termurah". Keduanya harus mendarat di tier PENAMPUNG.
    • NEGARA. Alamat luar negeri harus DITOLAK, bukan ditagih tarif domestik — paket itu tidak
      akan pernah bisa dikirim dengan uang segitu, dan ujungnya refund manual.
    • LANTAI IDRX. Tarif di bawah Rp 20.000 harus gagal saat DIKONFIGURASI, bukan saat pembeli
      pertama menekan "Bayar ongkir". */

describe('tier ongkir per-wilayah', () => {
  const logger = new Logger('test');
  const jakarta = { city: 'Jakarta', state: 'DKI Jakarta', country: 'ID' };
  const papua = { city: 'Jayapura', state: 'Papua', country: 'ID' };

  /** Dua tier DB: Jawa (murah, berdaftar provinsi) + luar Jawa (mahal, penampung). */
  const twoTiers = [
    {
      scope: DOMESTIC_TIER_JAWA,
      priceIdr: 22_000,
      provinces: ['jakarta', 'dki jakarta', 'jawa barat', 'west java'],
      fallback: false,
      label: 'Jawa',
      active: true,
    },
    {
      scope: DOMESTIC_TIER_LUAR_JAWA,
      priceIdr: 45_000,
      provinces: [],
      fallback: true,
      label: 'Luar Jawa',
      active: true,
    },
  ];

  it('memilih tier dari DAFTAR PROVINSI di baris, bukan dari kode', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld({ rates: [...twoTiers] })),
        logger,
        dest: jakarta,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({
      priceIdr: 22_000,
      scope: DOMESTIC_TIER_JAWA,
      label: 'Jawa',
      source: 'DB',
      region: 'TIER',
      regionUnresolved: false,
    });
  });

  it('provinsi di luar daftar mana pun → tier PENAMPUNG (yang lebih mahal), bukan yang termurah', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld({ rates: [...twoTiers] })),
        logger,
        dest: papua,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({
      priceIdr: 45_000,
      scope: DOMESTIC_TIER_LUAR_JAWA,
      region: 'FALLBACK_TIER',
      // TERLIHAT, bukan senyap: operator bisa menambahkan ejaan 'papua' ke tier yang benar.
      regionUnresolved: true,
    });
  });

  it('alamat TANPA provinsi tetap dilayani, dengan tarif penampung — tidak pernah gratis', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld({ rates: [...twoTiers] })),
        logger,
        // Kota yang tidak menyerupai nama provinsi mana pun, dan `state` kosong.
        dest: { city: 'Sorong', state: null, country: 'ID' },
        env: () => undefined,
      }),
    ).resolves.toMatchObject({
      priceIdr: 45_000,
      region: 'FALLBACK_TIER',
      province: 'sorong',
      regionUnresolved: true,
    });
  });

  it('alamat tanpa provinsi TAPI kotanya nama provinsi → tetap ketemu tiernya', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld({ rates: [...twoTiers] })),
        logger,
        dest: { city: 'Jakarta', state: null, country: 'ID' },
        env: () => undefined,
      }),
    ).resolves.toMatchObject({ priceIdr: 22_000, region: 'TIER' });
  });

  it('MENAMBAH TIER = menambah BARIS, nol perubahan kode', async () => {
    const world = baseWorld({ rates: [...twoTiers] });
    // Tier ketiga yang tidak pernah disebut kode mana pun.
    await admin(world).setDomesticShippingRate(
      {
        scope: 'TIER:TIMUR',
        label: 'Papua & Maluku',
        priceIdr: 88_000,
        provinces: ['Papua', 'Papua Barat', 'Maluku'],
      },
      ADMIN,
    );
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest: papua,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({
      priceIdr: 88_000,
      scope: 'TIER:TIMUR',
      label: 'Papua & Maluku',
      region: 'TIER',
      regionUnresolved: false,
    });
  });

  it('harga KHUSUS SATU PROVINSI menang atas tier-nya', async () => {
    const world = baseWorld({ rates: [...twoTiers] });
    await admin(world).setDomesticShippingRate(
      { scope: 'STATE:DKI Jakarta', priceIdr: 15_000 + 5_000, label: 'Jakarta saja' },
      ADMIN,
    );
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest: jakarta,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({ priceIdr: 20_000, region: 'STATE' });
  });

  it('scope STATE dinormalkan, jadi ejaan admin dan ejaan alamat tidak jadi dua baris', () => {
    expect(normalizeScope('STATE:DKI  Jakarta')).toBe(
      normalizeScope('state:dki jakarta'.toUpperCase()),
    );
    expect(normalizeScope('TIER:JAWA')).toBe('TIER:JAWA');
    expect(normalizeScope(DOMESTIC_RATE_SCOPE_NATIONWIDE)).toBe('*');
  });

  it('ejaan Inggris dari dropdown geo DAN singkatan ketikan bebas sama-sama kena tier Jawa', async () => {
    for (const state of ['West Java', 'Jabar', 'Central Java', 'Jogja', 'Yogyakarta']) {
      await expect(
        resolveDomesticShippingIdr({
          prisma: fakePrisma(baseWorld()),
          logger,
          dest: { city: 'x', state, country: 'ID' },
          env: () => undefined,
        }),
      ).resolves.toMatchObject({
        scope: DOMESTIC_TIER_JAWA,
        priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      });
    }
  });

  /* ─────────────────────── gerbang NEGARA ─────────────────────── */

  it.each(['Indonesia', 'indonesia', 'ID', 'id', 'IDN', 'Republik Indonesia'])(
    'membaca "%s" sebagai Indonesia',
    (c) => expect(isIndonesianDestination(c)).toBe(true),
  );

  it.each(['United States', 'US', 'Singapore', 'Malaysia', '', 'Indonesian'])(
    'TIDAK membaca "%s" sebagai Indonesia',
    (c) => expect(isIndonesianDestination(c)).toBe(false),
  );

  it('alamat luar negeri DITOLAK, bukan ditagih tarif domestik', async () => {
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(baseWorld({ rates: [...twoTiers] })),
        logger,
        dest: { city: 'Austin', state: 'Texas', country: 'United States' },
        env: () => undefined,
      }),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.ADDRESS_UNSUPPORTED },
    });
  });

  it('gerbang negara juga berlaku di TAKSIRAN, jadi user tahu SEBELUM menekan bayar', async () => {
    const world = baseWorld({
      redemption: domesticRow(RedemptionStatus.REQUESTED, {
        country: 'Singapore',
      }),
    });
    await expect(payments(world).quoteDomesticShipping(RED_ID, USER)).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.ADDRESS_UNSUPPORTED },
    });
    // NOL efek samping: barisnya tidak bergerak dan tidak ada order yang lahir.
    expect(world.redemption!.status).toBe(RedemptionStatus.REQUESTED);
    expect(world.order).toBeNull();
  });

  /* ─────────────────── konfigurasi yang salah ─────────────────── */

  it('provinsi yang terdaftar di DUA tier → dipakai yang TERMAHAL (tidak pernah menagih kurang)', () => {
    const picked = pickTier(
      [
        { scope: 'TIER:A', priceIdr: 20_000, provinces: ['bali'], fallback: false, label: null },
        { scope: 'TIER:B', priceIdr: 60_000, provinces: ['bali'], fallback: false, label: null },
      ],
      'bali',
    );
    expect(picked).toMatchObject({ region: 'TIER' });
    expect(picked!.row.priceIdr).toBe(60_000);
  });

  it('dua tier sama-sama fallback → dipakai yang TERMAHAL', () => {
    const picked = pickTier(
      [
        { scope: 'TIER:A', priceIdr: 20_000, provinces: [], fallback: true, label: null },
        { scope: 'TIER:B', priceIdr: 70_000, provinces: [], fallback: true, label: null },
      ],
      'entah',
    );
    expect(picked).toMatchObject({ region: 'FALLBACK_TIER' });
    expect(picked!.row.priceIdr).toBe(70_000);
  });

  it('menyalakan fallback di satu tier MEMATIKANNYA di tier lain (penampung selalu tunggal)', async () => {
    const world = baseWorld({ rates: [...twoTiers] });
    await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_JAWA, priceIdr: 22_000, fallback: true },
      ADMIN,
    );
    expect(world.rates.filter((r: any) => r.fallback === true)).toHaveLength(1);
    expect(world.rates.find((r: any) => r.fallback === true)!.scope).toBe(DOMESTIC_TIER_JAWA);
  });

  it('MENGAKTIFKAN kembali baris yang sudah penampung tetap membersihkan penampung lain', async () => {
    // Keadaan akhir dihitung dari gabungan body + baris yang sudah ada. Kalau hanya body yang
    // dibaca, PUT ini (yang tidak menyebut `fallback` sama sekali) akan melewati pembersihan dan
    // meninggalkan DUA penampung aktif — ditolak index parsial DB dengan P2002 yang tak
    // menjelaskan apa pun.
    const world = baseWorld({
      rates: [
        { ...twoTiers[0], fallback: true, active: true },
        { ...twoTiers[1], fallback: true, active: false },
      ],
    });
    await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_LUAR_JAWA, priceIdr: 45_000, active: true },
      ADMIN,
    );
    expect(
      world.rates.filter((r: any) => r.fallback === true && r.active === true),
    ).toHaveLength(1);
  });

  it('PUT yang cuma membetulkan harga TIDAK mengosongkan daftar provinsi tier itu', async () => {
    const world = baseWorld({ rates: [...twoTiers] });
    await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_JAWA, priceIdr: 24_000 },
      ADMIN,
    );
    const row = world.rates.find((r: any) => r.scope === DOMESTIC_TIER_JAWA)!;
    expect(row.priceIdr).toBe(24_000);
    expect(row.provinces).toEqual(['jakarta', 'dki jakarta', 'jawa barat', 'west java']);
  });

  it('provinsi yang ditulis admin DINORMALKAN, jadi "DKI Jakarta" cocok dengan alamat apa adanya', async () => {
    const world = baseWorld();
    await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_JAWA, priceIdr: 21_000, provinces: ['  DKI   Jakarta ', 'DKI Jakarta'] },
      ADMIN,
    );
    const row = world.rates.find((r: any) => r.scope === DOMESTIC_TIER_JAWA)!;
    expect(row.provinces).toEqual(['dki jakarta']); // dinormalkan DAN di-dedup
    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(world),
        logger,
        dest: jakarta,
        env: () => undefined,
      }),
    ).resolves.toMatchObject({ priceIdr: 21_000, region: 'TIER' });
  });

  it('entri provinsi KOSONG dibuang — kalau tidak, ia diam-diam jadi penampung kedua', async () => {
    const world = baseWorld();
    await admin(world).setDomesticShippingRate(
      { scope: 'TIER:X', priceIdr: 30_000, provinces: ['', '   ', 'bali'] },
      ADMIN,
    );
    expect(world.rates.find((r: any) => r.scope === 'TIER:X')!.provinces).toEqual(['bali']);
  });

  /* ─────────────────── LANTAI IDRX & PENAMPUNG ─────────────────── */

  it('tier baru pun tidak bisa disimpan di bawah lantai IDRX', async () => {
    const world = baseWorld();
    await expect(
      admin(world).setDomesticShippingRate(
        { scope: 'TIER:MURAH', priceIdr: IDRX_MIN_MINT_IDR - 1 },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      response: { code: DOMESTIC_ERROR_CODE.RATE_UNAVAILABLE },
    });
    expect(world.rates).toHaveLength(0);
  });

  it('SEMUA tier penampung di kode berada di dalam batas yang bisa ditagih', () => {
    for (const t of DOMESTIC_DEFAULT_TIERS) {
      expect(() => assertSaneRate(t.priceIdr, t.scope)).not.toThrow();
    }
  });

  it('tier PENAMPUNG bawaan adalah yang TERMAHAL — provinsi tak dikenal tak pernah ditagih kurang', () => {
    const fb = DOMESTIC_DEFAULT_TIERS.filter((t) => t.fallback);
    expect(fb).toHaveLength(1); // tepat satu penampung
    const dearest = Math.max(...DOMESTIC_DEFAULT_TIERS.map((t) => t.priceIdr));
    expect(fb[0].priceIdr).toBe(dearest);
    expect(fb[0].priceIdr).toBe(DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER);
  });

  it('label tier bawaan MENGAKU dirinya penampung (angka sementara tak boleh menyamar jadi final)', () => {
    for (const t of DOMESTIC_DEFAULT_TIERS) {
      expect(t.label.toUpperCase()).toContain('PENAMPUNG');
    }
  });

  it('daftar alias Jawa sudah dalam bentuk NORMAL (kalau tidak, ia tak akan pernah cocok)', () => {
    for (const a of JAWA_PROVINCE_ALIASES) {
      expect(normalizeRegionKey(a)).toBe(a);
    }
  });

  it('dashboard admin MENUNTUT keputusan pemilik selama angkanya masih penampung', async () => {
    const world = baseWorld();
    const empty = await admin(world).listDomesticShippingRates();
    // Tabel KOSONG bukan "tidak ada yang perlu dilakukan": tier penampung SEDANG ditagihkan.
    expect(empty.effective).toHaveLength(DOMESTIC_DEFAULT_TIERS.length);
    expect(empty.effective.every((t) => t.placeholder)).toBe(true);
    expect(empty.actionRequired.join(' ')).toContain('PENAMPUNG');

    // Begitu manusia menetapkan harganya, tuntutan itu hilang untuk baris tersebut.
    await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_LUAR_JAWA, priceIdr: 45_000, fallback: true },
      ADMIN,
    );
    const after = await admin(world).listDomesticShippingRates();
    expect(after.effective.some((t) => t.placeholder)).toBe(false);
    expect(after.actionRequired).toEqual([]);
  });
});

/* ══════════════════════════ 11. BACKFILL `sellable` ══════════════════════════ */

describe('A — kontrol sellable untuk baris yang sudah ada', () => {
  it('menaikkan flag pada baris yang memenuhi pagar bentuk', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: false,
        buyerId: null,
      }),
    });
    const res = await admin(world).setListingsSellable(
      [LISTING_ID],
      true,
      ADMIN,
    );
    expect(res.changed).toBe(1);
    expect(world.listing!.sellable).toBe(true);
  });

  it.each([
    ['katalog CollectorCrypt', { source: 'COLLECTORCRYPT' }],
    ['listing milik user', { sellerId: 'user-lain' }],
    ['baris yang sudah SOLD', { status: ListingStatus.SOLD }],
  ])('MENOLAK (melewati) %s', async (_label, over) => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: false,
        buyerId: null,
        ...over,
      }),
    });
    const res = await admin(world).setListingsSellable(
      [LISTING_ID],
      true,
      ADMIN,
    );
    expect(res.changed).toBe(0);
    expect(res.skipped).toEqual([LISTING_ID]);
    expect(world.listing!.sellable).toBe(false);
  });

  /** TIDAK ADA mode "semua baris" — itu akan membuka kembali bahaya listing dummy. */
  it('menolak daftar id kosong (tidak ada sapuan massal)', async () => {
    await expect(
      admin(baseWorld()).setListingsSellable([], true, ADMIN),
    ).rejects.toThrow(/minimal satu id/);
  });

  it('reversibel: flag bisa diturunkan lagi', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: true,
        buyerId: null,
      }),
    });
    const res = await admin(world).setListingsSellable(
      [LISTING_ID],
      false,
      ADMIN,
    );
    expect(res.changed).toBe(1);
    expect(world.listing!.sellable).toBe(false);
  });

  /**
   * B4 — AMAN DIPANGGIL UI. Klien yang gugup (retry, double-click, reload) tidak boleh bisa
   * membedakan panggilan kedua dari yang pertama SELAIN lewat `changed: 0` + `alreadyCorrect`.
   * Tanpa pembedaan itu, `changed: 0` ambigu antara "sudah benar" dan "ditolak diam-diam".
   */
  it('IDEMPOTEN: panggilan kedua tidak mengubah apa pun dan mengaku kenapa', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: false,
        buyerId: null,
      }),
    });
    const first = await admin(world).setListingsSellable(
      [LISTING_ID],
      true,
      ADMIN,
    );
    expect(first.changed).toBe(1);
    expect(first.alreadyCorrect).toEqual([]);

    const second = await admin(world).setListingsSellable(
      [LISTING_ID],
      true,
      ADMIN,
    );
    expect(second.changed).toBe(0);
    expect(second.alreadyCorrect).toEqual([LISTING_ID]);
    // "Sudah benar" BUKAN "ditolak": id-nya tidak boleh mendarat di `skipped`.
    expect(second.skipped).toEqual([]);
    expect(world.listing!.sellable).toBe(true);
  });

  it('daftar stok tertahan membawa paging + actionRequired (bukan cuma tabel)', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: false,
        buyerId: null,
      }),
    });
    const res = await admin(world).listUnsellableStock(50, 0);
    expect(res).toMatchObject({
      total: 1,
      returned: 1,
      limit: 50,
      offset: 0,
      hasMore: false,
      placeholderDetection: 'MANUAL_ONLY',
    });
    expect(res.actionRequired.join(' ')).toContain('TIDAK BISA DIBELI');

    // Batas dijepit DI SERVER: query string tidak boleh bisa menarik seluruh tabel.
    const clamped = await admin(world).listUnsellableStock(999_999, -5);
    expect(clamped.limit).toBe(1000);
    expect(clamped.offset).toBe(0);
  });

  it('tidak ada stok tertahan → actionRequired KOSONG (kosong berarti benar-benar beres)', async () => {
    const world = baseWorld({
      listing: hoshiStockListing({
        status: ListingStatus.ACTIVE,
        sellable: true,
        buyerId: null,
      }),
    });
    const res = await admin(world).listUnsellableStock();
    expect(res.total).toBe(0);
    expect(res.actionRequired).toEqual([]);
  });
});

/* ══════════════════════ 12. B4 — KONTRAK RUTE TARIF UNTUK DASHBOARD ══════════════════════ */

/**
 * Rute-rute ini sudah ada TAPI belum punya klien, jadi defaultnya berlaku diam-diam: setiap
 * pembeli domestik ditagih angka PENAMPUNG yang `DOMESTIC_DEFAULT_TIERS` sendiri akui belum
 * diputuskan pemilik produk. Yang diuji di sini adalah apakah responsnya cukup untuk MERENDER dan
 * MEMVALIDASI layarnya tanpa menebak.
 */
describe('B4 — GET/PUT tarif ongkir menyajikan kontrak yang lengkap', () => {
  it('tabel kosong MENGAKU sedang memakai penampung, lengkap dengan angkanya', async () => {
    const res = await admin(baseWorld()).listDomesticShippingRates();
    expect(res.usingDefaults).toBe(true);
    expect(res.placeholderCount).toBe(DOMESTIC_DEFAULT_TIERS.length);
    expect(res.placeholderPricesIdr).toEqual({
      jawa: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      luarJawa: DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER,
    });
    expect(res.actionRequired.length).toBeGreaterThan(0);
  });

  /** Form di dashboard harus bisa menolak nominal buruk SEBELUM submit — pakai batas yang SAMA. */
  it('membawa batas nominal yang BENAR-BENAR ditegakkan service', async () => {
    const world = baseWorld();
    const res = await admin(world).listDomesticShippingRates();
    expect(res.limits.minPriceIdr).toBe(IDRX_MIN_MINT_IDR);
    expect(res.limits.maxPriceIdr).toBe(IDRX_MAX_MINT_IDR);
    // Batas yang diiklankan harus batas yang sungguhan: satu rupiah di bawahnya DITOLAK.
    await expect(
      admin(world).setDomesticShippingRate(
        { priceIdr: res.limits.minPriceIdr - 1 },
        ADMIN,
      ),
    ).rejects.toBeDefined();
  });

  /**
   * PUT mengembalikan keadaan SESUDAH tulisannya, dari fungsi yang sama dengan GET. Tanpa ini
   * dashboard harus memanggil GET lagi — dan di antara keduanya ia menampilkan `actionRequired`
   * yang basi (mis. masih menuntut keputusan yang baru saja dibuat operator).
   */
  it('PUT mengembalikan effective/actionRequired/usingDefaults yang SUDAH diperbarui', async () => {
    const world = baseWorld();
    const put = await admin(world).setDomesticShippingRate(
      { scope: DOMESTIC_TIER_LUAR_JAWA, priceIdr: 45_000, fallback: true },
      ADMIN,
    );
    expect(put.usingDefaults).toBe(false);
    expect(put.actionRequired).toEqual([]);
    expect(put.effective.some((t) => t.placeholder)).toBe(false);

    // Dan ia IDENTIK dengan apa yang GET katakan sesudahnya — dua pembaca, satu perhitungan.
    const get = await admin(world).listDomesticShippingRates();
    expect(put.actionRequired).toEqual(get.actionRequired);
    expect(put.usingDefaults).toBe(get.usingDefaults);
    expect(put.effective).toEqual(get.effective);
  });

  /** UPSERT per scope: dipanggil dua kali dengan body sama → satu baris, bukan dua. */
  it('PUT IDEMPOTEN per scope (aman di-retry dari UI)', async () => {
    const world = baseWorld();
    const body = {
      scope: DOMESTIC_TIER_JAWA,
      priceIdr: 22_000,
      provinces: ['jakarta'],
    };
    await admin(world).setDomesticShippingRate(body, ADMIN);
    await admin(world).setDomesticShippingRate(body, ADMIN);
    expect(world.rates.filter((r) => r.scope === DOMESTIC_TIER_JAWA)).toHaveLength(
      1,
    );
  });
});
