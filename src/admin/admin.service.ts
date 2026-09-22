import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// CATATAN: cloudinary SENGAJA TIDAK di-import di sini (top-level). SDK-nya memvalidasi CLOUDINARY_URL
// saat MODULE DI-LOAD dan melempar Error kalau formatnya salah (harus diawali 'cloudinary://'). Import
// top-level = satu env rusak meng-crash SELURUH backend saat boot (crash-loop, deploy gagal). Kita
// require LAZY + tangkap error di cloudinaryLib() → env rusak cuma menonaktifkan cloudinary.
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import {
  ActivityType,
  EscrowRecoveryOutcome,
  ListingSource,
  ListingStatus,
  OfferStatus,
  PaymentStatus,
  Prisma,
  RedemptionStatus,
  StorageProvider,
  VaultStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { MarketplaceService } from '../marketplace/marketplace.service';
import {
  EscrowService,
  EscrowTransferIndeterminateError,
} from '../escrow/escrow.service';
import {
  p2pModeOf,
  unescrowedUserListingWhere,
} from '../marketplace/p2p.gate';
// SATU definisi "baris listing ini titipan atau bukan?" — lihat `financeSummary`.
import {
  isConsignedListing,
  listingKindOf,
  nonConsignedListingWhere,
} from '../common/listing-kind';
// Penolakan BER-RUTE untuk aksi listing yang memang tidak berlaku bagi kartu TITIPAN.
import { consignmentUnsupported } from '../common/consignment.gate';
import { PrismaService } from '../prisma/prisma.service';
import {
  recordShippingRefundDebts,
  type ShippingRefundDebt,
} from '../payments/shipping-refund-debt';
import {
  DOMESTIC_DEFAULT_TIERS,
  DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER,
  DOMESTIC_RATE_SCOPE_NATIONWIDE,
  DOMESTIC_RATE_SCOPE_STATE_PREFIX,
  DOMESTIC_RATE_SCOPE_TIER_PREFIX,
  DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
  DOMESTIC_TIER_JAWA,
  DOMESTIC_TIER_LUAR_JAWA,
  JAWA_PROVINCE_ALIASES,
  assertSaneRate,
  normalizeRegionKey,
  normalizeScope,
} from '../payments/domestic-shipping-rate';
import {
  IDRX_MAX_MINT_IDR,
  IDRX_MIN_MINT_IDR,
} from '../payments/idrx-mint-bounds';
import { appendBoundedNote, NOTE_MAX } from '../common/append-note';
import { isHoshiSellableStock } from '../common/hoshi-stock';
import { isDomesticRedemption } from '../common/hoshi-domestic-shipping';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { CreateContactMessageDto } from './dto/contact-message.dto';
import { ImportListingsDto } from './dto/import-listings.dto';
import {
  QueryAdminActivityDto,
  QueryAdminCardsDto,
  QueryAdminListingsDto,
} from './dto/query-admin.dto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Label wallet ringkas: 5 depan + ".." + 4 belakang (cermin shortWallet marketplace). */
function shortWalletLabel(w: string): string {
  return w.length <= 11 ? w : `${w.slice(0, 5)}..${w.slice(-4)}`;
}

/* ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   ║ B2 — SATU SUMBER KEBENARAN untuk transisi status redemption yang boleh dilakukan admin.    ║
   ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   Dulu tabel ini hidup sebagai variabel LOKAL di `updateRedemptionStatus`, jadi satu-satunya cara
   dashboard bisa tahu tombol mana yang sah adalah MENEBAK — dan tebakan itulah yang menampilkan
   "Kemas" & "Kirim" pada baris domestik yang ongkirnya belum ditagih. Dinaikkan ke modul supaya
   `listRedemptions()` MENYAJIKAN daftar yang SAMA PERSIS dengan yang ditegakkan penulisnya; tidak
   ada dua salinan yang bisa menyimpang.

   Partial: status yang tak tercantum → tak punya transisi admin (default []). Itu yang menutup
   BURN_SUBMITTED/DELIVERED dst. dari sentuhan admin. Penjelasan lengkap tiap barisnya ada di
   docblock `updateRedemptionStatus`. */
const REDEMPTION_ADMIN_TRANSITIONS: Partial<
  Record<RedemptionStatus, RedemptionStatus[]>
> = {
  [RedemptionStatus.REQUESTED]: [
    RedemptionStatus.PACKING,
    RedemptionStatus.SHIPPED,
    RedemptionStatus.CANCELED,
  ],
  [RedemptionStatus.PACKING]: [
    RedemptionStatus.SHIPPED,
    RedemptionStatus.CANCELED,
  ],
  // B1: penutupan jalur record-only. Tanpa ini SHIPPED memblokir mint-nya selamanya.
  [RedemptionStatus.SHIPPED]: [RedemptionStatus.DELIVERED],
  // Resolusi manual jalur real: funding yang ditinggalkan user → RECLAIM_DUE (USDC sudah/mungkin
  // keluar; JANGAN refund Rupiah, reclaim USDC on-chain manual).
  [RedemptionStatus.FUNDING]: [RedemptionStatus.RECLAIM_DUE],
  [RedemptionStatus.FUNDED]: [RedemptionStatus.RECLAIM_DUE],
  // B1: penutupan RECLAIM_DUE sesudah USDC-nya benar-benar direklaim/ditulis-rugi. Kartunya
  // TIDAK pernah dibakar (itulah arti RECLAIM_DUE), jadi mint-nya memang boleh diminta lagi.
  // refundSafe TIDAK ikut ditulis di sini: ia tetap false, dan gerbang refund tetap menolak.
  [RedemptionStatus.RECLAIM_DUE]: [RedemptionStatus.CANCELED],
  // B1: penutupan kasus support pasca-burn yang akhirnya sampai ke user.
  [RedemptionStatus.SHIP_FAILED_POST_BURN]: [RedemptionStatus.DELIVERED],
  // B2: penutupan yang DIKENDALIKAN KITA untuk kiriman yang diparkir CC di `Shipped`.
  // Tidak menyentuh uang: IN_TRANSIT berarti NFT-nya sudah dibakar, jadi tidak ada yang bisa
  // ditebus dua kali dan tidak ada Rupiah yang jadi bisa di-refund gara-gara transisi ini.
  [RedemptionStatus.IN_TRANSIT]: [RedemptionStatus.DELIVERED],
};

/**
 * B2 — TRANSISI DOMESTIK YANG MENGIRIM BARANG. Inilah yang tidak boleh dijalankan sebelum ongkir
 * Rupiah-nya lunas: keduanya berarti paketnya mulai bergerak keluar dari rak Hoshi.
 */
const DOMESTIC_FULFILMENT_TARGETS: RedemptionStatus[] = [
  RedemptionStatus.PACKING,
  RedemptionStatus.SHIPPED,
];

/** Panjang minimum pernyataan operator yang ikut DISIMPAN di baris (sama dengan rute admin lain). */
const OPERATOR_NOTE_MIN = 10;

/**
 * B2 — RINGKASAN TAGIHAN ONGKIR satu baris redemption, untuk dashboard admin.
 *
 * Dulu tidak ada satu pun field seperti ini yang sampai ke layar: rail-nya dihitung lalu dibuang,
 * dan keadaan pembayaran ongkirnya tidak pernah dihitung sama sekali. Operator melihat dua tombol
 * dan tidak punya cara tahu bahwa menekannya berarti Hoshi menanggung ongkirnya.
 */
export interface AdminRedemptionOngkir {
  /** true ⇔ rail ini menagih ongkir Rupiah lewat invoice IDRX (yaitu: rail DOMESTIK). */
  required: boolean;
  /** true ⇔ ADA order SHIPPING berstatus FULFILLED untuk baris ini = ongkirnya LUNAS. */
  paid: boolean;
  /** true ⇔ ada order yang pemenuhannya masih berjalan (PAID/FULFILLING) — TUNGGU, jangan majukan. */
  inFlight: boolean;
  /** true ⇔ ada order yang sudah tercatat sebagai utang refund (REFUND_DUE). */
  refundDue: boolean;
  /**
   * Untuk order REFUND_DUE: gerbang refund-nya. false = operator DILARANG mengirim uang sebelum
   * verifikasi di luar sistem. null = tidak ada order REFUND_DUE.
   */
  refundSafe: boolean | null;
  /** Total Rupiah yang benar-benar LUNAS (jumlah order berstatus FULFILLED). */
  paidIdr: number;
  /** Semua tagihan ongkir baris ini, terbaru dulu. [] = belum pernah ada tagihan. */
  orders: Array<{
    merchantOrderId: string;
    status: PaymentStatus;
    priceIdr: number;
    refundSafe: boolean;
    createdAt: Date;
    paidAt: Date | null;
    fulfilledAt: Date | null;
  }>;
}

/**
 * Ringkasan "belum ada tagihan apa pun". FUNGSI, bukan konstanta: sebuah konstanta bersama akan
 * membuat SEMUA baris ikut memakai SATU array `orders` yang sama, dan satu `push` di mana pun
 * kelak akan bocor ke setiap baris lain. Objek baru tiap panggilan menutup jalan itu sepenuhnya.
 */
function ongkirNone(required = false): AdminRedemptionOngkir {
  return {
    required,
    paid: false,
    inFlight: false,
    refundDue: false,
    refundSafe: null,
    paidIdr: 0,
    orders: [],
  };
}

/**
 * B2 — APA YANG MASIH HARUS DIPUTUSKAN MANUSIA pada SATU baris redemption.
 *
 * Bentuknya sengaja sama dengan `actionRequired` di rute tarif ongkir: daftar kalimat, KOSONG
 * berarti benar-benar tidak ada yang tertunggak. Ini pengganti `logger.warn` yang tidak pernah
 * sampai ke siapa pun — sebuah peringatan yang tidak terbaca bukan pengaman.
 */
function redemptionActionRequired(
  status: RedemptionStatus,
  rail: 'HOSHI_DOMESTIC' | 'CC_VAULT',
  ongkir: AdminRedemptionOngkir,
): string[] {
  const out: string[] = [];
  if (rail === 'HOSHI_DOMESTIC' && status === RedemptionStatus.REQUESTED) {
    if (ongkir.inFlight) {
      out.push(
        'Pembayaran ongkir user sedang diproses (order PAID/FULFILLING). TUNGGU satu putaran ' +
          'reconciler — baris ini akan pindah ke PACKING sendiri begitu lunas. Jangan dimajukan ' +
          'tangan sekarang.',
      );
    } else if (!ongkir.paid) {
      out.push(
        'ONGKIR BELUM LUNAS. Alur normalnya: user membayar invoice ongkir, lalu baris ini pindah ' +
          'ke PACKING OTOMATIS. Memajukannya tangan berarti ONGKIRNYA DITANGGUNG HOSHI — jadi ' +
          'PACKING/SHIPPED DITOLAK di sini kecuali Anda sadar-sadar menanggungnya ' +
          '(absorbShippingFee=true + alasan, tersimpan permanen di baris).',
      );
    }
  }
  if (ongkir.refundDue) {
    out.push(
      ongkir.refundSafe === false
        ? 'Ada tagihan ongkir REFUND_DUE dengan refundSafe=FALSE — JANGAN kirim uangnya. ' +
            'Verifikasi dulu di luar sistem (dashboard IDRX / posisi USDC on-chain).'
        : `Ada tagihan ongkir REFUND_DUE (refundSafe=true): KEMBALIKAN Rupiah-nya ke user DI LUAR ` +
            'SISTEM. Tidak ada kode yang mengirimkannya otomatis.',
    );
  }
  return out;
}

/**
 * Ember ledger `/admin/transactions`. Ini LABEL LAPORAN, bukan gerbang settlement — gerbangnya
 * tetap `listingKindOf` (src/common/listing-kind.ts), dan label di sini DITURUNKAN darinya.
 *
 * CONSIGNMENT berdiri sendiri karena satu-satunya alternatifnya adalah menyembunyikannya di dalam
 * P2P, dan "P2P" di layar uang berarti "kartunya milik user, uangnya jadi saldo penjual, kalau
 * gagal kembalikan saja". Untuk kartu titipan yang sudah terjual lalu hilang, ketiga kalimat itu
 * salah sekaligus: payout-nya SUDAH cair ke pemilik, jadi memulihkan pembeli adalah KERUGIAN
 * Hoshi — bukan mengembalikan uang yang masih kami pegang.
 */
export type AdminTransactionType = 'PACK' | 'RESELLER' | 'CONSIGNMENT' | 'P2P';

export interface AdminStatsResponse {
  totalListings: number;
  activeListings: number;
  soldListings: number;
  /** Ditarik penjual (delisting). */
  cancelledListings: number;
  /** Nunggu kartu masuk escrow (hanya jalur P2P real; 0 di staging mock). */
  pendingEscrowListings: number;
  totalUsers: number;
  totalCards: number;
  totalRevenue: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly marketplace: MarketplaceService,
    // D (checklist 4.6) — dashboard escrow + pemulihan manual. EscrowService satu-satunya yang
    // boleh menyuruh wallet escrow menandatangani; admin hanya memicunya lewat pintu ini.
    private readonly escrow: EscrowService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new BadRequestException('Invalid email or password.');
    }
    const valid = await verify(user.passwordHash, password);
    if (!valid) {
      throw new BadRequestException('Invalid email or password.');
    }
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: 'ADMIN',
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async stats(): Promise<AdminStatsResponse> {
    const [
      totalListings,
      activeListings,
      soldListings,
      cancelledListings,
      pendingEscrowListings,
      totalUsers,
      totalCards,
    ] = await Promise.all([
      this.prisma.listing.count(),
      this.prisma.listing.count({ where: { status: ListingStatus.ACTIVE } }),
      this.prisma.listing.count({ where: { status: ListingStatus.SOLD } }),
      this.prisma.listing.count({ where: { status: ListingStatus.CANCELLED } }),
      this.prisma.listing.count({
        where: { status: ListingStatus.PENDING_ESCROW },
      }),
      this.prisma.user.count(),
      // "Jenis kartu" = jumlah DESAIN UNIK yang benar-benar dipajang (distinct nama listing), BUKAN
      // baris tabel `Card` internal. Mayoritas listing (hasil sinkron CC) tak mengisi cardId, jadi
      // card.count() dulu cuma menghitung ~8 desain ter-mint/admin → menyesatkan. Distinct nama
      // listing mencerminkan variasi kartu yang sebenarnya di marketplace.
      this.prisma.listing
        .findMany({ distinct: ['name'], select: { name: true } })
        .then((rows) => rows.length),
    ]);
    const revenueAgg = await this.prisma.listing.aggregate({
      where: { status: ListingStatus.SOLD },
      _sum: { priceIdrx: true },
    });
    return {
      totalListings,
      activeListings,
      soldListings,
      cancelledListings,
      pendingEscrowListings,
      totalUsers,
      totalCards,
      totalRevenue: revenueAgg._sum.priceIdrx ?? 0,
    };
  }

  /* ──────────── TARIF ONGKIR KIRIM DOMESTIK (stok Hoshi, kurir lokal) ──────────── */

  /**
   * Semua baris tarif + penjelasan urutan resolusinya + APA YANG MASIH HARUS DIPUTUSKAN PEMILIK
   * PRODUK. READ-ONLY.
   *
   * ┌──── KENAPA RUTE INI MENGEMBALIKAN LEBIH DARI SEKADAR BARIS ────────────────────────────┐
   * │ Model ongkirnya BERTINGKAT PER WILAYAH tapi ANGKANYA BELUM DIPUTUSKAN. Kalau rute ini    │
   * │ cuma mengembalikan isi tabel, tabel KOSONG akan terbaca sebagai "tidak ada yang perlu    │
   * │ dilakukan" — padahal artinya justru sebaliknya: jalur bayar sedang memakai TIER          │
   * │ PENAMPUNG di kode, dan setiap pembeli sedang ditagih angka yang belum disetujui siapa    │
   * │ pun. Maka rute ini SELALU menyebut tier yang SEDANG BERLAKU (dari DB maupun dari         │
   * │ penampung), menandai mana yang masih penampung, dan menaruhnya di `actionRequired`.      │
   * └─────────────────────────────────────────────────────────────────────────────────────────┘
   */
  async listDomesticShippingRates() {
    const state = await this.domesticRateState();
    return {
      data: state.rows,
      /** Tier yang SEDANG berlaku — dari DB kalau ada baris aktif, kalau tidak dari penampung. */
      effective: state.effective,
      /** Kosong = konfigurasi ongkir lengkap. Tidak kosong = pembeli ditagih angka sementara. */
      actionRequired: state.actionRequired,
      /**
       * B4 — true ⇔ TIDAK ADA satu pun baris AKTIF di DB, jadi jalur bayar sedang memakai
       * DOMESTIC_DEFAULT_TIERS di kode. Sengaja jadi boolean sendiri: sebuah tabel kosong tidak
       * boleh bisa terbaca sebagai "beres" hanya karena `data` berukuran nol.
       */
      usingDefaults: state.usingDefaults,
      /** Jumlah tier yang harganya masih PENAMPUNG. >0 = pembeli ditagih angka yang belum disetujui. */
      placeholderCount: state.effective.filter((t) => t.placeholder).length,
      /**
       * B4 — batas nominal yang DITEGAKKAN service (assertSaneRate). Form di dashboard WAJIB
       * memvalidasi dengan angka ini supaya operator tidak baru tahu setelah menekan Simpan.
       */
      limits: {
        minPriceIdr: IDRX_MIN_MINT_IDR,
        maxPriceIdr: IDRX_MAX_MINT_IDR,
        maxProvincesPerTier: 500,
        maxScopeLength: 120,
      },
      /** Angka PENAMPUNG di kode — yang SEDANG ditagihkan selama `usingDefaults` true. */
      placeholderPricesIdr: {
        jawa: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
        luarJawa: DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER,
      },
      nationwideScope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
      tierScopePrefix: DOMESTIC_RATE_SCOPE_TIER_PREFIX,
      stateScopePrefix: DOMESTIC_RATE_SCOPE_STATE_PREFIX,
      /** Contoh SIAP-TEMPEL untuk menetapkan dua tier awal. */
      example: {
        jawa: {
          scope: DOMESTIC_TIER_JAWA,
          label: 'Jawa',
          priceIdr: 22000,
          provinces: [...JAWA_PROVINCE_ALIASES],
        },
        luarJawa: {
          scope: DOMESTIC_TIER_LUAR_JAWA,
          label: 'Luar Jawa',
          priceIdr: 45000,
          fallback: true,
        },
        satuProvinsi: { scope: 'STATE:papua', label: 'Papua', priceIdr: 95000 },
      },
      resolution:
        'Urutan yang dipakai jalur bayar, dari paling spesifik: (1) baris AKTIF ber-scope ' +
        "'STATE:<provinsi>'; (2) baris AKTIF yang `provinces`-nya memuat provinsi tujuan; " +
        '(3) baris AKTIF ber-fallback=true (provinsi tak dikenal / alamat tanpa provinsi); ' +
        "(4) baris AKTIF ber-scope '*'; (5) env HOSHI_DOMESTIC_SHIPPING_FLAT_IDR; (6) tier " +
        'PENAMPUNG di kode (src/payments/domestic-shipping-rate.ts). Set baris di sini untuk ' +
        'mengubah ongkir TANPA deploy dan TANPA restart — termasuk MENAMBAH TIER BARU.',
      note:
        'Alamat di LUAR Indonesia DITOLAK jalur ini (HOSHI_DOMESTIC_ADDRESS_UNSUPPORTED), bukan ' +
        'ditagih tarif domestik. Alamat Indonesia TANPA provinsi tetap dilayani, dengan tarif ' +
        'tier PENAMPUNG.',
      /** PUT-nya UPSERT per `scope` → memanggilnya dua kali dengan body sama TIDAK menggandakan apa pun. */
      idempotency:
        "PUT /admin/shipping/domestic-rates adalah UPSERT dengan kunci `scope`: mengirim body " +
        'yang sama dua kali menghasilkan baris yang sama (aman di-retry). Field yang TIDAK ' +
        'disebut tidak diubah — sebuah PUT yang cuma membetulkan harga tidak mengosongkan ' +
        'daftar provinsi tier itu.',
    };
  }

  /**
   * B4 — keadaan tarif yang DIPAKAI BERSAMA oleh GET dan PUT, supaya keduanya tidak bisa
   * menyimpang. PUT mengembalikan `actionRequired`/`effective` yang SUDAH diperbarui, jadi
   * dashboard bisa merender ulang tanpa memanggil GET lagi (dan tanpa menampilkan keadaan basi).
   */
  private async domesticRateState() {
    const rows = await this.prisma.domesticShippingRate.findMany({
      orderBy: { scope: 'asc' },
    });
    const activeRows = rows.filter((r) => r.active);

    // Tier yang BENAR-BENAR dipakai hari ini. Kalau belum ada satu pun baris AKTIF, jalur bayar
    // memakai DOMESTIC_DEFAULT_TIERS — jadi itulah yang ditampilkan, ditandai jelas.
    const effective =
      activeRows.length > 0
        ? activeRows.map((r) => ({
            scope: r.scope,
            label: r.label,
            priceIdr: r.priceIdr,
            provinces: r.provinces,
            fallback: r.fallback,
            placeholder: r.placeholder,
            from: 'DB' as const,
          }))
        : DOMESTIC_DEFAULT_TIERS.map((t) => ({
            scope: t.scope,
            label: t.label,
            priceIdr: t.priceIdr,
            provinces: [...t.provinces],
            fallback: t.fallback,
            placeholder: true,
            from: 'DEFAULT_TIER' as const,
          }));

    const stillPlaceholder = effective.filter((t) => t.placeholder);
    const fallbackCount = effective.filter((t) => t.fallback).length;

    // Daftar tugas yang BELUM SELESAI. Kosong = konfigurasinya lengkap. Tidak pernah diperhalus
    // jadi "peringatan" — ini hal-hal yang membuat pembeli ditagih angka yang salah.
    const actionRequired: string[] = [];
    if (stillPlaceholder.length > 0) {
      actionRequired.push(
        `${stillPlaceholder.length} tier masih memakai ANGKA PENAMPUNG yang belum diputuskan ` +
          `pemilik produk (${stillPlaceholder.map((t) => t.scope).join(', ')}). Set harganya ` +
          'lewat PUT /api/admin/shipping/domestic-rates — angka itu SEDANG ditagihkan ke pembeli.',
      );
    }
    if (fallbackCount === 0) {
      actionRequired.push(
        'TIDAK ADA tier PENAMPUNG (fallback=true). Provinsi yang tidak terdaftar di tier mana pun ' +
          "akan jatuh ke baris '*' (flat nasional) kalau ada, dan kalau tidak ada pun ke tier " +
          'penampung di kode. Tandai satu tier — biasanya yang TERMAHAL — dengan fallback=true.',
      );
    }
    if (fallbackCount > 1) {
      actionRequired.push(
        `Ada ${fallbackCount} tier yang sama-sama fallback=true. Seharusnya TEPAT SATU; resolusi ` +
          'memakai yang TERMAHAL sampai ini dibereskan.',
      );
    }

    return {
      rows,
      effective,
      actionRequired,
      usingDefaults: activeRows.length === 0,
    };
  }

  /**
   * UPSERT satu TIER ongkir (kunci: scope). Default scope '*' = flat nasional (bentuk lama).
   *
   * INI RUTE TEMPAT PEMILIK PRODUK MENETAPKAN ONGKIRNYA, dan tempat TIER BARU LAHIR: karena satu
   * baris = satu tier yang membawa harganya SEKALIGUS daftar provinsinya, menambah tier tidak
   * pernah butuh perubahan kode, migrasi, atau restart.
   *
   * NOL DANA TREASURY: baris ini hanya menentukan nominal RUPIAH yang ditagihkan ke pembeli.
   * Tidak ada USDC, tidak ada plafon treasury yang tersentuh.
   *
   * TIGA PENEGAKAN DI SINI, semuanya di depan operator (bukan nanti di checkout user):
   *   1. nominal divalidasi ke batas mint IDRX (assertSaneRate) — tarif di bawah Rp 20.000
   *      menghasilkan baris yang kelihatan benar tapi invoice-nya tidak akan pernah bisa terbit.
   *   2. `provinces` DINORMALKAN (huruf kecil, tanda baca jadi spasi) supaya pencocokan tidak
   *      bergantung pada cara operator mengetik, dan duplikatnya dibuang.
   *   3. fallback TUNGGAL: menyalakan flag itu di satu baris otomatis mematikannya di baris lain,
   *      dalam SATU transaksi. Tanpa ini, partial unique index di DB akan menolak tulisannya
   *      dengan P2002 yang tidak menjelaskan apa-apa.
   */
  async setDomesticShippingRate(
    input: {
      scope?: string;
      priceIdr: number;
      provinces?: string[];
      fallback?: boolean;
      label?: string;
      active?: boolean;
      note?: string;
    },
    admin: { id: string; walletAddress: string },
  ) {
    // Scope dinormalkan lewat helper yang SAMA dengan yang dipakai resolusi, supaya
    // 'STATE:DKI Jakarta' yang diketik admin dan 'STATE:dki jakarta' yang dicari jalur bayar
    // tidak pernah jadi dua baris berbeda yang saling tidak kelihatan.
    const scope = normalizeScope(input.scope ?? DOMESTIC_RATE_SCOPE_NATIONWIDE);
    if (!scope) {
      throw new BadRequestException(
        `Scope tidak boleh kosong. Pakai '${DOMESTIC_RATE_SCOPE_NATIONWIDE}' untuk flat nasional, ` +
          `'${DOMESTIC_RATE_SCOPE_TIER_PREFIX}<NAMA>' untuk tier wilayah.`,
      );
    }
    assertSaneRate(input.priceIdr, scope);

    // Provinsi dinormalkan + di-dedup. Yang kosong dibuang: satu entri kosong akan cocok dengan
    // alamat yang tidak menyebut provinsi, diam-diam mengubah tier ini jadi penampung kedua.
    const provinces =
      input.provinces === undefined
        ? undefined
        : [
            ...new Set(
              input.provinces.map((p) => normalizeRegionKey(p)).filter((p) => p.length > 0),
            ),
          ];

    // Keadaan AKHIR baris ini dihitung dari gabungan "apa yang dikirim" dan "apa yang sudah ada",
    // BUKAN dari body saja. Kalau tidak: sebuah PUT yang cuma menyalakan `active: true` pada baris
    // yang SUDAH fallback akan melewati pembersihan di bawah dan ditolak index parsialnya dengan
    // P2002 yang tidak menjelaskan apa-apa.
    const existing = await this.prisma.domesticShippingRate.findUnique({
      where: { scope },
      select: { fallback: true, active: true },
    });
    const willBeFallback = input.fallback ?? existing?.fallback ?? false;
    const willBeActive = input.active ?? existing?.active ?? true;
    const wantsFallback = input.fallback === true;

    const row = await this.prisma.$transaction(async (tx) => {
      // FALLBACK TUNGGAL — dimatikan di baris lain DULU, di transaksi yang sama, supaya tidak
      // pernah ada dua penampung (dan supaya index parsialnya tidak menolak tulisan ini).
      if (willBeFallback && willBeActive) {
        await tx.domesticShippingRate.updateMany({
          where: { fallback: true, scope: { not: scope } },
          data: { fallback: false },
        });
      }
      return tx.domesticShippingRate.upsert({
        where: { scope },
        create: {
          scope,
          priceIdr: input.priceIdr,
          provinces: provinces ?? [],
          fallback: wantsFallback,
          label: input.label ?? null,
          active: input.active ?? true,
          note: input.note ?? null,
          // Ditulis MANUSIA → bukan penampung lagi. Inilah yang membuat `actionRequired` menyusut.
          placeholder: false,
          updatedBy: admin.id,
        },
        update: {
          priceIdr: input.priceIdr,
          // TIDAK DISEBUT = TIDAK DIUBAH. Sebuah PUT yang cuma membetulkan harga tidak boleh
          // diam-diam mengosongkan daftar provinsi tier itu.
          ...(provinces !== undefined && { provinces }),
          ...(input.fallback !== undefined && { fallback: input.fallback }),
          ...(input.label !== undefined && { label: input.label }),
          ...(input.active !== undefined && { active: input.active }),
          ...(input.note !== undefined && { note: input.note }),
          placeholder: false,
          updatedBy: admin.id,
        },
      });
    });

    // PERINGATAN KONFIGURASI — dihitung SESUDAH tulisannya, dari keadaan yang sebenarnya.
    const after = await this.prisma.domesticShippingRate.findMany({
      where: { active: true },
      select: { scope: true, priceIdr: true, fallback: true, placeholder: true },
    });
    const warnings: string[] = [];
    const fallbacks = after.filter((r) => r.fallback);
    if (fallbacks.length === 0) {
      warnings.push(
        'Belum ada tier PENAMPUNG (fallback=true). Provinsi yang tidak terdaftar di tier mana pun ' +
          "akan jatuh ke baris '*' kalau ada, kalau tidak ke tier penampung di kode.",
      );
    }
    const dearest = after.reduce(
      (a, r) => (r.priceIdr > a ? r.priceIdr : a),
      0,
    );
    if (fallbacks.length === 1 && fallbacks[0].priceIdr < dearest) {
      warnings.push(
        `Tier PENAMPUNG (${fallbacks[0].scope}, Rp ${fallbacks[0].priceIdr}) BUKAN yang termahal ` +
          `(termahal: Rp ${dearest}). Provinsi yang belum terdaftar akan ditagih KURANG dari ` +
          'tier termahal — pastikan itu memang yang kamu mau.',
      );
    }
    const stillPlaceholder = after.filter((r) => r.placeholder);
    if (stillPlaceholder.length > 0) {
      warnings.push(
        `${stillPlaceholder.length} tier lain masih memakai angka PENAMPUNG ` +
          `(${stillPlaceholder.map((r) => r.scope).join(', ')}).`,
      );
    }

    this.logger.warn(
      `ADMIN tarif ongkir DOMESTIK scope '${scope}' = Rp ${row.priceIdr} ` +
        `(active=${row.active}, fallback=${row.fallback}, provinsi=${row.provinces.length}) ` +
        `oleh ${admin.id} (${admin.walletAddress}). ` +
        'Berlaku untuk tagihan ongkir BERIKUTNYA; tagihan yang sudah terbit memakai nominal ' +
        'yang di-snapshot di baris PaymentOrder-nya sendiri.',
    );
    // B4 — keadaan SESUDAH tulisan, dari fungsi yang SAMA dengan GET. Dashboard bisa merender
    // ulang langsung dari respons PUT: tidak ada jendela di mana layar memperlihatkan
    // `actionRequired` yang basi, dan tidak ada dua perhitungan yang bisa menyimpang.
    const state = await this.domesticRateState();
    return {
      rate: row,
      warnings,
      warning:
        'Tarif ini dipakai untuk tagihan ongkir BERIKUTNYA. Tagihan yang sudah terbit TIDAK ' +
        'berubah — nominalnya di-snapshot di PaymentOrder saat invoice dibuat.',
      /** Bentuknya IDENTIK dengan field bernama sama di GET — satu tipe di klien. */
      effective: state.effective,
      actionRequired: state.actionRequired,
      usingDefaults: state.usingDefaults,
    };
  }

  /* ---------------------- Kirim kartu fisik (redemption) ---------------------- */

  /**
   * Semua permintaan kirim kartu fisik (admin), terbaru dulu.
   *
   * `rail` DITURUNKAN dari kolom `listingId` (bukan dari `source`, yang free-form dan bisa
   * berbunyi 'HOSHI' pada baris warisan jalur CC). Operator WAJIB bisa melihat bedanya sekilas:
   * HOSHI_DOMESTIC = kemas & kirim sendiri lewat kurir lokal, isi resinya di sini.
   * CC_VAULT = burn + shipment CollectorCrypt; resinya datang dari poll CC, jangan diisi tangan.
   */
  async listRedemptions() {
    const rows = await this.prisma.cardRedemption.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const ongkirById = await this.summarizeOngkir(rows.map((r) => r.id));
    // KARTU SIAPA yang dipegang operator. `source='CONSIGNMENT'` sudah mengatakan "ini barang
    // orang lain", tapi tidak menyebut SIAPA — dan operator yang harus mengambil satu slab dari
    // rak butuh nama pemiliknya, bukan sekadar kategori. SATU query untuk seluruh halaman.
    const consignmentByListing =
      await this.consignmentRefsForListings(rows.map((r) => r.listingId));

    return rows.map((r) => {
      const domestic = isDomesticRedemption(r);
      const rail = domestic
        ? ('HOSHI_DOMESTIC' as const)
        : ('CC_VAULT' as const);
      const ongkir: AdminRedemptionOngkir = domestic
        ? (ongkirById.get(r.id) ?? ongkirNone(true))
        : ongkirNone(false);

      // Transisi yang BENAR-BENAR akan diterima penulisnya — dari tabel yang SAMA, lalu dikurangi
      // pagar ongkir. Inilah yang dulu tidak ada: dashboard menggambar tombolnya sendiri.
      const allNext = REDEMPTION_ADMIN_TRANSITIONS[r.status] ?? [];
      const ongkirBlocks =
        domestic &&
        r.status === RedemptionStatus.REQUESTED &&
        !ongkir.paid;
      const blockedNextStatuses = ongkirBlocks
        ? allNext.filter((s) => DOMESTIC_FULFILMENT_TARGETS.includes(s))
        : [];
      const allowedNextStatuses = allNext.filter(
        (s) => !blockedNextStatuses.includes(s),
      );

      return {
        ...r,
        rail,
        ongkir,
        /**
         * Titipan yang kartunya sedang dikirim ini — null kalau baris ini BUKAN titipan.
         * LABEL, bukan gerbang (sama seperti `source`): railnya tetap dibaca dari `listingId`.
         */
        consignment:
          (r.listingId ? consignmentByListing.get(r.listingId) : null) ?? null,
        /** Tombol yang boleh dirender. Sudah dikurangi pagar ongkir — bukan tabel mentah. */
        allowedNextStatuses,
        /**
         * Tombol yang tabelnya izinkan TAPI pagar ongkir tolak. Render disabled + alasannya,
         * jangan disembunyikan: operator harus tahu bahwa jalan keluarnya ada tapi berbayar.
         */
        blockedNextStatuses,
        /** Kosong = tidak ada yang tertunggak di baris ini. Tidak pernah diperhalus jadi "info". */
        actionRequired: redemptionActionRequired(r.status, rail, ongkir),
      };
    });
  }

  /**
   * "Kartu ini titipan siapa?" untuk BANYAK baris redemption sekaligus (satu query, bukan N+1).
   *
   * Dibaca dari `Listing.consignment`, yaitu FAKTA yang sama dengan yang dipakai `listingKindOf`
   * — BUKAN dari `CardRedemption.source`, yang memang cuma label dan pada baris warisan bisa
   * berbunyi 'HOSHI' untuk kartu titipan. Map kosong = tidak ada satu pun baris titipan.
   */
  private async consignmentRefsForListings(
    listingIds: (string | null)[],
  ): Promise<
    Map<
      string,
      { id: string; status: string; consignorName: string; askPriceIdr: number }
    >
  > {
    const out = new Map<
      string,
      { id: string; status: string; consignorName: string; askPriceIdr: number }
    >();
    const ids = [...new Set(listingIds.filter((v): v is string => !!v))];
    if (ids.length === 0) return out;
    const rows = await this.prisma.listing.findMany({
      where: { id: { in: ids }, consignmentId: { not: null } },
      select: {
        id: true,
        consignment: {
          select: {
            id: true,
            status: true,
            consignorNameAtIntake: true,
            askPriceIdr: true,
          },
        },
      },
    });
    for (const row of rows) {
      if (!row.consignment) continue;
      out.set(row.id, {
        id: row.consignment.id,
        status: row.consignment.status,
        // SNAPSHOT saat serah-terima — tetap benar meski nama akunnya berubah kemudian.
        consignorName: row.consignment.consignorNameAtIntake,
        askPriceIdr: row.consignment.askPriceIdr,
      });
    }
    return out;
  }

  /**
   * B2 — keadaan tagihan ongkir untuk BANYAK baris redemption sekaligus (satu query, bukan N+1).
   *
   * Sumbernya SATU: baris PaymentOrder ber-`packType='SHIPPING'`. Tidak ada kolom turunan di
   * CardRedemption yang bisa menyimpang darinya.
   */
  private async summarizeOngkir(
    redemptionIds: string[],
  ): Promise<Map<string, AdminRedemptionOngkir>> {
    const out = new Map<string, AdminRedemptionOngkir>();
    if (redemptionIds.length === 0) return out;

    const orders = await this.prisma.paymentOrder.findMany({
      where: { redemptionId: { in: redemptionIds }, packType: 'SHIPPING' },
      orderBy: { createdAt: 'desc' },
      select: {
        redemptionId: true,
        merchantOrderId: true,
        status: true,
        priceIdr: true,
        refundSafe: true,
        createdAt: true,
        paidAt: true,
        fulfilledAt: true,
      },
    });

    for (const o of orders) {
      if (!o.redemptionId) continue;
      const cur = out.get(o.redemptionId) ?? ongkirNone(true);
      cur.orders.push({
        merchantOrderId: o.merchantOrderId,
        status: o.status,
        priceIdr: o.priceIdr,
        refundSafe: o.refundSafe,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        fulfilledAt: o.fulfilledAt,
      });
      if (o.status === PaymentStatus.FULFILLED) {
        cur.paid = true;
        cur.paidIdr += o.priceIdr;
      }
      if (
        o.status === PaymentStatus.PAID ||
        o.status === PaymentStatus.FULFILLING
      ) {
        cur.inFlight = true;
      }
      if (o.status === PaymentStatus.REFUND_DUE) {
        cur.refundDue = true;
        // Gerbang refund PALING KETAT menang: satu order yang tidak boleh di-refund cukup untuk
        // menahan seluruh barisnya. Menaikkannya kembali ke true di sini akan menghapus larangan.
        cur.refundSafe = (cur.refundSafe ?? true) && o.refundSafe;
      }
      out.set(o.redemptionId, cur);
    }
    return out;
  }

  /**
   * Admin memajukan status kirim REDEMPTION — HANYA baris RECORD-ONLY + resolusi manual jalur real.
   *
   * PEMBAGIAN TEGAS setelah CC Vault Shipping ada:
   *  - Baris RECORD-ONLY (REQUESTED/PACKING/SHIPPED): admin yang memenuhi fisik manual
   *    (REQUESTED→PACKING→SHIPPED) atau membatalkan (→CANCELED). Nol on-chain — tak ada burn/transfer.
   *  - Baris JALUR REAL (AWAITING_PAYMENT…): burn-nya USER yang menandatangani (bukan admin), dan
   *    status majunya digerakkan CcShippingService + poll shipment CC — BUKAN dari sini. Yang admin
   *    boleh cuma RESOLUSI MANUAL: menandai funding yang ditinggalkan user sebagai RECLAIM_DUE
   *    (USDC sudah/mungkin keluar → refundSafe=false, JANGAN refund Rupiah; reclaim USDC on-chain).
   *
   * B1 — SETIAP STATUS PEMBLOKIR WAJIB PUNYA JALAN KELUAR. Memblokir tanpa jalan keluar = kunci
   * kartu PERMANEN, dan tiga status dulu tidak punya satu pun:
   *   - SHIPPED               -> DELIVERED : penutupan jalur record-only (kartunya sudah sampai).
   *   - RECLAIM_DUE           -> CANCELED  : ops SUDAH mereklaim/menutup USDC-nya. Kartunya tidak
   *                                          pernah dibakar, jadi mint-nya memang boleh hidup lagi.
   *                                          refundSafe TIDAK disentuh (tetap false) — menutup
   *                                          kasus BUKAN berarti Rupiah jadi bisa di-refund.
   *   - SHIP_FAILED_POST_BURN -> DELIVERED : kasus support tuntas dan kartunya benar-benar sampai.
   *   - IN_TRANSIT            -> DELIVERED : B2 — lihat blok di bawah. Satu-satunya sel matriks
   *                                          yang jalan keluarnya dulu BUKAN milik kita.
   *
   * ┌─ B2 — SEBUAH STATUS TIDAK BOLEH BERGANTUNG PADA NIAT BAIK PIHAK KETIGA ────────────────────┐
   * │ IN_TRANSIT dulu TIDAK punya kunci di peta ini: satu-satunya jalan keluarnya adalah poll    │
   * │ status CC menjawab `Delivered`. Kalau CC memarkir shipment di `Shipped` (mapCcShipmentStatus│
   * │ memetakannya ke IN_TRANSIT — tidak memajukan apa pun), atau GET /outbound-shipment/:id      │
   * │ mulai menjawab 200-body-kosong "id tak dikenal" (refreshStatus sengaja TIDAK menulis apa pun│
   * │ pada kasus itu), barisnya tersangkut SELAMANYA — dan `nftAddress`-nya ikut menahan indeks   │
   * │ unik yang dilebarkan, jadi mint itu tidak bisa diminta kirim lagi.                          │
   * │ NOL UANG dipertaruhkan (IN_TRANSIT = NFT-nya memang SUDAH dibakar, jadi tidak ada yang bisa │
   * │ menebusnya dua kali) — yang dipertaruhkan adalah KENDALI. Operator yang sudah memastikan    │
   * │ kartunya sampai sekarang bisa menutupnya sendiri, tanpa mengedit Postgres.                  │
   * └────────────────────────────────────────────────────────────────────────────────────────────┘
   *
   * Status yang tetap tak bisa digerakkan endpoint ini (AWAITING_PAYMENT, BURN_SUBMITTED,
   * DELIVERED, REFUND_DUE, CANCELED, dan READY_TO_FUND) SENGAJA punya rute sendiri,
   * bukan tanpa rute:
   *   - AWAITING_PAYMENT-> CANCELED   : POST /admin/redemptions/:id/cancel-awaiting-payment
   *                                     (wajib beralasan; melaporkan utang ongkir yang tersisa).
   *   - BURN_SUBMITTED  -> FUNDED     : POST /admin/redemptions/:id/recover-burn-submitted
   *                                     (wajib beralasan + pernyataan verifikasi ke CC).
   *   - READY_TO_FUND   -> REFUND_DUE : POST /admin/redemptions/:id/settle-refund-due
   *                                     (wajib beralasan; satu-satunya penulis REFUND_DUE).
   *   - DELIVERED / REFUND_DUE / CANCELED: terminal, tidak memblokir apa pun.
   *
   * IN_TRANSIT kini punya DUA jalan keluar: poll shipment CC (CcShippingService.refreshStatus →
   * `Delivered`) yang OTOMATIS tapi MILIK PIHAK KETIGA, dan PATCH status ini yang MILIK KITA.
   */
  async updateRedemptionStatus(
    id: string,
    status: RedemptionStatus,
    /**
     * RESI kurir — HANYA sah untuk baris jalur DOMESTIK. Pada baris jalur CC, kolom
     * trackingIds/trackingUrls MILIK poll shipment CollectorCrypt: menulisnya tangan di sini
     * akan menimpa nomor resi asli dengan angka yang kita karang, dan tidak ada apa pun di
     * baris itu yang menandai bahwa itu terjadi. Jadi ditolak, bukan diabaikan.
     */
    tracking?: { trackingIds?: string[]; trackingUrls?: string[] },
    /**
     * B2 — PENANGGUNGAN ONGKIR YANG DISENGAJA. Satu-satunya cara memajukan baris DOMESTIK dari
     * REQUESTED ke PACKING/SHIPPED tanpa ongkir yang lunas. Bukan "flag paksa" umum: ia hanya
     * berlaku untuk sel matriks itu, wajib membawa alasan, dan alasannya DISIMPAN di baris.
     */
    opts?: { absorbShippingFee?: boolean; note?: string },
  ) {
    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    const domestic = isDomesticRedemption(row);
    const wantsTracking =
      (tracking?.trackingIds?.length ?? 0) > 0 ||
      (tracking?.trackingUrls?.length ?? 0) > 0;
    if (wantsTracking && !domestic) {
      throw new BadRequestException(
        'Resi hanya bisa diisi tangan untuk pengiriman DOMESTIK (stok Hoshi). Untuk kartu vault ' +
          'CollectorCrypt, resinya datang dari poll shipment CC — jangan ditimpa manual.',
      );
    }
    // Tabel transisinya kini MODUL-LEVEL (REDEMPTION_ADMIN_TRANSITIONS) supaya `listRedemptions()`
    // menyajikan daftar yang SAMA PERSIS dengan yang ditegakkan di sini. Satu tabel, dua pembaca.
    if (!(REDEMPTION_ADMIN_TRANSITIONS[row.status] ?? []).includes(status)) {
      throw new BadRequestException(
        `Tidak bisa mengubah status dari ${row.status} ke ${status}.`,
      );
    }
    if (status === RedemptionStatus.SHIPPED) {
      this.logger.warn(
        `Redemption ${id} → SHIPPED (record-only, pemenuhan fisik manual). Burn CC jalur real ` +
          `di-tandatangani USER lewat /redemptions/:id/submit-burn — bukan di sini.`,
      );
    }
    // RECLAIM_DUE: USDC treasury sudah/mungkin didanai ke wallet user tapi burn tak dituntaskan →
    // refundSafe=false supaya gerbang refund tak pernah membalikkan Rupiah (rugi dobel).
    // Perhatikan ARAH-nya: hanya MASUK ke RECLAIM_DUE yang menulis false. KELUAR darinya
    // (→ CANCELED) sengaja TIDAK menulis apa pun — refundSafe tetap false. Tidak ada satu pun
    // cabang di method ini yang pernah menulis refundSafe=true.
    const extra: { refundSafe?: boolean } =
      status === RedemptionStatus.RECLAIM_DUE ? { refundSafe: false } : {};
    // RESI DOMESTIK. Ditulis hanya kalau diberikan; tidak pernah menimpa dengan array kosong.
    const trackingData: { trackingIds?: string[]; trackingUrls?: string[] } = {};
    if (domestic && tracking?.trackingIds?.length) {
      trackingData.trackingIds = tracking.trackingIds;
    }
    if (domestic && tracking?.trackingUrls?.length) {
      trackingData.trackingUrls = tracking.trackingUrls;
    }
    // ╔════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ B2 — MENOLAK, BUKAN SEKADAR MEMPERINGATKAN: baris DOMESTIK yang ongkirnya BELUM lunas. ║
    // ╚════════════════════════════════════════════════════════════════════════════════════════╝
    // Dulu sel matriks ini cuma `logger.warn`. Peringatan itu tidak pernah sampai ke siapa pun:
    // dashboard tidak membaca log, responsnya tidak menyebutkannya, dan operator melihat dua
    // tombol yang tampak normal. Setiap penekanannya = satu paket yang ongkirnya ditanggung Hoshi
    // tanpa seorang pun memutuskannya. Peringatan yang tidak terbaca BUKAN pengaman.
    //
    // KENAPA TETAP ADA JALAN LEWAT (dan bukan larangan mutlak): menanggung ongkir kadang MEMANG
    // keputusan bisnis yang benar (goodwill, promo, user yang sudah membayar lewat kanal lain).
    // Larangan mutlak akan menghapus kemampuan itu dan memaksa operator mengedit Postgres — pola
    // yang sudah tiga kali melahirkan bug di repo ini. Jadi: DITOLAK secara default, LOLOS hanya
    // lewat pernyataan eksplisit yang DISIMPAN DI BARIS (bukan cuma di log).
    //
    // KETERJANGKAUAN JALAN KELUAR TIDAK BERKURANG: REQUESTED tetap punya dua jalan keluar yang
    // tidak butuh pernyataan apa pun (user POST /redemptions/:id/cancel dan admin PATCH →
    // CANCELED), dan PACKING/SHIPPED tetap terbuka begitu ongkirnya lunas atau ditanggung sadar.
    let absorbNote: string | null = null;
    if (
      domestic &&
      row.status === RedemptionStatus.REQUESTED &&
      DOMESTIC_FULFILMENT_TARGETS.includes(status)
    ) {
      const ongkir = (await this.summarizeOngkir([id])).get(id) ?? ongkirNone(true);

      if (!ongkir.paid) {
        const inFlightNote = ongkir.inFlight
          ? ' CATATAN: ada tagihan ongkir yang pembayarannya SEDANG DIPROSES (PAID/FULFILLING) — ' +
            'baris ini akan pindah ke PACKING sendiri begitu lunas. Tunggu satu putaran reconciler ' +
            'sebelum memutuskan menanggungnya.'
          : '';
        const reason = (opts?.note ?? '').trim();

        if (opts?.absorbShippingFee !== true) {
          throw new BadRequestException(
            `Baris DOMESTIK ${id} belum punya ongkir yang lunas, jadi ${row.status} → ${status} ` +
              'DITOLAK. Alur normalnya: user membayar invoice ongkir dan baris ini pindah ke ' +
              'PACKING OTOMATIS. Kalau Hoshi memang mau MENANGGUNG ongkirnya, kirim ulang dengan ' +
              '`absorbShippingFee: true` beserta `note` (alasan, min. ' +
              `${OPERATOR_NOTE_MIN} karakter) — keduanya disimpan permanen di baris ini.` +
              inFlightNote,
          );
        }
        if (reason.length < OPERATOR_NOTE_MIN) {
          throw new BadRequestException(
            `Menanggung ongkir wajib beralasan (minimal ${OPERATOR_NOTE_MIN} karakter) dan ` +
              'alasannya disimpan permanen di baris ini.',
          );
        }

        const stamp = new Date().toISOString();
        absorbNote =
          `[ADMIN ONGKIR DITANGGUNG HOSHI ${stamp}] ${row.status} → ${status} tanpa ongkir yang ` +
          `lunas. Operator MENYATAKAN Hoshi menanggung ongkir paket ini. Alasan: ${reason}`;
        // Log KERAS dulu — jejaknya ada bahkan kalau tulisan DB gagal sesudah ini.
        this.logger.error(
          `ONGKIR DITANGGUNG HOSHI — redemption DOMESTIK ${id}: ${row.status} → ${status} ` +
            `DI-MAJUKAN ADMIN tanpa pembayaran ongkir. Listing ${row.listingId}, user ` +
            `${row.userId}. Nol Rupiah ongkir pernah masuk untuk baris ini. Alasan: ${reason}`,
        );
      }
    }
    if (
      row.status === RedemptionStatus.RECLAIM_DUE &&
      status === RedemptionStatus.CANCELED
    ) {
      this.logger.error(
        `Redemption ${id}: RECLAIM_DUE → CANCELED (penutupan manual). Operator MENYATAKAN USDC ` +
          `ongkir sudah direklaim atau ditulis-rugi. refundSafe TETAP ${row.refundSafe} — ` +
          'penutupan ini BUKAN izin me-refund Rupiah. Kartunya tidak pernah dibakar, jadi mint ' +
          `${row.nftAddress} kembali bisa diminta kirim.`,
      );
    }
    if (status === RedemptionStatus.RECLAIM_DUE) {
      this.logger.warn(
        `Redemption ${id} → RECLAIM_DUE (resolusi manual). USDC ongkir sudah/mungkin di wallet ` +
          `user — reclaim on-chain; JANGAN refund Rupiah (refundSafe=false).`,
      );
    }
    // B2: penutupan MANUAL sebuah kiriman jalur-real. Poll CC yang biasanya melakukannya tidak
    // pernah menjawab `Delivered` untuk baris ini, jadi operator MENYATAKAN kartunya sampai.
    // refundSafe TIDAK disentuh: menutup kasus BUKAN izin membalikkan Rupiah.
    if (
      row.status === RedemptionStatus.IN_TRANSIT &&
      status === RedemptionStatus.DELIVERED
    ) {
      this.logger.warn(
        `Redemption ${id}: IN_TRANSIT → DELIVERED (penutupan MANUAL, bukan dari poll CC). ` +
          `Shipment CC ${row.outboundShipmentId ?? 'tidak ada'}, nft ${row.nftAddress}, user ` +
          `${row.userId}. Operator MENYATAKAN kiriman sudah sampai — CC tidak pernah menjawab ` +
          `\`Delivered\`. refundSafe TETAP ${row.refundSafe}; NFT-nya memang sudah dibakar, jadi ` +
          'mint ini tidak bisa (dan tidak boleh) diminta kirim lagi.',
      );
    }
    // Pernyataan "ongkir ditanggung Hoshi" ikut ke KOLOM `note`, bukan cuma ke log: sebuah
    // keputusan uang harus bisa dibaca kembali dari barisnya sendiri berbulan-bulan kemudian.
    const noteData = absorbNote
      ? { note: appendBoundedNote(row.note, absorbNote, NOTE_MAX) }
      : {};
    const updated = await this.prisma.cardRedemption.update({
      where: { id },
      data: { status, ...extra, ...trackingData, ...noteData },
    });

    // ╔════════════════════════════════════════════════════════════════════════════════════╗
    // ║ KARTU TITIPAN YANG DISERAHKAN KE KURIR = CUSTODY SELESAI. CATAT SEKARANG.          ║
    // ╚════════════════════════════════════════════════════════════════════════════════════╝
    // SHIPPED berarti paketnya sudah keluar dari tangan Hoshi. Untuk kartu TITIPAN itu bukan
    // sekadar perubahan status pengiriman: itu akhir dari custody atas barang orang lain, dan
    // `custodyReleasedAt` adalah SATU-SATUNYA tempat fakta itu hidup. Tanpa baris ini, kartu yang
    // sudah dikirim akan selamanya terlihat "masih di rak Hoshi" di dashboard dan di gerbang
    // `isInHoshiCustody` — yaitu tepat kebalikan dari kenyataannya.
    //
    // BERPAGAR (`custodyReleasedAt: null`) dan BEST-EFFORT: baris redemption sudah commit di
    // atas, jadi kegagalan mencatat di sini tidak boleh menggagalkan PATCH-nya — tapi ia di-LOG
    // KERAS, karena yang hilang adalah kebenaran tentang barang orang lain.
    if (domestic && status === RedemptionStatus.SHIPPED && row.listingId) {
      try {
        const listing = await this.prisma.listing.findUnique({
          where: { id: row.listingId },
          select: { consignmentId: true },
        });
        if (listing?.consignmentId) {
          const closed = await this.prisma.$transaction(async (tx) => {
            const c = await tx.consignment.updateMany({
              where: { id: listing.consignmentId as string, custodyReleasedAt: null },
              data: {
                status: 'RELEASED',
                custodyReleasedAt: new Date(),
                releaseReason: 'SHIPPED_TO_BUYER',
              },
            });
            if (c.count === 1) {
              await tx.consignmentEvent.create({
                data: {
                  consignmentId: listing.consignmentId as string,
                  kind: 'RELEASE',
                  toStatus: 'RELEASED',
                  actorId: null,
                  actorLabel: 'admin (PATCH redemption → SHIPPED)',
                  note: `Paket diserahkan ke kurir; redemption ${id}. Custody SELESAI.`,
                },
              });
            }
            return c.count;
          });
          this.logger.warn(
            `Titipan ${listing.consignmentId}: custody DITUTUP (SHIPPED_TO_BUYER) lewat ` +
              `redemption ${id} — ${closed} baris. Kartunya sudah keluar dari rak Hoshi.`,
          );
        }
      } catch (err) {
        this.logger.error(
          `GAGAL menutup custody titipan untuk redemption ${id} (listing ${row.listingId}): ` +
            `${err instanceof Error ? err.message : String(err)}. Paketnya SUDAH dikirim tapi ` +
            'catatan titipannya masih berbunyi "di rak Hoshi" — PERBAIKI MANUAL lewat ' +
            'POST /admin/consignments/:id/release.',
        );
      }
    }

    // ╔════════════════════════════════════════════════════════════════════════════════════╗
    // ║ PEMBUKUAN ONGKIR saat baris DOMESTIK dibatalkan admin. WAJIB, dan baru sejak       ║
    // ║ jalur domestik ada.                                                                 ║
    // ╚════════════════════════════════════════════════════════════════════════════════════╝
    // Dulu CANCELED dari REQUESTED/PACKING hanya mungkin untuk baris record-only yang NOL
    // uang — tidak pernah ada tagihan ongkir yang bisa tertinggal. Baris DOMESTIK berbeda:
    // PACKING berarti ongkir Rupiah-nya SUDAH LUNAS (order SHIPPING FULFILLED). Membatalkannya
    // tanpa pembukuan = user membayar ongkir, paketnya tidak dikirim, dan tidak ada satu pun
    // baris yang mencatat utangnya. Helper ini TIDAK PERNAH MELEMPAR, jadi pembatalan yang
    // sudah commit tidak bisa berubah jadi 500.
    let shippingDebts: ShippingRefundDebt[] = [];
    if (domestic && status === RedemptionStatus.CANCELED) {
      shippingDebts = await recordShippingRefundDebts({
        prisma: this.prisma,
        logger: this.logger,
        redemptionId: id,
        // B1 — rail + status-SEBELUM. `PACKING` di rail domestik berarti order ongkirnya FULFILLED
        // (fulfilShipping menulis keduanya dalam satu transaksi), dan itulah yang membuat
        // pembatalan ini melahirkan UTANG REFUND yang harus tercatat, bukan sekadar dilaporkan.
        rail: 'HOSHI_DOMESTIC',
        canceledFromStatus: row.status,
        actor: 'admin (PATCH status)',
        reason: `dibatalkan admin dari status ${row.status}`,
      });
    }

    // Keadaan ongkir dibaca ULANG SESUDAH pembukuan di atas, supaya respons PATCH memperlihatkan
    // baris seperti apa adanya SEKARANG (mis. order yang barusan jadi REFUND_DUE) — dashboard
    // bisa memperbarui barisnya tanpa memanggil GET lagi.
    const rail = domestic
      ? ('HOSHI_DOMESTIC' as const)
      : ('CC_VAULT' as const);
    const ongkirAfter: AdminRedemptionOngkir = domestic
      ? ((await this.summarizeOngkir([id])).get(id) ?? ongkirNone(true))
      : ongkirNone(false);

    return {
      ...updated,
      /**
       * Tagihan ongkir yang terdampak. SELALU ADA sebagai field (array kosong kalau tidak ada),
       * supaya bentuk respons rute ini tidak berubah-ubah per cabang — klien yang membacanya
       * tidak perlu tahu rail mana yang baru saja digerakkan.
       */
      shippingDebts,
      /**
       * B2 — bentuk yang SAMA PERSIS dengan baris di GET /admin/redemptions, termasuk
       * `blockedNextStatuses` yang di sini SELALU kosong (tidak ada transisi yang mendarat
       * kembali di REQUESTED, satu-satunya status yang pagar ongkirnya berlaku). Fieldnya tetap
       * ada supaya klien memakai SATU tipe untuk baris hasil GET maupun hasil PATCH.
       */
      rail,
      ongkir: ongkirAfter,
      allowedNextStatuses: REDEMPTION_ADMIN_TRANSITIONS[updated.status] ?? [],
      blockedNextStatuses: [] as RedemptionStatus[],
      actionRequired: redemptionActionRequired(updated.status, rail, ongkirAfter),
    };
  }

  /**
   * PEMULIHAN MANUAL: kembalikan SATU baris yang nyangkut di BURN_SUBMITTED ke FUNDED.
   *
   * ⚠️ OPERATOR MENYATAKAN SUDAH MEMVERIFIKASI KE COLLECTORCRYPT BAHWA KARTUNYA BELUM DIBAKAR.
   * Kalau ternyata sudah dibakar, aksi ini mengundang user menandatangani burn KEDUA untuk kartu
   * yang sudah tidak ada. Verifikasi dulu lewat GET /outbound-shipment/:id atau
   * support@collectorcrypt.com. Aksi ini TIDAK PERNAH membuat uang bisa di-refund: refundSafe
   * DIPAKSA tetap false.
   *
   * KENAPA ADA: `updateRedemptionStatus` SENGAJA tidak bisa menggerakkan BURN_SUBMITTED — itu
   * pilihan keamanan yang tetap berlaku. Tapi beberapa kegagalan burn mendarat di BURN_SUBMITTED
   * tanpa jalan keluar otomatis (403 CC yang tidak membawa jaminan "nothing was burned"; pelepasan
   * klaim ke FUNDED yang gagal), sementara reprepareBurn HANYA menerima FUNDED. Tanpa rute ini
   * satu-satunya pilihan manusia adalah mengedit Postgres langsung.
   *
   * BUKAN endpoint "set status apa saja": HANYA transisi BURN_SUBMITTED -> FUNDED, tidak ada
   * parameter status, dan wajib disertai alasan operator yang ikut disimpan di baris.
   */
  async recoverBurnSubmittedToFunded(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan pemulihan wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.BURN_SUBMITTED) {
      throw new BadRequestException(
        `Pemulihan ini HANYA untuk baris yang nyangkut di BURN_SUBMITTED — status sekarang ${row.status}.`,
      );
    }

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN RECOVER BURN_SUBMITTED->FUNDED ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] operator menyatakan sudah memverifikasi ke CollectorCrypt bahwa ` +
      `kartu BELUM dibakar. Alasan: ${reason}`;

    // Log KERAS dulu — supaya jejaknya ada bahkan kalau tulisan DB gagal setelah ini.
    // B2: catatan SEBELUMNYA ikut di-log. Itu satu-satunya string yang membedakan "submitBurn LEG
    // GAGAL" / "submitBurn INDETERMINATE" / "submitBurn DITOLAK CC tanpa membakar apa pun", dan
    // dulu ia lenyap tanpa jejak karena aksi ini MENIMPA kolom note.
    this.logger.error(
      `PEMULIHAN MANUAL redemption ${id}: BURN_SUBMITTED -> FUNDED oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. Shipment CC ${row.outboundShipmentId ?? 'tidak ada'}, ` +
        `nft ${row.nftAddress}, user ${row.userId}. refundSafe TETAP false (uang TIDAK jadi bisa ` +
        `di-refund). CATATAN SEBELUMNYA (penyebab baris ini nyangkut): ` +
        `${row.note ?? '(kosong)'}. Alasan operator: ${reason}`,
    );

    // Berpagar status di updateMany: baris yang keburu bergerak (mis. poll CC memajukannya ke
    // IN_TRANSIT/DELIVERED) TIDAK akan dimundurkan oleh balapan.
    const moved = await this.prisma.cardRedemption.updateMany({
      where: { id, status: RedemptionStatus.BURN_SUBMITTED },
      data: {
        status: RedemptionStatus.FUNDED,
        // TIDAK PERNAH true. Uang treasury sudah pindah ke wallet user; pemulihan ini murni soal
        // status baris, bukan soal uang.
        refundSafe: false,
        // B2 — MENAMBAH, BUKAN MENIMPA. `note` adalah satu-satunya bukti DURABEL kenapa baris ini
        // nyangkut (log droplet dirotasi; baris DB tidak). Menimpanya di sini berarti aksi
        // pemulihan menghapus penyebabnya — itulah cara aksi ini bisa MENUTUPI kerugian nyata:
        // lewat efek samping, bukan lewat desain. Pemotongan membuang bagian TERTUA, tidak pernah
        // alasan kegagalan yang terbaru.
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum pemulihan tereksekusi — muat ulang lalu cek lagi.',
      );
    }

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      warning:
        'Baris dikembalikan ke FUNDED. Dengan menjalankan ini Anda MENYATAKAN sudah memverifikasi ' +
        'ke CollectorCrypt bahwa kartu ini BELUM dibakar. refundSafe tetap false — USDC ongkir ' +
        'sudah ada di wallet user; JANGAN me-refund Rupiah-nya.',
    };
  }

  /**
   * B1 — SATU-SATUNYA JALAN KELUAR untuk READY_TO_FUND: tandai ongkir Rupiah sebagai UTANG REFUND.
   *
   * KENAPA ADA: READY_TO_FUND berarti Rupiah ongkir SUDAH LUNAS tapi USDC BELUM dikirim. Kalau
   * pendanaan tidak pernah bisa dijalankan — assertCostWithinPaid menolak permanen karena harga CC
   * bergerak melewati plafon slippage, atau user tidak pernah kembali — baris itu dulu tersangkut
   * SELAMANYA: tidak ada transisi admin, tidak ada rute user, dan kartunya ikut terkunci karena
   * READY_TO_FUND memblokir. Pesan error-nya bahkan menjanjikan "ongkir Rupiah bisa di-refund"
   * padahal TIDAK ADA satu pun kode di repo ini yang bisa menindaklanjutinya.
   *
   * INI SATU-SATUNYA PENULIS RedemptionStatus.REFUND_DUE di seluruh repo.
   *
   * APA YANG ANDA NYATAKAN SEBAGAI OPERATOR DENGAN MENJALANKAN INI:
   *   • Anda akan MENGEMBALIKAN Rupiah ongkir user DI LUAR SISTEM (IDRX/manual). Baris ini menjadi
   *     catatan utang itu; tidak ada kode yang mengirim uangnya otomatis.
   *   • Dan itu MEMANG boleh: di READY_TO_FUND NOL USDC treasury pernah bergerak. Itu bukan
   *     kepercayaan, itu DIPERIKSA — fundingSignature WAJIB null dan refundSafe WAJIB true, dan
   *     keduanya ikut jadi PREDIKAT pada tulisan berpagar di bawah. Satu saja menyimpang → ditolak,
   *     karena itu berarti baris ini pernah menyentuh jalur pasca-danai dan Rupiah-nya TIDAK aman
   *     di-refund (rugi dobel). Kasus seperti itu diselesaikan lewat RECLAIM_DUE, bukan lewat sini.
   *
   * refundSafe TIDAK DITULIS di sini. Ia sudah true dan diverifikasi true sebagai predikat, dan
   * aturan repo ini mutlak: tidak ada satu pun tempat yang boleh MENULIS refundSafe=true.
   *
   * EFEK SAMPING YANG DISENGAJA: REFUND_DUE ada di TERMINAL_STATUSES, jadi mint-nya BEBAS lagi —
   * user bisa meminta kirim ulang (dengan invoice ongkir baru) tanpa menunggu refundnya beres.
   * BUKAN endpoint "set status apa saja": HANYA READY_TO_FUND -> REFUND_DUE, tanpa parameter
   * status, wajib beralasan, dan alasannya DITAMBAHKAN ke catatan baris (tidak menimpa).
   */
  async settleReadyToFundAsRefundDue(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan penyelesaian wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.READY_TO_FUND) {
      throw new BadRequestException(
        'Penyelesaian refund ongkir ini HANYA untuk baris READY_TO_FUND (Rupiah lunas, USDC belum ' +
          `dikirim) — status sekarang ${row.status}.`,
      );
    }
    // FAIL-CLOSED. Dua kolom jejak PASCA-danai: kalau salah satunya menyimpang, baris ini pernah
    // menyentuh jalur pendanaan dan Rupiah-nya TIDAK aman di-refund — apa pun status-nya sekarang.
    if (row.fundingSignature !== null || row.refundSafe !== true) {
      this.logger.error(
        `Penyelesaian refund redemption ${id} DITOLAK: status READY_TO_FUND tapi membawa jejak ` +
          `PASCA-danai (fundingSignature=${row.fundingSignature ?? 'null'}, ` +
          `refundSafe=${row.refundSafe}). JANGAN refund Rupiah sebelum posisi USDC dicek on-chain.`,
      );
      throw new BadRequestException(
        'Baris ini membawa jejak pendanaan USDC (fundingSignature/refundSafe). Refund Rupiah TIDAK ' +
          'aman sampai posisi USDC dicek on-chain — selesaikan lewat RECLAIM_DUE, bukan lewat rute ini.',
      );
    }

    // Order Rupiah-nya — supaya operator tahu PERSIS apa yang harus dikembalikan.
    const order = row.paymentOrderId
      ? await this.prisma.paymentOrder.findUnique({
          where: { id: row.paymentOrderId },
        })
      : await this.prisma.paymentOrder.findFirst({
          where: { redemptionId: id, packType: 'SHIPPING' },
          orderBy: { createdAt: 'desc' },
        });

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN SETTLE READY_TO_FUND->REFUND_DUE ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] ongkir Rupiah ${order?.merchantOrderId ?? 'order tidak ditemukan'} ` +
      `(Rp ${order?.priceIdr ?? '?'}) dinyatakan sebagai UTANG REFUND; nol USDC treasury pernah ` +
      `bergerak untuk baris ini. Alasan: ${reason}`;

    // Log KERAS dulu — jejaknya ada bahkan kalau tulisan DB gagal setelah ini. Catatan SEBELUMNYA
    // ikut di-log sebelum ditambahi (B2: jangan pernah menghilangkan bukti yang lama).
    this.logger.error(
      `UTANG REFUND ONGKIR redemption ${id}: READY_TO_FUND -> REFUND_DUE oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. User ${row.userId}, nft ${row.nftAddress}, order ` +
        `${order?.merchantOrderId ?? 'tidak ditemukan'} Rp ${order?.priceIdr ?? '?'}. refundSafe ` +
        `TETAP true dan fundingSignature null → Rupiah ini BENAR-BENAR aman di-refund, dan operator ` +
        `WAJIB mengembalikannya di luar sistem. CATATAN SEBELUMNYA: ${row.note ?? '(kosong)'}. ` +
        `Alasan operator: ${reason}`,
    );

    // Tulisan BERPAGAR: predikatnya mengulang KETIGA syarat uang, jadi keputusan di atas tidak bisa
    // basi karena balapan (mis. fundAndPrepare yang menang klaim READY_TO_FUND -> FUNDING).
    // refundSafe DIBACA sebagai predikat, TIDAK PERNAH ditulis.
    const moved = await this.prisma.cardRedemption.updateMany({
      where: {
        id,
        status: RedemptionStatus.READY_TO_FUND,
        fundingSignature: null,
        refundSafe: true,
      },
      data: {
        status: RedemptionStatus.REFUND_DUE,
        processedAt: new Date(),
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum penyelesaian tereksekusi (mungkin pendanaan USDC ' +
          'barusan dimulai) — muat ulang lalu cek lagi. JANGAN refund sebelum statusnya jelas.',
      );
    }

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      rupiahOrder: order
        ? {
            merchantOrderId: order.merchantOrderId,
            priceIdr: order.priceIdr,
            status: order.status,
            paidAt: order.paidAt,
          }
        : null,
      warning:
        'Baris ditandai REFUND_DUE. Di status READY_TO_FUND NOL USDC treasury pernah bergerak ' +
        '(fundingSignature null + refundSafe true — diverifikasi sebagai SYARAT, bukan diasumsikan), ' +
        'jadi ongkir Rupiah ini BENAR-BENAR aman di-refund. REFUND ITU HARUS ANDA LAKUKAN DI LUAR ' +
        'SISTEM: tidak ada kode yang mengirim uangnya otomatis. Kartunya tidak pernah dibakar dan ' +
        'mint-nya kini bebas — user boleh meminta kirim lagi dengan tagihan ongkir baru.',
    };
  }

  /**
   * B1 — JALAN KELUAR TERAKHIR untuk `AWAITING_PAYMENT`: batalkan barisnya (admin), apa pun status
   * order ongkirnya.
   *
   * KENAPA ADA, PADAHAL USER SUDAH PUNYA TOMBOL BATAL. Tombol user sengaja menolak dua status order
   * (PAID, FULFILLED) karena di sana pemenuhan otomatisnya masih hidup / sudah tuntas. Itu benar
   * untuk tombol, tapi menyisakan kasus di mana TIDAK ADA yang bisa bergerak:
   *   • user sudah pergi (ganti wallet, akun ditinggalkan) dan barisnya menahan mint selamanya;
   *   • order PAID yang IDRX-nya tidak pernah bisa diverifikasi (mis. pin tak terbaca berulang),
   *     jadi reconciler mengulang tanpa pernah konvergen.
   * Tanpa rute ini, satu-satunya pilihan manusia adalah mengedit Postgres langsung — dan itulah
   * bentuk kambuh yang sama untuk ketiga kalinya.
   *
   * PAGAR UANG (SAMA KETATNYA dengan rute admin lain):
   *   • HANYA dari AWAITING_PAYMENT. Tidak ada parameter status; tidak bisa dipakai untuk apa pun lain.
   *   • FAIL-CLOSED pada jejak PASCA-danai: fundingSignature WAJIB null dan refundSafe WAJIB true,
   *     dan keduanya ikut jadi PREDIKAT tulisan berpagar. refundSafe DIBACA, TIDAK PERNAH DITULIS.
   *   • Wajib beralasan (≥10 karakter) dan alasannya DITAMBAHKAN (bukan menimpa) ke catatan baris.
   *
   * KENAPA AMAN WALAU ONGKIRNYA SUDAH DIBAYAR: di AWAITING_PAYMENT baris redemption-nya NOL uang.
   * Utang ongkir hidup di baris PaymentOrder, dan baris itu TIDAK ikut dibatalkan —
   * `recordShippingRefundDebts` menjadikan yang macet di FULFILLING sebagai REFUND_DUE dan
   * MELAPORKAN sisanya. Hasil laporannya ikut dikembalikan di respons ini supaya operator melihat
   * PERSIS berapa Rupiah yang harus dikembalikan, bukan cuma "sudah dibatalkan".
   */
  async cancelAwaitingPayment(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan pembatalan wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.AWAITING_PAYMENT) {
      throw new BadRequestException(
        'Pembatalan ini HANYA untuk baris AWAITING_PAYMENT (tagihan ongkir terbit, baris ' +
          `redemption belum menyentuh uang) — status sekarang ${row.status}.`,
      );
    }
    // FAIL-CLOSED. Dua kolom jejak PASCA-danai: kalau salah satunya menyimpang, baris ini pernah
    // menyentuh jalur pendanaan USDC dan TIDAK boleh ditutup lewat rute pra-danai ini.
    if (row.fundingSignature !== null || row.refundSafe !== true) {
      this.logger.error(
        `Pembatalan admin redemption ${id} DITOLAK: status AWAITING_PAYMENT tapi membawa jejak ` +
          `PASCA-danai (fundingSignature=${row.fundingSignature ?? 'null'}, ` +
          `refundSafe=${row.refundSafe}). Selesaikan lewat RECLAIM_DUE, bukan lewat rute ini.`,
      );
      throw new BadRequestException(
        'Baris ini membawa jejak pendanaan USDC (fundingSignature/refundSafe) padahal statusnya ' +
          'AWAITING_PAYMENT. Jangan ditutup lewat rute ini — cek posisi USDC on-chain dulu.',
      );
    }

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN CANCEL AWAITING_PAYMENT->CANCELED ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] baris redemption nol uang; utang ongkir (bila ada) tetap ` +
      `tercatat di PaymentOrder-nya sendiri. Alasan: ${reason}`;

    // Log KERAS dulu — jejaknya ada bahkan kalau tulisan DB gagal setelah ini.
    this.logger.error(
      `PEMBATALAN ADMIN redemption ${id}: AWAITING_PAYMENT -> CANCELED oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. User ${row.userId}, nft ${row.nftAddress}. ` +
        `Mint-nya jadi BEBAS diminta kirim lagi. CATATAN SEBELUMNYA: ${row.note ?? '(kosong)'}. ` +
        `Alasan operator: ${reason}`,
    );

    // Tulisan BERPAGAR: predikatnya mengulang KETIGA syarat, jadi keputusan di atas tidak bisa basi
    // karena balapan (mis. fulfilShipping yang menang klaim AWAITING_PAYMENT -> READY_TO_FUND).
    const moved = await this.prisma.cardRedemption.updateMany({
      where: {
        id,
        status: RedemptionStatus.AWAITING_PAYMENT,
        fundingSignature: null,
        refundSafe: true,
      },
      data: {
        status: RedemptionStatus.CANCELED,
        processedAt: new Date(),
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum pembatalan tereksekusi (mungkin pembayaran ongkirnya ' +
          'barusan masuk) — muat ulang lalu cek lagi.',
      );
    }

    // PEMBUKUAN — sesudah pembatalan commit. Order ongkir yang macet di FULFILLING jadi REFUND_DUE;
    // yang lain dilaporkan apa adanya. Tidak pernah melempar.
    const shippingDebts = await recordShippingRefundDebts({
      prisma: this.prisma,
      logger: this.logger,
      redemptionId: id,
      // Rail dari kolom `listingId` (immutable), status-sebelum dari baris yang kami baca di atas
      // dan yang PREDIKAT tulisannya sudah menjamin masih AWAITING_PAYMENT saat dibatalkan.
      rail: isDomesticRedemption(row) ? 'HOSHI_DOMESTIC' : 'CC_VAULT',
      canceledFromStatus: RedemptionStatus.AWAITING_PAYMENT,
      actor: `admin ${admin.id}`,
      reason,
    });

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      /** Tagihan ongkir yang terpengaruh + aksi operatornya. [] = nol Rupiah pernah mendarat. */
      shippingDebts,
      warning:
        'Baris DIBATALKAN dan mint-nya kini bebas — user boleh meminta kirim lagi. Pembatalan ini ' +
        'TIDAK menghapus tagihan ongkirnya: periksa `shippingDebts` di respons ini. Setiap order ' +
        'yang tercatat REFUND_DUE dengan refundSafe=true WAJIB Anda kembalikan DI LUAR SISTEM — ' +
        'tidak ada kode yang mengirim uangnya otomatis.',
    };
  }

  /**
   * Ledger transaksi pembayaran (PaymentOrder) untuk admin — dipisah per jenis:
   *   • PACK        : order buka-pack gacha (listingId null)
   *   • RESELLER    : kartu yang dijual HOSHI sendiri — katalog CC maupun stok Hoshi (sellerId null)
   *   • CONSIGNMENT : kartu TITIPAN, milik ORANG LAIN, fisiknya di rak Hoshi
   *   • P2P         : beli kartu antar user
   * PaymentOrder tak punya relasi Prisma ke Listing (listingId cuma string), jadi kita join manual.
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ DUA HAL YANG DULU HILANG DI SINI, DAN KEDUANYA SOAL UANG YANG KAMI PEGANG TANPA BARANG.   ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * 1. `refundSafe` + `error` SEKARANG IKUT TERKIRIM. Status `REFUND_DUE` cuma berarti "user sudah
   *    bayar dan tidak menerima apa pun" — ia TIDAK menjawab "boleh saya transfer sekarang?".
   *    Yang menjawab itu adalah kolom `refundSafe` (lihat komentarnya di prisma/schema.prisma:
   *    "GERBANG REFUND. Gerbang refund apa pun WAJIB membaca FIELD ini"), dan yang menjelaskan APA
   *    yang terjadi adalah teks `error` yang ditulis penulis utangnya. Selama dua kolom itu tidak
   *    pernah meninggalkan backend, satu-satunya cara operator melihat gerbangnya adalah membaca
   *    log — jadi layar ini secara efektif menyajikan setiap utang sebagai "silakan refund".
   *
   *    Keduanya dikirim APA ADANYA: `error` TIDAK dipotong/diperhalus di sini (teksnya ditulis
   *    justru supaya dibaca manusia), dan `refundSafe` TIDAK PERNAH diturunkan ulang dari status
   *    atau dari teks — ia disalin dari baris.
   *
   * 2. JENISNYA DIJAWAB `listingKindOf`, BUKAN `sellerId != null`. Kartu titipan WAJIB punya
   *    `sellerId` (kalau tidak, tidak ada siapa pun yang bisa dikredit saat terjual), jadi predikat
   *    bentuk lama menelan SETIAP penjualan titipan dan melabelinya "P2P" — persis jebakan yang
   *    didokumentasikan src/common/listing-kind.ts. Akibatnya di layar ini bukan sekadar label
   *    salah: utang titipan yang hilang sesudah terjual (refundSafe=false, KERUGIAN Hoshi, bukan
   *    pengembalian uang yang kami pegang) terbaca sebagai transaksi P2P biasa.
   */
  async listTransactions(query: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? 30), 100);
    const where: Prisma.PaymentOrderWhereInput = {};
    if (query.status && query.status in PaymentStatus) {
      where.status = query.status as PaymentStatus;
    }
    const [orders, total] = await Promise.all([
      this.prisma.paymentOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.paymentOrder.count({ where }),
    ]);

    const listingIds = [
      ...new Set(
        orders.map((o) => o.listingId).filter((x): x is string => !!x),
      ),
    ];
    const buyerIds = [...new Set(orders.map((o) => o.userId))];
    const [listings, buyers] = await Promise.all([
      listingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: listingIds } },
            select: {
              id: true,
              name: true,
              sellerId: true,
              sellerAddress: true,
              source: true,
              // Dua kolom ini ADA HANYA untuk memberi makan `listingKindOf`: `consignmentId`
              // adalah FAKTA yang membedakan titipan dari P2P, dan `sellable` adalah syarat
              // ketiga `isHoshiSellableStock`. Jangan dihapus "karena tidak dipakai di output".
              consignmentId: true,
              sellable: true,
            },
          })
        : Promise.resolve(
            [] as {
              id: string;
              name: string;
              sellerId: string | null;
              sellerAddress: string;
              source: ListingSource;
              consignmentId: string | null;
              sellable: boolean;
            }[],
          ),
      this.prisma.user.findMany({
        where: { id: { in: buyerIds } },
        select: { id: true, walletAddress: true, displayName: true },
      }),
    ]);
    const sellerIds = [
      ...new Set(
        listings.map((l) => l.sellerId).filter((x): x is string => !!x),
      ),
    ];
    const sellers = sellerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, walletAddress: true, displayName: true },
        })
      : [];
    const listingMap = new Map(listings.map((l) => [l.id, l]));
    const buyerMap = new Map(buyers.map((u) => [u.id, u]));
    const sellerMap = new Map(sellers.map((u) => [u.id, u]));
    const label = (
      u?: { walletAddress: string; displayName: string | null } | null,
    ): string | null =>
      u ? (u.displayName ?? shortWalletLabel(u.walletAddress)) : null;

    const data = orders.map((o) => {
      const listing = o.listingId ? listingMap.get(o.listingId) : null;
      // Jenisnya DITANYAKAN ke helper kanonik, bukan ditebak ulang dari bentuk baris. Empat kind
      // dipetakan ke tiga label ledger: CC_CATALOG/HOSHI_STOCK/NOT_SELLABLE semuanya "dijual
      // Hoshi sendiri" (tidak ada penjual user yang harus dikredit), jadi mereka satu ember.
      const kind = listing ? listingKindOf(listing) : null;
      const type: AdminTransactionType = !o.listingId
        ? 'PACK'
        : kind === 'CONSIGNMENT'
          ? 'CONSIGNMENT'
          : // `kind === null` = baris listing-nya sudah tidak ada. Label warisannya 'P2P' dan itu
            // TETAP AMAN untuk pertanyaan yang layar ini urus: `deleteListing` MENOLAK baris
            // ber-consignmentId (lihat penolakannya di bawah), jadi baris yatim TIDAK PERNAH
            // titipan. Yang hilang cuma bisa listing user atau stok Hoshi.
            kind === 'USER_P2P' || kind === null
            ? 'P2P'
            : 'RESELLER';
      // "Vault" ala model PM: CC vault (kartu CC, harga default, Hoshi 0% margin) vs Hoshi vault
      // (Hoshi ambil 5% / stok Hoshi sendiri). RESELLER katalog CC = CC vault; RESELLER stok Hoshi
      // (source ≠ COLLECTORCRYPT) & P2P antar user = Hoshi vault; PACK/TOPUP bukan kartu vault.
      //
      // TITIPAN DISEBUT EKSPLISIT, DAN ITU BUKAN KERAPIAN. Di layar ini `vault` menjawab "SIAPA
      // yang mengirim barangnya" (dashboard menulisnya sebagai "Kirim oleh: CollectorCrypt (gudang
      // US)" / "Hoshi"). Kartu titipan SELALU dikirim Hoshi — fisiknya ada di rak Hoshi, itu
      // definisi custody-nya. Dulu ia kebetulan benar karena jatuh ke cabang P2P; begitu jenisnya
      // diperbaiki ia akan jatuh ke cabang terakhir dan membaca `source`, yang cuma LABEL dan
      // BUKAN FAKTA (admin bisa mengubahnya). Satu baris titipan ber-`source=COLLECTORCRYPT` akan
      // menyuruh operator menunggu paket dari gudang di Amerika untuk kartu yang ada di rak
      // sebelahnya. Maka jawabannya diambil dari JENISNYA, bukan dari labelnya.
      const vault: 'CC' | 'HOSHI' | null =
        type === 'PACK'
          ? null
          : type === 'P2P' || type === 'CONSIGNMENT'
            ? 'HOSHI'
            : listing?.source === ListingSource.COLLECTORCRYPT
              ? 'CC'
              : 'HOSHI';
      const seller = listing?.sellerId ? sellerMap.get(listing.sellerId) : null;
      return {
        id: o.id,
        merchantOrderId: o.merchantOrderId,
        type,
        vault,
        status: o.status,
        priceIdr: o.priceIdr,
        item: listing?.name ?? (type === 'PACK' ? o.packType : null),
        buyer: label(buyerMap.get(o.userId)) ?? o.userId,
        // Baris titipan IKUT membawa penjualnya: yang tertulis di sana adalah PEMILIK KARTU, dan
        // pada utang titipan-hilang dialah orang yang payout-nya sudah terlanjur cair.
        seller:
          type === 'RESELLER'
            ? 'Hoshi'
            : type === 'P2P' || type === 'CONSIGNMENT'
              ? (label(seller) ?? listing?.sellerAddress ?? null)
              : null,
        /**
         * GERBANG UANG, disalin apa adanya dari baris. false = JANGAN transfer sebelum
         * diverifikasi di luar sistem (on-chain / dashboard IDRX). Tidak pernah diturunkan dari
         * `status` dan tidak pernah dari `error`.
         */
        refundSafe: o.refundSafe,
        /** Teks alasan APA ADANYA — satu-satunya yang menjelaskan APA yang sebenarnya terjadi. */
        error: o.error,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        fulfilledAt: o.fulfilledAt,
      };
    });
    return { data, total, page, limit };
  }

  /**
   * Ringkasan keuangan untuk admin: pemasukan dipisah per RAIL, TOTAL KEWAJIBAN (saldo penjual
   * yang belum ditarik = utang Hoshi), + daftar saldo tiap penjual. Treasury on-chain & "profit
   * yang aman ditarik" (treasury − kewajiban) dihitung di controller (yang punya akses gacha).
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ EMPAT EMBER, BUKAN TIGA — dan ember keempat adalah SATU-SATUNYA yang komisinya milik Hoshi.║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Ringkasan ini LEBIH TUA dari `src/common/listing-kind.ts`, dan itu persis yang membuatnya
   * salah: ember `p2p` dulu berbunyi `sellerId: { not: null }` — BENTUK YANG SAMA PERSIS dengan
   * baris listing TITIPAN, yang memang wajib punya `sellerId` (kalau tidak, tidak ada siapa pun
   * yang bisa dikredit). Jadi SETIAP penjualan titipan dilaporkan sebagai P2P, dan komisi 5% —
   * seluruh model bisnis kustodi ini — tidak punya satu baris pun di layar mana pun. Sekarang
   * kedua ember memakai `nonConsignedListingWhere()` / kolom yang dicatat settlement, jadi yang
   * memisahkan keduanya adalah SATU definisi, bukan dua bentuk yang kebetulan mirip.
   *
   * ── DARI MANA ANGKA KOMISINYA DATANG, dan kenapa BUKAN dari harga listing ──────────────────
   *
   * `Consignment.commissionIdrx` / `payoutIdrx` ditulis oleh `PaymentsService.fulfilConsignment`
   * di dalam transaksi settlement, dari `commissionBps` yang DI-SNAPSHOT saat perjanjian
   * ditandatangani dan dari harga yang pembeli BENAR-BENAR bayar. Menghitung ulang 5% dari
   * `listing.priceIdrx` di sini akan salah pada dua hal sekaligus: harga listing bisa diubah
   * admin SESUDAH invoice terbit, dan bps-nya bisa berbeda per titipan. Yang dilaporkan adalah
   * yang TERCATAT, bukan yang diperkirakan ulang.
   *
   * PREDIKATNYA `commissionIdrx: { not: null }`, BUKAN `status: SOLD` — dan itu bukan selera:
   * titipan yang sudah terjual LALU DIKIRIM ke pembelinya berpindah ke RELEASED, dan yang
   * ditandai hilang sesudah terjual berpindah ke LOST. Memfilter dengan `status: SOLD` akan
   * MENJATUHKAN penjualan-penjualan itu dari laporan — tepat penjualan yang sudah paling tuntas.
   */
  async financeSummary() {
    const [
      resellerAgg,
      hoshiInvAgg,
      p2pAgg,
      consignmentAgg,
      sellers,
      pendingWdAgg,
    ] = await Promise.all([
        // Reseller = Hoshi jual kartu KATALOG CC (source COLLECTORCRYPT, tanpa penjual user).
        this.prisma.listing.aggregate({
          where: {
            status: ListingStatus.SOLD,
            sellerId: null,
            source: ListingSource.COLLECTORCRYPT,
          },
          _sum: { priceIdrx: true },
          _count: true,
        }),
        // Inventaris Hoshi = Hoshi jual kartu SENDIRI (source HOSHI, tanpa penjual user).
        // Seluruh omzet = pendapatan Hoshi (bukan modal CC, bukan titipan penjual).
        this.prisma.listing.aggregate({
          where: {
            status: ListingStatus.SOLD,
            sellerId: null,
            source: ListingSource.HOSHI,
          },
          _sum: { priceIdrx: true },
          _count: true,
        }),
        // P2P = listing milik USER. `nonConsignedListingWhere()` WAJIB ada di sini: tanpa itu,
        // setiap kartu TITIPAN (yang juga ber-sellerId) ikut terhitung sebagai P2P. Lihat
        // paragraf "EMPAT EMBER" di atas.
        this.prisma.listing.aggregate({
          where: {
            status: ListingStatus.SOLD,
            sellerId: { not: null },
            ...nonConsignedListingWhere(),
          },
          _sum: { priceIdrx: true },
          _count: true,
        }),
        // TITIPAN = kartu ORANG LAIN yang fisiknya di rak Hoshi. Yang menjadi PENDAPATAN HOSHI
        // di sini BUKAN omzetnya melainkan KOMISINYA; sisanya utang ke pemilik kartu dan sudah
        // masuk `liabilitiesIdr` lewat saldo penjual. Dibaca dari kolom yang DITULIS settlement.
        this.prisma.consignment.aggregate({
          where: { commissionIdrx: { not: null } },
          _sum: { commissionIdrx: true, payoutIdrx: true },
          _count: true,
        }),
      this.prisma.user.findMany({
        where: { balanceIdrx: { gt: 0 } },
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          balanceIdrx: true,
        },
        orderBy: { balanceIdrx: 'desc' },
      }),
      // Penarikan REQUESTED = saldo SUDAH di-debit (keluar dari balanceIdrx) tapi payout BELUM
      // keluar treasury → kewajiban yang tak tercermin di balanceIdrx maupun treasury. WAJIB dihitung,
      // kalau tidak "profit aman ditarik" over-stated & treasury bisa kurang saat payout dicairkan.
      this.prisma.withdrawal.aggregate({
        where: { status: WithdrawalStatus.REQUESTED },
        _sum: { amountIdr: true },
        _count: true,
      }),
    ]);
    const sellerBalances = sellers.map((u) => ({
      id: u.id,
      wallet: u.walletAddress,
      label: u.displayName ?? shortWalletLabel(u.walletAddress),
      balanceIdr: Number(u.balanceIdrx),
    }));
    const liabilitiesIdr = sellerBalances.reduce(
      (s, u) => s + u.balanceIdr,
      0,
    );
    const pendingWithdrawalsIdr = Number(pendingWdAgg._sum.amountIdr ?? 0n);
    return {
      reseller: {
        count: resellerAgg._count,
        grossIdr: resellerAgg._sum.priceIdrx ?? 0,
      },
      hoshiInventory: {
        count: hoshiInvAgg._count,
        grossIdr: hoshiInvAgg._sum.priceIdrx ?? 0,
      },
      p2p: { count: p2pAgg._count, grossIdr: p2pAgg._sum.priceIdrx ?? 0 },
      /**
       * TITIPAN. `commissionIdr` adalah SATU-SATUNYA bagian yang menjadi pendapatan Hoshi;
       * `payoutIdr` sudah menjadi saldo pemilik kartu, jadi ia ADA DI `liabilitiesIdr` sampai
       * ditarik. `grossIdr` = keduanya dijumlahkan = yang pembeli bayar di luar fee QRIS.
       */
      consignment: {
        count: consignmentAgg._count,
        grossIdr:
          (consignmentAgg._sum.commissionIdrx ?? 0) +
          (consignmentAgg._sum.payoutIdrx ?? 0),
        commissionIdr: consignmentAgg._sum.commissionIdrx ?? 0,
        payoutIdr: consignmentAgg._sum.payoutIdrx ?? 0,
      },
      liabilitiesIdr,
      pendingWithdrawalsIdr,
      pendingWithdrawalsCount: pendingWdAgg._count,
      sellerCount: sellerBalances.length,
      sellerBalances,
    };
  }

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ LAYAR INI MENCAMPUR STOK HOSHI DENGAN BARANG ORANG LAIN — jadi ia WAJIB mengatakannya.   ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `Listing.consignmentId` sudah ikut terbawa (tidak ada `select` yang menyaringnya), tapi
   * tanpa NAMA PEMILIKNYA badge di layar cuma bisa berbunyi "titipan" tanpa menyebut titipan
   * SIAPA — dan operator yang tidak tahu kartu siapa yang dipegangnya adalah operator yang
   * menekan Deactivate/Delete tanpa rasa takut. `consignorNameAtIntake` adalah SNAPSHOT saat
   * serah-terima (lihat schema), jadi ia tetap benar meski nama akunnya berubah kemudian.
   *
   * `askPriceIdr` ikut DENGAN SENGAJA: itu harga dasar yang DISEPAKATI pemiliknya. Layar yang
   * menampilkan `priceIdrx` sendirian tidak bisa memperlihatkan kalau keduanya sudah menyimpang.
   */
  async listListings(query: QueryAdminListingsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ListingWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.vault) where.vaultLocation = query.vault;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sellerAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const orderBy: Prisma.ListingOrderByWithRelationInput =
      query.sort === 'price-asc'
        ? { priceIdrx: 'asc' }
        : query.sort === 'price-desc'
          ? { priceIdrx: 'desc' }
          : { listedAt: 'desc' };
    const [data, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          nft: true,
          // null ⇔ baris ini BUKAN titipan. Relasi 1-1, jadi nol query tambahan.
          consignment: {
            select: {
              id: true,
              status: true,
              consignorNameAtIntake: true,
              askPriceIdr: true,
            },
          },
        },
      }),
      this.prisma.listing.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Distinct, non-empty vault locations across all listings — powers the admin
   *  "filter by vault" dropdown. Sorted alphabetically for a stable menu. */
  async listVaults(): Promise<string[]> {
    const rows = await this.prisma.listing.findMany({
      where: { vaultLocation: { not: null } },
      distinct: ['vaultLocation'],
      select: { vaultLocation: true },
      orderBy: { vaultLocation: 'asc' },
    });
    return rows
      .map((r) => r.vaultLocation)
      .filter((v): v is string => !!v && v.trim().length > 0);
  }

  async getListing(id: string) {
    const row = await this.prisma.listing.findUnique({
      where: { id },
      include: { nft: true },
    });
    if (!row) throw new NotFoundException('Listing not found.');
    return row;
  }

  async createListing(dto: AdminCreateListingDto) {
    const row = await this.prisma.listing.create({
      data: {
        name: dto.name,
        set: dto.set,
        rarity: dto.rarity,
        image: dto.image,
        imageBack: dto.imageBack,
        priceIdrx: dto.price,
        expectedValueIdrx: dto.expectedValue,
        buybackIdrx: dto.buyback ?? 0,
        grade: dto.grade,
        grader: dto.grader,
        gradeScore: dto.gradeScore,
        language: dto.language,
        era: dto.era,
        element: dto.element,
        category: dto.category,
        sellerAddress: dto.sellerAddress ?? 'admin',
        // Stok Hoshi genuine yang di-upload admin → boleh dijual (jalur Hoshi-inventory). Seed
        // chart-filler TIDAK lewat sini, jadi tetap sellable=false (tak bisa dibeli).
        sellable: true,
        certificate: dto.certificate,
        vaultLocation: dto.vaultLocation,
        cardNumber: dto.cardNumber,
        variant: dto.variant,
        priceHistory: dto.priceHistory ?? [dto.expectedValue, dto.price],
        offers: [],
      },
      include: { nft: true },
    });
    return row;
  }

  /**
   * Field yang MILIK CollectorCrypt pada listing hasil sync: nilainya di-refresh
   * setiap re-sync, jadi edit admin di sini pasti tertimpa lagi — lebih jujur
   * menolaknya dengan 400 daripada menerima edit yang umurnya sampai sync
   * berikutnya. Model bisnisnya "kita hanya edit harga di atas katalog mereka":
   * price / expectedValue / buyback / priceHistory tetap boleh.
   */
  private static readonly CC_LOCKED_FIELDS = [
    'name',
    'set',
    'rarity',
    'image',
    'imageBack',
    'grade',
    'grader',
    'gradeScore',
    'language',
    'era',
    'element',
    'category',
    'certificate',
    'vaultLocation',
    'cardNumber',
    'variant',
    'contractAddress',
  ] as const satisfies readonly (keyof AdminUpdateListingDto)[];

  /**
   * Field EKONOMI pada baris listing: angka yang menentukan berapa Rupiah yang berpindah.
   *
   * Untuk kartu TITIPAN ketiganya punya kembaran di `Consignment` (`askPriceIdr` + `ConsignmentEvent`)
   * yang TIDAK ikut berubah kalau ditulis dari sini — lihat gerbang di `updateListing`.
   */
  private static readonly CONSIGNMENT_ECONOMIC_FIELDS = [
    'price',
    'expectedValue',
    'buyback',
  ] as const satisfies readonly (keyof AdminUpdateListingDto)[];

  async updateListing(id: string, dto: AdminUpdateListingDto) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ HARGA KARTU TITIPAN TIDAK BOLEH BERUBAH DARI SINI — DAN ITU BUKAN SOAL IZIN.        ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    //
    // Tulisan di bawah cuma menyentuh `priceIdrx`. Untuk baris titipan itu berarti tiga hal yang
    // semuanya tidak terlihat di layar ini: `Consignment.askPriceIdr` — harga yang DISEPAKATI
    // pemiliknya — tetap seperti semula, NOL baris `ConsignmentEvent` lahir sehingga pemiliknya
    // tidak punya satu pun jejak untuk dibaca, dan harga dasar (reserve) yang ia setujui tidak
    // pernah diperiksa. Karena payout dihitung dari harga yang pembeli BENAR-BENAR bayar, sebuah
    // ketikan di sini mengkredit pemilik kartu dari angka yang tidak pernah ia setujui.
    //
    // Rute yang benar menulis KEDUANYA dalam satu transaksi + satu event ber-aktor.
    const economic = AdminService.CONSIGNMENT_ECONOMIC_FIELDS.filter(
      (field) => dto[field] !== undefined,
    );
    if (isConsignedListing(existing) && economic.length > 0) {
      consignmentUnsupported(
        `Kartu ini TITIPAN — miliknya orang lain, fisiknya dititipkan ke rak Hoshi. Harga kartu ` +
          `titipan tidak bisa diubah dari layar listing (field: ${economic.join(', ')}): ` +
          `tulisan di sini hanya mengubah harga pajangan, sementara harga yang DISEPAKATI ` +
          `pemiliknya (Consignment.askPriceIdr) tetap seperti semula dan tidak ada satu pun ` +
          `catatan riwayat yang lahir. Pakai PATCH /admin/consignments/${existing.consignmentId ?? ':id'}/price ` +
          `(layar /admin/titipan): rute itu menulis harga pajangan DAN harga kesepakatan dalam ` +
          `satu transaksi, memeriksa harga dasar yang disetujui pemiliknya, dan meninggalkan ` +
          `satu baris ConsignmentEvent yang bisa dibaca pemiliknya sendiri.`,
        id,
      );
    }
    if (existing.source === ListingSource.COLLECTORCRYPT) {
      const locked = AdminService.CC_LOCKED_FIELDS.filter(
        (field) => dto[field] !== undefined,
      );
      if (locked.length > 0) {
        throw new BadRequestException(
          `Listing ini hasil sync CollectorCrypt — metadata milik mereka dan akan ` +
            `ditimpa re-sync. Field terkunci: ${locked.join(', ')}. ` +
            `Yang bisa diedit: price, expectedValue, buyback, priceHistory.`,
        );
      }
    }
    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.set !== undefined && { set: dto.set }),
        ...(dto.rarity !== undefined && { rarity: dto.rarity }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.imageBack !== undefined && { imageBack: dto.imageBack }),
        ...(dto.price !== undefined && { priceIdrx: dto.price }),
        ...(dto.expectedValue !== undefined && {
          expectedValueIdrx: dto.expectedValue,
        }),
        ...(dto.buyback !== undefined && { buybackIdrx: dto.buyback }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
        ...(dto.grader !== undefined && { grader: dto.grader }),
        ...(dto.gradeScore !== undefined && { gradeScore: dto.gradeScore }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.era !== undefined && { era: dto.era }),
        ...(dto.element !== undefined && { element: dto.element }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.certificate !== undefined && { certificate: dto.certificate }),
        ...(dto.vaultLocation !== undefined && {
          vaultLocation: dto.vaultLocation,
        }),
        ...(dto.cardNumber !== undefined && { cardNumber: dto.cardNumber }),
        ...(dto.variant !== undefined && { variant: dto.variant }),
        ...(dto.contractAddress !== undefined && {
          contractAddress: dto.contractAddress,
        }),
        ...(dto.priceHistory !== undefined && {
          priceHistory: dto.priceHistory,
        }),
      },
      include: { nft: true },
    });
  }

  /**
   * Activate / deactivate a listing (ACTIVE ⇄ CANCELLED). Deactivating just hides
   * it from the marketplace; the row and its data stay intact, so it can be
   * re-activated later — unlike deleteListing which removes it.
   *
   * A SOLD listing is off-limits: it changed hands via a purchase (buyer set), so
   * flipping it back to ACTIVE would re-list a card that is no longer ours to sell.
   */
  async setListingStatus(id: string, status: 'ACTIVE' | 'CANCELLED') {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ MENURUNKAN LISTING TITIPAN DARI SINI MEMBELAH SATU KARTU JADI DUA KEBENARAN.        ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    //
    // Tulisan di bawah hanya menyentuh `Listing.status`. Baris `Consignment`-nya TETAP LISTED,
    // dan dari situ dua kegagalan terbit sekaligus:
    //   • Order yang SUDAH terbit tetap bisa dibayar. Saat callback-nya mendarat, klaim
    //     settlement menuntut listing `status: ACTIVE` → cocok NOL baris → pembeli membayar dan
    //     tidak menerima apa pun.
    //   • Pemilik menekan "minta kartu saya kembali" → `takeDown` cabang LISTED menemukan
    //     listing yang sudah CANCELLED dan gagal di klaimnya sendiri.
    // Rute yang benar menurunkan listing DAN mengembalikan titipannya ke IN_CUSTODY dalam SATU
    // transaksi, plus satu baris ConsignmentEvent yang bisa dibaca pemilik kartunya.
    if (isConsignedListing(existing)) {
      consignmentUnsupported(
        'Kartu ini TITIPAN — miliknya orang lain, fisiknya dititipkan ke rak Hoshi. ' +
          'Mengaktifkan/menonaktifkan pajangannya dari layar listing hanya mengubah baris ' +
          'listing, sementara catatan titipannya tetap berstatus LISTED — pembeli yang sudah ' +
          'memegang tagihan tetap bisa membayar dan tidak akan menerima apa pun, dan permintaan ' +
          'tarik dari pemiliknya akan menabrak keadaan yang tidak konsisten. ' +
          `Turunkan pajangannya lewat POST /admin/consignments/${existing.consignmentId ?? ':id'}/withdraw ` +
          '(layar /admin/titipan) — rute itu menurunkan listing dan mengembalikan titipannya ke ' +
          'IN_CUSTODY dalam satu transaksi, dan meninggalkan jejak audit yang pemiliknya sendiri ' +
          'bisa baca. Untuk memajangnya kembali: POST /admin/consignments/:id/listing.',
        id,
      );
    }
    if (existing.status === ListingStatus.SOLD) {
      throw new BadRequestException(
        'Listing yang sudah SOLD tidak bisa diaktifkan/nonaktifkan.',
      );
    }
    return this.prisma.listing.update({
      where: { id },
      data: { status: status },
      include: { nft: true },
    });
  }

  /**
   * Impor massal stok Hoshi (CSV/JSON dari dashboard admin).
   *
   * ┌──── KENAPA `sellable: true` DI SINI (dan kenapa ketiadaannya adalah BUG) ─────────────┐
   * │ Rute ini dan `createListing` dijaga AdminGuard yang SAMA, jadi keduanya membawa       │
   * │ kepercayaan yang sama: seorang admin yang meng-upload 200 kartu MENYATAKAN kartu itu   │
   * │ stok fisik Hoshi yang dijual. Tanpa flag ini barisnya default `sellable=false`, dan    │
   * │ SETIAP jalur billing menolaknya (payments.service: jalur Hoshi-inventory mewajibkan    │
   * │ `listing.sellable === true`). Hasilnya: 200 kartu terpajang, nol Rupiah bisa masuk,    │
   * │ DIAM-DIAM — tanpa satu pun pesan yang menjelaskan kenapa.                              │
   * │                                                                                       │
   * │ Ini TIDAK melonggarkan gerbangnya: default `false` ada untuk baris SEED/CHART-FILLER   │
   * │ yang tidak pernah lewat rute ber-AdminGuard sama sekali. Baris seperti itu tetap       │
   * │ tidak bisa dibeli maupun diminta kirim. Baris yang SUDAH terlanjur diimpor sebelum     │
   * │ perbaikan ini dinaikkan lewat `setListingsSellable` (eksplisit, per-id).               │
   * └───────────────────────────────────────────────────────────────────────────────────────┘
   */
  async importListings(dto: ImportListingsDto) {
    const seller = dto.sellerOverride ?? 'admin';
    const items = dto.items.map((item) => ({
      name: item.name,
      set: item.set,
      rarity: item.rarity,
      image: item.image,
      priceIdrx: item.price,
      expectedValueIdrx: item.expectedValue ?? item.price,
      buybackIdrx: item.buyback ?? 0,
      grade: item.grade,
      grader: item.grader,
      gradeScore: item.gradeScore,
      language: item.language ?? 'EN',
      era: item.era ?? '',
      element: item.element ?? '',
      category: item.category ?? '',
      sellerAddress: seller,
      // Stok Hoshi genuine yang di-upload admin → boleh dijual (jalur Hoshi-inventory), SAMA
      // seperti createListing. Lihat blok panjang di atas method ini.
      sellable: true,
      certificate: item.certificate,
      vaultLocation: item.vaultLocation,
      cardNumber: item.cardNumber,
      variant: item.variant,
      priceHistory: [item.expectedValue ?? item.price, item.price],
      offers: [],
    }));
    const created = await this.prisma.$transaction(
      items.map((data) =>
        this.prisma.listing.create({ data, include: { nft: true } }),
      ),
    );
    return { imported: created.length, items: created };
  }

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════╗
   * ║ A — PERBAIKAN DATA: naikkan/turunkan flag `sellable` pada baris yang SUDAH ADA.      ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════╝
   *
   * MASALAHNYA. Baris yang diimpor SEBELUM `importListings` menulis `sellable: true` tetap
   * tidak bisa dibeli SELAMANYA, dan sebelum rute ini tidak ada satu pun kontrol untuk
   * memperbaikinya (`updateListing` tidak menyentuh flag itu) — jalan keluarnya cuma mengedit
   * Postgres langsung.
   *
   * ┌──── KENAPA PER-ID DAN BUKAN "jadikan semuanya sellable" ──────────────────────────────┐
   * │ Seluruh GUNA flag ini adalah menahan baris seed/placeholder. Dan bentuk baris seed
   * │ IDENTIK dengan bentuk stok sungguhan: `source=HOSHI` + `sellerId=null` adalah bentuk
   * │ DEFAULT setiap listing. Artinya TIDAK ADA predikat otomatis yang bisa membedakan
   * │ "kartu fisik yang benar-benar ada di rak" dari "chart filler" — hanya manusia yang
   * │ tahu. Sebuah sapuan massal karena itu akan membuka kembali persis bahaya yang
   * │ defaultnya `false` diciptakan untuk menutup: pembeli membayar Rupiah untuk kartu hantu.
   * │
   * │ Maka: daftar id EKSPLISIT, dibatasi 500 per panggilan, setiap perubahan DI-LOG dengan
   * │ id admin-nya, dan operator diharapkan MEMBACA dulu lewat `listUnsellableStock()` /
   * │ query SQL yang didokumentasikan di sana.
   * └──────────────────────────────────────────────────────────────────────────────────────┘
   *
   * PAGAR BENTUK (ditegakkan sebagai PREDIKAT pada tulisannya, bukan cuma dibaca):
   *   • source != COLLECTORCRYPT — baris katalog CC bukan stok kita; fisiknya di gudang CC.
   *   • sellerId = null         — listing milik user lain tidak pernah jadi "stok Hoshi".
   *   • status = ACTIVE         — baris SOLD/CANCELLED tidak perlu (dan tidak boleh) diubah:
   *     SOLD berarti sudah berpindah tangan, dan menaikkan flag di sana hanya mengaburkan
   *     riwayat. Baris SOLD yang lolos jalur beli lain tetap bisa dikirim lewat jalur CC.
   *
   * REVERSIBEL DENGAN SENGAJA (`sellable: false` juga diterima): kalau operator salah menandai
   * satu baris, ia harus bisa menurunkannya lagi SEBELUM ada yang membelinya — tanpa itu satu
   * salah klik jadi permanen.
   */
  async setListingsSellable(
    ids: string[],
    sellable: boolean,
    admin: { id: string; walletAddress: string },
  ) {
    const unique = [...new Set((ids ?? []).map((v) => (v ?? '').trim()))].filter(
      (v) => v.length > 0,
    );
    if (unique.length === 0) {
      throw new BadRequestException(
        'Sebutkan minimal satu id listing. Rute ini SENGAJA tidak punya mode "semua baris".',
      );
    }
    if (unique.length > 500) {
      throw new BadRequestException(
        `Maksimal 500 id per panggilan (diberikan ${unique.length}). Pecah jadi beberapa batch.`,
      );
    }

    // Baris yang BENAR-BENAR akan berubah — dibaca DULU supaya responsnya bisa menyebut mana
    // yang dilewati dan KENAPA, bukan cuma mengembalikan sebuah angka.
    const eligible = await this.prisma.listing.findMany({
      where: {
        id: { in: unique },
        source: { not: ListingSource.COLLECTORCRYPT },
        sellerId: null,
        status: ListingStatus.ACTIVE,
      },
      select: {
        id: true,
        name: true,
        priceIdrx: true,
        sellable: true,
        source: true,
        status: true,
      },
    });
    const eligibleIds = new Set(eligible.map((r) => r.id));
    const skipped = unique.filter((id) => !eligibleIds.has(id));

    // Tulisan BERPAGAR: predikatnya mengulang SELURUH pagar bentuk, jadi keputusan di atas
    // tidak bisa basi karena balapan (mis. baris terjual tepat di antara baca dan tulis).
    const changed = await this.prisma.listing.updateMany({
      where: {
        id: { in: [...eligibleIds] },
        source: { not: ListingSource.COLLECTORCRYPT },
        sellerId: null,
        status: ListingStatus.ACTIVE,
        sellable: !sellable,
      },
      data: { sellable },
    });

    this.logger.warn(
      `ADMIN sellable=${sellable} oleh ${admin.id} (${admin.walletAddress}): ` +
        `${changed.count} baris diubah dari ${unique.length} id yang diminta ` +
        `(dilewati: ${skipped.length}). Ids diubah: ${[...eligibleIds].join(', ') || '(tidak ada)'}. ` +
        (sellable
          ? 'Baris ini SEKARANG BISA DIBELI — pastikan kartunya benar-benar ada di rak.'
          : 'Baris ini sekarang TIDAK bisa dibeli lagi.'),
    );

    // B4 — BEDAKAN "tidak berubah karena sudah benar" dari "tidak berubah karena ditolak pagar".
    // Tanpa ini sebuah UI hanya melihat `changed: 0` dan tidak bisa tahu apakah panggilannya
    // sukses-idempoten atau gagal diam-diam — dan retry pun jadi menakutkan.
    const alreadyCorrect = eligible
      .filter((r) => r.sellable === sellable)
      .map((r) => r.id);

    return {
      requested: unique.length,
      changed: changed.count,
      /** Baris yang cocok pagar bentuk (termasuk yang flag-nya sudah sesuai → tidak ikut diubah). */
      eligible,
      /**
       * Id yang memenuhi pagar bentuk TAPI flag-nya SUDAH sama dengan yang diminta. Ini yang
       * membuat rute ini aman di-retry: memanggilnya dua kali dengan body yang sama menghasilkan
       * `changed: 0` + id-nya di sini, BUKAN error dan bukan perubahan kedua.
       */
      alreadyCorrect,
      /** Id yang TIDAK memenuhi pagar bentuk (tidak ada, katalog CC, listing user, atau bukan ACTIVE). */
      skipped,
      warning:
        sellable
          ? 'Baris yang diubah kini BISA DIBELI pembeli. Flag ini satu-satunya yang menahan ' +
            'baris seed/placeholder agar tidak bisa dibeli — jangan pernah menaikkannya untuk ' +
            'baris yang kartunya tidak benar-benar ada di rak Hoshi.'
          : 'Baris yang diubah kini TIDAK bisa dibeli. Order yang sudah PENDING untuk baris itu ' +
            'akan gagal di settlement dan perlu di-refund manual — cek /admin/transactions.',
    };
  }

  /**
   * READ-ONLY: stok Hoshi yang TIDAK bisa dibeli karena `sellable=false`. Inilah permukaan yang
   * dulu tidak ada sama sekali — 200 kartu terpajang, nol Rupiah masuk, dan tidak ada apa pun di
   * dashboard yang menjelaskan kenapa.
   *
   * BACA INI DULU sebelum memanggil setListingsSellable. Query SQL yang setara (untuk dijalankan
   * langsung di Postgres kalau lebih enak):
   *
   *   SELECT id, name, "priceIdrx", status, source, "sellerId", "listedAt"
   *   FROM "listings"
   *   WHERE sellable = false
   *     AND source <> 'COLLECTORCRYPT'
   *     AND "sellerId" IS NULL
   *     AND status = 'ACTIVE'
   *   ORDER BY "listedAt" DESC;
   *
   * Hasilnya mencampur stok sungguhan dengan baris seed/chart-filler — MEMANG TIDAK BISA
   * dibedakan otomatis (bentuknya identik). Operator yang memutuskan baris mana yang nyata.
   */
  async listUnsellableStock(limit = 200, offset = 0) {
    // Angka dari query string bisa berbentuk apa saja (NaN, negatif, 1e9). Dijepit DI SINI supaya
    // rute ini aman dipanggil UI berulang kali tanpa bisa menarik seluruh tabel sekaligus.
    const take = Math.min(Math.max(Math.trunc(limit) || 200, 1), 1000);
    const skip = Math.max(Math.trunc(offset) || 0, 0);
    const where: Prisma.ListingWhereInput = {
      sellable: false,
      source: { not: ListingSource.COLLECTORCRYPT },
      sellerId: null,
      status: ListingStatus.ACTIVE,
    };
    const [data, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy: { listedAt: 'desc' },
        take,
        skip,
        select: {
          id: true,
          name: true,
          set: true,
          priceIdrx: true,
          status: true,
          source: true,
          sellable: true,
          vaultLocation: true,
          listedAt: true,
        },
      }),
      this.prisma.listing.count({ where }),
    ]);

    // B4 — daftar KOSONG di sini artinya "tidak ada yang tertahan", jadi `actionRequired` yang
    // kosong memang benar. Yang TIDAK boleh terjadi adalah sebaliknya: ratusan baris tertahan dan
    // dashboard tidak mengatakan apa-apa karena ia cuma merender tabel.
    const actionRequired: string[] =
      total > 0
        ? [
            `${total} listing stok Hoshi TIDAK BISA DIBELI (sellable=false) — nol Rupiah bisa ` +
              'masuk untuk kartu-kartu itu. Tandai baris yang kartunya BENAR-BENAR ada di rak ' +
              'lewat POST /admin/listings/sellable (daftar id eksplisit, maks 500 per panggilan). ' +
              'Daftar ini MENCAMPUR stok sungguhan dengan baris seed/placeholder — hanya manusia ' +
              'yang bisa membedakannya.',
          ]
        : [];

    return {
      total,
      returned: data.length,
      /** Nilai yang BENAR-BENAR dipakai sesudah dijepit — bukan yang dikirim klien. */
      limit: take,
      offset: skip,
      hasMore: skip + data.length < total,
      data,
      actionRequired,
      /**
       * TIDAK ADA predikat otomatis yang bisa menandai baris seed: `source=HOSHI` + `sellerId=null`
       * adalah bentuk DEFAULT setiap listing, jadi bentuk baris seed IDENTIK dengan stok nyata.
       * Itu sebabnya rute penandanya per-id dan bukan sapuan massal.
       */
      placeholderDetection: 'MANUAL_ONLY',
      note:
        'Baris di sini TIDAK BISA DIBELI (sellable=false), jadi tidak ada Rupiah yang bisa masuk ' +
        'untuk kartunya. Daftar ini MENCAMPUR stok sungguhan dengan baris seed/placeholder — ' +
        'bentuknya identik dan tidak bisa dibedakan otomatis. Tandai HANYA baris yang kartunya ' +
        'benar-benar ada di rak, lewat POST /admin/listings/sellable dengan daftar id eksplisit.',
    };
  }

  /**
   * Hapus listing. FK `card_redemptions.listingId` ber-ON DELETE RESTRICT, jadi baris yang masih
   * punya permintaan kirim domestik TIDAK BISA dihapus — dan itu disengaja: menghapusnya akan
   * menghilangkan IDENTITAS kartu di baris redemption yang sedang berjalan. Prisma melaporkannya
   * sebagai P2003; kita terjemahkan jadi kalimat yang memberi tahu operator apa yang harus
   * dilakukan, bukan 500.
   */
  async deleteListing(id: string) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ INI PENOLAKAN YANG PALING TIDAK BOLEH DILONGGARKAN DI SELURUH LAYAR ADMIN.          ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    //
    // Menghapus baris listing titipan MENGUNCI KARTU FISIK MILIK ORANG LAIN DI RAK HOSHI
    // SELAMANYA. Yang tertinggal adalah `Consignment` berstatus LISTED dengan `listing = null`,
    // dan SETIAP jalan keluarnya buntu: `takeDown` cabang LISTED tidak punya listing untuk
    // diturunkan, dan `createListingFor` menolak karena `listClaimWhere` menuntut IN_CUSTODY.
    // Satu-satunya perbaikan sesudahnya adalah UPDATE tangan ke database produksi.
    //
    // (Cabang penyelamat di `takeDown` sekarang bisa mengembalikan baris yatim yang TERLANJUR
    // ada ke IN_CUSTODY — itu jaring pengaman untuk data lama, BUKAN izin membuat yang baru.)
    if (isConsignedListing(existing)) {
      consignmentUnsupported(
        'Kartu ini TITIPAN — miliknya orang lain, fisiknya ada di rak Hoshi. Barisnya TIDAK ' +
          'BOLEH dihapus: yang tersisa sesudahnya adalah catatan titipan tanpa listing, dan di ' +
          'keadaan itu kartunya tidak bisa ditarik pemiliknya maupun dipajang ulang — kartu ' +
          'fisik milik orang lain terkunci di rak Hoshi tanpa jalan keluar. ' +
          `Turunkan pajangannya lewat POST /admin/consignments/${existing.consignmentId ?? ':id'}/withdraw, ` +
          'lalu kembalikan kartunya lewat POST /admin/consignments/:id/release (layar ' +
          '/admin/titipan). Dua rute itu menjaga status titipannya tetap benar dan meninggalkan ' +
          'jejak audit yang pemiliknya sendiri bisa baca.',
        id,
      );
    }
    try {
      await this.prisma.listing.delete({ where: { id } });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === 'P2003' || err.code === 'P2014')
      ) {
        throw new BadRequestException(
          'Listing ini masih dirujuk permintaan kirim fisik (kirim domestik). Selesaikan atau ' +
            'batalkan permintaan kirimnya dulu di /admin/redemptions — baru listing-nya bisa ' +
            'dihapus. (Menghapusnya sekarang akan menghilangkan identitas kartu pada permintaan ' +
            'kirim yang sedang berjalan.)',
        );
      }
      throw err;
    }
    return { deleted: true, id };
  }

  async listCards(query: QueryAdminCardsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CardWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.set) where.set = query.set;
    if (query.rarity) where.rarity = query.rarity;
    const [data, total] = await Promise.all([
      this.prisma.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.card.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Feed aktivitas admin dibaca dari tabel `Activity` (event log append-only yang
   * ditulis real-time oleh MarketplaceService) — BUKAN lagi direkonstruksi dari
   * status listing terkini. Rekonstruksi lama menghilangkan riwayat (listed→cancel
   * →listed lagi jadi satu baris) dan membuat re-sync CC memunculkan event palsu.
   */
  async listActivity(query: QueryAdminActivityDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ActivityWhereInput = {};
    // `action` = salah satu nilai ActivityType (mis. SALE_CARD). Nilai lain diabaikan.
    if (query.action && query.action in ActivityType)
      where.type = query.action as ActivityType;
    if (query.search)
      where.itemName = { contains: query.search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          itemName: true,
          itemImage: true,
          category: true,
          set: true,
          amount: true,
          fromLabel: true,
          toLabel: true,
          listingId: true,
          createdAt: true,
        },
      }),
      this.prisma.activity.count({ where }),
    ]);

    const mapped = data.map((a) => ({
      id: a.id,
      type: a.type,
      itemName: a.itemName,
      itemImage: a.itemImage,
      category: a.category,
      set: a.set,
      amount: a.amount,
      fromLabel: a.fromLabel,
      toLabel: a.toLabel,
      listingId: a.listingId,
      createdAt: a.createdAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private readonly logger = new Logger(AdminService.name);
  private readonly uploadDir = path.join(__dirname, '..', '..', 'uploads');

  /* ---------- Contact Messages ---------- */

  async listMessages(query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ContactMessageWhereInput = {};
    if (query.status === 'read') where.isRead = true;
    else if (query.status === 'unread') where.isRead = false;
    if (query.search) {
      where.OR = [
        { listingName: { contains: query.search, mode: 'insensitive' } },
        { senderName: { contains: query.search, mode: 'insensitive' } },
        { senderEmail: { contains: query.search, mode: 'insensitive' } },
        { text: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createMessage(dto: CreateContactMessageDto) {
    return this.prisma.contactMessage.create({ data: dto });
  }

  async markMessageRead(id: string, isRead: boolean) {
    const row = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Message not found');
    return this.prisma.contactMessage.update({
      where: { id },
      data: { isRead },
    });
  }

  /* ---------- Offers (aggregate from Listing JSON) ---------- */
  async listOffers(query: {
    page?: number;
    limit?: number;
    listingId?: string;
    search?: string;
    status?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.OfferWhereInput = {};
    if (query.listingId) where.listingId = query.listingId;
    if (query.search)
      where.listing = { name: { contains: query.search, mode: 'insensitive' } };
    // Filter status opsional. Hanya nilai enum yang valid diterima; nilai lain
    // (mis. "ALL" atau typo) diabaikan agar tidak melempar 500.
    if (query.status && query.status in OfferStatus)
      where.status = query.status as OfferStatus;

    const [data, total] = await Promise.all([
      this.prisma.offer.findMany({
        where,
        // Ambil sekalian data yang SUDAH ada di DB supaya admin bisa menilai
        // offer tanpa membuka listing: thumbnail, harga ask, status listing,
        // dan wallet pembeli. Jangan pernah ikutkan `nonce` user.
        include: {
          listing: {
            select: {
              id: true,
              name: true,
              image: true,
              priceIdrx: true,
              status: true,
            },
          },
          buyer: {
            select: { id: true, displayName: true, walletAddress: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offer.count({ where }),
    ]);

    const mapped = data.map((o) => ({
      id: o.id,
      listingId: o.listingId,
      listingName: o.listing?.name ?? '',
      listingImage: o.listing?.image ?? null,
      listingStatus: o.listing?.status ?? null,
      askPrice: o.listing?.priceIdrx ?? null,
      user: o.user,
      buyerWallet: o.buyer?.walletAddress ?? null,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      // updatedAt = kapan offer di-resolve (accept/reject/cancel) untuk baris
      // non-PENDING. Untuk PENDING nilainya sama dengan createdAt.
      updatedAt: o.updatedAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /* ---------- Users ---------- */

  /**
   * Daftar user untuk admin. Sumbernya sama dengan angka "Users" di dashboard
   * (prisma.user.count()). PENTING: JANGAN pernah select `nonce` atau
   * `passwordHash` — keduanya rahasia keamanan (replay-login & kredensial admin).
   */
  async listUsers(query: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.search)
      where.OR = [
        { walletAddress: { contains: query.search, mode: 'insensitive' } },
        { displayName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          role: true,
          email: true,
          createdAt: true,
          _count: {
            select: {
              listingsSelling: true,
              listingsBought: true,
              offersMade: true,
              ccPackPurchases: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const mapped = data.map((u) => ({
      id: u.id,
      walletAddress: u.walletAddress,
      displayName: u.displayName,
      role: u.role,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      listings: u._count.listingsSelling,
      bought: u._count.listingsBought,
      offers: u._count.offersMade,
      packs: u._count.ccPackPurchases,
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /* ---------- Vault / Inventory (custody location) ---------- */

  /**
   * Daftar item vault untuk admin — menjawab "inventory kita ada di vault mana".
   * Bisa difilter per status (STORED/MINTING/MINTED/REDEEMED) dan per provider
   * custody, plus cari via serial / nama kartu / label lokasi.
   */
  async listVaultItems(query: {
    page?: number;
    limit?: number;
    status?: string;
    provider?: string;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.VaultItemWhereInput = {};
    if (query.status && query.status in VaultStatus)
      where.status = query.status as VaultStatus;
    if (query.provider && query.provider in StorageProvider)
      where.storageProvider = query.provider as StorageProvider;
    if (query.search)
      where.OR = [
        { serialNumber: { contains: query.search, mode: 'insensitive' } },
        { vaultLocation: { contains: query.search, mode: 'insensitive' } },
        { card: { name: { contains: query.search, mode: 'insensitive' } } },
      ];

    const [data, total] = await Promise.all([
      this.prisma.vaultItem.findMany({
        where,
        include: {
          card: { select: { id: true, name: true, imageUrl: true, set: true } },
          owner: {
            select: { id: true, displayName: true, walletAddress: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.vaultItem.count({ where }),
    ]);

    const mapped = data.map((v) => ({
      id: v.id,
      serialNumber: v.serialNumber,
      status: v.status,
      storageProvider: v.storageProvider,
      vaultLocation: v.vaultLocation,
      cardId: v.cardId,
      cardName: v.card?.name ?? '',
      cardImage: v.card?.imageUrl ?? null,
      cardSet: v.card?.set ?? null,
      ownerWallet: v.owner?.walletAddress ?? null,
      ownerLabel: v.owner?.displayName ?? null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Admin memindahkan/mengoreksi lokasi custody sebuah item vault. */
  async updateVaultItem(
    id: string,
    dto: { storageProvider?: string; vaultLocation?: string | null },
  ) {
    const data: Prisma.VaultItemUpdateInput = {};
    if (dto.storageProvider !== undefined) {
      if (!(dto.storageProvider in StorageProvider))
        throw new BadRequestException('storageProvider tidak valid');
      data.storageProvider = dto.storageProvider as StorageProvider;
    }
    if (dto.vaultLocation !== undefined) data.vaultLocation = dto.vaultLocation;
    // P2025 (row tidak ada) dipetakan ke 404 oleh PrismaExceptionFilter global.
    return this.prisma.vaultItem.update({ where: { id }, data });
  }

  /* ---------- Daily Stats (Charts) ---------- */

  async dailyStats(days = 30) {
    const now = new Date();
    const since = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - days,
      ),
    );

    const listings = await this.prisma.listing.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, priceIdrx: true, status: true, soldAt: true },
    });

    const dateMap = new Map<string, { listings: number; revenue: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dateMap.set(key, { listings: 0, revenue: 0 });
    }

    for (const l of listings) {
      const key = l.createdAt.toISOString().slice(0, 10);
      if (dateMap.has(key)) dateMap.get(key)!.listings++;
      if (l.status === 'SOLD' && l.soldAt) {
        const soldKey = l.soldAt.toISOString().slice(0, 10);
        if (dateMap.has(soldKey)) dateMap.get(soldKey)!.revenue += l.priceIdrx;
      }
    }

    const dailyListings: { date: string; count: number }[] = [];
    const dailyRevenue: { date: string; amount: number }[] = [];
    for (const [date, vals] of dateMap) {
      dailyListings.push({ date, count: vals.listings });
      dailyRevenue.push({ date, amount: vals.revenue });
    }
    dailyListings.sort((a, b) => a.date.localeCompare(b.date));
    dailyRevenue.sort((a, b) => a.date.localeCompare(b.date));

    const statusDist = [
      {
        status: 'ACTIVE',
        count: await this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      },
      {
        status: 'SOLD',
        count: await this.prisma.listing.count({ where: { status: 'SOLD' } }),
      },
      {
        status: 'CANCELLED',
        count: await this.prisma.listing.count({
          where: { status: 'CANCELLED' },
        }),
      },
    ];

    const topListings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { views: 'desc' },
      take: 5,
      select: { id: true, name: true, views: true, priceIdrx: true },
    });

    const conversionAgg = await this.prisma.listing.aggregate({
      _count: true,
      where: { status: 'SOLD' },
    });
    const totalListings = await this.prisma.listing.count();
    const conversionRate =
      totalListings > 0 ? (conversionAgg._count / totalListings) * 100 : 0;

    return {
      dailyListings,
      dailyRevenue,
      statusDistribution: statusDist,
      topListings,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  }

  /* ---------- Image Upload ---------- */

  /**
   * Accept/reject dari admin DIDELEGASIKAN ke MarketplaceService — jalur yang
   * sama dengan tombol penjual di halaman profil. Dulu method ini cuma menulis
   * `status: ACCEPTED` tanpa menjual listing atau mint NFT: offer tampak diterima
   * padahal kartunya tidak pernah pindah tangan, dan penjual kehilangan tombol
   * accept-nya (status bukan PENDING lagi). Admin = moderasi, bukan alur utama.
   */
  acceptOffer(id: string) {
    return this.marketplace.acceptOfferAsAdmin(id);
  }

  rejectOffer(id: string) {
    return this.marketplace.rejectOfferAsAdmin(id);
  }

  /**
   * Upload gambar listing.
   *
   * PRODUKSI: kalau `CLOUDINARY_URL` di-set, byte diunggah ke Cloudinary dan yang
   * dikembalikan adalah URL CDN ABSOLUT (secure_url). Ini penting karena:
   *   1) disk container Render bersifat EPHEMERAL — file lokal hilang tiap redeploy;
   *   2) URL relatif `/uploads/...` tidak resolve dari origin frontend (Vercel).
   *
   * DEV: kalau env belum di-set, jatuh balik ke disk lokal (URL relatif) supaya
   * pengembangan lokal tetap jalan tanpa akun Cloudinary. JANGAN andalkan jalur ini
   * di produksi. Set `CLOUDINARY_URL` di env Render.
   */
  /**
   * Kredensial Cloudinary boleh diisi lewat SALAH SATU dari:
   *   a) CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>  (1 baris), atau
   *   b) CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET (3 baris).
   * Dua-duanya didukung supaya tidak tergantung format yang ditampilkan dashboard.
   */
  // Cache instance cloudinary (atau null kalau gagal load). undefined = belum dicoba.
  private cld: (typeof import('cloudinary'))['v2'] | null | undefined = undefined;

  /** Load cloudinary LAZY + DEFENSIF. require di sini bisa THROW kalau CLOUDINARY_URL salah format —
   *  ditangkap → return null (cloudinary dianggap tak tersedia), backend TETAP jalan. */
  private cloudinaryLib(): (typeof import('cloudinary'))['v2'] | null {
    if (this.cld !== undefined) return this.cld;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.cld = (require('cloudinary') as typeof import('cloudinary')).v2;
    } catch (e) {
      this.logger.error(
        `Cloudinary gagal dimuat (CLOUDINARY_URL kemungkinan salah format — harus 'cloudinary://…'): ` +
          `${e instanceof Error ? e.message : String(e)}. Upload gambar jatuh ke DATA URL.`,
      );
      this.cld = null;
    }
    return this.cld;
  }

  private cloudinaryReady(): boolean {
    const cld = this.cloudinaryLib();
    if (!cld) return false;
    // SDK otomatis membaca process.env.CLOUDINARY_URL saat config() dipanggil.
    if (cld.config().cloud_name) return true;
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (cloudName && apiKey && apiSecret) {
      cld.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      return true;
    }
    return false;
  }

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/'))
      throw new BadRequestException('Hanya file gambar yang diperbolehkan');

    const cld = this.cloudinaryLib();
    if (cld && this.cloudinaryReady()) {
      const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      const uploaded = await cld.uploader.upload(dataUri, {
        folder: 'hoshi/listings',
        resource_type: 'image',
      });
      return { url: uploaded.secure_url };
    }

    // Tanpa Cloudinary di PRODUKSI/staging: simpan sebagai DATA URL base64. Berbeda dari fallback
    // disk (URL relatif `/uploads/...` yang 404 di origin frontend & hilang tiap redeploy), data URL
    // SELF-CONTAINED: render langsung di <img>, tersimpan di DB (bukan disk ephemeral), tanpa host
    // eksternal. Dibatasi 2MB supaya baris DB tidak membengkak — untuk volume besar tetap set
    // CLOUDINARY_URL. Ini bikin upload LANGSUNG JALAN tanpa kredensial apa pun.
    if (this.config.get<string>('NODE_ENV') === 'production') {
      const MAX = 2 * 1024 * 1024;
      const size = file.size ?? file.buffer.length;
      if (size > MAX)
        throw new BadRequestException(
          'Gambar terlalu besar (maks 2MB tanpa Cloudinary). Kompres dulu, atau set CLOUDINARY_URL di server.',
        );
      return {
        url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
      };
    }

    // Fallback dev-only: tulis ke disk lokal (URL relatif — hanya berguna lokal).
    this.logger.warn(
      'Kredensial Cloudinary belum di-set (CLOUDINARY_URL, atau CLOUDINARY_CLOUD_NAME + ' +
        'CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET) — upload jatuh ke disk lokal (ephemeral, dev-only).',
    );
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const filename = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(this.uploadDir, filename);
    if (!fs.existsSync(this.uploadDir))
      fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return { url: `/uploads/${filename}` };
  }

  async seedAdmin(email: string, password: string, secret?: string) {
    // Fail closed: tanpa ADMIN_SECRET di env, seed tidak bisa dipakai sama
    // sekali — endpoint ini membuat akun ADMIN, bukan sekadar data demo.
    const expected = this.config.get<string>('ADMIN_SECRET');
    if (!expected || secret !== expected) {
      throw new ForbiddenException(
        'Seed admin butuh header x-admin-secret yang cocok dengan env ADMIN_SECRET.',
      );
    }
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) throw new ConflictException('Admin already exists');
    const passwordHash = await hash(password);
    return this.prisma.user.create({
      data: {
        walletAddress: `admin-${email.replace(/[^a-zA-Z0-9]/g, '')}`,
        email,
        passwordHash,
        role: 'ADMIN',
        displayName: 'Admin',
      },
    });
  }

  async seedChartData() {
    // Guard: endpoint ini menulis 91 listing demo langsung ke tabel `listings`
    // yang dipakai dashboard. Dilarang di production agar angka riil tidak
    // tercemar data palsu.
    if (this.config.get<string>('NODE_ENV') === 'production')
      throw new ForbiddenException('Seed chart data dilarang di production.');
    const SEED_CARDS = [
      {
        name: 'Pikachu VMAX',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Lightning',
        category: 'Special Illustration',
        priceIdrx: 45000000,
        expectedValueIdrx: 48000000,
        image: 'https://placehold.co/400x560/3a2e0e/ffd700?text=Pikachu+VMAX',
      },
      {
        name: 'Charizard VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Fire',
        category: 'Character Illustration',
        priceIdrx: 52000000,
        expectedValueIdrx: 55000000,
        image: 'https://placehold.co/400x560/4a0e0e/ffd700?text=Charizard+VMAX',
      },
      {
        name: 'Mewtwo VSTAR',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Psychic',
        category: 'Special Illustration',
        priceIdrx: 28000000,
        expectedValueIdrx: 30000000,
        image: 'https://placehold.co/400x560/2e0e4a/ffd700?text=Mewtwo+VSTAR',
      },
      {
        name: 'Gengar VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'CGC 9',
        grader: 'CGC' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Classic',
        element: 'Darkness',
        category: 'Special Illustration',
        priceIdrx: 35000000,
        expectedValueIdrx: 38000000,
        image: 'https://placehold.co/400x560/2e0e0e/ffd700?text=Gengar+VMAX',
      },
      {
        name: 'Eevee V',
        set: 'Promo',
        rarity: 'Epic',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Modern',
        element: 'Normal',
        category: 'Illustration',
        priceIdrx: 8500000,
        expectedValueIdrx: 9200000,
        image: 'https://placehold.co/400x560/3a2e0e/c8a84e?text=Eevee+V',
      },
      {
        name: 'Umbreon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 10',
        grader: 'BGS' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Darkness',
        category: 'Character Illustration',
        priceIdrx: 62000000,
        expectedValueIdrx: 65000000,
        image: 'https://placehold.co/400x560/1a1a2e/ffd700?text=Umbreon+VMAX',
      },
      {
        name: 'Rayquaza V',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'CGC 9.5',
        grader: 'CGC' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Classic',
        element: 'Dragon',
        category: 'Special Illustration',
        priceIdrx: 38000000,
        expectedValueIdrx: 40000000,
        image: 'https://placehold.co/400x560/0e3a2e/ffd700?text=Rayquaza+V',
      },
      {
        name: 'Glaceon VSTAR',
        set: 'Jungle',
        rarity: 'Epic',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Water',
        category: 'Illustration',
        priceIdrx: 18000000,
        expectedValueIdrx: 20000000,
        image: 'https://placehold.co/400x560/0e1a4a/aaccff?text=Glaceon+VSTAR',
      },
      {
        name: 'Lucario V',
        set: 'Rare',
        rarity: 'Rare',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'Japan',
        era: 'Modern',
        element: 'Fighting',
        category: 'Character Illustration',
        priceIdrx: 6500000,
        expectedValueIdrx: 7200000,
        image: 'https://placehold.co/400x560/4a2e0e/d4a64e?text=Lucario+V',
      },
      {
        name: 'Sylveon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Fairy',
        category: 'Character Illustration',
        priceIdrx: 42000000,
        expectedValueIdrx: 45000000,
        image: 'https://placehold.co/400x560/2e1a3a/ffb6c1?text=Sylveon+VMAX',
      },
    ];

    const now = new Date();
    let created = 0;

    for (let dayOffset = 90; dayOffset >= 0; dayOffset--) {
      const card = SEED_CARDS[dayOffset % SEED_CARDS.length];
      const createdAt = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - dayOffset,
          8,
          0,
          0,
        ),
      );
      await this.prisma.listing.create({
        data: {
          ...card,
          buybackIdrx: Math.round(card.priceIdrx * 0.7),
          sellerAddress: 'seed-admin',
          status: 'ACTIVE',
          createdAt,
          listedAt: createdAt,
          updatedAt: createdAt,
          priceHistory: [card.expectedValueIdrx, card.priceIdrx],
          offers: [],
        },
      });
      created++;
    }

    return {
      listingsCreated: created,
      dateRange: {
        to: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 0,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
        from: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 90,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
      },
    };
  }

  /* ═══════════════════════ D (4.6) — ESCROW: LIHAT & PULIHKAN ═══════════════════════ */

  /* (Predikat `held` / `stranded` ada di akhir file — lihat komentarnya: keduanya bersama-sama
     WAJIB mencakup SETIAP baris yang membawa fakta `escrowedAt`.) */

  /**
   * APA YANG SEDANG DIPEGANG ESCROW, dan apa yang akan bermasalah saat P2P dinyalakan.
   *
   * KENAPA ADA: sampai sekarang TIDAK ADA satu pun permukaan yang menunjukkan kartu mana yang
   * ada di wallet escrow. Satu-satunya jejaknya adalah baris log `cancel: gagal mengembalikan
   * kartu ... CEK ON-CHAIN & kembalikan kartu manual` — dan log droplet dirotasi, jadi kartu
   * penjual bisa tertinggal di escrow tanpa seorang pun tahu.
   *
   * READ-ONLY. TIDAK menyentuh on-chain kecuali diminta eksplisit (`verify`), karena
   * memverifikasi N aset berarti N panggilan RPC dan dashboard tidak boleh jadi sumber badai RPC.
   *
   * TIGA daftar, masing-masing menjawab pertanyaan operasional yang berbeda:
   *   • held      — listing yang FAKTANYA ber-escrow dan masih hidup (ACTIVE): ini normal.
   *   • stranded  — escrowedAt MASIH ter-set padahal listing sudah TIDAK ACTIVE lagi. Untuk
   *                 CANCELLED itu berarti pengembalian ke penjual GAGAL → kandidat pemulihan.
   *                 Predikatnya adalah KOMPLEMEN `held`, bukan daftar status yang disebut satu-
   *                 satu: bersama-sama keduanya wajib mencakup SETIAP baris ber-escrowedAt, jadi
   *                 tidak ada kartu yang dipegang escrow yang bisa jatuh di antara dua daftar
   *                 (lihat escrowHeldWhere/escrowStrandedWhere di akhir file + test-nya).
   *   • unescrowedActive (B) — RADIUS LEDAKAN hari arming: listing USER ACTIVE yang TIDAK
   *                 escrow-backed. Predikatnya butuh DUA fakta (ccNftAddress ADA dan
   *                 escrowedAt ADA) dan hidup di src/marketplace/p2p.gate.ts. Ia mencakup
   *                 DUA sub-populasi dengan pemulihan yang BERBEDA:
   *                   – ccNftAddress ADA, escrowedAt NULL → penjual memajang ulang (relist),
   *                     SATU aksi, dan kartunya masuk escrow;
   *                   – ccNftAddress NULL → tidak ada kartu on-chain untuk dititipkan sama
   *                     sekali; relist tidak akan menolong, listing harus DIBATALKAN.
   *                 Sub-populasi kedua DULU TIDAK TERHITUNG di sini (WHERE-nya menuntut
   *                 ccNftAddress IS NOT NULL) padahal ia yang paling mudah dibuat — jadi
   *                 angka ini akan lebih besar dari yang pernah dilihat operator. Itu
   *                 koreksi, bukan lonjakan.
   */
  async escrowOverview(opts: { verify?: boolean; limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const mode = p2pModeOf(this.config);

    const listingSelect = {
      id: true,
      name: true,
      status: true,
      priceIdrx: true,
      ccNftAddress: true,
      escrowedAt: true,
      listedAt: true,
      sellerId: true,
      sellerAddress: true,
      seller: { select: { id: true, displayName: true, walletAddress: true } },
    } as const;

    const [heldRows, strandedRows, unescrowedRows, unescrowedCount, recoveries] =
      await Promise.all([
        this.prisma.listing.findMany({
          where: escrowHeldWhere(),
          select: listingSelect,
          orderBy: { escrowedAt: 'desc' },
          take,
        }),
        this.prisma.listing.findMany({
          where: escrowStrandedWhere(),
          select: listingSelect,
          orderBy: { escrowedAt: 'desc' },
          take,
        }),
        this.prisma.listing.findMany({
          where: {
            status: ListingStatus.ACTIVE,
            ...unescrowedUserListingWhere(),
          },
          select: listingSelect,
          orderBy: { listedAt: 'desc' },
          take,
        }),
        this.prisma.listing.count({
          where: {
            status: ListingStatus.ACTIVE,
            ...unescrowedUserListingWhere(),
          },
        }),
        this.prisma.escrowRecovery.findMany({
          orderBy: { createdAt: 'desc' },
          take: 20,
        }),
      ]);

    const shape = (r: (typeof heldRows)[number]) => ({
      listingId: r.id,
      name: r.name,
      status: r.status,
      priceIdrx: r.priceIdrx,
      assetAddress: r.ccNftAddress,
      escrowedAt: r.escrowedAt?.toISOString() ?? null,
      listedAt: r.listedAt.toISOString(),
      sellerId: r.sellerId,
      sellerLabel:
        r.seller?.displayName?.trim() ||
        (r.seller ? shortWalletLabel(r.seller.walletAddress) : r.sellerAddress),
      sellerWallet: r.seller?.walletAddress ?? null,
      // Diisi HANYA kalau verify=true. null = TIDAK DIPERIKSA, bukan "tidak dipegang" — bedanya
      // penting: operator tidak boleh menyimpulkan apa pun dari kolom yang tak pernah dibaca.
      escrowOwnsOnChain: null as boolean | null,
    });

    const held = heldRows.map(shape);
    const stranded = strandedRows.map(shape);

    if (opts.verify === true && this.escrow.isConfigured()) {
      // Hanya daftar yang MENGAKU ber-escrow yang diverifikasi — di situlah klaim DB bisa salah.
      for (const row of [...held, ...stranded]) {
        if (!row.assetAddress) continue;
        row.escrowOwnsOnChain = await this.escrow.ownsAsset(row.assetAddress);
      }
    }

    return {
      escrowConfigured: this.escrow.isConfigured(),
      escrowAddress: this.escrow.isConfigured() ? this.escrow.publicKey : null,
      /** MOCK / ARMED / OFF — menjelaskan apakah `unescrowedActive` berbahaya atau tidak. */
      p2pMode: mode,
      heldCount: held.length,
      held,
      strandedCount: stranded.length,
      stranded,
      /**
       * B — jumlah PENUH (bukan hanya yang ditampilkan). Inilah angka yang harus dilihat product
       * owner SEBELUM menyalakan HOSHI_P2P_ENABLED: sebanyak ini listing akan langsung hilang
       * dari feed publik. Pemiliknya perlu diberi tahu — memajang ulang (relist) untuk baris
       * yang punya `assetAddress`, MEMBATALKAN untuk baris yang `assetAddress`-nya null.
       * Runbook lengkapnya (termasuk query pra-cek invoice IDRX yang masih hidup) ada di
       * prisma/migrations/20260919000000_escrow_sponsor_serialization_and_buyability.
       */
      unescrowedActiveCount: unescrowedCount,
      unescrowedActive: unescrowedRows.map(shape),
      recentRecoveries: recoveries,
    };
  }

  /**
   * PEMULIHAN MANUAL: kembalikan SATU kartu dari wallet escrow ke PENJUALNYA.
   *
   * Bentuknya sengaja sama persis dengan tiga rute pemulihan redemption yang sudah ada: satu
   * transisi saja, TANPA parameter bebas, wajib beralasan, log keras SEBELUM aksinya, dan
   * tulisan DB berpagar predikat.
   *
   * APA YANG DIJAGA, DAN KENAPA:
   *   • TUJUAN TIDAK BISA DIPILIH. Wallet penerima diturunkan dari baris penjual. Kalau alamat
   *     boleh datang dari body, ini bukan pemulihan melainkan "kirim aset siapa pun ke mana pun".
   *   • STATUS DIBATASI ke CANCELLED dan PENDING_ESCROW. ACTIVE ditolak karena listing-nya masih
   *     bisa dibeli detik ini — jalannya adalah membatalkannya dulu (cancel sudah punya klaim
   *     atomik yang menutup jendela beli SEBELUM menyentuh escrow). SOLD ditolak KERAS: di sana
   *     kartunya sudah/mungkin sah milik pembeli, dan "mengembalikannya" = mengambil barang orang.
   *   • KEPEMILIKAN ON-CHAIN DIPERIKSA DULU. Kita tidak pernah mencoba memindahkan yang tidak
   *     kita pegang, dan tidak pernah melaporkan sukses yang tidak terjadi.
   *   • HASIL YANG TIDAK DIKETAHUI DICATAT APA ADANYA. Transfer yang sudah disiarkan tapi
   *     konfirmasinya hilang TIDAK dianggap gagal: escrowedAt SENGAJA tidak dibersihkan (kalau
   *     ternyata kartunya sudah pindah, membersihkannya menghapus satu-satunya petunjuk), dan
   *     barisnya ditulis INDETERMINATE.
   */
  async recoverEscrowToSeller(
    listingId: string,
    reason: string,
    admin: { id: string; walletAddress: string },
  ) {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 10) {
      throw new BadRequestException(
        'Alasan pemulihan wajib diisi (minimal 10 karakter) dan akan disimpan permanen.',
      );
    }

    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      include: { seller: { select: { id: true, walletAddress: true } } },
    });
    if (!listing) throw new NotFoundException('Listing tidak ditemukan.');
    if (!listing.ccNftAddress) {
      throw new BadRequestException(
        'Listing ini tidak punya aset on-chain — tidak ada yang bisa dikembalikan dari escrow.',
      );
    }
    if (
      listing.status !== ListingStatus.CANCELLED &&
      listing.status !== ListingStatus.PENDING_ESCROW
    ) {
      throw new BadRequestException(
        'Pemulihan escrow HANYA untuk listing CANCELLED atau PENDING_ESCROW — status sekarang ' +
          `${listing.status}. Listing ACTIVE: batalkan dulu (cancel menutup jendela beli secara ` +
          'atomik sebelum menyentuh escrow). Listing SOLD: kartunya sudah/mungkin sah milik ' +
          'pembeli — selesaikan lewat cek on-chain, JANGAN tarik kembali dari sini.',
      );
    }
    const toWallet = listing.seller?.walletAddress;
    if (!toWallet) {
      throw new BadRequestException(
        'Listing ini tidak punya akun penjual dengan wallet — tidak ada tujuan pengembalian yang sah.',
      );
    }
    if (!this.escrow.isConfigured()) {
      throw new BadRequestException(
        'Wallet escrow belum dikonfigurasi di deployment ini (HOSHI_ESCROW_SECRET_KEY).',
      );
    }

    // JANGAN PERNAH memindahkan yang tidak kita pegang. Ini juga yang membuat aksi ini idempoten
    // dalam praktik: dijalankan dua kali, yang kedua ditolak karena escrow sudah tidak memegangnya.
    const owned = await this.escrow.ownsAsset(listing.ccNftAddress);
    if (!owned) {
      throw new ConflictException(
        `Wallet escrow TIDAK memegang kartu ${listing.ccNftAddress} on-chain — tidak ada yang ` +
          'dikembalikan. Kartunya mungkin sudah kembali ke penjual atau sudah diserahkan ke ' +
          'pembeli; periksa explorer sebelum melakukan apa pun.',
      );
    }

    const stamp = new Date().toISOString();
    // Log KERAS DULU — supaya jejaknya ada bahkan kalau tulisan DB setelah ini gagal.
    this.logger.error(
      `PEMULIHAN ESCROW MANUAL ${stamp}: kartu ${listing.ccNftAddress} (listing ${listing.id} ` +
        `"${listing.name}", status ${listing.status}) dikembalikan ke penjual ` +
        `${listing.sellerId ?? 'tidak diketahui'} (${toWallet}) oleh admin ${admin.id} ` +
        `(${admin.walletAddress}). Alasan operator: ${trimmed}`,
    );

    let signature: string;
    try {
      signature = await this.escrow.transferCoreAssetTo({
        assetAddress: listing.ccNftAddress,
        newOwner: toWallet,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof EscrowTransferIndeterminateError) {
        // Kartu MUNGKIN sudah pindah. Catat apa adanya; JANGAN bersihkan escrowedAt (itu satu-
        // satunya penanda bahwa kartu ini pernah ada di escrow) dan JANGAN ulangi tanpa cek.
        await this.prisma.escrowRecovery.create({
          data: {
            listingId: listing.id,
            assetAddress: listing.ccNftAddress,
            sellerId: listing.sellerId,
            toWallet,
            adminId: admin.id,
            adminWallet: admin.walletAddress,
            reason: trimmed,
            outcome: EscrowRecoveryOutcome.INDETERMINATE,
          },
        });
        this.logger.error(
          `PEMULIHAN ESCROW INDETERMINATE: transfer ${listing.ccNftAddress} → ${toWallet} ` +
            `disiarkan tapi konfirmasi gagal (${message}). Kartu MUNGKIN sudah pindah — CEK ` +
            'ON-CHAIN sebelum mengulang. escrowedAt SENGAJA tidak dibersihkan.',
        );
        throw new ConflictException(
          'Transfer sudah disiarkan tapi konfirmasinya tidak diterima — kartu MUNGKIN sudah ' +
            'kembali ke penjual. JANGAN ulangi sebelum memeriksa kepemilikan on-chain. ' +
            'Kejadian ini sudah dicatat di escrow_recoveries.',
        );
      }
      // Pra-kirim (mis. escrow kehilangan kepemilikan di antara cek dan kirim) → nol yang pindah.
      this.logger.error(
        `PEMULIHAN ESCROW GAGAL PRA-KIRIM untuk ${listing.ccNftAddress}: ${message}. Nol aset ` +
          'berpindah; aman dicoba lagi.',
      );
      throw new ConflictException(
        `Pengembalian kartu gagal sebelum terkirim: ${message}. Tidak ada aset yang berpindah — ` +
          'aman dicoba lagi.',
      );
    }

    // Kartu TERBUKTI kembali. Bersihkan penanda escrow dengan tulisan BERPAGAR, dan untuk baris
    // PENDING_ESCROW tutup juga listing-nya: kartunya sudah tidak ada di escrow, jadi membiarkan
    // ia "menunggu escrow" hanya akan mengundang penjual menandatangani penitipan yang tak cocok.
    await this.prisma.listing.updateMany({
      where: { id: listing.id, status: listing.status },
      data: {
        escrowedAt: null,
        ...(listing.status === ListingStatus.PENDING_ESCROW
          ? { status: ListingStatus.CANCELLED }
          : {}),
      },
    });

    const recovery = await this.prisma.escrowRecovery.create({
      data: {
        listingId: listing.id,
        assetAddress: listing.ccNftAddress,
        sellerId: listing.sellerId,
        toWallet,
        adminId: admin.id,
        adminWallet: admin.walletAddress,
        reason: trimmed,
        outcome: EscrowRecoveryOutcome.RETURNED,
        signature,
      },
    });

    this.logger.warn(
      `PEMULIHAN ESCROW SELESAI: ${listing.ccNftAddress} kembali ke ${toWallet} (sig ${signature}).`,
    );

    return {
      recovery,
      warning:
        'Kartu sudah dikembalikan ke wallet penjual dan penanda escrow dibersihkan. Beri tahu ' +
        'penjual bahwa kartunya kembali di wallet-nya dan bisa dipajang ulang kapan saja.',
    };
  }
}

/* ═════════════ PREDIKAT DAFTAR ESCROW — `held` DAN `stranded` HARUS MENUTUP SEMUANYA ═════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ INVARIAN: SETIAP baris yang membawa fakta `escrowedAt` HARUS muncul di `held` ATAU        ║
 * ║ `stranded`. Tidak ada baris ber-escrow yang boleh jatuh di antara keduanya.               ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * `escrowedAt` adalah FAKTA "wallet escrow memegang kartu ini" — dan untuk kartu yang tertinggal
 * di escrow, ia satu-satunya petunjuk yang kita punya. Kalau sebuah baris membawa fakta itu tapi
 * tidak muncul di daftar mana pun, kartunya tidak lenyap dari blockchain; ia lenyap dari
 * PANDANGAN OPERATOR, yang justru lebih buruk: tidak ada yang tahu ada yang perlu dipulihkan.
 *
 * Versi sebelumnya membentuk `stranded` dengan daftar status yang DISEBUT SATU-SATU
 * (`CANCELLED, SOLD`). Daftar seperti itu diam-diam menjadi tidak lengkap setiap kali ada status
 * baru — dan sudah tidak lengkap sekarang: baris PENDING_ESCROW yang ber-`escrowedAt` (mis.
 * pemulihan admin yang hasilnya INDETERMINATE, yang SENGAJA tidak membersihkan penanda) tidak
 * muncul di satu pun dari ketiga daftar.
 *
 * Karena itu `stranded` sekarang dinyatakan sebagai KOMPLEMEN dari `held`: "ber-escrow dan TIDAK
 * ACTIVE". Dua predikat yang saling melengkapi tidak bisa punya celah — termasuk untuk status
 * yang belum ada saat baris ini ditulis. Ada test yang menjalankan SETIAP nilai ListingStatus
 * lewat keduanya dan gagal kalau ada satu saja yang lolos dari dua-duanya.
 *
 * (`unescrowedActive` — daftar ketiga — menjawab pertanyaan yang BERLAWANAN: baris yang
 * SEHARUSNYA ber-escrow tapi tidak. Ia tidak ikut menutupi invarian ini dan memang tidak bisa.)
 */
export function escrowHeldWhere(): Prisma.ListingWhereInput {
  return { escrowedAt: { not: null }, status: ListingStatus.ACTIVE };
}

/** Komplemen `escrowHeldWhere` di antara baris ber-`escrowedAt`. Lihat invarian di atas. */
export function escrowStrandedWhere(): Prisma.ListingWhereInput {
  return { escrowedAt: { not: null }, status: { not: ListingStatus.ACTIVE } };
}
