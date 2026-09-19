import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  ActivityType,
  CcPackStatus,
  ListingStatus,
  PaymentStatus,
  Prisma,
  RedemptionStatus,
} from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import {
  CcShippingService,
  type FundAndPrepareResult,
  type ReprepareResult,
} from '../collectorcrypt/cc-shipping.service';
import type {
  CcSiwsNonceResponse,
  CcSiwsRefreshResponse,
  CcSiwsVerifyResponse,
} from '../collectorcrypt/cc-shipping.types';
import {
  SHIPPING_ERROR_CODE,
  noEffectError,
} from '../collectorcrypt/cc-shipping.errors';
import { PaymentsService } from '../payments/payments.service';
import {
  recordShippingRefundDebts,
  type ShippingRefundDebt,
} from '../payments/shipping-refund-debt';
import { appendBoundedNote, NOTE_MAX } from '../common/append-note';
import type { DomesticShippingQuote } from '../payments/domestic-shipping-rate';
import {
  DOMESTIC_ERROR_CODE,
  domesticError,
  hoshiListingRef,
  isDomesticRedemption,
  isDomesticShippableStock,
} from '../common/hoshi-domestic-shipping';
import { isPhysicallyHeldByHoshi } from '../common/consignment.gate';
import { RequestRedemptionDto } from './dto/request-redemption.dto';

export type CardRedemptionDto = {
  id: string;
  /**
   * IDENTITAS kartu. Jalur CC Vault: alamat NFT sungguhan. Jalur DOMESTIK (stok Hoshi): turunan
   * `hoshi-listing:<listingId>` — kartu itu memang TIDAK punya alamat NFT (settlement-nya
   * database-only). Alfabet base58 Solana tak memuat ':' maupun '-', jadi dua bentuk ini tidak
   * bisa tertukar. Klien yang perlu tahu railnya membaca `listingId` di bawah, bukan mem-parse ini.
   */
  nftAddress: string;
  /** NON-NULL = jalur kirim DOMESTIK (stok Hoshi, kurir lokal). NULL = jalur CC Vault. */
  listingId: string | null;
  cardName: string;
  cardImage: string | null;
  cardSet: string | null;
  recipientName: string;
  city: string;
  country: string;
  status: RedemptionStatus;
  createdAt: Date;
};

/**
 * Status SELESAI/BATAL — redemption-nya sudah berakhir, jadi mint-nya boleh diminta lagi.
 * Dienumerasi SADAR (bukan "sisanya"), dan diuji lengkap terhadap enum di redemption.service.spec.ts:
 * status BARU yang ditambahkan nanti tidak masuk daftar ini → otomatis ikut MEMBLOKIR (fail-closed).
 *
 *  - CANCELED   : permintaan dibatalkan user/admin. Tidak ada kartu yang bergerak.
 *  - DELIVERED  : terminal sukses. Kartunya sudah dibakar & sampai di rumah user — tidak ada
 *                 redemption kedua yang masuk akal, dan kalau toh diminta, CC menolaknya di
 *                 /redeem/prepare (404 Cards not found) yang masih PRA-danai (nol dana berpindah).
 *  - REFUND_DUE : abort PRA-danai; Rupiah-nya sedang dibalikkan. Memblokir di sini justru
 *                 MENJEBAK user: percobaan yang gagal akan mengunci kartunya selamanya.
 *                 SEJAK B1 nilai ini BENAR-BENAR DITULIS — satu-satunya penulisnya adalah aksi
 *                 admin AdminService.settleReadyToFundAsRefundDue (READY_TO_FUND → REFUND_DUE).
 */
const TERMINAL_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.CANCELED,
  RedemptionStatus.DELIVERED,
  RedemptionStatus.REFUND_DUE,
];

/**
 * Status yang masih "aktif" (kartu dianggap sedang diproses kirim) — blok request dobel.
 *
 * DULU cuma REQUESTED/PACKING/SHIPPED, yaitu jalur record-only saja. Artinya baris jalur REAL —
 * termasuk FUNDED, yang berarti USDC treasury SUDAH ada di wallet user — TIDAK memblokir
 * redemption kedua untuk mint yang sama, dan satu-satunya yang menahan cuma UI. Panggilan API
 * berulang bisa mendanai kartu yang sama dua kali.
 *
 * Sekarang SETIAP status in-flight memblokir.
 *
 * ┌─────────────────────────── B1: SETIAP STATUS PEMBLOKIR PUNYA JALAN KELUAR ───────────────────┐
 * │ Memblokir tanpa jalan keluar = KUNCI KARTU PERMANEN. Tabel ini adalah kontraknya; kalau kamu │
 * │ menambah status pemblokir baru, TAMBAHKAN BARISNYA di sini beserta jalan keluarnya.          │
 * │                                                                                              │
 * │ STATUS                 UANG           JALAN KELUAR (siapa yang menggerakkan)                 │
 * │ REQUESTED              nol            createShippingOrder → AWAITING_PAYMENT                 │
 * │                                       user  POST /redemptions/:id/cancel → CANCELED          │
 * │                                       admin PATCH status → PACKING/SHIPPED/CANCELED          │
 * │ AWAITING_PAYMENT       nol (belum)    fulfilShipping (Rupiah lunas) → READY_TO_FUND          │
 * │                                       invoice kedaluwarsa (recordUnfulfilled) → REQUESTED    │
 * │                                       createShippingOrder masuk lagi: invoice hidup dipakai  │
 * │                                         ulang, invoice mati → dilepas ke REQUESTED           │
 * │                                       user  POST /redemptions/:id/cancel → CANCELED          │
 * │                                         (BERLAKU JUGA saat order ongkirnya FULFILLING /      │
 * │                                          REFUND_DUE — utangnya pindah ke PaymentOrder)       │
 * │                                       admin POST :id/cancel-awaiting-payment → CANCELED      │
 * │                                         (jalan keluar TERAKHIR: berlaku untuk SETIAP status  │
 * │                                          order ongkir, termasuk PAID/FULFILLED)              │
 * │ READY_TO_FUND          Rupiah LUNAS   fundAndPrepare → FUNDING                               │
 * │                                       admin POST :id/settle-refund-due → REFUND_DUE  (B1#4)  │
 * │ FUNDING                USDC mungkin   fundAndPrepare sukses → FUNDED                         │
 * │                                       admin PATCH status → RECLAIM_DUE                       │
 * │ FUNDED                 USDC PINDAH    submitBurn → BURN_SUBMITTED                            │
 * │                                       admin PATCH status → RECLAIM_DUE                       │
 * │ BURN_SUBMITTED         USDC PINDAH    refreshStatus (poll CC) → IN_TRANSIT/DELIVERED/…       │
 * │                                       admin POST :id/recover-burn-submitted → FUNDED         │
 * │ IN_TRANSIT             USDC PINDAH    refreshStatus (poll CC) → DELIVERED                    │
 * │ RECLAIM_DUE            USDC PINDAH    admin PATCH status → CANCELED (sesudah reclaim/ditutup; │
 * │                                         refundSafe TIDAK disentuh, tetap false)              │
 * │ SHIP_FAILED_POST_BURN  USDC PINDAH    admin PATCH status → DELIVERED (kasus support tuntas)  │
 * │ PACKING (record-only)  nol            admin PATCH status → SHIPPED/CANCELED                  │
 * │ SHIPPED (record-only)  nol            admin PATCH status → DELIVERED                         │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Pagar sebenarnya tetap ganda: cek ini (per-user, pesan ramah) + partial unique index di DB
 * (global per nftAddress). Cek API ini BERDIRI SENDIRI — ia sudah menutup lubangnya meskipun
 * index-nya tidak pernah dilebarkan.
 */
const ACTIVE_STATUSES: RedemptionStatus[] = [
  // Jalur record-only (lama).
  RedemptionStatus.REQUESTED,
  RedemptionStatus.PACKING,
  RedemptionStatus.SHIPPED,
  // Jalur REAL (CC Vault Shipping).
  RedemptionStatus.AWAITING_PAYMENT,
  RedemptionStatus.READY_TO_FUND,
  RedemptionStatus.FUNDING,
  RedemptionStatus.FUNDED,
  RedemptionStatus.BURN_SUBMITTED,
  RedemptionStatus.IN_TRANSIT,
  RedemptionStatus.RECLAIM_DUE,
  RedemptionStatus.SHIP_FAILED_POST_BURN,
];

/**
 * B1 — status redemption yang boleh dibatalkan SENDIRI oleh user. Daftarnya pendek DENGAN SENGAJA:
 * batal-sendiri hanya sah selama NOL uang bergerak. READY_TO_FUND berarti ongkir Rupiah SUDAH
 * lunas, dan FUNDING/FUNDED ke atas berarti USDC treasury sudah/mungkin pindah — dua-duanya
 * keputusan uang, jadi jalan keluarnya lewat admin (audited), bukan lewat tombol user.
 */
const USER_CANCELABLE_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.AWAITING_PAYMENT,
];

/**
 * Status PaymentOrder ongkir yang MELARANG batal-sendiri.
 *
 * ┌─ B1 (KAMBUH KE-3) — DAFTAR INI PERNAH BERISI `FULFILLING` DAN `REFUND_DUE`. ITU BUG. ────────┐
 * │ Menambahkan keduanya membuat AWAITING_PAYMENT jadi KUNCI KARTU PERMANEN, karena KEEMPAT      │
 * │ jalan keluarnya ikut tertutup sekaligus oleh satu daftar yang sama:                          │
 * │   • batal user             → 400 CANCEL_PAYMENT_LANDED (daftar ini)                          │
 * │   • terbitkan invoice lagi → 400 (SHIPPING_MONEY_LANDED_STATUSES di PaymentsService)         │
 * │   • sapuan kedaluwarsa     → butuh order PENDING|PAID; FULFILLING/REFUND_DUE tak pernah cocok│
 * │   • fulfilShipping         → tidak akan pernah jalan lagi                                    │
 * │ dan admin pun tidak punya transisi keluar dari AWAITING_PAYMENT. Sebuah proses yang mati     │
 * │ tepat sesudah klaim atomik (deploy/OOM/restart droplet) sudah cukup untuk memicunya.         │
 * │                                                                                              │
 * │ KENAPA MELEPASKAN KEDUANYA AMAN: di AWAITING_PAYMENT, baris REDEMPTION-nya NOL uang. Utang   │
 * │ refund — kalau ada — hidup di baris PaymentOrder, dan baris itu TIDAK ikut dibatalkan:       │
 * │ `recordShippingRefundDebts` menjadikannya REFUND_DUE (FULFILLING) atau melaporkannya apa     │
 * │ adanya (REFUND_DUE). Uangnya jadi UTANG TERCATAT, bukan alasan mengunci kartu.               │
 * │                                                                                              │
 * │ YANG TETAP MEMBLOKIR, dan kenapa keduanya punya jalan keluar SENDIRI:                        │
 * │   PAID      — reconciler memindai PAID → verifyAndFulfil → fulfilShipping → READY_TO_FUND    │
 * │               (atau REFUND_DUE kalau barisnya sudah pindah). Mesinnya MASIH BEKERJA; batal   │
 * │               di sini cuma balapan tanpa guna. Kalau user benar-benar ingin batal: admin.    │
 * │   FULFILLED  — ongkirnya SUDAH dilayani, jadi redemption-nya mestinya READY_TO_FUND, bukan   │
 * │               AWAITING_PAYMENT. Kombinasi mustahil → jangan dibereskan lewat tombol user.    │
 * │ Keduanya tetap bisa dikeluarkan lewat POST /admin/redemptions/:id/cancel-awaiting-payment.   │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 */
const CANCEL_BLOCKING_ORDER_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FULFILLED,
];

/** Diekspor untuk diuji lengkap terhadap enum (tak boleh ada status yang tak terklasifikasi). */
export const REDEMPTION_ACTIVE_STATUSES: readonly RedemptionStatus[] =
  ACTIVE_STATUSES;
export const REDEMPTION_TERMINAL_STATUSES: readonly RedemptionStatus[] =
  TERMINAL_STATUSES;

function toDto(r: CardRedemption): CardRedemptionDto {
  return {
    id: r.id,
    nftAddress: r.nftAddress,
    listingId: r.listingId,
    cardName: r.cardName,
    cardImage: r.cardImage,
    cardSet: r.cardSet,
    recipientName: r.recipientName,
    city: r.city,
    country: r.country,
    status: r.status,
    createdAt: r.createdAt,
  };
}

/**
 * Redeem kartu vault → kirim fisik ke rumah.
 *
 * RECORD-ONLY (MVP): mencatat permintaan + tujuan kirim dan menulis satu baris feed
 * `SEND_TO_HOME`. TIDAK burn NFT, TIDAK transfer aset, TIDAK menyentuh treasury/on-chain —
 * pemenuhan fisik ditangani admin manual. (Kalau nanti ada yang menambah burnV1/transferV1 di
 * sini, itu memindahkan/menghancurkan aset on-chain nyata — JANGAN, kecuali diarmed sadar.)
 */
@Injectable()
export class RedemptionService {
  private readonly logger = new Logger(RedemptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ccShipping: CcShippingService,
    private readonly payments: PaymentsService,
  ) {}

  async request(
    dto: RequestRedemptionDto,
    user: AuthUser,
  ): Promise<CardRedemptionDto> {
    // ╔════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ 1. KEPEMILIKAN lewat LEDGER, bukan klaim klien — TIGA sumber kartu yang sah.           ║
    // ╚════════════════════════════════════════════════════════════════════════════════════════╝
    //   (a) hasil PACK yang OPENED (ccPackPurchase)                → fisiknya di gudang CC
    //   (b) kartu DIBELI di marketplace (Listing SOLD, buyerId=user) yang punya alamat NFT
    //                                                               → fisiknya di gudang CC / P2P
    //   (c) STOK HOSHI yang DIBELI user (Listing SOLD, buyerId=user, sellable, tanpa penjual
    //       user, source != COLLECTORCRYPT)                         → fisiknya DI HOSHI, Indonesia
    //
    // (c) adalah jalur DOMESTIK dan ia TIDAK PUNYA alamat NFT: fulfilHoshiInventory settle
    // DATABASE-ONLY ("nol on-chain"). Sebelum jalur ini ada, kartu seperti itu ditolak
    // CARD_NOT_YOURS — kepada orang yang benar-benar membeli dan membayarnya.
    //
    // Info kartu (nama/gambar/set) selalu diambil dari sumber yang cocok, bukan dari body.
    let cardName = 'Kartu';
    let cardImage: string | null = null;
    let cardSet: string | null = null;
    // ASAL kartu → petunjuk siapa yang kirim fisik. PACK/CC_CATALOG/P2P fisiknya di gudang CC (CC
    // kirim); HOSHI = stok fisik Hoshi sendiri (Hoshi kirim). Di-snapshot saat request.
    // LABEL, BUKAN GERBANG: yang menentukan rail adalah `listingId` di bawah.
    let source = 'PACK';
    /**
     * IDENTITAS kartu yang ditulis ke kolom `nftAddress` — yaitu kunci PARTIAL UNIQUE INDEX
     * anti-dobel-kirim. Jalur CC: alamat NFT sungguhan. Jalur domestik: `hoshi-listing:<id>`.
     */
    let identity: string;
    /** NON-NULL ⇒ baris ini jalur DOMESTIK. Ditulis SEKALI, di sini, dan tidak pernah lagi. */
    let listingId: string | null = null;
    /** Alamat NFT WARISAN pada listing stok Hoshi (biasanya kosong) — ikut dicek anti-dobel. */
    let legacyNftKeys: string[] = [];

    // 0. TARGET: TEPAT SATU dari nftAddress / listingId. Menerima keduanya akan membuat klien
    //    memilih rail-nya sendiri, dan rail adalah keputusan SERVER (ia yang menentukan apakah
    //    ada NFT yang dibakar dan USDC treasury yang berpindah).
    const wantNft = (dto.nftAddress ?? '').trim();
    const wantListing = (dto.listingId ?? '').trim();
    if ((wantNft === '') === (wantListing === '')) {
      throw domesticError({
        status: HttpStatus.BAD_REQUEST,
        code: DOMESTIC_ERROR_CODE.TARGET_REQUIRED,
        message:
          'Sebutkan TEPAT SATU: nftAddress (kartu vault CollectorCrypt / hasil pack) atau ' +
          'listingId (kartu stok Hoshi yang kamu beli).',
      });
    }

    if (wantListing !== '') {
      // ── (c) STOK HOSHI — jalur DOMESTIK ────────────────────────────────────────────────────
      const listing = await this.prisma.listing.findFirst({
        where: {
          id: wantListing,
          buyerId: user.id,
          status: ListingStatus.SOLD,
        },
        include: {
          nft: { select: { assetAddress: true } },
          consignment: {
            select: {
              id: true,
              status: true,
              custodyAcceptedAt: true,
              custodyReleasedAt: true,
            },
          },
        },
      });
      // ╔════════════════════════════════════════════════════════════════════════════════════╗
      // ║ DUA PERTANYAAN BERBEDA, DAN KEDUANYA HARUS DITANYAKAN.                             ║
      // ╚════════════════════════════════════════════════════════════════════════════════════╝
      //
      // (1) DIKIRIMNYA LEWAT MANA — `isDomesticShippableStock`. SENGAJA LEBIH LUAS dari
      //     `isHoshiSellableStock`: ia ikut memuat kartu TITIPAN, yang fisiknya juga ada di rak
      //     Hoshi di Indonesia dan karenanya juga dikirim kurir lokal. Tanpa pelebaran ini,
      //     PEMBELI KARTU TITIPAN MEMBAYAR RUPIAH LALU TIDAK BISA MEMINTA PENGIRIMAN, SELAMANYA:
      //     `isHoshiSellableStock` menuntut `sellerId == null`, yang tidak pernah benar untuk
      //     titipan.
      //
      //     Yang TIDAK dilakukan: melonggarkan `isHoshiSellableStock` itu sendiri. Predikat itu
      //     DIPAKAI BERSAMA dengan gerbang BELI, dan melonggarkannya akan mengarahkan kartu
      //     titipan ke `fulfilHoshiInventory` — Hoshi menyimpan 100%, pemilik kartunya tidak
      //     dibayar sepeser pun. Lihat src/common/hoshi-domestic-shipping.ts.
      //
      // (2) MASIH ADA ATAU TIDAK — untuk titipan, `isPhysicallyHeldByHoshi`, BUKAN
      //     `isInHoshiCustody`. Pertanyaannya di sini murni fisik: kartunya masih di rak atau
      //     tidak. Kartu yang BARU SAJA TERJUAL statusnya SOLD dan memang tidak boleh dijual
      //     lagi — tapi ia MASIH di rak, dan justru pembelinyalah yang sekarang berhak
      //     memintanya dikirim. Memakai gerbang "boleh dijual" di sini menolak setiap pembeli
      //     yang sudah membayar. Kartu yang sudah keluar
      //     dari rak (ditarik, sudah dikirim, atau hilang) tidak bisa dijanjikan lagi ke siapa
      //     pun. Ini FAKTA tersimpan, bukan flag.
      //
      // Yang tetap ditolak sama seperti sebelumnya: baris seed/placeholder (sellable=false),
      // listing user lain yang BUKAN titipan, katalog CC (itu jalur CC Vault, bukan kurir
      // domestik), dan apa pun yang bukan SOLD ke pemanggil.
      if (!listing || !isDomesticShippableStock(listing)) {
        this.logger.warn(
          `Redeem domestik ditolak: listing ${wantListing} bukan stok Hoshi sellable / kartu ` +
            `titipan yang SOLD ke user ${user.id}.`,
        );
        throw domesticError({
          status: HttpStatus.FORBIDDEN,
          code: DOMESTIC_ERROR_CODE.NOT_YOUR_STOCK,
          message:
            'Kartu ini bukan stok Hoshi milikmu (bukan pembelianmu, atau bukan kartu stok Hoshi ' +
            'yang dijual).',
        });
      }
      if (listing.consignmentId != null) {
        if (
          !listing.consignment ||
          !isPhysicallyHeldByHoshi(listing.consignment)
        ) {
          this.logger.error(
            `Redeem domestik ditolak: kartu titipan listing ${wantListing} sudah TIDAK ADA di ` +
              `penyimpanan Hoshi (consignment ${listing.consignmentId ?? 'null'}). Pembeli ` +
              `${user.id} sudah membayar — ini perlu diselesaikan manusia.`,
          );
          throw domesticError({
            status: HttpStatus.CONFLICT,
            code: DOMESTIC_ERROR_CODE.NOT_YOUR_STOCK,
            message:
              'Kartu ini sedang tidak berada di penyimpanan Hoshi, jadi permintaan kirim belum ' +
              'bisa dibuat. Tidak ada biaya yang dibuat dan tidak ada uang yang diambil — ' +
              'hubungi support Hoshi dengan menyebut ID kartu ini.',
          });
        }
      }
      cardName = listing.name;
      cardImage = listing.image ?? null;
      cardSet = listing.set ?? listing.category ?? null;
      // LABEL, BUKAN GERBANG (railnya tetap `listingId`): operator perlu tahu kartu SIAPA yang
      // dipegangnya. Stok Hoshi boleh diapakan saja; kartu titipan adalah barang orang lain dan
      // pengirimannya menutup custody atas milik orang itu.
      source = listing.consignmentId != null ? 'CONSIGNMENT' : 'HOSHI';
      listingId = listing.id;
      identity = hoshiListingRef(listing.id);
      legacyNftKeys = [listing.ccNftAddress, listing.nft?.assetAddress].filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      );
    } else {
      // ── (a)/(b) jalur CC Vault ─────────────────────────────────────────────────────────────
      const pull = await this.prisma.ccPackPurchase.findFirst({
        where: {
          userId: user.id,
          nftAddress: wantNft,
          status: CcPackStatus.OPENED,
        },
      });
      if (pull) {
        cardName = pull.ccItemName ?? pull.nftName ?? 'Kartu';
        cardImage = pull.nftImage ?? null;
        cardSet = pull.ccSet ?? pull.ccCategory ?? null;
        source = 'PACK';
        identity = wantNft;
      } else {
        const bought = await this.prisma.listing.findFirst({
          where: {
            buyerId: user.id,
            status: ListingStatus.SOLD,
            OR: [{ ccNftAddress: wantNft }, { nft: { assetAddress: wantNft } }],
          },
          include: { nft: { select: { assetAddress: true } } },
        });
        if (!bought) {
          this.logger.warn(
            `Redeem ditolak: NFT ${wantNft} bukan pack/pembelian user ${user.id}.`,
          );
          throw noEffectError(
            HttpStatus.FORBIDDEN,
            SHIPPING_ERROR_CODE.CARD_NOT_YOURS,
            'Kartu ini bukan milikmu di Hoshi (bukan hasil pack maupun pembelian).',
          );
        }
        cardName = bought.name;
        cardImage = bought.image ?? null;
        cardSet = bought.set ?? bought.category ?? null;
        if (isDomesticShippableStock(bought)) {
          // NORMALISASI IDENTITAS — dan ini yang menutup lubang "satu kartu, dua identitas".
          // Sebuah baris stok Hoshi bisa (dari jalur demo/warisan) punya alamat NFT. Kalau
          // permintaan lewat alamat itu dibiarkan jadi baris jalur CC, kartu fisik yang SAMA
          // punya DUA kunci anti-dobel berbeda (alamat NFT vs id listing) → dua permintaan kirim
          // aktif sekaligus, dua paket, satu kartu. Jadi apa pun kunci yang dikirim klien, stok
          // Hoshi SELALU mendarat di identitas domestik.
          //
          // Kartu TITIPAN ikut dinormalkan ke sini dengan predikat yang SAMA seperti di cabang
          // (c) di atas. Ia TIDAK PUNYA alamat NFT (CHECK constraint memaku `ccNftAddress` NULL,
          // dan settlement titipan tidak pernah me-mint), jadi cabang ini praktis tak terjangkau
          // untuknya — tapi memakai predikat yang sama di kedua tempat berarti tidak ada kartu
          // fisik yang bisa mendarat di rail yang berbeda tergantung kunci apa yang dikirim klien.
          // LABEL-nya dibedakan supaya operator tahu kartu siapa yang dipegangnya.
          source = bought.consignmentId != null ? 'CONSIGNMENT' : 'HOSHI';
          listingId = bought.id;
          identity = hoshiListingRef(bought.id);
          legacyNftKeys = [bought.ccNftAddress, bought.nft?.assetAddress].filter(
            (v): v is string => typeof v === 'string' && v.length > 0,
          );
        } else {
          // Beli dari user lain (sellerId ada) = P2P; katalog CC (source CC, tanpa penjual) =
          // CC_CATALOG; selain itu (source HOSHI tapi TIDAK sellable — baris warisan/demo) =
          // HOSHI. Perilaku cabang ini TIDAK BERUBAH dari sebelum jalur domestik ada.
          // (Kartu titipan tidak pernah sampai ke sini: cabang di atas sudah menangkapnya.)
          source =
            bought.sellerId != null
              ? 'P2P'
              : bought.source === 'COLLECTORCRYPT'
                ? 'CC_CATALOG'
                : 'HOSHI';
          identity = wantNft;
        }
      }
    }

    // 2. Alamat tujuan harus milik user.
    const addr = await this.prisma.shippingAddress.findFirst({
      where: { id: dto.shippingAddressId, userId: user.id },
    });
    if (!addr) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.ADDRESS_NOT_FOUND,
        'Alamat pengiriman tidak ditemukan. Tambahkan alamat dulu di Settings.',
      );
    }

    // 3. Anti-dobel: satu kartu tidak boleh punya dua permintaan kirim yang masih aktif.
    //    Kuncinya BEDA per rail, dan itu memang benar:
    //      • jalur CC       → (userId, nftAddress). Sama seperti sebelumnya, byte-for-byte.
    //      • jalur DOMESTIK → (listingId) SECARA GLOBAL, tanpa userId. Satu baris listing = satu
    //        kartu FISIK di rak Hoshi; mengikat cek ini ke userId akan membiarkan dua paket
    //        keluar untuk satu kartu kalau entah bagaimana ada dua pengklaim.
    //    Untuk jalur domestik, alamat NFT WARISAN listing yang sama ikut diperiksa: baris jalur
    //    CC yang lahir SEBELUM normalisasi identitas ada tetap harus memblokir.
    const active = await this.prisma.cardRedemption.findFirst({
      where:
        listingId !== null
          ? {
              status: { in: ACTIVE_STATUSES },
              OR: [
                { listingId },
                { nftAddress: identity },
                ...(legacyNftKeys.length > 0
                  ? [{ nftAddress: { in: legacyNftKeys } }]
                  : []),
              ],
            }
          : {
              userId: user.id,
              nftAddress: identity,
              status: { in: ACTIVE_STATUSES },
            },
    });
    if (active) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.ALREADY_ACTIVE,
        'Kartu ini sudah dalam proses pengiriman fisik.',
      );
    }

    // 4. Record + activity dalam SATU transaksi. NOL burn/transfer — murni catatan.
    //    Gerbang anti-dobel yang SEBENARNYA = DUA partial unique index di DB, keduanya atas
    //    daftar status aktif yang SAMA:
    //      • card_redemptions_active_nft_uniq     (nftAddress) — berlaku untuk KEDUA rail,
    //        karena identitas domestik pun ditulis ke kolom itu (`hoshi-listing:<id>`).
    //      • card_redemptions_active_listing_uniq (listingId)  — kunci SEBENARNYA jalur
    //        domestik; baris jalur CC ber-listingId NULL dan NULL tak pernah bentrok.
    //    Pre-check langkah 3 di atas cuma jalur cepat untuk error ramah di kasus berurutan;
    //    dua request PARALEL yang lolos pre-check kalah di sini (P2002) → tetap ditolak dengan pesan
    //    yang sama. Tanpa constraint DB ini, cek aplikasi TOCTOU bisa menghasilkan dobel-kirim fisik.
    let created: CardRedemption;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.cardRedemption.create({
          data: {
            userId: user.id,
            // Identitas yang DIPUTUSKAN SERVER (lihat blok 1), bukan string dari body.
            nftAddress: identity,
            // Ditulis SEKALI. NON-NULL = jalur domestik; ini satu-satunya penulisnya di repo.
            listingId,
            cardName,
            cardImage,
            cardSet,
            source,
            shippingAddressId: addr.id,
            recipientName: addr.fullName,
            country: addr.country,
            street: addr.street,
            apt: addr.apt,
            city: addr.city,
            state: addr.state,
            zip: addr.zip,
            phoneCountryCode: addr.phoneCountryCode,
            phoneNumber: addr.phoneNumber,
            status: RedemptionStatus.REQUESTED,
          },
        });
        await tx.activity.create({
          data: {
            type: ActivityType.SEND_TO_HOME,
            itemName: cardName,
            itemImage: cardImage,
            category: cardSet,
            set: cardSet,
            amount: null, // tak ada nominal uang
            fromId: user.id,
            fromLabel: user.displayName ?? user.walletAddress,
            toLabel: addr.city,
          },
        });
        return row;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw noEffectError(
          HttpStatus.BAD_REQUEST,
          SHIPPING_ERROR_CODE.ALREADY_ACTIVE,
          'Kartu ini sudah dalam proses pengiriman fisik.',
        );
      }
      throw err;
    }

    this.logger.log(
      `Redemption ${created.id} REQUESTED: ` +
        (listingId !== null
          ? `STOK HOSHI (kurir domestik) listing ${listingId}`
          : `NFT ${identity}`) +
        ` → ${addr.city} (user ${user.id}). RECORD-ONLY — tidak ada burn/transfer.`,
    );
    return toDto(created);
  }

  /**
   * B1 — BATALKAN SENDIRI permintaan kirim yang BELUM menyentuh uang.
   *
   * KENAPA ADA: tanpa rute ini, AWAITING_PAYMENT adalah KUNCI KARTU PERMANEN. User menekan
   * "Bayar ongkir", baris pindah REQUESTED → AWAITING_PAYMENT, lalu ia menutup tab IDRX. Baris itu
   * memblokir (ACTIVE_STATUSES + partial unique index), dan sebelum perubahan ini TIDAK ADA satu
   * pun transisi di seluruh repo yang bisa mengeluarkannya — POST /redemptions menjawab 400
   * REDEMPTION_ALREADY_ACTIVE selamanya dan hanya edit Postgres langsung yang menolong.
   *
   * PAGAR UANG (JANGAN dilonggarkan) — tiga lapis, semuanya harus lolos:
   *   1. STATUS: hanya REQUESTED / AWAITING_PAYMENT. READY_TO_FUND ke atas = Rupiah SUDAH lunas
   *      atau USDC sudah/mungkin pindah → itu urusan admin (audited), bukan tombol user.
   *   2. LEDGER ORDER: tidak boleh ada order ongkir yang MASIH PUNYA JALUR PEMENUHAN HIDUP
   *      (PAID = reconciler masih akan menebusnya; FULFILLED = ongkirnya sudah dilayani).
   *      `FULFILLING` dan `REFUND_DUE` SENGAJA TIDAK di daftar itu — lihat komentar panjang di
   *      CANCEL_BLOCKING_ORDER_STATUSES: memblokir keduanya menutup SETIAP jalan keluar
   *      AWAITING_PAYMENT sekaligus, sementara membiarkannya lewat tidak menghilangkan uang
   *      (utangnya pindah/tetap ke baris PaymentOrder lewat recordShippingRefundDebts).
   *   3. BUKTI DI BARIS: fundingSignature WAJIB null dan refundSafe WAJIB true. Dua kolom itu
   *      adalah catatan PASCA-danai; kalau salah satunya sudah menyimpang, batal ditolak. Keduanya
   *      ikut jadi PREDIKAT di updateMany — dibaca, TIDAK PERNAH ditulis (nothing writes
   *      refundSafe=true, di sini pun tidak).
   *
   * BALAPAN: tulisannya updateMany berpagar, jadi ia head-to-head dengan klaim
   * PaymentsService.fulfilShipping (AWAITING_PAYMENT → READY_TO_FUND). Tepat satu yang menang.
   * Kalau fulfilShipping yang menang, batal ini count===0 → 409 dan baris tetap hidup. Kalau batal
   * ini yang menang, fulfilShipping-lah yang count!==1 → failToRefund menandai order REFUND_DUE
   * dengan refundSafe=true: utang refund yang TERCATAT, bukan uang yang hilang diam-diam.
   *
   * NOL on-chain, NOL treasury, NOL panggilan CC. Tidak digerbang HOSHI_CC_SHIPPING_ENABLED —
   * baris record-only juga harus bisa dibatalkan saat fitur real-nya mati.
   */
  async cancel(
    id: string,
    user: AuthUser,
    reason?: string,
  ): Promise<
    CardRedemptionDto & {
      warning: string;
      shippingDebts: ShippingRefundDebt[];
    }
  > {
    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw noEffectError(
        HttpStatus.NOT_FOUND,
        SHIPPING_ERROR_CODE.REDEMPTION_NOT_FOUND,
        'Redemption tidak ditemukan.',
      );
    }
    if (row.userId !== user.id) {
      this.logger.warn(
        `Batal redemption ${id} ditolak untuk user ${user.id} (pemilik: ${row.userId}).`,
      );
      throw noEffectError(
        HttpStatus.FORBIDDEN,
        SHIPPING_ERROR_CODE.REDEMPTION_NOT_YOURS,
        'Redemption ini bukan milik Anda.',
      );
    }

    // 1. STATUS.
    if (!USER_CANCELABLE_STATUSES.includes(row.status)) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.CANCEL_NOT_ALLOWED,
        `Permintaan kirim ini tidak bisa dibatalkan sendiri (status ${row.status}). ` +
          'Ongkir sudah dibayar atau pengiriman sudah berjalan — hubungi support.',
        row.id,
      );
    }

    // 3. BUKTI DI BARIS (dicek lebih dulu: murah, dan menutup baris yang jelas pasca-danai).
    if (row.fundingSignature !== null || row.refundSafe !== true) {
      this.logger.error(
        `Batal redemption ${row.id} DITOLAK: baris ${row.status} tapi membawa jejak PASCA-danai ` +
          `(fundingSignature=${row.fundingSignature ? 'ada' : 'null'}, refundSafe=${row.refundSafe}). ` +
          'Butuh penyelesaian manual — JANGAN refund sebelum dicek on-chain.',
      );
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.CANCEL_NOT_ALLOWED,
        'Permintaan kirim ini tidak bisa dibatalkan sendiri — ada jejak pendanaan di baris ini. ' +
          'Hubungi support dengan menyebut id redemption.',
        row.id,
      );
    }

    // 2. LEDGER ORDER.
    const landed = await this.prisma.paymentOrder.findFirst({
      where: {
        redemptionId: row.id,
        packType: 'SHIPPING',
        status: { in: CANCEL_BLOCKING_ORDER_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (landed) {
      this.logger.warn(
        `Batal redemption ${row.id} ditolak: order ongkir ${landed.merchantOrderId} berstatus ` +
          `${landed.status} (pemenuhannya masih hidup / sudah tuntas). Penyelesaian lewat admin.`,
      );
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.CANCEL_PAYMENT_LANDED,
        'Pembayaran ongkir untuk permintaan ini sudah masuk dan masih diproses, jadi tidak bisa ' +
          'dibatalkan sendiri. Tunggu prosesnya selesai, atau hubungi support untuk ' +
          'penyelesaian/refund.',
        row.id,
      );
    }

    const trimmed = (reason ?? '').trim().slice(0, 200);
    // Catatannya TIDAK BOLEH lagi berbunyi "nol pembayaran ongkir mendarat": sejak pagar
    // dipersempit, batal SAH juga ketika ada order ongkir yang macet di FULFILLING / sudah
    // REFUND_DUE. Yang benar-benar dijamin di sini adalah "baris INI nol uang".
    const note = appendBoundedNote(
      row.note,
      `[USER CANCEL ${new Date().toISOString()} oleh ${user.id}] dari status ${row.status}; ` +
        'baris redemption nol uang (fundingSignature null, refundSafe true) dan tidak ada order ' +
        'ongkir PAID/FULFILLED. Utang ongkir — bila ada — dicatat di PaymentOrder-nya sendiri.' +
        `${trimmed ? ` Alasan user: ${trimmed}` : ''}`,
      NOTE_MAX,
    );

    // Tulisan BERPAGAR — predikatnya mengulang KETIGA lapis pagar supaya keputusan di atas tidak
    // bisa basi karena balapan. refundSafe hanya DIBACA di sini; ia tidak pernah ditulis.
    const canceled = await this.prisma.cardRedemption.updateMany({
      where: {
        id: row.id,
        userId: user.id,
        status: { in: USER_CANCELABLE_STATUSES },
        fundingSignature: null,
        refundSafe: true,
      },
      data: {
        status: RedemptionStatus.CANCELED,
        processedAt: new Date(),
        note,
      },
    });
    if (canceled.count !== 1) {
      throw noEffectError(
        HttpStatus.CONFLICT,
        SHIPPING_ERROR_CODE.CANCEL_RACE,
        'Permintaan kirim ini baru saja berpindah status (mungkin pembayaranmu masuk). ' +
          'Muat ulang halamannya lalu cek lagi.',
        row.id,
      );
    }

    this.logger.log(
      `Redemption ${row.id} DIBATALKAN user ${user.id} dari status ${row.status} ` +
        `(NFT ${row.nftAddress}). Nol dana bergerak di BARIS INI; kartunya bebas diminta kirim lagi.`,
    );

    // PEMBUKUAN SESUDAH PEMBATALAN — WAJIB, dan wajib SESUDAH tulisan di atas commit.
    // Baris redemption-nya nol uang, tapi order ongkirnya mungkin TIDAK: yang macet di FULFILLING
    // di sini diubah jadi REFUND_DUE (utang tercatat), yang sudah REFUND_DUE dilaporkan apa adanya.
    // Helper-nya tidak pernah melempar — pembatalan yang sudah sah tidak boleh berubah jadi 500.
    const shippingDebts = await recordShippingRefundDebts({
      prisma: this.prisma,
      logger: this.logger,
      redemptionId: row.id,
      // RAIL + STATUS-SEBELUM dibaca dari BARIS yang baru saja kami batalkan, bukan dari flag:
      // keduanya menentukan apakah order ongkir FULFILLED adalah utang (rail domestik, pra-serah
      // terima) atau anomali yang butuh mata manusia (rail CC). `listingId` immutable, jadi
      // pembacaan ini tidak bisa basi.
      rail: isDomesticRedemption(row) ? 'HOSHI_DOMESTIC' : 'CC_VAULT',
      canceledFromStatus: row.status,
      actor: `user ${user.id}`,
      reason: trimmed || 'tanpa alasan',
    });

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id: row.id },
    });
    return {
      ...toDto(updated ?? { ...row, status: RedemptionStatus.CANCELED }),
      warning:
        'Permintaan kirim dibatalkan. Tidak ada dana yang berpindah dari permintaan ini. Kalau kamu ' +
        'SUDAH terlanjur membayar invoice ongkirnya, pembayaran itu TETAP TERCATAT sebagai utang ' +
        'refund pada tagihannya sendiri (tidak ikut terhapus) — hubungi support dengan menyebut id ' +
        'redemption ini.',
      /** Tagihan ongkir yang terpengaruh + apa yang harus dilakukan operator. [] = tidak ada. */
      shippingDebts,
    };
  }

  async listMine(userId: string): Promise<CardRedemptionDto[]> {
    const rows = await this.prisma.cardRedemption.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toDto);
  }

  /* ──────────────── Jalur DOMESTIK (stok Hoshi, kurir lokal) ────────────────
     TIDAK digerbang HOSHI_CC_SHIPPING_ENABLED: nol CC, nol USDC, nol burn, nol tanda tangan.
     Penerbitan tagihan ongkirnya ada di PaymentsService.createDomesticShippingOrder
     (POST /payments/shipping/domestic) — rail invoice IDRX yang SUDAH ADA, bukan rail kedua. */

  /**
   * Ongkir domestik untuk satu redemption. READ-ONLY (nol uang, nol order). Delegasi tipis ke
   * PaymentsService supaya angka yang DILIHAT user dan angka yang DITAGIHKAN lahir dari satu
   * fungsi resolusi tarif yang sama.
   */
  domesticQuote(id: string, user: AuthUser): Promise<DomesticShippingQuote> {
    return this.payments.quoteDomesticShipping(id, user);
  }

  /* ---------------------- Jalur REAL (CC Vault Shipping) ---------------------- */
  /* Semua di bawah DIGERBANG HOSHI_CC_SHIPPING_ENABLED di dalam CcShippingService.assertEnabled();
     kalau mati, mereka menolak dan perilaku record-only di atas tidak berubah sama sekali. */

  /**
   * Taksiran ongkir untuk redemption ini: USD + USDC base unit + Rupiah. Tidak menyentuh dana dan
   * tidak membuat shipment (efek sampingnya cuma memastikan alamat kirim ada di CC). Rupiah dihitung
   * lewat PaymentsService.quoteRupiah — SUMBER HARGA yang sama dengan invoice ongkir (createShippingOrder)
   * — supaya angka yang dilihat user dan yang ditagihkan tidak lahir dari dua kalkulasi berbeda.
   */
  async estimate(
    id: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<{ usd: number; usdcBaseUnits: number; rupiah: number }> {
    const est = await this.ccShipping.estimateForRedemption(
      id,
      user,
      ccAccessToken,
    );
    const rupiah = await this.payments.quoteRupiah(est.usdcBaseUnits);
    return { usd: est.usd, usdcBaseUnits: est.usdcBaseUnits, rupiah };
  }

  /** Danai USDC ongkir ke wallet user + bangun transaksi burn UNSIGNED (money-critical, di CcShippingService). */
  fundAndPrepare(
    id: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<FundAndPrepareResult> {
    return this.ccShipping.fundAndPrepare(id, user, ccAccessToken);
  }

  /**
   * Terbitkan ULANG transaksi burn untuk redemption yang ongkirnya SUDAH didanai (status FUNDED) —
   * pemulihan resmi menurut dokumen CC saat set transaksi 15 menit / blockhash-nya kedaluwarsa
   * ("Calling prepare again with identical input returns the same shipment with fresh transactions").
   * NOL dana berpindah: jalur ini TIDAK PERNAH mendanai USDC lagi (uangnya sudah pindah saat FUNDED).
   */
  reprepareBurn(
    id: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<ReprepareResult> {
    return this.ccShipping.reprepareBurn(id, user, ccAccessToken);
  }

  /**
   * Teruskan transaksi burn+ship yang sudah ditandatangani user ke CC. `signedDelistTransactions`
   * dioper TERPISAH (bukan digabung ke signedTransactions) — CC memvalidasi kedua set itu sendiri.
   */
  submitBurn(
    id: string,
    user: AuthUser,
    ccAccessToken: string,
    signedTransactions: string[],
    signedDelistTransactions: string[] = [],
  ): Promise<{ status: RedemptionStatus; burnSignature: string | null }> {
    return this.ccShipping.submitBurn(
      id,
      user,
      ccAccessToken,
      signedTransactions,
      signedDelistTransactions,
    );
  }

  /** Poll status shipment CC → petakan ke status Hoshi + tracking. */
  async status(
    id: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<CardRedemptionDto & { trackingIds: string[]; trackingUrls: string[] }> {
    const row = await this.ccShipping.refreshStatus(id, user, ccAccessToken);
    return {
      ...toDto(row),
      trackingIds: row.trackingIds,
      trackingUrls: row.trackingUrls,
    };
  }

  /* ---------------------- SIWS (Track B) — login wallet ke CC ----------------------
     Pass-through tipis ke CcShippingService (relay + gerbang HOSHI_CC_SHIPPING_ENABLED).
     Guard kepemilikan wallet ada di controller; di sini murni delegasi. */

  /** Minta nonce SIWS CC untuk wallet user (partnerAppId/domain/uri disuntik service). */
  siwsNonce(wallet: string): Promise<CcSiwsNonceResponse> {
    return this.ccShipping.siwsNonce(wallet);
  }

  /** Verifikasi message+signature → token sesi CC (cca_/ccr_). */
  siwsVerify(
    message: string,
    signature: string,
  ): Promise<CcSiwsVerifyResponse> {
    return this.ccShipping.siwsVerify(message, signature);
  }

  /** Tukar refreshToken CC dengan pasangan token baru. */
  siwsRefresh(refreshToken: string): Promise<CcSiwsRefreshResponse> {
    return this.ccShipping.siwsRefresh(refreshToken);
  }
}
