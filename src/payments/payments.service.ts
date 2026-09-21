import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActivityType,
  ListingStatus,
  OfferStatus,
  PaymentStatus,
  RedemptionStatus,
} from '@prisma/client';
import type { Listing, PaymentOrder } from '@prisma/client';
import { detectProductionSignal } from '../common/demo-mode';
import { PublicKey } from '@solana/web3.js';
import type { AuthUser } from '../auth/jwt.strategy';
import {
  GachaPostSpendError,
  GachaService,
  TREASURY_MAX_PACK_PRICE_USDC,
} from '../collectorcrypt/gacha.service';
import { CcShippingService } from '../collectorcrypt/cc-shipping.service';
import { SHIPPING_FUND_MAX_PER_TX_USDC } from '../collectorcrypt/treasury.service';
import {
  ResellerPostBuyError,
  ResellerSettlementService,
  type ResellerSettleResult,
} from '../collectorcrypt/reseller-settlement.service';
import {
  EscrowService,
  EscrowTransferIndeterminateError,
} from '../escrow/escrow.service';
import { BalanceService } from '../balance/balance.service';
import {
  assertP2pSaleAvailable,
  isEscrowBackedUserListing,
  p2pModeOf,
  type P2pMode,
} from '../marketplace/p2p.gate';
import { PrismaService } from '../prisma/prisma.service';
import { isHoshiSellableStock } from '../common/hoshi-stock';
import { listingKindOf, type ListingKind } from '../common/listing-kind';
import {
  CONSIGNMENT_SALE_REASON,
  assertConsignmentSaleAvailable,
  consignmentSaleClaimWhere,
  isInHoshiCustody,
} from '../common/consignment.gate';
import { ConsignmentNotifyService } from '../consignment/consignment-notify.service';
import {
  CONSIGNMENT_ERROR_CODE,
  consignmentError,
} from '../common/consignment.errors';
import {
  DOMESTIC_ERROR_CODE,
  assertCcRail,
  assertDomesticRail,
  domesticError,
  isDomesticRedemption,
} from '../common/hoshi-domestic-shipping';
import {
  resolveDomesticShippingIdr,
  type DomesticShippingQuote,
} from './domestic-shipping-rate';
import { IDRX_MAX_MINT_IDR, IDRX_MIN_MINT_IDR } from './idrx-mint-bounds';
import { CreatePackOrderDto } from './dto/create-pack-order.dto';
import { IdrxClient } from './idrx.client';

/** Mesin default bila klien tidak menyebut packType — sama dengan jalur gacha. */
const DEFAULT_PACK_TYPE = 'pokemon_50';

/** USDC base unit: 6 desimal. $50 = 50_000_000. JANGAN pernah dibaca sebagai rupiah. */
const USDC_UNITS = 1_000_000;

const BPS_DENOMINATOR = 10_000;

/**
 * Biaya QRIS IDRX: 0,7% (untuk nominal ≤ Rp 10 juta), DIBEBANKAN DI ATAS jumlah yang
 * di-mint. Kita masukkan ke harga jual supaya treasury menerima penuh harga pack +
 * margin; kalau tidak, tiap pack diam-diam rugi 0,7%.
 */
const QRIS_FEE_BPS = 70;

/* Batas nominal mint-request IDRX (IDRX_MIN_MINT_IDR / IDRX_MAX_MINT_IDR) kini hidup di
   ./idrx-mint-bounds.ts — jalur ONGKIR DOMESTIK harus memvalidasi tarif yang di-set ADMIN
   terhadap batas yang SAMA, dan dua salinan konstanta uang adalah dua salinan yang bisa
   melenceng. Nilainya TIDAK berubah. */

/**
 * SOL minimum (lamports) yang harus tetap dipegang treasury untuk fee tx + kemungkinan
 * rent ATA saat menebus pack. Dipakai preflight: kalau SOL treasury di bawah ini, order
 * ditolak sebelum user bayar (treasury = fee payer; kehabisan SOL = fulfillment gagal).
 * 0,01 SOL — jauh di atas fee riil satu tx, longgar untuk rent akun bila perlu.
 */
const TREASURY_MIN_GAS_LAMPORTS = 10_000_000;

/** Margin Hoshi. Default 0 = jual seharga modal — angka bisnis harus DIPILIH sadar, bukan diwarisi. */
const DEFAULT_MARGIN_BPS = 0;

/**
 * Sinyal INTERNAL `fulfilConsignment`: klaim custody `LISTED → SOLD` kalah balapan melawan
 * penarikan oleh pemilik (atau penandaan hilang) yang terjadi PERSIS di tengah settlement.
 *
 * KENAPA LEMPAR, DAN BUKAN `return`: kedua klaimnya berada di dalam satu `$transaction`, dan
 * melempar adalah SATU-SATUNYA cara membatalkan klaim listing `ACTIVE → SOLD` yang sudah menang
 * di langkah sebelumnya. `return` akan meninggalkan listing SOLD atas nama pembeli sementara
 * kartunya justru pulang ke pemiliknya — persis bentuk half-state yang aturan
 * "pilih secara sadar antara rollback dan tidak" ada untuk mencegahnya.
 */
class ConsignmentCustodyRaceLost extends Error {
  constructor(readonly consignmentId: string) {
    super(
      `Custody titipan ${consignmentId} berubah di tengah settlement — transaksi dibatalkan.`,
    );
    this.name = 'ConsignmentCustodyRaceLost';
  }
}

/**
 * Umur order. Sengaja jauh lebih pendek dari default IDRX (120 menit): jendela bayar =
 * jendela di mana snapshot harga kita bisa basi, dan selisih harga CC selama jendela itu
 * ditanggung treasury (lihat DEFAULT_MAX_SLIPPAGE_BPS).
 */
const DEFAULT_EXPIRY_MINUTES = 30;

/** Order PENDING yang boleh menganggur per user. Bikin order itu gratis buat penyerang. */
const DEFAULT_MAX_OPEN_ORDERS = 3;

/**
 * Seberapa jauh harga mesin CC boleh NAIK antara "user bayar" dan "kita tebus" sebelum
 * kita menolak menebusnya. Ini angka yang SESEORANG PILIH, bukan properti yang muncul
 * sendiri gara-gara tidak ada yang membandingkan. Default 5%.
 */
const DEFAULT_MAX_SLIPPAGE_BPS = 500;

/** Plafon belanja treasury 24 jam — cermin GachaService, dipakai untuk MENOLAK SEBELUM user bayar.
 *  STAGING (branch staging-live): dinaikkan ke $100k supaya testing berulang tidak
 *  ketahan cap — aman karena staging memakai CC_MOCK (belanja treasury disimulasi, tak
 *  ada USDC nyata keluar). Prod (main) tetap default $500. Override runtime tetap bisa
 *  lewat env GACHA_TREASURY_DAILY_CAP_USDC. */
const TREASURY_DAILY_CAP_USDC = 100_000_000_000;
const TREASURY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Batas satu putaran reconciler — supaya backlog tidak pernah menyandera worker. */
const RECONCILE_BATCH_MAX = 50;

/**
 * Order yang lebih tua dari ini berhenti di-poll. IDRX menjamin token terkirim dalam 24 jam;
 * 7 hari memberi ruang lebar untuk kasus tepi tanpa membiarkan set polling tumbuh selamanya.
 */
const RECONCILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * B1 — SABUK-DAN-BRETEL untuk balapan kedaluwarsa-vs-pembayaran: seberapa lama sesudah sebuah
 * order JADI EXPIRED ia masih ikut diverifikasi ulang oleh reconciler.
 *
 * KENAPA ADA SAMA SEKALI: kedua jalur utang balapan ini (settleExpiredButPaid dan settleLostClaim)
 * dipicu oleh SEBUAH CALLBACK. Callback IDRX dikirim TEPAT SEKALI dan tidak pernah diulang, jadi
 * kalau callback-nya HILANG (deploy/OOM/502 tiga detik) tidak ada apa pun yang menyadari bahwa
 * order EXPIRED itu sebenarnya DIBAYAR. Sapuan ini menghapus ketergantungan itu.
 *
 * KENAPA DIBATASI `updatedAt`, BUKAN `createdAt`: `updatedAt` adalah detik ketika barisnya
 * benar-benar DITULIS jadi EXPIRED — awal jendela bahayanya. Satu jam sesudah itu, vonis terminal
 * IDRX sendiri tidak akan berbalik jadi PAID, dan baris yang jujur-kedaluwarsa (mayoritas mutlak)
 * berhenti dipoll selamanya alih-alih membebani History API tanpa batas. Baris yang MEMANG jadi
 * utang keluar dari himpunan ini lebih awal lagi: statusnya berubah jadi REFUND_DUE, dan filter
 * `status = EXPIRED` tidak melihatnya lagi → tidak mungkin ada utang kedua.
 */
const RECONCILE_EXPIRED_SWEEP_MS = 60 * 60 * 1000;

/** Batas batch sapuan EXPIRED. TERPISAH dan lebih kecil: ia tidak boleh menyandera jatah order
 *  PENDING/PAID yang masih bisa MAJU (yang itu menahan uang user yang belum jadi apa-apa). */
const RECONCILE_EXPIRED_BATCH_MAX = 25;

/**
 * B2 — JEDA MINIMAL sebelum baris EXPIRED yang jawabannya BELUM terminal ditanya ulang.
 *
 * Sapuan EXPIRED memilih baris yang sama selama SATU JAM penuh (baris yang jujur-kedaluwarsa tidak
 * pernah ditulis, jadi `updatedAt`-nya tidak bergerak dan ia tetap lolos filter). Pada interval
 * default 120 detik itu 30 tick — 30 panggilan History untuk SATU baris, yang semuanya menjawab hal
 * yang sama. Jeda ini yang memutusnya: baris yang sudah ditanya tidak ditanya lagi sebelum lewat.
 *
 * KENAPA TIDAK LANGSUNG "berhenti selamanya" untuk semua: hanya vonis TERMINAL IDRX ('EXPIRED')
 * yang tidak mungkin berbalik jadi PAID. 'WAITING_FOR_PAYMENT' MASIH bisa — dan menangkap
 * pembayaran terlambat itulah SATU-SATUNYA alasan jendela sejam ini ada. Jadi yang non-terminal
 * DIJEDA, bukan dihentikan.
 *
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ B1 — JEDA INI TIDAK BOLEH MENUTUP MULUT SAPUAN TEPAT SEBELUM JENDELANYA HABIS.             ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 * Jeda datar 10 menit yang TIDAK sadar tepi jendela membuka kembali lubang yang jadi ALASAN
 * sapuan ini ada. Jendelanya tertutup keras di `updatedAt >= now - RECONCILE_EXPIRED_SWEEP_MS`:
 * begitu lewat, baris itu TIDAK PERNAH ditanya lagi, selamanya. Kalau pertanyaan terakhir jatuh
 * 10 menit sebelum tepi itu, SEMUA pembayaran yang mendarat di 10 menit terakhir hilang tanpa
 * satu baris pun jejak — persis skenario "callback IDRX hilang" yang sapuan ini tangani, dan
 * `recordUnfulfilled` sudah terlanjur melepas redemption-nya AWAITING_PAYMENT → REQUESTED
 * sehingga layar user MENGUNDANG PEMBAYARAN KEDUA.
 *
 * ATURANNYA (lihat `quietExpiredSweepNonTerminal`): jeda non-terminal TIDAK PERNAH boleh
 * menjangkau MARGIN TERAKHIR jendela — dan marginnya adalah konstanta yang SAMA ini. Dengan
 * margin ≥ panjang jeda, jarak antara pertanyaan TERAKHIR dan tertutupnya jendela terbatas pada
 * SATU interval reconciler, berapa pun intervalnya:
 *   - interval ≥ jeda  → tiap tick memang sudah bertanya; paparannya satu interval.
 *   - interval < jeda  → margin (= jeda) memuat setidaknya satu tick, dan di dalam margin TIDAK
 *                        ADA jeda sama sekali, jadi tick TERAKHIR sebelum tepi pasti bertanya.
 * Harganya: beberapa panggilan History ekstra di ekor tiap baris non-terminal (pada interval
 * default 120 detik: ≤ 5 tick × 10 menit margin). Itu ditukar dengan tidak pernah kehilangan
 * pembayaran terlambat — pertukaran yang arahnya TIDAK boleh dibalik demi menghemat panggilan.
 */
const EXPIRED_SWEEP_RECHECK_MS = 10 * 60 * 1000;

/** B2 — plafon memori peta jeda. Di atas ini entri baru tidak ditambahkan: efeknya cuma
 *  "ditanya lagi nanti", TIDAK PERNAH "utang terlewat". */
const EXPIRED_SWEEP_QUIET_MAX = 5_000;

/** B2 — plafon panjang `notIn` yang dikirim ke Postgres. Sisanya ikut terambil dan ditanya ulang
 *  (aman, cuma boros) — lebih baik daripada mengirim predikat raksasa tiap tick. */
const EXPIRED_SWEEP_NOT_IN_MAX = 500;

const ERROR_MAX = 500;

/**
 * B1 — status PaymentOrder yang berarti pembayaran ongkir SUDAH MENDARAT (atau sedang
 * diselesaikan). Dipakai sebagai PAGAR untuk SATU hal saja: MENERBITKAN TAGIHAN KEDUA.
 * Selama satu saja order ongkir redemption ada di salah satu status ini, klaim AWAITING_PAYMENT-nya
 * TIDAK BOLEH dilepas ke REQUESTED — kalau dilepas, user mendapat invoice baru dan MEMBAYAR DUA
 * KALI untuk satu pengiriman, sementara Rupiah yang pertama masih menggantung.
 *
 * DAFTAR INI BUKAN LAGI PAGAR PEMBATALAN. Sampai pass ini, RedemptionService memakai daftar yang
 * IDENTIK untuk melarang batal-sendiri, dan itulah yang menutup SETIAP jalan keluar
 * AWAITING_PAYMENT sekaligus (B1, kambuh ke-3): satu daftar, empat pintu. Sekarang pembatalan
 * punya daftarnya SENDIRI yang lebih sempit (CANCEL_BLOCKING_ORDER_STATUSES di
 * redemption.service.ts) — membatalkan tidak menerbitkan tagihan apa pun, jadi ia tidak boleh
 * dipagari oleh alasan "nanti bayar dua kali".
 *
 * KARENA ITU 400 dari pagar ini TIDAK PERNAH BOLEH JADI BUNTU: pesannya WAJIB menunjuk jalan
 * keluar yang masih hidup (batalkan permintaannya, lalu minta kirim lagi).
 *
 * PENDING dan EXPIRED/FAILED SENGAJA TIDAK di sini: keduanya berarti nol Rupiah mendarat.
 */
const SHIPPING_MONEY_LANDED_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FULFILLING,
  PaymentStatus.FULFILLED,
  PaymentStatus.REFUND_DUE,
];

/**
 * B1 — TERMINAL TANPA PENYERAHAN. Dua sifat SEKALIGUS, dan keduanya wajib:
 *
 *   1. TERMINAL  — order tidak akan pernah maju lagi dengan sendirinya. Tak ada pemanggil yang
 *      sedang memegangnya, tak ada klaim yang sedang berjalan, tak ada mesin yang akan menebusnya.
 *   2. TANPA PENYERAHAN — status ini HANYA bisa dicapai TANPA klaim atomik pernah diambil, jadi
 *      TIDAK ADA satu pun jalur pemenuhan (gacha.purchase / reseller.settle / balance.credit /
 *      fulfilShipping) yang pernah berjalan atas order ini. EXPIRED cuma ditulis recordUnfulfilled
 *      berpredikat PENDING|PAID; FAILED tidak pernah ditulis kode produksi mana pun dan artinya
 *      (lihat markRefundDue) adalah "kami YAKIN tidak ada uang user yang tertahan".
 *
 * INI SATU-SATUNYA HIMPUNAN yang boleh diubah jadi UTANG ketika sebuah klaim KALAH sementara
 * pemanggilnya memegang bukti PAID+MINTED server-ke-server. Semua status lain yang bisa
 * memenangkan klaim itu (FULFILLING = pemenang sah sedang menyerahkan, FULFILLED = sudah
 * diserahkan, REFUND_DUE = utangnya sudah tercatat, PENDING/PAID = klaim dilepas untuk diulang
 * dan reconciler masih memiliki order itu) TIDAK BOLEH menghasilkan utang: itu akan
 * mendeklarasikan utang atas barang yang sudah/sedang dikirim, atau utang KEDUA.
 *
 * ⚠️ JANGAN pernah menambahkan status ke sini tanpa membuktikan sifat (2). Sebuah status yang
 * bisa dicapai SESUDAH penyerahan akan mengubah baris ini jadi mesin refund-dobel.
 */
const TERMINAL_UNDELIVERED_STATUSES: PaymentStatus[] = [
  PaymentStatus.EXPIRED,
  PaymentStatus.FAILED,
];

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

/**
 * B2 — APA yang dibayar order ini, dalam bahasa manusia.
 *
 * KENAPA ADA: kelas ini lahir sebagai rail pack, jadi hampir setiap log utangnya berbunyi "pack".
 * Sejak rail yang sama mengangkut TOP-UP, KARTU MARKETPLACE, dan ONGKIR KIRIM FISIK, kalimat itu
 * menyesatkan pada saat yang paling mahal: operator yang jam 3 pagi mencari "kenapa user bayar
 * ongkir tapi kartunya tidak dikirim" tidak akan pernah mencocokkan log yang bicara soal pack.
 * Label ini diturunkan dari KOLOM ORDER (sentinel packType/redemptionId/listingId yang di-set
 * SERVER), bukan dari tebakan — jadi ia tidak bisa dipalsukan lewat body klien.
 */
function orderSubject(order: PaymentOrder): string {
  if (order.packType === 'SHIPPING' || order.redemptionId) {
    return 'ONGKIR KIRIM FISIK';
  }
  if (order.packType === 'TOPUP') return 'TOP-UP SALDO';
  if (order.listingId) return 'KARTU MARKETPLACE';
  return 'PACK';
}

/**
 * Catatan mint IDRX seperti dikembalikan History API. Tipenya DITURUNKAN dari IdrxClient
 * (bukan di-import ulang) supaya bentuknya tidak pernah bisa berbeda dari yang benar-benar
 * dikembalikan klien.
 */
type IdrxMintRecord = NonNullable<
  Awaited<ReturnType<IdrxClient['findMintByMerchantOrderId']>>
>;

/** Hasil satu putaran verifikasi. Sengaja bukan exception: reconciler harus jalan terus. */
export type FulfilOutcome =
  | 'FULFILLED' // pack dibeli treasury & tertaut ke order ini
  | 'ALREADY_CLAIMED' // pihak lain (callback/reconciler) sudah menang klaim — INI NORMAL
  | 'AWAITING_PAYMENT' // belum PAID+MINTED; order tetap dipoll
  | 'EXPIRED' // jendela bayar habis tanpa pembayaran
  | 'REFUND_DUE' // user SUDAH BAYAR tapi pack tidak bisa diberikan → kita berutang
  | 'PIN_UNVERIFIABLE' // PAID+MINTED tapi field pin WAJIB (destinationWalletAddress) tak ada → tak bisa diputuskan
  | 'UNKNOWN_ORDER' // merchantOrderId tidak dikenal
  | 'VERIFY_FAILED'; // IDRX tidak bisa dihubungi → status TIDAK disentuh, coba lagi nanti

/**
 * Hasil pin catatan IDRX ke order kita:
 *  - null            → cocok, aman ditebus.
 *  - refund: true    → TERBUKTI menyimpang (mis. mint ke wallet lain / nominal kurang). Uang
 *                      user sudah bergerak tapi tidak seperti seharusnya → REFUND_DUE (antrean manual).
 *  - refund: false   → field pin WAJIB tidak ada di respons IDRX. Kita TIDAK bisa memastikan uang
 *                      mendarat di treasury → JANGAN tebus, tapi JANGAN pula deklarasikan utang:
 *                      tinggalkan statusnya, teriak di log, biarkan reconciler mencoba lagi.
 */
type PinResult = { refund: boolean; reason: string } | null;

/**
 * Hasil cek harga saat penebusan:
 *  - null              → harga masih layak (termasuk saat TURUN — itu untung kita).
 *  - permanent: true   → harga TERBUKTI melewati plafon slippage / mesin hilang. Uang sudah masuk,
 *                        packnya tak layak ditebus dengan snapshot lama → REFUND_DUE (antrean manual).
 *  - permanent: false  → harga CC tak terbaca (CC down/timeout). TRANSIEN dan PRA-belanja: klaim
 *                        dilepas kembali ke PAID supaya reconciler mencoba lagi. Tidak ada USDC
 *                        treasury yang bergerak, jadi melepasnya AMAN (beda dari kegagalan pasca-belanja).
 */
type PriceCheck = { permanent: boolean; reason: string } | null;

/**
 * B3 — SINYAL REFUND YANG DILIHAT USER. Turunan, bukan kolom mentah.
 *
 * ┌──── KENAPA TURUNAN DAN BUKAN `refundSafe` APA ADANYA ─────────────────────────────────────┐
 * │ `refundSafe` adalah kolom OPERASIONAL: ia menjawab "boleh tidak operator mentransfer uang  │
 * │ ini sekarang", dan `false` punya dua sebab yang keduanya bicara tentang KAMI, bukan tentang │
 * │ user (posisi USDC treasury yang belum diverifikasi on-chain; pin IDRX yang menyimpang       │
 * │ sehingga Rupiah-nya belum terbukti kami terima). User tidak butuh — dan tidak berhak —      │
 * │ membaca alasan internal itu; ia butuh SATU hal: uangnya kembali, sedang diperiksa, atau     │
 * │ perlu menghubungi kami.                                                                     │
 * │                                                                                             │
 * │ Dan ada alasan yang lebih keras: membocorkan kolomnya berarti bentuk respons publik kita    │
 * │ ikut berubah setiap kali kebijakan refund internal berubah. Turunan ini menahan perubahan   │
 * │ itu di satu fungsi (`deriveRefundState`) alih-alih menyebarkannya ke klien.                 │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 *  NONE         : bukan kasus refund sama sekali (status apa pun selain REFUND_DUE).
 *  IN_PROGRESS  : REFUND_DUE + refundSafe=true → utangnya TERCATAT dan operator memang diminta
 *                 mengembalikannya. Ini SATU-SATUNYA keadaan yang boleh berbunyi "dana kembali".
 *  UNDER_REVIEW : REFUND_DUE + refundSafe=false → reconciler secara EKSPLISIT menyuruh operator
 *                 JANGAN mengirim uang sampai diverifikasi di luar sistem. Tidak boleh pernah
 *                 dirender sebagai refund yang sedang berjalan.
 */
export type PaymentRefundState = 'NONE' | 'IN_PROGRESS' | 'UNDER_REVIEW';

/**
 * Kalimat siap-tampil untuk tiap keadaan. DITARUH DI SERVER dengan sengaja: kalau klien yang
 * mengarangnya, satu salah-pasang cabang cukup untuk menjanjikan refund kepada user yang justru
 * sedang ditahan operator. Nada NONE = null (tidak ada yang perlu dikatakan).
 */
const REFUND_NOTICE: Record<PaymentRefundState, string | null> = {
  NONE: null,
  IN_PROGRESS:
    'Pembayaran ini tercatat sebagai refund dan sedang kami proses manual — dananya dikembalikan ' +
    'ke sumber pembayaranmu. Kalau setelah 3 hari kerja belum masuk, hubungi support sambil ' +
    'menyebut kode order ini.',
  UNDER_REVIEW:
    'Pembayaran ini sedang KAMI PERIKSA dulu, jadi belum ada refund yang dijadwalkan. Hubungi ' +
    'support sambil menyebut kode order ini supaya bisa kami cek lebih cepat.',
};

/** Satu-satunya tempat kolom operasional `refundSafe` diterjemahkan jadi sinyal publik. */
function deriveRefundState(order: {
  status: PaymentStatus;
  refundSafe: boolean;
}): PaymentRefundState {
  if (order.status !== PaymentStatus.REFUND_DUE) return 'NONE';
  // FAIL-CLOSED: apa pun selain `true` yang eksplisit dianggap "tahan dulu". Kolomnya non-null di
  // schema, tapi gerbang uang tidak boleh bergantung pada janji itu.
  return order.refundSafe === true ? 'IN_PROGRESS' : 'UNDER_REVIEW';
}

/** Bentuk order yang aman dikirim ke klien. `error` sengaja TIDAK diekspos. */
export interface PaymentOrderDto {
  merchantOrderId: string;
  packType: string;
  /** Rupiah penuh (integer). */
  priceIdr: number;
  /** USDC base unit (6 desimal) — satuan BERBEDA dari priceIdr, jangan dibandingkan. */
  priceUsdc: number;
  paymentMethod: string;
  status: PaymentStatus;
  qrContent: string | null;
  virtualAccountNo: string | null;
  paymentUrl: string | null;
  packMemo: string | null;
  expiresAt: Date | null;
  createdAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  /**
   * B3 — sinyal refund TURUNAN. Kolom `refundSafe` sendiri TIDAK PERNAH diekspos. Riwayat
   * pembayaran WAJIB membedakan IN_PROGRESS dari UNDER_REVIEW: sebelum ini SETIAP user REFUND_DUE
   * diberi tahu refundnya sedang diproses — termasuk yang operatornya justru dilarang membayar.
   */
  refundState: PaymentRefundState;
  /** Kalimat siap-tampil untuk `refundState`. null ⇔ NONE. Ditentukan server, bukan klien. */
  refundNotice: string | null;
}

export interface ReconcileSummary {
  scanned: number;
  fulfilled: number;
  expired: number;
  refundDue: number;
  stillPending: number;
  verifyFailed: number;
}

/**
 * On-ramp rupiah → pack. GERBANG antara "user login" dan "treasury membelanjakan ~$50 USDC asli".
 *
 * Dua kalimat dari dokumentasi IDRX yang membentuk SELURUH desain kelas ini:
 *
 *  1. "No signature on the outgoing webhook." → body callback adalah PEMICU, BUKAN BUKTI.
 *     merchantOrderId pun bukan rahasia: kita sendiri yang menyerahkannya ke frontend supaya
 *     user bisa melihat QR-nya. Jadi siapa pun bisa mengarang POST "paymentStatus: PAID".
 *     Satu-satunya field yang boleh dibaca dari body itu adalah merchantOrderId; SETIAP
 *     keputusan uang diambil dari GET /api/transaction/user-transaction-history.
 *
 *  2. "The callback is not retried automatically." → callback bisa hilang selamanya. Maka
 *     SUMBER KEBENARAN sebenarnya adalah reconcile(), bukan callback. Ukurannya: kalau route
 *     callback DIHAPUS TOTAL, sistem ini harus tetap benar — cuma lebih lambat. handleCallback()
 *     memang tidak melakukan apa pun yang tidak dilakukan reconcile(); ia cuma mempercepatnya.
 *
 * Dan satu invariant yang menahan sisanya: KLAIM ATOMIK (PENDING|PAID → FULFILLING lewat
 * updateMany berpredikat status, lalu cek count === 1). Callback yang di-replay, callback yang
 * digandakan, dan callback yang balapan dengan reconciler semuanya bertabrakan di SATU baris,
 * dan tepat satu yang menang. Tanpa itu, satu pembayaran Rp 800.000 bisa ditukar jadi N pack.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /**
   * B2 — merchantOrderId → epoch ms sampai kapan sapuan EXPIRED TIDAK BOLEH menanyakannya lagi.
   *
   * MURNI DI MEMORI, dan itu disengaja: lihat `quietExpiredSweep`. Tidak ada kolom, tidak ada
   * tulisan, jadi peta ini TIDAK BISA berbohong tentang keadaan sebuah order — satu-satunya yang
   * dipengaruhinya adalah KAPAN kita bertanya lagi ke IDRX, bukan apa yang kita simpulkan.
   */
  private readonly expiredSweepQuiet = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly idrx: IdrxClient,
    private readonly gacha: GachaService,
    private readonly config: ConfigService,
    private readonly resellerSettlement: ResellerSettlementService,
    private readonly escrow: EscrowService,
    private readonly balance: BalanceService,
    private readonly ccShipping: CcShippingService,
    // Pemberitahuan ke PEMILIK KARTU TITIPAN. Di sinilah satu-satunya tempat yang tahu kartu
    // seseorang BARU SAJA terjual dan berapa persisnya yang masuk ke saldonya. Method-nya `void`
    // dan menelan errornya sendiri — email TIDAK PERNAH boleh menyentuh jalur uang.
    private readonly consignmentNotify: ConsignmentNotifyService,
  ) {}

  /* ─────────────────────────── Bikin order ─────────────────────────── */

  /**
   * Terbitkan tagihan rupiah untuk satu pack. TIDAK ADA USDC yang bergerak di sini.
   *
   * URUTANNYA ADALAH PROPERTI KEAMANANNYA:
   *   0. plafon treasury & kuota order  → MENOLAK SEBELUM user bayar itu GRATIS. Menolak
   *      SESUDAH user bayar berarti kita berutang refund (dan reputasi).
   *   1. snapshot harga mesin (USDC)    → nominal tidak pernah datang dari klien
   *   2. snapshot kurs IDRX (rupiah)    → integer, dibulatkan KE ATAS
   *   3. mint-request ke IDRX           → merchantOrderId lahir DI SANA
   *   4. persist baris PENDING          → baru sesudah ini user boleh melihat QR-nya
   */
  async createPackOrder(
    dto: CreatePackOrderDto,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();
    const packType = dto.packType ?? DEFAULT_PACK_TYPE;
    const method = dto.method ?? 'QRIS';

    await this.assertOrderQuota(user.id);

    // 1. Harga SELALU dari mesin mereka — tidak pernah di-hardcode, tidak pernah dari klien.
    const machines = await this.gacha.machines();
    const machine = machines.find((m) => m.code === packType);
    if (!machine) {
      throw new BadRequestException(
        `Mesin "${packType}" tidak tersedia di CollectorCrypt.`,
      );
    }
    const priceUsdc = machine.priceUsdcBaseUnits;
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) {
      this.logger.error(
        `Harga mesin ${packType} tidak masuk akal: ${priceUsdc} (USDC base unit). Order ditolak.`,
      );
      throw new ServiceUnavailableException(
        'Harga pack dari CollectorCrypt sedang tidak wajar. Coba lagi nanti.',
      );
    }

    // Plafon 24 jam dicek DI SINI, bukan cuma di dalam purchase(). Kalau baru dicek saat
    // fulfilment, plafon pengaman kita sendiri berubah jadi alat merampok user yang SUDAH bayar.
    await this.assertTreasuryCapacity(priceUsdc);

    // 2. Rupiah-kan. IDRX 1:1 dengan IDR → buyAmount dari rates() ADALAH harga rupiahnya.
    const priceIdr = await this.quoteRupiah(priceUsdc);

    // 3. merchantOrderId TIDAK kita karang: ia lahir di IDRX dan jadi kunci join semua hilir.
    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    const mint = await this.idrx.mintRequest({
      // Rupiah penuh sebagai string — persis nominal yang nanti kita cocokkan (toBeMinted >=)
      // saat verifikasi. destinationWalletAddress WAJIB treasury: user membayar rupiah, treasury
      // yang membelanjakan USDC; kalau ini pernah datang dari input user, kita mencetak IDRX ke
      // wallet mereka dan tetap membayari pack-nya.
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      // returnUrl WAJIB di kontrak IDRX (dipakai alur hosted; tak berbahaya di alur QRIS).
      returnUrl: this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
      expiryPeriod: expiryMinutes,
      productDetails: `Hoshi pack ${packType}`.slice(0, 255),
      // Alur DIRECT (QRIS) menuntut paymentMethod + channelId. Alur HOSTED mengosongkan keduanya
      // → IDRX mengembalikan paymentUrl yang mencakup QRIS + e-wallet + VA + retail.
      ...(method === 'QRIS'
        ? {
            paymentMethod: 'QRIS' as const,
            channelId: this.requiredConfig('IDRX_QRIS_CHANNEL_ID'),
          }
        : {}),
    });

    // Respons 2xx dengan data cacat tidak boleh menghasilkan order tanpa join key: tanpa
    // merchantOrderId, callback maupun reconciler tidak akan pernah bisa menemukan baris ini.
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }

    // 4. Baris ini adalah SATU-SATUNYA gerbang belanja treasury. Sebelum ia ada, tidak ada
    // apa pun yang boleh menyuruh purchase() jalan.
    const order = await this.prisma.paymentOrder.create({
      data: {
        merchantOrderId: data.merchantOrderId,
        idrxRequestId: data.id != null ? String(data.id) : null,
        reference: data.reference ?? null,
        userId: user.id,
        packType,
        priceIdr,
        priceUsdc,
        paymentMethod: method,
        qrContent: data.qrContent ?? null,
        virtualAccountNo: data.virtualAccountNo ?? null,
        paymentUrl: data.paymentUrl ?? null,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
        status: PaymentStatus.PENDING,
      },
    });

    this.logger.log(
      `Order ${order.merchantOrderId} dibuat: ${packType}, Rp ${priceIdr}, ` +
        `${priceUsdc} USDC base unit (user ${user.id}).`,
    );
    return toPaymentOrderDto(order);
  }

  /**
   * Terbitkan tagihan rupiah untuk membeli satu kartu KATALOG CollectorCrypt lewat jalur
   * RESELLER — pembeli bayar HARGA KITA (IDRX), treasury yang nanti membeli kartu di CC
   * (USDC) dan men-transfer-nya ke pembeli; selisihnya margin Hoshi. TIDAK ADA USDC yang
   * bergerak di sini — hanya di fulfilment.
   *
   * Urutan = properti keamanannya, sama seperti createPackOrder:
   *   0. kuota order per-user + validasi listing  → menolak SEBELUM bayar itu gratis
   *   1. snapshot biaya CC (USDC) dari baris listing  → jadi PLAFON saat treasury menebus
   *   2. cek harga kita menutup biaya CC  → jangan sampai jual rugi
   *   3. plafon treasury 24 jam  → dicek di sini, bukan cuma saat fulfilment
   *   4. mint-request IDRX  → merchantOrderId lahir di sana
   *   5. persist baris PENDING (listingId != null = jalur reseller)
   */
  async createListingOrder(
    listingId: string,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();

    // 0. Listing harus ACTIVE. DUA jenis yang boleh dibeli lewat rail Rupiah ini:
    //    • KATALOG CC (reseller): source COLLECTORCRYPT, TANPA penjual user, ada alamat CC +
    //      harga USD → treasury yang beli di CC, butuh snapshot biaya + plafon.
    //    • listing USER (P2P Flow B): sellerId ter-set (kartu milik user lain) → Hoshi TIDAK
    //      beli apa-apa (escrow yang kirim + penjual dikredit saldo), tak ada leg/plafon USDC.
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    if (!listing || listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Listing tidak ditemukan atau sudah tidak dijual.',
      );
    }
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ JENIS LISTING DIBACA DARI SATU KOLOM, SEBELUM PERTANYAAN BENTUK APA PUN DIAJUKAN.    ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    // Kartu TITIPAN punya `sellerId != null` (pemiliknya User sungguhan — harus, kalau tidak
    // tidak ada yang bisa dikredit) TAPI tidak punya NFT di escrow, dan tidak akan pernah punya.
    // Jadi bagi `isUserListing` di bawah ia TAMPAK PERSIS SEPERTI listing P2P — dan kalau ia
    // menempuh gerbang P2P, `assertP2pSaleAvailable` akan menolaknya dengan nasihat "pajang
    // ulang supaya kartunya dititipkan ke escrow": nasihat yang tidak bisa berhasil.
    // `listingKindOf` (src/common/listing-kind.ts) menjawab TITIPAN lebih dulu, dari kolom.
    const kind = listingKindOf(listing);
    const isConsignment = kind === 'CONSIGNMENT';
    const isUserListing = !isConsignment && listing.sellerId != null;
    // Larangan beli-sendiri berlaku untuk KEDUANYA — kartu titipan juga punya penjual sungguhan.
    if (listing.sellerId != null && listing.sellerId === user.id) {
      throw new BadRequestException(
        'Tidak bisa membeli kartu yang Anda jual sendiri.',
      );
    }
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ GERBANG TITIPAN, DI DEPAN — SEBELUM SATU RUPIAH PUN DIMINTA.                         ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    // Pertanyaannya cuma satu, dan ia FAKTA, bukan flag: apakah kartunya ada di rak Hoshi
    // SEKARANG. Penarikan oleh pemiliknya, pengiriman ke pembeli sebelumnya, atau kartu yang
    // hilang — ketiganya membuat `custodyReleasedAt` terisi dan gerbang ini menolak dengan
    // stage NO_EFFECT: NOL Rupiah diambil, jadi tidak ada utang refund yang lahir di sini.
    //
    // Posisinya SEBELUM cabang idempoten di bawah, dengan alasan yang SAMA seperti gerbang P2P:
    // order PENDING yang lahir ketika kartunya masih ada akan tetap dikembalikan (beserta
    // paymentUrl IDRX-nya yang masih hidup) sesudah kartunya ditarik pemiliknya.
    if (isConsignment) {
      const c = await this.prisma.consignment.findUnique({
        where: { id: listing.consignmentId as string },
        select: {
          id: true,
          status: true,
          custodyAcceptedAt: true,
          custodyReleasedAt: true,
        },
      });
      if (!c) {
        throw new BadRequestException(
          'Kartu titipan ini tidak punya catatan serah-terima — tidak bisa dibeli.',
        );
      }
      assertConsignmentSaleAvailable(c, listing.id);
    }
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ A — GERBANG P2P, DI DEPAN. Ini perbaikan inti pass ini.                             ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    // `fulfilUserListing` sudah memeriksa HOSHI_P2P_ENABLED — TAPI ia berjalan SESUDAH pembeli
    // membayar. Tanpa pemeriksaan DI SINI, urutannya adalah: invoice terbit → Rupiah SUNGGUHAN
    // mendarat di treasury → settlement menolak → REFUND_DUE → refund MANUAL, dan tidak ada
    // perkakas refund di repo ini. Jalur ongkir kirim-fisik sudah melakukannya dengan benar
    // (ccShipping.assertEnabled() di baris pertama createShippingOrder); ini pola yang sama.
    //
    // POSISINYA PENTING: SEBELUM cabang idempoten di bawah. Kalau ditaruh sesudahnya, order
    // PENDING yang lahir ketika fitur masih menyala akan tetap dikembalikan (beserta paymentUrl
    // IDRX-nya yang masih hidup) sesudah fitur dimatikan — persis kebocoran yang sama.
    if (isUserListing) {
      assertP2pSaleAvailable(this.p2pMode(), {
        id: listing.id,
        ccNftAddress: listing.ccNftAddress,
        escrowedAt: listing.escrowedAt,
      });
    }
    const isCcCatalog =
      listing.source === 'COLLECTORCRYPT' &&
      listing.sellerId == null &&
      !!listing.ccNftAddress &&
      listing.ccPriceUsd != null;
    // INVENTARIS HOSHI: kartu milik Hoshi sendiri (di-upload admin) — source=HOSHI, tanpa penjual
    // user, DAN ditandai `sellable`. Flag `sellable` WAJIB: source=HOSHI+sellerId=null adalah bentuk
    // DEFAULT tiap listing (termasuk seed/chart-filler placeholder) — tanpa flag ini kartu hantu ikut
    // buyable & pembeli bayar rupiah untuk barang tak terkirim. Hoshi = penjual+platform → seluruh
    // harga pendapatan Hoshi, TIDAK beli di CC, priceUsdc 0. Settlement cuma DB (klaim SOLD).
    // SATU DEFINISI, dipakai bersama jalur KIRIM DOMESTIK (redemption.service.ts). Kalau
    // predikat ini dan predikat kirim berbeda, kita menjual kartu yang tak bisa dikirim (atau
    // sebaliknya) — lihat src/common/hoshi-stock.ts.
    const isHoshiInventory = isHoshiSellableStock(listing);
    if (!isConsignment && !isUserListing && !isCcCatalog && !isHoshiInventory) {
      throw new BadRequestException(
        'Kartu ini belum bisa dibeli lewat jalur ini.',
      );
    }

    // IDEMPOTEN per (user, listing) untuk rail BELI-LANGSUNG saja (offerId=null): kalau user sudah
    // punya order PENDING belum kedaluwarsa untuk listing INI, kembalikan yang itu — spam klik "Beli
    // via Rupiah" jadi TIDAK menumpuk order yatim, tidak boros mint-request IDRX, dan tidak kena
    // kuota gara-gara kartu yang sama. `offerId: null` WAJIB: order bayar-offer (harga offer) pada
    // listing yang sama TIDAK boleh dikembalikan ke sini — beda harga, beda rail.
    const existingPending = await this.prisma.paymentOrder.findFirst({
      where: {
        userId: user.id,
        listingId: listing.id,
        offerId: null,
        status: PaymentStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending) {
      return toPaymentOrderDto(existingPending);
    }

    // Kuota order per-user (PENDING) — hanya ditegakkan saat benar-benar MEMBUAT order baru.
    // Ini plafon anti-spam/DDoS di sisi identitas (throttle per-IP jadi lapis kedua).
    await this.assertOrderQuota(user.id);

    // Jalur RESELLER: snapshot biaya CC sbg plafon tebus + tolak jual-rugi + cek plafon treasury.
    // Jalur USER: priceUsdc = 0 (tak ada USDC bergerak; field non-null jadi tetap 0).
    let priceUsdc = 0;
    if (isCcCatalog) {
      const ccPriceUsd = listing.ccPriceUsd as number;
      priceUsdc = Math.round(ccPriceUsd * 1_000_000);
      if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) {
        this.logger.error(
          `Harga CC listing ${listingId} tidak masuk akal: ccPriceUsd=${ccPriceUsd}. Order ditolak.`,
        );
        throw new ServiceUnavailableException(
          'Harga kartu dari CollectorCrypt sedang tidak wajar. Coba lagi nanti.',
        );
      }
      const usdIdrRate = this.intConfig('HOSHI_USD_IDR_RATE', 16_000, 1);
      const ccCostIdr = Math.ceil(ccPriceUsd * usdIdrRate);
      if (listing.priceIdrx < ccCostIdr) {
        this.logger.error(
          `Listing ${listingId} priceIdrx ${listing.priceIdrx} < biaya CC ${ccCostIdr} IDR — jual rugi, order ditolak.`,
        );
        throw new ServiceUnavailableException(
          'Harga kartu ini sedang tidak wajar. Coba lagi nanti.',
        );
      }
      await this.assertTreasuryCapacity(
        priceUsdc,
        this.intConfig('HOSHI_CC_MAX_CARD_PRICE_USDC', 5_000_000_000, 1),
      );
    }

    // 4. Pembeli bayar HARGA KITA + fee QRIS di atasnya (treasury tetap menerima priceIdrx).
    const priceIdr = applyBps(
      listing.priceIdrx,
      BPS_DENOMINATOR + QRIS_FEE_BPS,
    );
    if (priceIdr < IDRX_MIN_MINT_IDR || priceIdr > IDRX_MAX_MINT_IDR) {
      throw new BadRequestException(
        `Harga kartu ini (Rp ${priceIdr}) di luar batas pembayaran IDRX ` +
          `(Rp ${IDRX_MIN_MINT_IDR}–Rp ${IDRX_MAX_MINT_IDR}).`,
      );
    }

    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    // Order MARKETPLACE balik ke VAULT (bukan /open-packs) — konteksnya BELI KARTU, bukan buka
    // pack: nav "Vault" aktif + kartu langsung tampak di koleksi. Origin diambil dari
    // HOSHI_PAYMENT_RETURN_URL (yang untuk pack menunjuk /open-packs).
    const listingReturnUrl = new URL(
      '/vault',
      this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
    ).toString();
    const mint = await this.idrx.mintRequest({
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl: listingReturnUrl,
      expiryPeriod: expiryMinutes,
      productDetails: `Hoshi CC ${listing.name}`.slice(0, 255),
      // HOSTED (paymentMethod/channelId dikosongkan) → halaman Duitku penuh (QRIS+e-wallet+VA).
    });
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }

    // 5. Baris ini gerbang belanja treasury untuk jalur reseller. `listingId` mengarahkan
    //    fulfilment ke settlement CC; `packType` sentinel; `packMemo` tetap null.
    const order = await this.prisma.paymentOrder.create({
      data: {
        merchantOrderId: data.merchantOrderId,
        idrxRequestId: data.id != null ? String(data.id) : null,
        reference: data.reference ?? null,
        userId: user.id,
        packType: 'MARKETPLACE',
        listingId: listing.id,
        priceIdr,
        priceUsdc,
        paymentMethod: 'HOSTED',
        qrContent: data.qrContent ?? null,
        virtualAccountNo: data.virtualAccountNo ?? null,
        paymentUrl: data.paymentUrl ?? null,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
        status: PaymentStatus.PENDING,
      },
    });

    this.logger.log(
      `Order marketplace ${order.merchantOrderId} dibuat: listing ${listing.id} ` +
        `(${listing.name}), Rp ${priceIdr}, biaya CC ${priceUsdc} USDC base unit (user ${user.id}).`,
    );
    return toPaymentOrderDto(order);
  }

  /**
   * Terbitkan tagihan rupiah untuk MENGISI SALDO in-app user (top-up).
   *
   * Jalur PALING AMAN di seluruh rail: fulfilment-nya TIDAK PERNAH membelanjakan treasury —
   * ia hanya menulis satu baris `BalanceEntry` + menaikkan `User.balanceIdrx`. Satu-satunya uang
   * adalah rupiah user MASUK (di staging IDRX_MOCK, itupun disimulasi).
   *
   * Beda dari createPackOrder: nominal DARI USER (top-up menambah saldo mereka sendiri), bukan
   * di-snapshot dari mesin. Tetap divalidasi ulang ke batas IDRX. Sentinel `packType='TOPUP'`
   * mengarahkan fulfilment ke fulfilTopup (kredit saldo) — BUKAN gacha.purchase(). `listingId`
   * NULL, `priceUsdc` 0 (tak ada USDC bergerak; field non-null jadi tetap 0).
   */
  async createTopupOrder(
    amountIdr: number,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();

    // Nominal dari klien → divalidasi ULANG di sini (DTO gerbang bentuk, ini gerbang kebenaran).
    // Batas = batas mint-request IDRX; di luar itu IDRX pasti menolak dan order jadi yatim.
    if (!Number.isInteger(amountIdr)) {
      throw new BadRequestException(
        'Nominal isi saldo harus bilangan bulat rupiah.',
      );
    }
    if (amountIdr < IDRX_MIN_MINT_IDR || amountIdr > IDRX_MAX_MINT_IDR) {
      throw new BadRequestException(
        `Nominal isi saldo (Rp ${amountIdr}) di luar batas (Rp ${IDRX_MIN_MINT_IDR}–Rp ${IDRX_MAX_MINT_IDR}).`,
      );
    }

    // Kuota order PENDING per-user (anti-spam) — sama seperti pack/listing.
    await this.assertOrderQuota(user.id);

    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    // Sesudah bayar, balik ke /deposit (halaman itu me-resume & poll order lalu tampilkan saldo baru).
    const topupReturnUrl = new URL(
      '/deposit',
      this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
    ).toString();
    const mint = await this.idrx.mintRequest({
      // Rupiah utuh: nominal yang user bayar = yang dikreditkan ke saldo (1:1, tanpa fee tambahan).
      toBeMinted: String(amountIdr),
      // WAJIB treasury (bukan wallet user): treasury memegang IDRX-nya, saldo in-app jadi klaim
      // user atasnya — persis pola P2P. Kalau ini pernah wallet user, kita mint ke mereka DAN
      // menambah saldo → dobel.
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl: topupReturnUrl,
      expiryPeriod: expiryMinutes,
      productDetails: `Hoshi isi saldo Rp ${amountIdr}`.slice(0, 255),
      // HOSTED (paymentMethod/channelId dikosongkan) → halaman Duitku penuh (QRIS+e-wallet+VA).
    });
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }

    // `packType='TOPUP'` = SENTINEL. fulfilClaimed bercabang ke fulfilTopup DI ATAS cek listingId
    // dan DI ATAS jalur pack — jadi top-up tak akan pernah menyentuh gacha.purchase (belanja USDC).
    const order = await this.prisma.paymentOrder.create({
      data: {
        merchantOrderId: data.merchantOrderId,
        idrxRequestId: data.id != null ? String(data.id) : null,
        reference: data.reference ?? null,
        userId: user.id,
        packType: 'TOPUP',
        priceIdr: amountIdr,
        priceUsdc: 0,
        paymentMethod: 'HOSTED',
        qrContent: data.qrContent ?? null,
        virtualAccountNo: data.virtualAccountNo ?? null,
        paymentUrl: data.paymentUrl ?? null,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
        status: PaymentStatus.PENDING,
      },
    });
    this.logger.log(
      `Order top-up ${order.merchantOrderId} dibuat: +Rp ${amountIdr} saldo (user ${user.id}).`,
    );
    return toPaymentOrderDto(order);
  }

  /**
   * Terbitkan tagihan rupiah untuk MEMBAYAR OFFER yang SUDAH DITERIMA penjual. Pembeli bayar di
   * HARGA OFFER (bukan harga listing) + fee QRIS; saat lunas, settlement P2P (fulfilUserListing)
   * mengirim kartu ke pembeli & mengkredit penjual (harga offer − komisi). Kartu BARU pindah
   * setelah bayar — accept hanya menyetujui harga.
   */
  async createOfferOrder(
    offerId: string,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();

    const offer = await this.prisma.offer.findUnique({
      where: { id: offerId },
      include: { listing: true },
    });
    if (!offer) throw new BadRequestException('Offer tidak ditemukan.');
    if (offer.buyerId !== user.id) {
      throw new ForbiddenException('Offer ini bukan milik Anda.');
    }
    if (offer.status !== 'ACCEPTED') {
      throw new BadRequestException(
        'Offer belum diterima penjual — belum bisa dibayar.',
      );
    }
    const listing = offer.listing;
    if (!listing || listing.status !== ListingStatus.ACTIVE) {
      throw new BadRequestException('Kartu sudah tidak tersedia.');
    }
    if (listing.sellerId == null) {
      throw new BadRequestException('Listing ini tidak punya penjual.');
    }
    if (listing.sellerId === user.id) {
      throw new BadRequestException(
        'Tidak bisa membeli kartu yang Anda jual sendiri.',
      );
    }
    // TITIPAN: menawar dimatikan di slice 1 (ditolak di `submitOffer`), jadi seharusnya tidak ada
    // offer ACCEPTED untuk kartu titipan yang bisa sampai ke sini. Pagar KEDUA, dan ia ditaruh
    // SEBELUM gerbang P2P di bawah — karena gerbang itu akan menolak kartu titipan dengan nasihat
    // yang salah ("pajang ulang supaya kartunya dititipkan ke escrow"), dan nasihat yang salah
    // mengirim pemiliknya menempuh langkah yang tidak akan pernah berhasil.
    if (listing.consignmentId != null) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.UNSUPPORTED_ACTION,
        message:
          'Kartu titipan belum menerima penawaran di fase ini, jadi penawaran ini tidak bisa ' +
          'dibayar. Tidak ada pembayaran yang dibuat dan tidak ada uang yang diambil. Belilah ' +
          'pada harga yang tertera.',
        listingId: listing.id,
      });
    }
    // A — gerbang yang SAMA, jalur bayar-offer. Ini rail kedua menuju uang pembeli: "lanjut ke
    // pembayaran" atas offer yang sudah diterima penjual. Ia SELALU menyangkut listing user
    // (`sellerId == null` sudah ditolak di atas), jadi tidak bersyarat. SEBELUM cabang idempoten,
    // dengan alasan yang sama seperti di createListingOrder.
    assertP2pSaleAvailable(this.p2pMode(), {
      id: listing.id,
      ccNftAddress: listing.ccNftAddress,
      escrowedAt: listing.escrowedAt,
    });

    // IDEMPOTEN per OFFER (bukan per listing): spam "Bayar" tidak menumpuk order/mint-request.
    // WAJIB di-scope ke offerId: kalau di-scope (user,listing) saja, order "beli-langsung" (harga
    // listing) yang masih PENDING untuk listing yang sama akan dikembalikan ke sini → pembeli kena
    // HARGA LISTING padahal mau bayar HARGA OFFER (bug uang). offerId memisahkan kedua rail.
    const existingPending = await this.prisma.paymentOrder.findFirst({
      where: {
        userId: user.id,
        offerId: offer.id,
        status: PaymentStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending) return toPaymentOrderDto(existingPending);

    await this.assertOrderQuota(user.id);

    // HARGA OFFER (bukan listing.priceIdrx) + fee QRIS di atasnya.
    const priceIdr = applyBps(offer.amount, BPS_DENOMINATOR + QRIS_FEE_BPS);
    if (priceIdr < IDRX_MIN_MINT_IDR || priceIdr > IDRX_MAX_MINT_IDR) {
      throw new BadRequestException(
        `Harga offer (Rp ${priceIdr}) di luar batas pembayaran IDRX ` +
          `(Rp ${IDRX_MIN_MINT_IDR}–Rp ${IDRX_MAX_MINT_IDR}).`,
      );
    }

    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    const returnUrl = new URL(
      '/vault',
      this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
    ).toString();
    const mint = await this.idrx.mintRequest({
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl,
      expiryPeriod: expiryMinutes,
      productDetails: `Hoshi offer ${listing.name}`.slice(0, 255),
    });
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }
    const order = await this.prisma.paymentOrder.create({
      data: {
        merchantOrderId: data.merchantOrderId,
        idrxRequestId: data.id != null ? String(data.id) : null,
        reference: data.reference ?? null,
        userId: user.id,
        packType: 'MARKETPLACE',
        listingId: listing.id,
        offerId: offer.id,
        priceIdr,
        priceUsdc: 0,
        paymentMethod: 'HOSTED',
        qrContent: data.qrContent ?? null,
        virtualAccountNo: data.virtualAccountNo ?? null,
        paymentUrl: data.paymentUrl ?? null,
        expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
        status: PaymentStatus.PENDING,
      },
    });
    this.logger.log(
      `Order offer ${order.merchantOrderId} dibuat: offer ${offerId} listing ${listing.id} ` +
        `(${listing.name}), Rp ${priceIdr} @ harga offer (user ${user.id}).`,
    );
    return toPaymentOrderDto(order);
  }

  /**
   * Terbitkan tagihan rupiah untuk ONGKIR KIRIM-FISIK (CC Vault Shipping). Model createListingOrder.
   *
   * Ongkir (USD) di-taksir SERVER dari CC (bukan dari body klien), lalu di-Rupiah-kan lewat
   * quoteRupiah yang SAMA dengan pack — jadi tak ada nominal yang datang dari user. TIDAK ADA USDC
   * yang bergerak di sini: pendanaan USDC + burn dilakukan MALAS di sesi TTD user setelah Rupiah
   * lunas (fulfilShipping → READY_TO_FUND → fundAndPrepare).
   *
   * Urutan = properti keamanannya:
   *   0. gate + validasi redemption milik user + status REQUESTED  → menolak SEBELUM bayar itu gratis
   *   1. taksir ongkir USD dari CC → USDC base unit
   *   2. assertTreasuryCapacity(ongkir, plafon per-transfer ongkir)  → treasury harus sanggup mendanai
   *   3. quoteRupiah  → Rupiah yang dibayar user
   *   4. mint-request IDRX  → merchantOrderId lahir di sana
   *   5. persist PaymentOrder (packType='SHIPPING', redemptionId) + redemption → AWAITING_PAYMENT
   */
  async createShippingOrder(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();
    // Gate fitur: kalau HOSHI_CC_SHIPPING_ENABLED mati → tolak (record-only tak tersentuh).
    this.ccShipping.assertEnabled();

    const redemption = await this.prisma.cardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!redemption) throw new NotFoundException('Redemption tidak ditemukan.');
    if (redemption.userId !== user.id) {
      throw new ForbiddenException('Redemption ini bukan milik Anda.');
    }
    // GERBANG RAIL. Baris jalur DOMESTIK (stok Hoshi) tidak punya ongkir CC untuk ditaksir dan
    // tidak boleh pernah sampai ke assertTreasuryCapacity di bawah — ongkirnya sudah dibayar
    // lewat createDomesticShippingOrder dan NOL USDC akan pernah didanai untuknya.
    assertCcRail(redemption);
    // B1 — DUA status boleh MASUK ke rute ini, dan URUTAN di bawah ini adalah perbaikannya.
    // DULU: cek status (hanya REQUESTED) berjalan SEBELUM cabang idempoten, jadi begitu baris
    // pindah ke AWAITING_PAYMENT cabang idempoten itu TIDAK PERNAH TERCAPAI — user yang kembali ke
    // invoice-nya sendiri (tombol "Buka halaman pembayaran") dijawab 400, selamanya. Sekarang:
    //   AWAITING_PAYMENT + invoice MASIH HIDUP  -> kembalikan invoice yang SAMA (re-entry),
    //   AWAITING_PAYMENT + invoice MATI/hilang  -> lepas balik ke REQUESTED lalu terbitkan yang baru,
    //   status lain                             -> 400 seperti dulu.
    if (
      redemption.status !== RedemptionStatus.REQUESTED &&
      redemption.status !== RedemptionStatus.AWAITING_PAYMENT
    ) {
      throw new BadRequestException(
        `Redemption ini tidak dalam status yang bisa dibuatkan tagihan ongkir (status ${redemption.status}).`,
      );
    }

    // IDEMPOTEN per redemption + RE-ENTRY: order ongkir PENDING yang belum kedaluwarsa →
    // kembalikan yang itu (spam "Bayar Ongkir" tidak menumpuk order/mint-request, dan user yang
    // kembali ke baris AWAITING_PAYMENT-nya sendiri mendapat invoice yang SAMA, bukan 400).
    const existingPending = await this.prisma.paymentOrder.findFirst({
      where: {
        userId: user.id,
        redemptionId,
        packType: 'SHIPPING',
        status: PaymentStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending) return toPaymentOrderDto(existingPending);

    // AWAITING_PAYMENT TANPA invoice hidup = invoice-nya sudah mati (user menutup tab IDRX; lihat
    // HOSHI_ORDER_EXPIRY_MINUTES). Lepas klaimnya balik ke REQUESTED supaya baris ini tidak
    // mengunci kartunya selamanya. Helper-nya MENOLAK KERAS kalau ada pembayaran yang mendarat.
    if (redemption.status === RedemptionStatus.AWAITING_PAYMENT) {
      await this.releaseAbandonedShippingClaim(redemptionId);
    }

    await this.assertOrderQuota(user.id);

    // 1. Taksir ongkir (USD) dari CC → USDC base unit. Server-side; tak pernah dari klien.
    const { usdcBaseUnits: priceUsdc } =
      await this.ccShipping.estimateForRedemption(
        redemptionId,
        user,
        ccAccessToken,
      );
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) {
      throw new ServiceUnavailableException(
        'Ongkir dari CollectorCrypt sedang tidak wajar. Coba lagi nanti.',
      );
    }

    // 2. Plafon: pakai plafon per-transfer ongkir yang SAMA dengan fundUsdc (impor konstanta agar
    //    tak mungkin melenceng), plus cap harian + preflight saldo treasury (treasury yang mendanai).
    await this.assertTreasuryCapacity(priceUsdc, SHIPPING_FUND_MAX_PER_TX_USDC);

    // 3. Rupiah-kan lewat sumber harga yang sama dengan pack.
    const priceIdr = await this.quoteRupiah(priceUsdc);

    // 4. mint-request IDRX.
    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    // Sesudah bayar, balik ke /vault (halaman itu me-resume order lalu lanjut ke sesi TTD kirim).
    const shippingReturnUrl = new URL(
      '/vault',
      this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
    ).toString();
    const mint = await this.idrx.mintRequest({
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl: shippingReturnUrl,
      expiryPeriod: expiryMinutes,
      productDetails: `Hoshi ongkir kirim ${redemption.cardName}`.slice(0, 255),
    });
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }

    // 5. Persist order (packType='SHIPPING', redemptionId) + redemption → AWAITING_PAYMENT +
    //    paymentOrderId, dalam SATU transaksi (klaim REQUESTED terjaga predikat). Kalah klaim
    //    (count!==1) → rollback, order tak dibuat (mint-request yatim akan kedaluwarsa sendiri).
    const created = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.cardRedemption.updateMany({
        where: { id: redemptionId, status: RedemptionStatus.REQUESTED },
        data: { status: RedemptionStatus.AWAITING_PAYMENT },
      });
      if (claim.count !== 1) return null;
      const order = await tx.paymentOrder.create({
        data: {
          merchantOrderId: data.merchantOrderId,
          idrxRequestId: data.id != null ? String(data.id) : null,
          reference: data.reference ?? null,
          userId: user.id,
          packType: 'SHIPPING',
          redemptionId,
          priceIdr,
          priceUsdc,
          paymentMethod: 'HOSTED',
          qrContent: data.qrContent ?? null,
          virtualAccountNo: data.virtualAccountNo ?? null,
          paymentUrl: data.paymentUrl ?? null,
          expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
          status: PaymentStatus.PENDING,
        },
      });
      await tx.cardRedemption.update({
        where: { id: redemptionId },
        data: { paymentOrderId: order.id },
      });
      return order;
    });
    if (!created) {
      throw new BadRequestException(
        'Redemption ini sudah dalam proses pembayaran ongkir. Cek order Anda.',
      );
    }

    this.logger.log(
      `Order ongkir ${created.merchantOrderId} dibuat: redemption ${redemptionId} ` +
        `(${redemption.cardName}), Rp ${priceIdr}, ongkir ${priceUsdc} USDC base unit (user ${user.id}).`,
    );
    return toPaymentOrderDto(created);
  }

  /**
   * B1 — LEPAS klaim AWAITING_PAYMENT yang invoice-nya sudah mati, balik ke REQUESTED.
   *
   * KENAPA REQUESTED DAN BUKAN CANCELED: nol Rupiah masuk dan user JELAS masih menginginkan
   * kartunya (ia baru saja menekan "Bayar ongkir" lagi). REQUESTED memulihkan PERSIS keadaan
   * sebelum invoice terbit — alamat, snapshot kartu, dan baris feed-nya tetap utuh — sementara
   * CANCELED memaksanya membuat permintaan baru dari nol. REQUESTED juga status yang memang
   * dibutuhkan klaim atomik di akhir createShippingOrder, jadi tidak ada jalur khusus baru.
   *
   * PAGAR UANG: kalau ADA order ongkir yang pembayarannya sudah mendarat
   * (PAID/FULFILLING/FULFILLED/REFUND_DUE) → TOLAK. Kita tidak pernah melepas klaim atas baris yang
   * Rupiah-nya sudah masuk; itu akan mengubah pembayaran sah jadi utang refund hanya karena user
   * menekan tombol dua kali.
   *
   * BALAPAN: tulisannya BERPAGAR (status AWAITING_PAYMENT + fundingSignature null + refundSafe
   * true), head-to-head dengan klaim fulfilShipping. Yang kalah tidak menulis apa pun.
   */
  private async releaseAbandonedShippingClaim(
    redemptionId: string,
  ): Promise<void> {
    const landed = await this.prisma.paymentOrder.findFirst({
      where: {
        redemptionId,
        packType: 'SHIPPING',
        status: { in: SHIPPING_MONEY_LANDED_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (landed) {
      this.logger.warn(
        `Redemption ${redemptionId}: klaim AWAITING_PAYMENT TIDAK dilepas — order ongkir ` +
          `${landed.merchantOrderId} berstatus ${landed.status} (pembayaran sudah mendarat).`,
      );
      throw new BadRequestException(
        `Pembayaran ongkir untuk permintaan ini sudah masuk (order ${landed.merchantOrderId}, ` +
          `status ${landed.status}). Tunggu prosesnya selesai — jangan membuat tagihan baru, ` +
          'nanti kamu membayar dua kali. Kalau macet: batalkan permintaan kirimnya ' +
          '(POST /redemptions/:id/cancel) lalu minta kirim lagi — pembayaran yang sudah masuk ' +
          'tetap tercatat sebagai utang refund pada tagihannya sendiri.',
      );
    }

    const released = await this.prisma.cardRedemption.updateMany({
      where: {
        id: redemptionId,
        status: RedemptionStatus.AWAITING_PAYMENT,
        // Fail-closed: dua kolom jejak PASCA-danai. Dibaca sebagai PREDIKAT, tidak pernah ditulis.
        fundingSignature: null,
        refundSafe: true,
      },
      data: { status: RedemptionStatus.REQUESTED },
    });
    if (released.count !== 1) {
      throw new BadRequestException(
        'Permintaan kirim ini baru saja berpindah status (mungkin pembayaranmu barusan masuk). ' +
          'Muat ulang halamannya lalu cek lagi.',
      );
    }
    this.logger.log(
      `Redemption ${redemptionId}: invoice ongkir mati → klaim AWAITING_PAYMENT dilepas balik ke ` +
        'REQUESTED. Nol Rupiah masuk; tagihan baru boleh diterbitkan.',
    );
  }

  /* ══════════════════════ ONGKIR KIRIM DOMESTIK (STOK HOSHI) ══════════════════════ */

  /**
   * Taksiran ongkir DOMESTIK untuk satu redemption. READ-ONLY: nol uang, nol order, nol efek
   * samping — aman dipanggil layar mana pun sebelum user memutuskan membayar. Sumber angkanya
   * PERSIS sama dengan yang dipakai `createDomesticShippingOrder`, jadi yang dilihat user dan
   * yang ditagihkan tidak bisa lahir dari dua kalkulasi berbeda.
   *
   * Termasuk yang sama: GERBANG NEGARA. Alamat di luar Indonesia ditolak DI SINI (400
   * HOSHI_DOMESTIC_ADDRESS_UNSUPPORTED), jadi user tahu alamatnya perlu dibetulkan SEBELUM ia
   * menekan tombol bayar — bukan sesudahnya.
   */
  async quoteDomesticShipping(
    redemptionId: string,
    user: AuthUser,
  ): Promise<DomesticShippingQuote> {
    const redemption = await this.ownedDomesticRedemption(redemptionId, user);
    const quote = await resolveDomesticShippingIdr({
      prisma: this.prisma,
      logger: this.logger,
      dest: {
        city: redemption.city,
        state: redemption.state,
        country: redemption.country,
      },
      env: (k) => this.config.get<string>(k),
    });
    return quote;
  }

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════╗
   * ║ Terbitkan tagihan Rupiah ONGKIR KIRIM DOMESTIK (stok fisik Hoshi, kurir lokal).      ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════╝
   *
   * RAIL PEMBAYARANNYA SAMA (packType='SHIPPING' + redemptionId): IDRX hosted checkout,
   * callback, reconciler, sapuan kedaluwarsa, pelepasan klaim — semuanya sudah bekerja dan
   * TIDAK ada rail pembayaran kedua yang dibangun di sini.
   *
   * ┌──── APA YANG BEDA DARI `createShippingOrder` (CC Vault), DAN KENAPA ────────────────┐
   * │ 1. TIDAK memanggil ccShipping.assertEnabled(): jalur ini tidak menyentuh CC sama     │
   * │    sekali, jadi ia TIDAK boleh mati bersama gerbang CC (dan TIDAK ikut terblokir     │
   * │    oleh kredensial CC yang masih ditunggu).                                         │
   * │ 2. TIDAK butuh x-cc-access-token. Tidak ada sesi CC yang relevan.                   │
   * │ 3. Harga dari TARIF ADMIN (domestic_shipping_rates), BUKAN dari estimate CC.        │
   * │    `priceUsdc` DITULIS 0 dan itu JUJUR: nol USDC akan pernah bergerak untuk baris ini.│
   * │ 4. TIDAK memanggil assertTreasuryCapacity. Itu BUKAN kelonggaran: fungsi itu menguji │
   * │    apakah treasury sanggup MENDANAI USDC ongkir, dan jalur ini tidak pernah mendanai │
   * │    apa pun. Memanggilnya akan MENOLAK pengiriman domestik gara-gara plafon dana yang │
   * │    tak pernah dipakai. Plafon per-tx + cap 24 jam treasury tetap UTUH dan tetap      │
   * │    ditegakkan di setiap jalur yang benar-benar memindahkan USDC.                     │
   * └─────────────────────────────────────────────────────────────────────────────────────┘
   *
   * POSISI refundSafe DI SINI: order lahir PENDING dengan refundSafe default `true`, dan baris
   * redemption-nya tetap `refundSafe=true` / `fundingSignature=null` — dua kolom itu DIBACA
   * sebagai predikat, TIDAK PERNAH ditulis. Tidak ada satu pun titik di jalur domestik yang
   * bisa membuat ongkir Rupiah TIDAK aman di-refund, karena tidak ada langkah pasca-belanja:
   * tak ada USDC yang keluar, tak ada NFT yang dibakar.
   *
   * Urutan = properti keamanannya:
   *   0. validasi milik user + RAIL DOMESTIK + status REQUESTED/AWAITING_PAYMENT
   *   1. resolusi tarif ongkir (admin → env → penampung), divalidasi ke batas mint IDRX
   *   2. mint-request IDRX → merchantOrderId lahir di sana
   *   3. persist PaymentOrder + klaim REQUESTED → AWAITING_PAYMENT dalam SATU transaksi
   */
  async createDomesticShippingOrder(
    redemptionId: string,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const treasuryAddress = this.treasuryAddressOrRefuse();
    const redemption = await this.ownedDomesticRedemption(redemptionId, user);

    // Dua status boleh MASUK — sama seperti jalur CC, dan alasannya sama: user yang kembali ke
    // invoice-nya sendiri harus mendapat invoice yang SAMA, bukan 400 selamanya.
    if (
      redemption.status !== RedemptionStatus.REQUESTED &&
      redemption.status !== RedemptionStatus.AWAITING_PAYMENT
    ) {
      throw domesticError({
        status: 400,
        code: DOMESTIC_ERROR_CODE.NOT_BILLABLE,
        message:
          'Permintaan kirim ini tidak dalam status yang bisa dibuatkan tagihan ongkir ' +
          `(status ${redemption.status}).`,
        redemptionId,
      });
    }

    // IDEMPOTEN + RE-ENTRY: order ongkir PENDING yang belum kedaluwarsa → kembalikan yang itu.
    const existingPending = await this.prisma.paymentOrder.findFirst({
      where: {
        userId: user.id,
        redemptionId,
        packType: 'SHIPPING',
        status: PaymentStatus.PENDING,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existingPending) return toPaymentOrderDto(existingPending);

    // AWAITING_PAYMENT tanpa invoice hidup = invoice-nya mati. Helper yang SAMA dengan jalur CC
    // melepas klaimnya balik ke REQUESTED — dan MENOLAK KERAS kalau ada pembayaran yang mendarat,
    // supaya user tidak pernah ditagih dua kali untuk satu pengiriman.
    if (redemption.status === RedemptionStatus.AWAITING_PAYMENT) {
      await this.releaseAbandonedShippingClaim(redemptionId);
    }

    await this.assertOrderQuota(user.id);

    // 1. TARIF. Dari baris admin kalau ada, lalu env, lalu penampung sementara — dan selalu
    //    divalidasi ke batas mint IDRX (resolveDomesticShippingIdr yang menegakkannya).
    const rate = await resolveDomesticShippingIdr({
      prisma: this.prisma,
      logger: this.logger,
      dest: {
        city: redemption.city,
        state: redemption.state,
        country: redemption.country,
      },
      env: (k) => this.config.get<string>(k),
    });
    const priceIdr = rate.priceIdr;
    if (priceIdr < IDRX_MIN_MINT_IDR || priceIdr > IDRX_MAX_MINT_IDR) {
      // Sabuk KEDUA (resolveDomesticShippingIdr sudah memeriksanya). Murah, dan menutup
      // kemungkinan lapis resolusi baru ditambahkan nanti tanpa validasinya sendiri.
      throw domesticError({
        status: 503,
        code: DOMESTIC_ERROR_CODE.RATE_UNAVAILABLE,
        message:
          'Tarif ongkir domestik belum bisa dipakai. Hubungi support — jangan bayar apa pun.',
        redemptionId,
      });
    }

    // 2. mint-request IDRX. Sesudah bayar, user kembali ke /withdraw (halaman yang memuat
    //    daftar pengiriman + melanjutkan sesinya). SENGAJA BUKAN /vault: /vault me-resume modal
    //    kirim CC, dan dua sesi resume yang berbeda tidak boleh mendarat di satu halaman.
    const expiryMinutes = this.intConfig(
      'HOSHI_ORDER_EXPIRY_MINUTES',
      DEFAULT_EXPIRY_MINUTES,
      1,
    );
    const returnUrl = new URL(
      '/withdraw',
      this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
    ).toString();
    const mint = await this.idrx.mintRequest({
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl,
      expiryPeriod: expiryMinutes,
      productDetails:
        `Hoshi ongkir kirim domestik ${redemption.cardName}`.slice(0, 255),
    });
    const data = mint.data;
    if (
      !data ||
      typeof data.merchantOrderId !== 'string' ||
      !data.merchantOrderId
    ) {
      throw new ServiceUnavailableException(
        'IDRX tidak mengembalikan merchantOrderId. Order tidak dibuat — coba lagi.',
      );
    }

    // 3. Persist order + klaim REQUESTED → AWAITING_PAYMENT dalam SATU transaksi. Predikat klaim
    //    memasang RAIL-nya (`listingId: { not: null }`) supaya sebuah baris jalur CC tidak bisa
    //    diklaim dari sini walau pun pembacaan di atas entah bagaimana basi. Kalah klaim →
    //    rollback, order tak dibuat (mint-request yatim akan kedaluwarsa sendiri).
    const created = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.cardRedemption.updateMany({
        where: {
          id: redemptionId,
          status: RedemptionStatus.REQUESTED,
          listingId: { not: null },
        },
        data: { status: RedemptionStatus.AWAITING_PAYMENT },
      });
      if (claim.count !== 1) return null;
      const order = await tx.paymentOrder.create({
        data: {
          merchantOrderId: data.merchantOrderId,
          idrxRequestId: data.id != null ? String(data.id) : null,
          reference: data.reference ?? null,
          userId: user.id,
          packType: 'SHIPPING',
          redemptionId,
          priceIdr,
          // 0 dan itu JUJUR: jalur domestik tidak pernah mendanai USDC. Setiap gerbang yang
          // membaca priceUsdc (plafon slippage CC, assertCostWithinPaid) hidup di jalur CC,
          // dan jalur itu tidak bisa dimasuki baris ber-listingId (assertCcRail).
          priceUsdc: 0,
          paymentMethod: 'HOSTED',
          qrContent: data.qrContent ?? null,
          virtualAccountNo: data.virtualAccountNo ?? null,
          paymentUrl: data.paymentUrl ?? null,
          expiresAt: new Date(Date.now() + expiryMinutes * 60_000),
          status: PaymentStatus.PENDING,
        },
      });
      await tx.cardRedemption.update({
        where: { id: redemptionId },
        data: { paymentOrderId: order.id },
      });
      return order;
    });
    if (!created) {
      throw domesticError({
        status: 400,
        code: DOMESTIC_ERROR_CODE.ORDER_IN_PROGRESS,
        message:
          'Permintaan kirim ini sudah dalam proses pembayaran ongkir. Cek tagihanmu.',
        redemptionId,
      });
    }

    this.logger.log(
      `Order ongkir DOMESTIK ${created.merchantOrderId} dibuat: redemption ${redemptionId} ` +
        `(${redemption.cardName}, listing ${redemption.listingId}), Rp ${priceIdr} ` +
        `(tarif scope ${rate.scope}, sumber ${rate.source}, wilayah ${rate.region}, ` +
        `provinsi '${rate.province}'). NOL USDC, NOL CC, NOL burn.`,
    );
    // Provinsi yang TIDAK terpetakan ke tier mana pun ditagih tarif PENAMPUNG. Bukan kegagalan —
    // tapi ia harus TERLIHAT, karena artinya ada ejaan provinsi yang belum masuk daftar tier dan
    // pembelinya mungkin ditagih lebih mahal dari seharusnya.
    if (rate.regionUnresolved) {
      this.logger.warn(
        `Ongkir domestik ${created.merchantOrderId}: provinsi '${rate.province}' (kota ` +
          `'${redemption.city}') TIDAK cocok ke tier mana pun — dipakai tarif penampung ` +
          `${rate.scope} Rp ${priceIdr}. Tambahkan ejaan itu ke \`provinces\` tier yang benar ` +
          'lewat PUT /api/admin/shipping/domestic-rates.',
      );
    }
    return toPaymentOrderDto(created);
  }

  /**
   * Muat redemption milik user DAN pastikan ia jalur DOMESTIK. Chokepoint tunggal untuk semua
   * rute domestik — cerminan `ownedRedemption` + `assertCcRail` di sisi CC.
   */
  private async ownedDomesticRedemption(redemptionId: string, user: AuthUser) {
    const row = await this.prisma.cardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!row) throw new NotFoundException('Redemption tidak ditemukan.');
    if (row.userId !== user.id) {
      throw new ForbiddenException('Redemption ini bukan milik Anda.');
    }
    assertDomesticRail(row);
    return row;
  }

  /* ─────────────────────────── Callback IDRX ─────────────────────────── */

  /**
   * Webhook IDRX. TIDAK DITANDATANGANI, TIDAK PERNAH DIULANG.
   *
   * Dari seluruh body, kita membaca TEPAT SATU field: merchantOrderId. paymentStatus,
   * userMintStatus, txHash, amount — semuanya DIABAIKAN, karena semuanya bisa dikarang oleh
   * siapa pun yang tahu URL ini. Kerahasiaan URL callback itu pertahanan berlapis, BUKAN gerbang.
   *
   * Tidak pernah melempar: controller harus bisa menjawab 2xx cepat, dan sebuah 5xx dari kita
   * membuat IDRX mencatat pengiriman gagal atas callback yang sebenarnya sudah kita tangani —
   * padahal mereka tidak akan mengirimnya lagi.
   */
  async handleCallback(body: unknown): Promise<FulfilOutcome> {
    const merchantOrderId = readMerchantOrderId(body);
    if (!merchantOrderId) {
      this.logger.warn(
        'Callback IDRX tanpa merchantOrderId yang sah — diabaikan.',
      );
      return 'UNKNOWN_ORDER';
    }

    try {
      const outcome = await this.verifyAndFulfil(merchantOrderId);
      this.logger.log(
        `Callback IDRX ${merchantOrderId} → ${outcome} (body-nya sendiri tidak dipercaya).`,
      );
      return outcome;
    } catch (err) {
      // Sampai sini seharusnya tidak pernah: verifyAndFulfil sudah menelan errornya sendiri.
      // Jaring pengaman supaya satu bug tidak berubah jadi 5xx → callback hilang selamanya.
      this.logger.error(
        `Callback IDRX ${merchantOrderId} gagal diproses: ${errorMessage(err)}. ` +
          'Order tetap akan diambil reconciler.',
      );
      return 'VERIFY_FAILED';
    }
  }

  /* ─────────────────────────── Verifikasi + fulfilment ─────────────────────────── */

  /**
   * Idempoten. Aman dipanggil dari callback MAUPUN reconciler, berkali-kali, bersamaan.
   * Tidak pernah melempar — hasilnya dikembalikan sebagai FulfilOutcome.
   *
   * Yang membuatnya aman bukan "kami memeriksa dulu sebelum membeli" (dua pemanggil bersamaan
   * sama-sama lolos pemeriksaan seperti itu), melainkan KLAIM ATOMIK di langkah 3.
   */
  async verifyAndFulfil(merchantOrderId: string): Promise<FulfilOutcome> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { merchantOrderId },
    });
    if (!order) {
      // Bukan error server: bisa saja callback nyasar atau merchantOrderId karangan.
      this.logger.warn(`Order ${merchantOrderId} tidak dikenal — diabaikan.`);
      return 'UNKNOWN_ORDER';
    }
    // ┌─ B2 — `EXPIRED` BUKAN LAGI JALAN BUNTU ────────────────────────────────────────────────┐
    // │ DULU EXPIRED ikut short-circuit di bawah, dan itulah cara uang hilang DIAM-DIAM:        │
    // │ tick reconciler dan callback pembayaran memverifikasi BERSAMAAN di batas kedaluwarsa,   │
    // │ pembacaan reconciler menjawab EXPIRED sementara pembacaan callback menjawab PAID. Kalau │
    // │ transaksi kedaluwarsa commit duluan, order jadi EXPIRED — lalu callback yang membawa    │
    // │ bukti PEMBAYARAN NYATA berhenti di sini, tidak pernah mencapai klaim atomik, tidak      │
    // │ pernah mencapai failToRefund. Rupiah-nya duduk di treasury tanpa satu pun baris utang.  │
    // │                                                                                        │
    // │ Sekarang EXPIRED DIVERIFIKASI ULANG. Kalau IDRX bilang benar-benar tak dibayar → tetap  │
    // │ EXPIRED, nol tulisan, nol utang. Kalau ternyata DIBAYAR → jadi UTANG YANG TERCATAT.     │
    // │ ATURAN YANG TIDAK BOLEH DILANGGAR: jalur ini MENCATAT UTANG, ia TIDAK PERNAH mengirim   │
    // │ barangnya. "Jangan pernah menebus ulang order yang ambigu" tetap berlaku utuh.          │
    // └────────────────────────────────────────────────────────────────────────────────────────┘
    if (order.status === PaymentStatus.EXPIRED) {
      return this.settleExpiredButPaid(order);
    }
    if (
      order.status === PaymentStatus.FULFILLED ||
      order.status === PaymentStatus.REFUND_DUE ||
      order.status === PaymentStatus.FAILED
    ) {
      return 'ALREADY_CLAIMED';
    }

    // 1. SATU-SATUNYA sumber bukti: panggilan server-to-server ke IDRX. Bukan body callback,
    //    bukan kolom idrx* yang tersimpan (itu cuma jejak audit).
    let record: IdrxMintRecord | null;
    try {
      record = await this.idrx.findMintByMerchantOrderId(merchantOrderId);
    } catch (err) {
      // GAGAL TERTUTUP, TAPI TIDAK MEMBUANG PEMICUNYA. IDRX down bukan alasan membayar pack,
      // dan juga bukan alasan melupakan order ini: status tidak disentuh → reconciler mengulang.
      this.logger.error(
        `Verifikasi order ${merchantOrderId} ke IDRX gagal: ${errorMessage(err)}. ` +
          'Status TIDAK diubah — reconciler akan mencoba lagi.',
      );
      return 'VERIFY_FAILED';
    }
    if (!record) {
      this.logger.warn(
        `Order ${merchantOrderId} tidak ditemukan di History API IDRX. Status TIDAK diubah.`,
      );
      return 'VERIFY_FAILED';
    }

    const paymentStatus = String(record.paymentStatus);
    const userMintStatus = String(record.userMintStatus);

    // 2. Belum PAID+MINTED → catat status mentahnya (audit) dan berhenti. Tidak ada pack.
    if (paymentStatus !== 'PAID' || userMintStatus !== 'MINTED') {
      return this.recordUnfulfilled(
        order,
        record,
        paymentStatus,
        userMintStatus,
      );
    }

    // Pin catatannya ke order KITA. Tanpa ini, "ada catatan PAID+MINTED dengan id ini" masih
    // bisa berarti rupiahnya mendarat di wallet orang lain, atau nominalnya jauh di bawah tagihan.
    const pinned = this.assertRecordMatchesOrder(order, record);
    if (pinned) {
      if (pinned.refund) {
        // TERBUKTI MENYIMPANG → utang TETAP dicatat (operator harus melihatnya) TAPI
        // refundSafe=false. Lihat markProvenDeviationRefundDue: yang tidak terbukti milik kita
        // masuk kategori paling hati-hati. Jalur kedaluwarsa memakai helper yang SAMA.
        await this.markProvenDeviationRefundDue(
          order,
          pinned.reason,
          `Verifikasi server-ke-server ke IDRX menjawab paymentStatus=${paymentStatus} ` +
            `userMintStatus=${userMintStatus}, tapi catatannya TIDAK cocok dengan order ini. ` +
            `Order TIDAK ditebus — tidak ada pack/kartu/saldo yang berangkat dari jalur ini.`,
          [PaymentStatus.PENDING, PaymentStatus.PAID],
          {
            idrxPaymentStatus: paymentStatus,
            idrxUserMintStatus: userMintStatus,
          },
        );
        return 'REFUND_DUE';
      }
      // Field pin WAJIB tidak ada → tak bisa diputuskan. Fail-closed TANPA menyentuh status:
      // menebus tanpa pin = bisa membiayai pack yang rupiahnya tak pernah sampai; menandai
      // REFUND_DUE = mungkin salah mendeklarasikan utang atas mint yang sebenarnya baik. Biarkan
      // reconciler mencoba lagi, dan teriak keras supaya manusia menyelidiki kontrak IDRX-nya.
      this.logger.error(
        `Order ${merchantOrderId}: PAID+MINTED tapi ${pinned.reason} TIDAK ditebus (fail-closed) ` +
          'dan status TIDAK diubah — butuh pemeriksaan manual bila berulang.',
      );
      return 'PIN_UNVERIFIABLE';
    }

    // 3. KLAIM ATOMIK — BARIS TERPENTING DI SELURUH FITUR INI.
    //    Predikat status ada di dalam WHERE, jadi Postgres yang mengunci barisnya dan tepat
    //    SATU pemanggil bisa mendapat count === 1. Callback yang di-replay, callback ganda, dan
    //    reconciler yang balapan dengan callback semuanya kalah di sini — dan kalah itu NORMAL,
    //    bukan error: tidak boleh melempar, cukup berhenti dengan tenang.
    const claimed = await this.prisma.paymentOrder.updateMany({
      where: {
        merchantOrderId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
      },
      data: {
        status: PaymentStatus.FULFILLING,
        paidAt: order.paidAt ?? new Date(),
        idrxPaymentStatus: paymentStatus,
        idrxUserMintStatus: userMintStatus,
        txHash: typeof record.txHash === 'string' ? record.txHash : null,
      },
    });
    if (claimed.count !== 1) {
      // B1 — KALAH KLAIM ≠ SELALU "pihak lain sedang menyerahkan". Lihat settleLostClaim.
      return this.settleLostClaim(order, paymentStatus, userMintStatus);
    }

    return this.fulfilClaimed(order);
  }

  /**
   * B1 — KLAIM ATOMIK KALAH, SEMENTARA PEMANGGIL INI MEMEGANG BUKTI PEMBAYARAN SERVER-KE-SERVER.
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ INTERLEAVING YANG DULU MENGUAPKAN UANG TANPA SATU BARIS PUN JEJAK — DI SETIAP RAIL.        ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `settleExpiredButPaid` hanya menangkap balapan yang callback-nya MEMBACA SESUDAH commit
   * kedaluwarsa (baris sudah EXPIRED di pembacaan teratas verifyAndFulfil). Interleaving yang
   * SATUNYA lolos utuh:
   *
   *   1. callback membaca order — masih PENDING.
   *   2. IDRX menjawab PAID+MINTED; pin (tujuan mint + nominal + requestType) LOLOS.
   *   3. tick reconciler yang bersamaan commit kedaluwarsa duluan → baris jadi EXPIRED.
   *   4. klaim atomik `status IN (PENDING,PAID) → FULFILLING` cocok NOL baris.
   *
   * Dulu langkah 4 berhenti di `logger.log(... sudah diklaim pihak lain ...)` pada level INFO —
   * kalimat yang terbaca seperti hasil NORMAL. Nol tulisan, nol REFUND_DUE, nol ERROR. Dan tidak
   * ada apa pun yang memicunya ulang: IDRX tidak pernah mengulang callback, reconciler dulu hanya
   * memindai PENDING/PAID/FULFILLING, dan getOrder hanya memverifikasi ulang PENDING|PAID. Untuk
   * order ONGKIR, `recordUnfulfilled` pada langkah 3 sekalian melepas redemption-nya
   * AWAITING_PAYMENT → REQUESTED, jadi layar user kembali ke "Menunggu ongkir" dan MENGUNDANG
   * PEMBAYARAN KEDUA. Rail yang sama mengangkut pack, kartu marketplace, dan top-up.
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ CARA MEMBEDAKAN "TERMINAL TANPA PENYERAHAN + TERBUKTI DIBAYAR" DARI PEMENANG KLAIM YANG SAH ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * BUKAN dari kenapa klaimnya kalah (tidak bisa diketahui), melainkan dari BACA ULANG barisnya —
   * satu findUnique SESUDAH klaim gagal — lalu DUA syarat yang harus terpenuhi BERSAMAAN:
   *
   *   (a) pemanggil ini memegang bukti PAID+MINTED dari panggilan SERVER-KE-SERVER ke IDRX yang
   *       pin-nya sudah lolos. Ini sudah dijamin oleh posisi kode: baris ini hanya tercapai
   *       SESUDAH `paymentStatus==='PAID' && userMintStatus==='MINTED'` dan
   *       `assertRecordMatchesOrder` mengembalikan null. Body callback tidak pernah ikut menentukan.
   *   (b) status HASIL BACA ULANG ada di TERMINAL_UNDELIVERED_STATUSES (EXPIRED/FAILED) —
   *       himpunan yang HANYA bisa dicapai tanpa klaim atomik pernah diambil, jadi tidak ada satu
   *       pun barang yang pernah berangkat atas order ini.
   *
   * SEMUA status lain = ALREADY_CLAIMED yang SAH, dan mereka pulang TANPA utang dan TANPA barang:
   *   - FULFILLING : pemenang sah SEDANG menyerahkan. Utang di sini = utang atas barang terkirim.
   *   - FULFILLED  : sudah diserahkan.
   *   - REFUND_DUE : utangnya SUDAH tercatat — mencatat lagi = utang DOBEL.
   *   - PENDING/PAID: klaim dilepas untuk diulang (releaseClaimForRetry). Order masih HIDUP dan
   *                   masih dimiliki reconciler; mendeklarasikannya utang akan membunuh order yang
   *                   sebentar lagi ditebus dengan benar.
   *
   * ATURAN YANG TIDAK BOLEH DILANGGAR: jalur ini MENCATAT UTANG, ia TIDAK PERNAH mengirim
   * barangnya. Ia tidak menyentuh fulfilClaimed, gacha.purchase, reseller.settle, balance.credit,
   * fulfilShipping, escrow, maupun treasury. "Jangan pernah menebus ulang order yang ambigu" utuh.
   *
   * IDEMPOTEN: tulisannya `markRefundDueRaw` berpagar `status IN (EXPIRED, FAILED)`. Callback yang
   * datang lagi menemukan baris sudah REFUND_DUE dan berhenti di penjaga terminal verifyAndFulfil;
   * sapuan EXPIRED reconciler tidak lagi melihatnya (ia memfilter `status = EXPIRED`). Satu utang.
   */
  private async settleLostClaim(
    order: PaymentOrder,
    paymentStatus: string,
    userMintStatus: string,
  ): Promise<FulfilOutcome> {
    // B2: sebut BARANGNYA. Kalimat lama selalu bicara "pack", padahal rail yang sama mengangkut
    // ongkir kirim fisik — dan itu membuat satu-satunya jejak sebuah order ongkir tak bisa dicari.
    const subject = orderSubject(order);
    const merchantOrderId = order.merchantOrderId;

    let after: PaymentOrder | null;
    try {
      after = await this.prisma.paymentOrder.findUnique({
        where: { merchantOrderId },
      });
    } catch (err) {
      // Tidak bisa memutuskan → FAIL-CLOSED tanpa menyentuh status, TAPI TERIAK. Reconciler
      // (termasuk sapuan EXPIRED yang baru) akan memutuskannya lagi nanti.
      this.logger.error(
        `Order ${subject} ${merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): klaim ` +
          `atomik KALAH sementara IDRX sudah menjawab PAID+MINTED, dan baca-ulang statusnya GAGAL: ` +
          `${errorMessage(err)}. Status TIDAK diubah — reconciler akan memutuskannya lagi.`,
      );
      return 'VERIFY_FAILED';
    }
    if (!after) {
      this.logger.error(
        `Order ${subject} ${merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): klaim ` +
          'atomik KALAH sementara IDRX sudah menjawab PAID+MINTED, tapi barisnya HILANG saat ' +
          'dibaca ulang. Status TIDAK diubah — periksa manual.',
      );
      return 'VERIFY_FAILED';
    }

    if (!TERMINAL_UNDELIVERED_STATUSES.includes(after.status)) {
      // Pemenang klaim yang SAH (atau utang yang sudah tercatat / order yang masih hidup):
      // SHORT-CIRCUIT tanpa utang dan tanpa barang. Status hasil baca ulang ikut disebut supaya
      // "sudah diklaim pihak lain" tidak lagi jadi kalimat buram.
      this.logger.log(
        `Order ${subject} ${merchantOrderId} sudah diklaim pihak lain (status sekarang ` +
          `${after.status}) — tidak ada pemenuhan kedua dan tidak ada utang yang dicatat.`,
      );
      return 'ALREADY_CLAIMED';
    }

    await this.markRefundDueRaw(
      order,
      `BALAPAN KEDALUWARSA vs PEMBAYARAN (kalah klaim): verifikasi server-ke-server ke IDRX ` +
        `menjawab paymentStatus=${paymentStatus} userMintStatus=${userMintStatus} dan pin-nya ` +
        `lolos, tapi klaim atomik PENDING|PAID → FULFILLING kalah dan order kini ${after.status} ` +
        `— terminal TANPA penyerahan. Jadi user membayar dan TIDAK menerima apa pun. Barangnya ` +
        `TIDAK dikirim dari jalur ini (aturan "jangan pernah menebus ulang order ambigu" tetap ` +
        `berlaku) — ini murni pencatatan utang.`,
      TERMINAL_UNDELIVERED_STATUSES,
      { idrxPaymentStatus: paymentStatus, idrxUserMintStatus: userMintStatus },
    );
    return 'REFUND_DUE';
  }

  /**
   * B2 — SISA JENDELA SAPUAN untuk baris EXPIRED ini, dalam milidetik. MENTAH: boleh ≤ 0.
   *
   * `updatedAt` pada baris EXPIRED adalah DETIK KETIKA BARIS ITU JADI EXPIRED, jadi tepi jendela
   * sapuan = `updatedAt + RECONCILE_EXPIRED_SWEEP_MS` — persis batas yang dipakai filter
   * `updatedAt >= now - RECONCILE_EXPIRED_SWEEP_MS` di reconcile(). Sesudah itu baris ini tidak
   * pernah ditanya lagi. Nilainya SENGAJA tidak dilantai di sini: kedua pemakainya punya aturan
   * lantai/plafon yang BERBEDA, dan melantainya di satu tempat pernah menyembunyikan tepi jendela
   * dari jalur non-terminal (B1).
   */
  private expiredSweepWindowLeftMs(order: PaymentOrder): number {
    return order.updatedAt.getTime() + RECONCILE_EXPIRED_SWEEP_MS - Date.now();
  }

  /**
   * B2 — jeda untuk vonis TERMINAL IDRX ('EXPIRED'): diam sampai jendelanya HABIS.
   *
   * 'EXPIRED' tidak akan pernah berbalik jadi PAID, jadi baris ini cukup ditanya SEKALI: satu
   * panggilan History untuk 30 tick, bukan 30. Lantainya EXPIRED_SWEEP_RECHECK_MS supaya baris
   * yang jendelanya sudah (hampir) habis tidak menghasilkan entri jeda nol-detik yang langsung
   * ditanya ulang.
   */
  private quietExpiredSweepTerminal(order: PaymentOrder): void {
    this.quietExpiredSweep(
      order.merchantOrderId,
      Math.max(this.expiredSweepWindowLeftMs(order), EXPIRED_SWEEP_RECHECK_MS),
    );
  }

  /**
   * B1 — jeda untuk SETIAP hasil NON-TERMINAL (WAITING_FOR_PAYMENT, status tak dikenal, tidak ada
   * catatan di IDRX, IDRX melempar, PIN_UNVERIFIABLE): dijeda, TAPI TIDAK PERNAH melewati MARGIN
   * TERAKHIR jendela sapuan.
   *
   * SATU-SATUNYA tempat kebijakan itu ditulis — kelima cabang non-terminal memanggil ini, bukan
   * `quietExpiredSweep(…, EXPIRED_SWEEP_RECHECK_MS)` langsung, supaya tidak ada cabang yang bisa
   * tertinggal saat kebijakannya berubah. Jeda datar yang tidak sadar tepi jendela adalah lubang
   * kehilangan-diam yang dijelaskan di EXPIRED_SWEEP_RECHECK_MS.
   *
   * MEKANISMENYA: jeda = min(RECHECK, sisaJendela − RECHECK). Begitu sisanya masuk margin terakhir
   * (≤ RECHECK) hasilnya ≤ 0 dan baris ini TIDAK DIJEDA SAMA SEKALI — tiap tick bertanya sampai
   * jendelanya benar-benar tertutup, sehingga SELALU ada satu pertanyaan terakhir sebelum
   * penutupan dan pembayaran yang mendarat di menit-menit pamungkas tetap jadi utang TERCATAT.
   */
  private quietExpiredSweepNonTerminal(order: PaymentOrder): void {
    const quietForMs = Math.min(
      EXPIRED_SWEEP_RECHECK_MS,
      this.expiredSweepWindowLeftMs(order) - EXPIRED_SWEEP_RECHECK_MS,
    );
    if (quietForMs <= 0) return;
    this.quietExpiredSweep(order.merchantOrderId, quietForMs);
  }

  /**
   * B2 — "sudah ditanya, jangan tanya lagi sebelum `ms`".
   *
   * KENAPA DI MEMORI, BUKAN KOLOM DB: apa pun yang ditulis ke baris PaymentOrder akan menggerakkan
   * `updatedAt` (Prisma @updatedAt) — dan `updatedAt` pada baris EXPIRED BUKAN metadata bebas: ia
   * adalah DETIK KETIKA BARIS ITU JADI EXPIRED, satu-satunya sumber jendela sapuan sejam ini.
   * Menulisnya akan BERBOHONG tentang kapan order kedaluwarsa dan sekaligus memperpanjang
   * jendelanya tanpa batas (baris yang disentuh tiap tick tidak pernah keluar dari `gte`). Kolom
   * khusus + migrasi juga TIDAK menolong: tulisannya tetap menggerakkan `updatedAt` kecuali lewat
   * SQL mentah yang mem-bypass Prisma. Peta ini tidak menyentuh basis data sama sekali, jadi ia
   * TIDAK BISA berbohong tentang keadaan: satu-satunya efeknya adalah "kapan kita bertanya lagi".
   *
   * TAHAN RESTART: peta hilang saat proses mati → setiap baris ditanya SEKALI lagi lalu konvergen
   * lagi. Kehilangan entri tidak pernah bisa MELEWATKAN utang; ia cuma membuat satu panggilan
   * History ekstra. (Kebalikannya — entri yang bertahan — juga tidak bisa melewatkan utang: jeda
   * non-terminal tidak pernah menjangkau margin terakhir jendela, dan hanya vonis TERMINAL yang
   * dijeda sampai jendelanya habis.)
   *
   * MEMORI BERBATAS: di atas EXPIRED_SWEEP_QUIET_MAX entri, entri baru tidak ditambahkan.
   * Konsekuensinya cuma "ditanya lagi nanti", tidak pernah "utang terlewat".
   *
   * ⚠️ JANGAN PANGGIL LANGSUNG dari cabang hasil verifikasi. Dua pembungkusnya
   * (`quietExpiredSweepTerminal` / `quietExpiredSweepNonTerminal`) yang memegang kebijakan tepi
   * jendela; memanggil yang ini dengan durasi datar adalah persis regresi B1.
   */
  private quietExpiredSweep(merchantOrderId: string, ms: number): void {
    if (
      this.expiredSweepQuiet.size >= EXPIRED_SWEEP_QUIET_MAX &&
      !this.expiredSweepQuiet.has(merchantOrderId)
    ) {
      return;
    }
    this.expiredSweepQuiet.set(merchantOrderId, Date.now() + ms);
  }

  /**
   * B2 — id yang jedanya MASIH berlaku (sekalian membuang yang sudah lewat).
   *
   * Dipakai sebagai `notIn` di query sapuan, BUKAN sebagai filter sesudah query: baris yang sudah
   * dijawab tidak boleh ikut memakan jatah `take` — kalau ikut, ia bisa menyandera baris EXPIRED
   * yang lebih baru selama sejam penuh (urutannya oldest-first), persis kelaparan yang dihindari
   * oleh batch terpisah ini. Panjangnya dipotong di EXPIRED_SWEEP_NOT_IN_MAX dengan sisa jeda
   * TERPANJANG diprioritaskan (itulah vonis terminal): yang terpotong hanya ditanya ulang — aman.
   */
  private activeExpiredSweepQuiet(now: number): string[] {
    const active: { id: string; until: number }[] = [];
    for (const [id, until] of this.expiredSweepQuiet) {
      if (until <= now) {
        this.expiredSweepQuiet.delete(id);
      } else {
        active.push({ id, until });
      }
    }
    if (active.length <= EXPIRED_SWEEP_NOT_IN_MAX) {
      return active.map((entry) => entry.id);
    }
    return active
      .sort((a, b) => b.until - a.until)
      .slice(0, EXPIRED_SWEEP_NOT_IN_MAX)
      .map((entry) => entry.id);
  }

  /**
   * B2 — order LOKAL sudah `EXPIRED`; cek apakah pembayarannya ternyata SUNGGUHAN mendarat.
   *
   * SATU-SATUNYA sumber bukti tetap panggilan server-ke-server ke IDRX — sama seperti jalur normal,
   * DAN dengan PIN yang sama persis (lihat `assertRecordMatchesOrder` + `markRefundDue`). Empat
   * kemungkinan, dan hanya satu yang menulis apa pun:
   *
   *   1. IDRX bilang BUKAN 'PAID'  → memang kedaluwarsa tanpa dibayar. NOL tulisan (EXPIRED sudah
   *      terminal dan benar), NOL utang. Ini jalur mayoritas, dan ia tidak boleh berisik.
   *   2. IDRX tak bisa dihubungi   → kami TIDAK TAHU. Status tidak disentuh, ERROR (ini satu-satunya
   *      kasus di mana utang bisa luput tercatat sama sekali). Catatan yang TIDAK ADA di History
   *      BUKAN kasus itu: untuk invoice yang tak pernah dibayar, absennya justru yang DIHARAPKAN —
   *      jadi ia WARN, bukan ERROR (lihat B2 di bawah).
   *   3. IDRX bilang 'PAID' tapi PIN-nya tak bisa diputuskan (field pin WAJIB tidak ada) →
   *      FAIL-CLOSED: `PIN_UNVERIFIABLE`, NOL tulisan, status tidak disentuh, ERROR.
   *   4. IDRX bilang 'PAID' dan pin LOLOS (atau pin TERBUKTI MENYIMPANG) → REFUND_DUE lewat
   *      markRefundDueRaw dengan predikat [EXPIRED]; penyimpangan ikut dibawa di `error`.
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B1 — KENAPA PIN-NYA WAJIB DI SINI, BUKAN "cukup paymentStatus === 'PAID'".                 ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   * `refundSafe = true` adalah KLAIM OPERASIONAL: uang user terbukti kami pegang DAN terbukti
   * belum diserahkan. Operator memutuskan refund dengan MEMBACA KOLOM ITU. 'PAID' sendirian tidak
   * membuktikan paruh pertamanya — catatan yang sama bisa mencetak ke wallet ORANG LAIN,
   * bernominal jauh di bawah tagihan, atau ber-requestType 'usdt'.
   * Jalur normal memperlakukan pin ini sebagai penentu; jalur ini DULU melewatinya, dan sejak
   * sapuan EXPIRED ada, SETIAP baris EXPIRED melewatinya — tiap tick, selama sejam.
   * Kebijakannya sekarang mengikuti jalur normal lewat KODE yang sama. SATU SUMBU yang sengaja
   * TIDAK identik: jalur normal MENSYARATKAN `userMintStatus==='MINTED'` sebelum melangkah sama
   * sekali (`:1208`), sedangkan jalur ini memang harus tetap mencatat utang untuk mint yang
   * gagal/di-refund — kalau tidak, uangnya hilang tanpa jejak. Maka bedanya dipindahkan ke kolom
   * `refundSafe`, bukan ke "catat / tidak catat", dan GERBANG MINT di `markRefundDueRaw` yang
   * menegakkannya. Jangan tulis ulang kalimat ini jadi "cermin persis" — itu yang dulu membuat
   * cabang pin-lolos di sini menulis refundSafe=true untuk `userMintStatus=REFUND`.
   *   - pin lolos + MINTED   → utang dicatat, refundSafe=true (memang terbukti dua-duanya).
   *   - pin lolos, mint TIDAK
   *     MINTED               → utang TETAP dicatat, refundSafe=FALSE lewat GERBANG MINT.
   *   - pin menyimpang       → utang TETAP dicatat (user tetap bayar & tetap tidak menerima apa
   *                            pun) TAPI refundSafe=FALSE: uangnya tidak terbukti pernah kami
   *                            terima, jadi ia belum boleh ditransfer. Kedua jalur menulisnya
   *                            lewat `markProvenDeviationRefundDue` — satu tempat, satu kebijakan;
   *                            di sanalah alasannya ditulis lengkap.
   *   - pin tak terputuskan  → NOL tulisan, `PIN_UNVERIFIABLE`, ERROR. Sama seperti jalur normal.
   *
   * IDEMPOTEN: tulisannya updateMany berpagar `status IN (EXPIRED)`. Callback yang datang lagi
   * menemukan order sudah REFUND_DUE dan berhenti di penjaga terminal verifyAndFulfil — jadi tidak
   * ada utang kedua, dan tidak ada log utang kedua. Dua verifikasi yang BENAR-BENAR bersamaan bisa
   * sama-sama menerbitkan log (sengaja: log terbit SEBELUM tulisan supaya kegagalan DB tidak
   * menelan utangnya), tapi tetap hanya SATU baris yang berubah.
   *
   * TIDAK PERNAH MENGIRIM BARANGNYA. Jalur ini tidak menyentuh klaim atomik, gacha.purchase,
   * fulfilShipping, escrow, maupun treasury. Ia hanya mencatat utang.
   */
  private async settleExpiredButPaid(
    order: PaymentOrder,
  ): Promise<FulfilOutcome> {
    const subject = orderSubject(order);
    const merchantOrderId = order.merchantOrderId;
    let record: IdrxMintRecord | null;
    try {
      record = await this.idrx.findMintByMerchantOrderId(merchantOrderId);
    } catch (err) {
      // IDRX tak terjangkau = KAMI TIDAK TAHU → tetap ERROR. Tapi jangan diulangi tiap tick:
      // jeda pendek, jadi satu gangguan IDRX menghasilkan beberapa baris, bukan tiga puluh.
      // B1: jedanya SADAR TEPI JENDELA — IDRX yang ngadat di menit ke-50 tidak boleh berarti
      // baris ini tidak pernah ditanya lagi sebelum jendelanya tertutup.
      this.quietExpiredSweepNonTerminal(order);
      this.logger.error(
        `Order ${subject} ${merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}) ` +
          `sudah EXPIRED dan verifikasi ulang ke IDRX GAGAL: ${errorMessage(err)}. Status TIDAK ` +
          'diubah. KALAU pembayarannya ternyata mendarat, utangnya BELUM tercatat — periksa ' +
          'manual di dashboard IDRX dengan merchantOrderId ini.',
      );
      return 'VERIFY_FAILED';
    }
    if (!record) {
      // B2 — INI HASIL YANG DIHARAPKAN, BUKAN ALARM. Invoice yang memang tidak pernah dibayar
      // wajar tidak punya baris di History API. Dulu kalimat ini terbit di level ERROR, dan sejak
      // sapuan EXPIRED ada ia terbit LAGI tiap tick untuk order yang sama — ERROR jadi murah dan
      // utang SUNGGUHAN (yang juga ERROR) tenggelam di antaranya. ERROR sekarang disimpan untuk
      // uang yang benar-benar butuh manusia; ini WARN, dan jedanya membuatnya tidak berulang.
      // B1: "belum ada catatan" BUKAN vonis terminal — catatannya bisa muncul begitu user membayar
      // di halaman IDRX. Jadi jedanya sadar tepi jendela, bukan 10 menit datar.
      this.quietExpiredSweepNonTerminal(order);
      this.logger.warn(
        `Order ${subject} ${merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}) sudah ` +
          'EXPIRED dan TIDAK punya catatan di History API IDRX — konsisten dengan "memang tidak ' +
          'pernah dibayar". Status TIDAK diubah, NOL utang dicatat. Akan dicek ulang beberapa kali ' +
          'lagi selama jendela sapuan sebelum berhenti.',
      );
      return 'VERIFY_FAILED';
    }

    const paymentStatus = String(record.paymentStatus);
    const userMintStatus = String(record.userMintStatus);
    if (paymentStatus !== 'PAID') {
      // Kedaluwarsa yang jujur: nol Rupiah mendarat. Biarkan EXPIRED apa adanya — NOL tulisan.
      //
      // B2 — KONVERGENSI SAPUAN. 'EXPIRED' adalah vonis TERMINAL milik IDRX SENDIRI
      // (IdrxPaymentStatus hanya punya PAID | WAITING_FOR_PAYMENT | EXPIRED, dan kita mengirim
      // expiryPeriod yang SAMA dengan umur order kita) — ia tidak akan pernah berbalik jadi PAID,
      // jadi baris ini boleh berhenti ditanya untuk SISA jendela sapuan: satu panggilan History,
      // bukan tiga puluh. WAITING_FOR_PAYMENT MASIH BISA berbalik jadi PAID (user membayar di
      // halaman IDRX sesudah order kita kedaluwarsa — justru SATU-SATUNYA alasan jendela sejam ini
      // ada), jadi ia hanya DIJEDA sebentar, tidak pernah dihentikan. Menyamakan keduanya =
      // melewatkan utang sungguhan, dan itu persis yang tidak boleh ditukar demi hemat panggilan.
      //
      // B1 — DAN JEDA NON-TERMINALNYA SADAR TEPI JENDELA. Jeda datar 10 menit di sini berarti
      // pertanyaan terakhir selalu jatuh sampai ~10 menit SEBELUM jendela tertutup, dan
      // pembayaran yang mendarat di celah itu tidak pernah ditanyakan lagi — hilang diam-diam,
      // persis kasus yang sapuan ini ada untuk menangkapnya. Lihat quietExpiredSweepNonTerminal.
      if (paymentStatus === 'EXPIRED') {
        this.quietExpiredSweepTerminal(order);
      } else {
        this.quietExpiredSweepNonTerminal(order);
      }
      return 'ALREADY_CLAIMED';
    }

    // ┌─ B1 — PIN DULU, BARU UTANG. Cermin persis jalur normal di verifyAndFulfil. ────────────┐
    // │ Tanpa ini, 'PAID' sendirian cukup untuk MENDEKLARASIKAN UTANG REFUND-SAFE — klaim bahwa │
    // │ uang user terbukti kami pegang — padahal catatannya bisa mencetak ke wallet lain.       │
    // └────────────────────────────────────────────────────────────────────────────────────────┘
    const pinned = this.assertRecordMatchesOrder(order, record);
    if (pinned && !pinned.refund) {
      // Field pin WAJIB tidak ada → TIDAK BISA DIPUTUSKAN. FAIL-CLOSED, persis jalur normal:
      // status tidak disentuh, NOL tulisan, dan TERIAK supaya manusia memeriksa kontrak IDRX-nya.
      // Mencatat REFUND_DUE di sini = mungkin salah mendeklarasikan utang atas uang yang tidak
      // pernah sampai ke kita.
      // B1: PIN_UNVERIFIABLE juga NON-TERMINAL (field pin-nya bisa muncul di panggilan berikutnya),
      // jadi jedanya tidak boleh menjangkau margin terakhir jendela. Tetap NOL tulisan.
      this.quietExpiredSweepNonTerminal(order);
      this.logger.error(
        `Order ${subject} ${merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): sudah ` +
          `EXPIRED dan IDRX menjawab PAID, tapi ${pinned.reason} — utang TIDAK dicatat ` +
          '(fail-closed) dan status TIDAK diubah. Butuh pemeriksaan manual bila berulang.',
      );
      return 'PIN_UNVERIFIABLE';
    }

    // Uangnya NYATA. Sebutkan juga posisi mint-nya: kalau IDRX sendiri menyatakan mint-nya
    // gagal/ditolak/di-refund, refundnya kemungkinan besar dari sisi MEREKA — operator harus
    // memverifikasi dulu supaya tidak terjadi refund DOBEL.
    const mintNote = ['FAILED', 'REJECTED', 'REFUND'].includes(userMintStatus)
      ? `userMintStatus=${userMintStatus} → IDRX menyatakan token TIDAK dikirim ke treasury; ` +
        'refundnya kemungkinan dari sisi IDRX — VERIFIKASI DULU, jangan refund dobel'
      : `userMintStatus=${userMintStatus}`;

    const context =
      `BALAPAN KEDALUWARSA vs PEMBAYARAN: order lokal sudah EXPIRED, tapi verifikasi ` +
      `server-ke-server ke IDRX menjawab paymentStatus=PAID (${mintNote}). Order EXPIRED tidak ` +
      `pernah ditebus, jadi user membayar dan TIDAK menerima apa pun. Barangnya TIDAK dikirim ` +
      `dari jalur ini (aturan "jangan pernah menebus ulang order ambigu" tetap berlaku) — ini ` +
      `murni pencatatan utang.`;
    const extra = {
      idrxPaymentStatus: paymentStatus,
      idrxUserMintStatus: userMintStatus,
    };

    // B2 — Pin TERBUKTI MENYIMPANG (bukan "tak terputuskan"): utangnya TETAP dicatat, tapi lewat
    // helper yang SAMA dengan jalur normal — satu tempat, satu kebijakan, refundSafe=false.
    // Kedua jalur memanggil helper itu supaya mereka tidak bisa berpisah lagi seperti dulu.
    if (pinned) {
      await this.markProvenDeviationRefundDue(
        order,
        pinned.reason,
        context,
        [PaymentStatus.EXPIRED],
        extra,
      );
      return 'REFUND_DUE';
    }

    // Pin LOLOS: TUJUAN mint-nya terbukti treasury kita dan barangnya TERBUKTI belum diserahkan.
    // Paruh "uangnya benar-benar masuk" ditentukan GERBANG MINT di markRefundDueRaw dari
    // `extra.idrxUserMintStatus` — MINTED → refundSafe=true; FAILED/REJECTED/REFUND/PENDING/
    // PROCESSING → utang tetap dicatat tapi refundSafe=false. Jangan duplikasi cek itu di sini:
    // satu gerbang di titik tulis berlaku juga untuk pemanggil yang belum ada.
    await this.markRefundDueRaw(order, context, [PaymentStatus.EXPIRED], extra);
    return 'REFUND_DUE';
  }

  /**
   * Belanja treasury untuk order yang SUDAH diklaim (status FULFILLING). Hanya boleh dipanggil
   * dari verifyAndFulfil, tepat setelah klaim atomik menang.
   */
  private async fulfilClaimed(order: PaymentOrder): Promise<FulfilOutcome> {
    // Penerima kartu dibaca dari BARIS USER milik order — tidak pernah dari body callback.
    // Callback tidak membawa JWT; wallet yang disebut di dalamnya adalah wallet penyerang.
    const user = await this.prisma.user.findUnique({
      where: { id: order.userId },
    });
    if (!user) {
      return this.failToRefund(
        order,
        `User ${order.userId} hilang — kartu tidak punya tujuan.`,
      );
    }

    // TOP-UP SALDO: gerbang PALING ATAS, sebelum listing DAN sebelum pack. Sebuah top-up TIDAK
    // punya listingId; tanpa cabang ini ia jatuh ke gacha.purchase() dan membelanjakan ~$50 USDC
    // treasury untuk sebuah pack alih-alih menambah saldo. Sentinel packType='TOPUP' di-set server
    // saat createTopupOrder (bukan dari klien) — jadi tidak bisa dipalsukan lewat body.
    if (order.packType === 'TOPUP') {
      return this.fulfilTopup(order);
    }

    // ONGKIR KIRIM-FISIK (CC Vault Shipping): sentinel packType='SHIPPING' + redemptionId. Di ATAS
    // fallback pack. fulfilShipping HANYA menandai redemption READY_TO_FUND (paruh AMAN) — TIDAK
    // mendanai USDC / memanggil CC (itu MALAS, di sesi TTD user), jadi jalur fulfilment tetap refund-safe.
    if (order.packType === 'SHIPPING' && order.redemptionId) {
      return this.fulfilShipping(order, user);
    }

    // Order MARKETPLACE (reseller kartu CC): jalur settlement TERSENDIRI — cek harga & delivery
    // spesifik-listing, BUKAN gacha.purchase() + assertPriceStillHonourable (yang untuk pack).
    if (order.listingId) {
      return this.fulfilListing(order, user);
    }

    // Harga bergerak antara "user bayar" dan "kita tebus". Berapa banyak drift yang kita
    // TELAN adalah keputusan yang dipilih (HOSHI_MAX_SLIPPAGE_BPS), bukan kecelakaan. Cek ini
    // PRA-belanja: belum ada USDC treasury yang bergerak, jadi kegagalannya boleh dibedakan —
    // yang TRANSIEN (CC down) dilepas untuk diulang, yang PERMANEN (harga tembus plafon) jadi utang.
    const price = await this.assertPriceStillHonourable(order);
    if (price) {
      return price.permanent
        ? this.failToRefund(order, price.reason)
        : this.releaseClaimForRetry(order, price.reason);
    }

    const authUser: AuthUser = {
      id: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      role: user.role,
    };

    try {
      // packType dari BARIS ORDER, bukan dari klien: kalau tidak, user bisa memesan pack
      // murah lalu menebus mesin mahal, dan cek nominal rupiah tetap lolos karena
      // di-snapshot terhadap pack yang murah.
      // viaRupiahPayment: user SUDAH membayar rupiah — jalur ini harus fulfil bahkan di
      // produksi, jadi ia mem-bypass pagar demo-only di purchase() (lihat komentar di sana).
      // Pack DIBUKA di tempat (generate→submit→open): begitu order FULFILLED, kartu sudah
      // ke-mint dan frontend langsung memainkan animasi reveal — auto-reveal, tanpa langkah
      // "buka manual". (Opsi deferOpen tetap ada di GachaService bila suatu saat mau balik ke
      // alur beli-dulu-buka-nanti.)
      const pack = await this.gacha.purchase(
        { packType: order.packType },
        authUser,
        { viaRupiahPayment: true },
      );

      // purchase() SUKSES → pack SUDAH dibeli + dibuka (kartu ke user). DARI SINI post-spend:
      // apa pun yang gagal (mis. tulis FULFILLED) TIDAK boleh di-refund (rugi dobel).
      try {
        const done = await this.prisma.paymentOrder.update({
          where: { merchantOrderId: order.merchantOrderId },
          data: {
            status: PaymentStatus.FULFILLED,
            packMemo: pack.memo,
            fulfilledAt: new Date(),
            error: null,
          },
        });
        this.logger.log(
          `Order ${done.merchantOrderId} FULFILLED → memo ${pack.memo} (user ${user.id}).`,
        );
        return 'FULFILLED';
      } catch (writeErr) {
        return this.failToRefund(
          order,
          `Pack SUDAH dibeli+dibuka (memo ${pack.memo}) tapi tulis FULFILLED gagal: ` +
            `${errorMessage(writeErr)} — tandai FULFILLED manual, JANGAN refund.`,
          false,
        );
      }
    } catch (err) {
      // USER SUDAH BAYAR. Ini UTANG, bukan kegagalan yang boleh dilupakan.
      //
      // JANGAN PERNAH menulis FAILED di sini (FAILED cuma sah kalau kita YAKIN tidak ada uang
      // user yang tertahan — di titik ini rupiahnya jelas-jelas sudah masuk treasury), dan
      // JANGAN PERNAH mengembalikan status ke PENDING/PAID. purchase() adalah mesin ROLL-FORWARD:
      // sesudah submitTransaction, sebuah exception TIDAK berarti "tidak ada yang terjadi" —
      // USDC treasury mungkin SUDAH keluar. Melepas klaim di sini = reconciler membeli pack KEDUA
      // untuk pembayaran yang sama.
      //
      // REFUND_DUE adalah status SERAP: tidak pernah di-retry otomatis, dan cara keluarnya adalah
      // manusia yang membaca ledger CcPackPurchase (lewat packMemo/userId) untuk memutuskan
      // "kirim pack-nya" atau "kembalikan uangnya".
      //
      // PISAH PRA vs PASCA-belanja: purchase() melempar GachaPostSpendError untuk kegagalan SESUDAH
      // submitTransaction (USDC mungkin/sudah keluar, pack milik user) → JANGAN refund. Kegagalan
      // PRA-submit (sign/harga/generate) → aman di-refund (refundSafe=true default).
      if (err instanceof GachaPostSpendError) {
        return this.failToRefund(order, errorMessage(err), false);
      }
      return this.failToRefund(order, errorMessage(err));
    }
  }

  /**
   * Fulfilment TOP-UP saldo untuk order yang sudah diklaim (FULFILLING).
   *
   * TIDAK ADA belanja treasury di sini — hanya kredit saldo in-app. Karena itu penanganan gagalnya
   * BERBEDA dari jalur pack/reseller: TIDAK PERNAH REFUND_DUE. `balance.credit` idempoten per
   * (reason, refId=merchantOrderId) dan tak menyentuh treasury, jadi setiap kegagalan (transien DB
   * saat credit, ATAU saat mark FULFILLED sesudah credit) → LEPAS klaim ke PAID supaya reconciler
   * mengulang dan KONVERGEN: credit kedua di-skip idempoten (credited:false), mark menyusul. Kalau
   * kita menandai REFUND_DUE malah salah — tidak ada utang; saldo memang harus jadi terkredit.
   */
  private async fulfilTopup(order: PaymentOrder): Promise<FulfilOutcome> {
    try {
      // priceIdr = rupiah utuh yang user bayar = yang dikreditkan (1:1). userId dari BARIS order,
      // bukan callback. refId=merchantOrderId → gerbang idempotensi anti dobel-kredit.
      const { credited } = await this.balance.credit({
        userId: order.userId,
        amountIdrx: order.priceIdr,
        reason: 'TOPUP',
        refId: order.merchantOrderId,
      });
      const done = await this.prisma.paymentOrder.update({
        where: { merchantOrderId: order.merchantOrderId },
        data: {
          status: PaymentStatus.FULFILLED,
          fulfilledAt: new Date(),
          error: null,
        },
      });
      this.logger.log(
        `Top-up ${done.merchantOrderId} FULFILLED → +Rp ${order.priceIdr} saldo ` +
          `(user ${order.userId}, credited=${credited}).`,
      );
      return 'FULFILLED';
    } catch (err) {
      // Aman diulang: credit idempoten + nol treasury. Bukan utang → jangan REFUND_DUE.
      return this.releaseClaimForRetry(
        order,
        `Top-up credit/mark gagal: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Fulfilment ONGKIR KIRIM-FISIK untuk order yang sudah diklaim (FULFILLING) — PARUH AMAN saja.
   *
   * TIDAK ADA belanja/pendanaan USDC di sini, dan TIDAK memanggil CC: ia HANYA MENGGERAKKAN
   * STATUS redemption + menandai order FULFILLED, dalam SATU transaksi.
   *
   * ┌──────────── DUA RAIL, DUA TUJUAN STATUS. TIDAK BOLEH TERTUKAR. ──────────────────────────┐
   * │ CC VAULT (listingId NULL)  : AWAITING_PAYMENT → READY_TO_FUND. Pendanaan USDC + CC       │
   * │   prepare/burn dikerjakan MALAS di sesi tanda-tangan user (fundAndPrepare), BUKAN di     │
   * │   sini — itulah yang membuat jalur fulfilment ini tetap refund-safe (I2).                │
   * │ DOMESTIK (listingId NON-NULL): AWAITING_PAYMENT → PACKING. Ongkir Rupiah LUNAS dan       │
   * │   yang tersisa hanyalah Hoshi mengemas paketnya. READY_TO_FUND berarti "siap danai USDC" │
   * │   dan TIDAK PERNAH BOLEH tertulis di baris domestik: ia akan mengundang fundAndPrepare   │
   * │   memindahkan USDC treasury untuk kartu yang tidak punya NFT untuk dibakar.              │
   * └─────────────────────────────────────────────────────────────────────────────────────────┘
   *
   * Rail dibaca dari kolom `listingId` yang IMMUTABLE sesudah create, jadi pembacaan di bawah
   * tidak bisa basi. Walau begitu railnya TETAP dipasang sebagai PREDIKAT di updateMany, supaya
   * pemisahan dua rail ditegakkan Postgres dan bukan hanya oleh urutan baca kita.
   *
   * Penanganan gagalnya seperti fulfilTopup: nol treasury → TIDAK PERNAH REFUND_DUE pasca-belanja.
   * Kegagalan transien → lepas klaim ke PAID (reconciler mengulang). Kalau redemption sudah tidak
   * AWAITING_PAYMENT (mis. dibatalkan admin) → refund manual (pra-danai, refundSafe=true).
   */
  private async fulfilShipping(
    order: PaymentOrder,
    _user: { id: string; walletAddress: string },
  ): Promise<FulfilOutcome> {
    const redemptionId = order.redemptionId;
    if (!redemptionId) {
      return this.failToRefund(
        order,
        `Order SHIPPING ${order.merchantOrderId} tanpa redemptionId — refund manual.`,
      );
    }
    // RAIL. Dibaca dari FAKTA yang tersimpan (kolom immutable), bukan dari flag/konfigurasi.
    // Baris yang hilang → utang refund (Rupiah masuk, nol yang diserahkan, nol USDC bergerak).
    const railRow = await this.prisma.cardRedemption.findUnique({
      where: { id: redemptionId },
      select: { listingId: true },
    });
    if (!railRow) {
      return this.failToRefund(
        order,
        `Redemption ${redemptionId} hilang — ongkir Rupiah perlu di-refund manual.`,
      );
    }
    const domestic = isDomesticRedemption(railRow);
    const nextStatus = domestic
      ? RedemptionStatus.PACKING
      : RedemptionStatus.READY_TO_FUND;

    try {
      // Klaim AWAITING_PAYMENT → (READY_TO_FUND | PACKING) + order FULFILLED, ALL-OR-NOTHING
      // dalam SATU tx. count!==1 = redemption bukan lagi AWAITING_PAYMENT milik order ini
      // (dibatalkan / sudah maju / rail-nya bukan yang kita baca) → jangan diam-diam menandai
      // order FULFILLED; lempar untuk memicu penanganan di bawah.
      const claimed = await this.prisma.$transaction(async (tx) => {
        const c = await tx.cardRedemption.updateMany({
          where: {
            id: redemptionId,
            status: RedemptionStatus.AWAITING_PAYMENT,
            // PIN RAIL. Tanpa ini, sebuah pembacaan basi bisa menulis READY_TO_FUND ke baris
            // domestik (mengundang pendanaan USDC untuk kartu tanpa NFT) atau PACKING ke baris
            // CC (kartunya tak pernah dibakar tapi dianggap sedang dikemas).
            listingId: domestic ? { not: null } : null,
            // B1 — PIN KE ORDER INI. Sejak klaim AWAITING_PAYMENT BISA DILEPAS (invoice
            // kedaluwarsa / batal user), baris yang sama bisa berjalan lagi dengan invoice BARU.
            // Tanpa pin ini, invoice LAMA yang dibayar telat akan MEMBAJAK baris yang sudah
            // terikat invoice BARU: Rupiah yang benar-benar dibayar dan snapshot harga yang dipakai
            // assertCostWithinPaid jadi milik dua order berbeda. createShippingOrder selalu menulis
            // paymentOrderId DI DALAM transaksi yang sama dengan pembuatan order, jadi pin ini
            // tidak pernah meleset untuk baris yang lahir dari jalur itu.
            paymentOrderId: order.id,
          },
          data: { status: nextStatus },
        });
        if (c.count !== 1) return 0;
        await tx.paymentOrder.update({
          where: { merchantOrderId: order.merchantOrderId },
          data: {
            status: PaymentStatus.FULFILLED,
            fulfilledAt: new Date(),
            error: null,
          },
        });
        return 1;
      });
      if (claimed !== 1) {
        // Redemption tak lagi AWAITING_PAYMENT (mis. dibatalkan). Rupiah sudah masuk, ongkir belum
        // dilayani, NOL USDC bergerak → utang refund AMAN (refundSafe=true default).
        // Baris ini sudah TIDAK lagi milik order ini: dibatalkan user, invoice-nya kedaluwarsa
        // lalu dilepas ke REQUESTED, atau sudah terikat invoice yang LEBIH BARU. Rupiah-nya sudah
        // masuk, ongkir belum dilayani, NOL USDC bergerak → utang refund AMAN (refundSafe=true).
        // INI yang membuat pelepasan klaim tidak pernah menelan uang diam-diam.
        return this.failToRefund(
          order,
          `Redemption ${redemptionId} bukan lagi AWAITING_PAYMENT milik order ini (dibatalkan user, ` +
            'invoice kedaluwarsa lalu dilepas, atau sudah terikat invoice yang lebih baru) — ongkir ' +
            'Rupiah perlu di-refund manual.',
        );
      }
      this.logger.log(
        `Ongkir ${order.merchantOrderId} FULFILLED → redemption ${redemptionId} ${nextStatus} ` +
          `(user ${order.userId}). ` +
          (domestic
            ? 'Jalur DOMESTIK: paket dikemas Hoshi; NOL USDC, NOL burn, NOL CC.'
            : 'Pendanaan USDC ditunda ke sesi TTD user.'),
      );
      return 'FULFILLED';
    } catch (err) {
      // Transien (DB blip) → aman diulang: nol treasury, klaim redemption predikat-terjaga. Lepas ke PAID.
      return this.releaseClaimForRetry(
        order,
        `Fulfil ongkir gagal: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Settlement RESELLER kartu katalog CC untuk order yang sudah diklaim (FULFILLING).
   *
   * DUIT TREASURY: jalur real MEMBELANJAKAN USDC treasury (beli di CC) + SOL (gas transfer).
   * Karena itu GANDA-DIGERBANG dan default TIDAK belanja apa pun:
   *   • MOCK (staging/devnet, CC_MOCK): "kirim" kartu tanpa on-chain — NOL USDC/SOL.
   *   • REAL tapi HOSHI_CC_RESELL_ENABLED MATI (default): TIDAK belanja; user perlu di-refund.
   *   • REAL + flag NYALA: baru benar-benar beli di CC + transfer (diarmed sadar, treasury didanai).
   */
  private async fulfilListing(
    order: PaymentOrder,
    user: { id: string; walletAddress: string },
  ): Promise<FulfilOutcome> {
    const listing = order.listingId
      ? await this.prisma.listing.findUnique({ where: { id: order.listingId } })
      : null;
    if (!listing) {
      return this.failToRefund(
        order,
        `Listing ${order.listingId} hilang — order tidak bisa diselesaikan.`,
      );
    }

    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ URUTAN CABANG DI BAWAH ADALAH KONTRAKNYA. TITIPAN HARUS PERTAMA.                     ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    // Kartu titipan punya `sellerId != null`, jadi cabang P2P di bawah akan MENANGKAPNYA kalau ia
    // ditaruh lebih dulu — dan cabang itu menuntut NFT di escrow yang tidak akan pernah ada, jadi
    // ia gagal SESUDAH pembeli membayar. `listingKindOf` menjawab dari KOLOM `consignmentId`,
    // bukan dari bentuk.
    const kind: ListingKind = listingKindOf(listing);
    if (kind === 'CONSIGNMENT') {
      return this.fulfilConsignment(order, listing, user);
    }

    // Order untuk listing USER (P2P Flow B) → settlement BEDA: escrow kirim kartu ke pembeli +
    // kredit saldo penjual. BUKAN beli-di-CC. Dicek SEBELUM gerbang reseller CC.
    if (listing.sellerId != null) {
      return this.fulfilUserListing(order, listing, user);
    }

    // INVENTARIS HOSHI (source != COLLECTORCRYPT, tanpa penjual user): Hoshi jual kartunya SENDIRI.
    // Seluruh harga tetap di treasury = kas Hoshi. Nol beli-di-CC, nol kredit penjual eksternal,
    // nol on-chain. Dicek SEBELUM gerbang reseller CC (yang butuh ccNftAddress + USDC).
    if (listing.source !== 'COLLECTORCRYPT') {
      // Defense-in-depth: hanya stok yang DITANDAI sellable. Guard di createListingOrder sudah
      // menolak yang tidak sellable, tapi kalau toh ada order (mis. dibuat sebelum flag ini),
      // JANGAN tandai baris seed/placeholder terjual — refund manual.
      if (!isHoshiSellableStock(listing)) {
        return this.failToRefund(
          order,
          `Listing ${listing.id} bukan stok Hoshi yang dijual (sellable=${listing.sellable}, ` +
            `source=${listing.source}, sellerId=${listing.sellerId ?? 'null'}) — refund manual.`,
        );
      }
      return this.fulfilHoshiInventory(order, listing, user);
    }

    const mock = this.ccMockEnabled();
    const armed =
      (this.config.get<string>('HOSHI_CC_RESELL_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';

    // GERBANG BELANJA. Bukan mock DAN belum diarmed → JANGAN sentuh on-chain, JANGAN tandai
    // listing terjual. User sudah bayar → ini UTANG (refund manual), bukan izin kuras treasury.
    if (!mock && !armed) {
      return this.failToRefund(
        order,
        'Reseller CC belum diaktifkan (HOSHI_CC_RESELL_ENABLED=false) — pembayaran perlu di-refund manual.',
      );
    }
    if (!mock && armed) {
      // REAL: treasury MEMBELANJAKAN USDC untuk beli kartu di CC + kirim NFT ke pembeli.
      if (!listing.ccNftAddress) {
        return this.failToRefund(
          order,
          `Listing ${listing.id} tak punya alamat NFT CC — tak bisa disettle, refund manual.`,
        );
      }
      // GERBANG KONKURENSI: klaim listing ACTIVE→SOLD DULU (tepat satu pemenang), BARU belanja —
      // supaya dua order untuk kartu yang sama tidak dua-duanya membeli NFT di CC. Kalah klaim
      // (count != 1) → refund TANPA belanja apa pun.
      const claimed = await this.prisma.listing.updateMany({
        where: { id: listing.id, status: ListingStatus.ACTIVE },
        data: {
          status: ListingStatus.SOLD,
          buyerId: user.id,
          soldAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        return this.failToRefund(
          order,
          `Listing ${listing.id} sudah terjual lebih dulu — refund manual (belum belanja).`,
        );
      }
      let result: ResellerSettleResult;
      try {
        result = await this.resellerSettlement.settle({
          nftAddress: listing.ccNftAddress,
          buyerWallet: user.walletAddress,
          maxPriceUsdcBaseUnits: order.priceUsdc,
        });
      } catch (err) {
        if (err instanceof ResellerPostBuyError) {
          // USDC SUDAH/MUNGKIN keluar & NFT (mungkin) sudah dibeli treasury; hanya transfer/
          // konfirmasi yang belum tuntas. JANGAN refund, JANGAN balikkan listing (pembeli sudah
          // memilikinya secara ekonomi). Pesan menyuruh CEK ON-CHAIN + KIRIM ULANG, bukan refund.
          return this.failToRefund(
            order,
            `KARTU SUDAH/MUNGKIN DIBELI treasury (buy ${err.buySignature}) tapi belum terkirim ke ` +
              `pembeli. CEK ON-CHAIN & KIRIM ULANG NFT manual ke ${user.walletAddress} — JANGAN refund. (${err.message})`,
            false, // PASCA-belanja: treasury sudah/mungkin bayar → JANGAN refund (rugi dobel).
          );
        }
        // Gagal SEBELUM belanja (kutip/build/verify/sign): belum ada USDC keluar → balikkan
        // listing ke ACTIVE (bisa dijual lagi) lalu refund pembeli.
        await this.prisma.listing.updateMany({
          where: {
            id: listing.id,
            status: ListingStatus.SOLD,
            buyerId: user.id,
          },
          data: { status: ListingStatus.ACTIVE, buyerId: null, soldAt: null },
        });
        return this.failToRefund(
          order,
          `Settlement reseller gagal sebelum belanja: ${errorMessage(err)} — refund manual.`,
        );
      }

      // SETTLE SUKSES: USDC keluar + NFT terkirim. DARI SINI JANGAN PERNAH refund/rollback —
      // apa pun yang gagal setelah ini (mis. tulis FULFILLED) TIDAK boleh membatalkan penjualan
      // (kalau tidak: kartu sudah di pembeli, treasury sudah bayar, tapi kita refund = double loss).
      try {
        await this.prisma.paymentOrder.update({
          where: { merchantOrderId: order.merchantOrderId },
          data: {
            status: PaymentStatus.FULFILLED,
            fulfilledAt: new Date(),
            txHash: result.buySignature,
            error: null,
          },
        });
      } catch (dbErr) {
        // Kartu SUDAH terkirim; hanya gagal menandai FULFILLED. JANGAN refund/rollback — biarkan
        // order FULFILLING (reconciler menandainya stuck) + log keras untuk di-set FULFILLED manual.
        this.logger.error(
          `REAL reseller: listing ${listing.id} SUDAH terkirim (beli ${result.buySignature}, ` +
            `transfer ${result.transferSignature}) tapi gagal menandai FULFILLED: ${errorMessage(dbErr)}. ` +
            'Set FULFILLED manual — JANGAN refund.',
        );
      }
      this.logger.warn(
        `REAL reseller: listing ${listing.id} (${listing.name}) terkirim ke user ${user.id} ` +
          `— beli ${result.buySignature}, transfer ${result.transferSignature} ` +
          `(order ${order.merchantOrderId} FULFILLED).`,
      );
      return 'FULFILLED';
    }

    // MOCK: klaim listing ACTIVE→SOLD (dua order untuk satu listing → satu menang) lalu tandai
    // order FULFILLED — DALAM SATU transaksi. Kalau write kedua gagal (transient / pod restart),
    // seluruh transaksi rollback: listing TIDAK jadi SOLD dan order tetap FULFILLING (bisa
    // di-retry), bukan kondisi setengah jadi "listing terjual tapi order nyangkut selamanya".
    // TIDAK ADA USDC/SOL treasury yang bergerak.
    const claimedCount = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.listing.updateMany({
        where: { id: listing.id, status: ListingStatus.ACTIVE },
        data: {
          status: ListingStatus.SOLD,
          buyerId: user.id,
          soldAt: new Date(),
        },
      });
      if (claim.count !== 1) return claim.count;
      await tx.paymentOrder.update({
        where: { merchantOrderId: order.merchantOrderId },
        data: {
          status: PaymentStatus.FULFILLED,
          fulfilledAt: new Date(),
          error: null,
        },
      });
      return claim.count;
    });
    if (claimedCount !== 1) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} sudah terjual lebih dulu — pembayaran perlu di-refund manual.`,
      );
    }
    this.logger.warn(
      `MOCK reseller: listing ${listing.id} (${listing.name}) "terkirim" ke user ${user.id} ` +
        `TANPA belanja treasury (order ${order.merchantOrderId} FULFILLED).`,
    );
    return 'FULFILLED';
  }

  /**
   * Settlement INVENTARIS HOSHI: kartu milik Hoshi sendiri (source=HOSHI, tanpa penjual user).
   * Hoshi adalah penjual DAN platform, jadi SELURUH harga (priceIdrx) = pendapatan Hoshi yang
   * TETAP di treasury — TIDAK ada kredit saldo penjual eksternal, TIDAK beli di CC, TIDAK ada
   * USDC/SOL/on-chain yang bergerak. (Fee 5% marketplace hanya relevan untuk P2P yang penjualnya
   * user eksternal; di sini Hoshi menyimpan 100%.)
   *
   * Klaim ACTIVE→SOLD + FULFILLED + baris feed SALE_CARD dalam SATU transaksi (gerbang konkurensi:
   * dua order untuk satu kartu → tepat satu menang; yang kalah = refund manual tanpa efek).
   */
  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ SETTLEMENT KARTU TITIPAN — kartu ORANG LAIN yang fisiknya di rak Hoshi.                    ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Pembeli sudah membayar Rupiah (harga + fee QRIS) → treasury menerima. Di sini: tandai listing
   * SOLD, tandai titipannya SOLD, dan KREDIT SALDO PEMILIK sebesar (yang dibayar − komisi).
   *
   *   NOL USDC · NOL SOL · NOL on-chain · NOL escrow · NOL burn · NOL panggilan CollectorCrypt
   *
   * ┌────────────────────────────────────────────────────────────────────────────────────────────┐
   * │ RAIL INI SECARA STRUKTURAL TIDAK BISA MELAHIRKAN ORDER YANG AMBIGU.                        │
   * │                                                                                            │
   * │ Tidak ada panggilan on-chain, tidak ada API pihak ketiga, tidak ada burn, tidak ada tanda  │
   * │ tangan — tidak ada apa pun yang bisa "berhasil tapi tak terkonfirmasi". Setiap kegagalan    │
   * │ adalah "tidak ada yang commit" atau "semuanya commit". Karena itu aturan JANGAN-PERNAH-     │
   * │ MEMENUHI-ULANG-ORDER-AMBIGU tidak pernah sampai diuji di sini, dan `refundSafe` tetap TRUE │
   * │ pada SETIAP REFUND_DUE yang bisa dilahirkan rail ini: di semua kasus itu, Rupiah pembeli    │
   * │ TERBUKTI ada di treasury dan TERBUKTI tidak membeli apa pun.                                │
   * │ (Properti yang sama yang didokumentasikan jalur kirim domestik tentang dirinya sendiri.)   │
   * └────────────────────────────────────────────────────────────────────────────────────────────┘
   */
  private async fulfilConsignment(
    order: PaymentOrder,
    listing: Listing,
    user: { id: string; walletAddress: string },
  ): Promise<FulfilOutcome> {
    const consignmentId = listing.consignmentId;
    const sellerId = listing.sellerId;
    if (!consignmentId || !sellerId) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} masuk jalur titipan tanpa consignmentId/sellerId yang lengkap — ` +
          'tidak diselesaikan; refund manual.',
      );
    }

    // 1. GERBANG CUSTODY, SEBELUM SATU BARIS PUN DIKLAIM. Predikat yang SAMA dengan gerbang
    //    penerbitan tagihan (`assertConsignmentSaleAvailable`), jadi keduanya tidak bisa
    //    melenceng. Menolak DI SINI berarti listing tidak pernah menyentuh SOLD dan pemilik tidak
    //    pernah dikredit — jadi Rupiah pembeli aman di-refund seutuhnya.
    const c = await this.prisma.consignment.findUnique({
      where: { id: consignmentId },
      select: {
        id: true,
        status: true,
        custodyAcceptedAt: true,
        custodyReleasedAt: true,
        commissionBps: true,
        consignorId: true,
        // Untuk email "kartumu terjual" di ujung method ini. `cardName` dipakai di subjeknya;
        // kedua kolom snapshot serah-terima dipakai untuk LOG yang bisa ditindaklanjuti manusia
        // ketika pemiliknya tidak punya email (jalur normal untuk titipan Path B).
        cardName: true,
        consignorNameAtIntake: true,
        consignorPhoneAtIntake: true,
      },
    });
    if (!c) {
      return this.failToRefund(
        order,
        `Catatan titipan ${consignmentId} hilang — listing ${listing.id} tidak bisa ` +
          'diselesaikan. NOL kartu bergerak; Rupiah pembeli aman di-refund.',
      );
    }
    if (!isInHoshiCustody(c)) {
      return this.failToRefund(
        order,
        `Kartu titipan ${consignmentId} TIDAK LAGI di penyimpanan Hoshi saat pembayaran mendarat ` +
          `(status ${c.status}, custodyAcceptedAt=${c.custodyAcceptedAt ? 'ada' : 'null'}, ` +
          `custodyReleasedAt=${c.custodyReleasedAt ? 'ada' : 'null'}) — ditarik pemiliknya, ` +
          'sudah keluar, atau hilang. Listing TIDAK diklaim SOLD, pemilik TIDAK dikredit. ' +
          'Rupiah pembeli aman di-refund seluruhnya.',
      );
    }

    // 1b. ═══ SIAPA YANG DIBAYAR — PAGAR TERAKHIR, DAN IA ADA DI JALUR UANG ═══
    //
    // Sejak titipan bisa diterima dari orang yang BELUM punya akun Hoshi (kode klaim di tanda
    // terima serah-terima), `Consignment.consignorId` NULLABLE. Baris tanpa pemilik seharusnya
    // TIDAK PERNAH bisa sampai ke sini: ia tidak bisa berstatus LISTED (CHECK
    // `consignments_listed_requires_owner_chk`), predikat `listClaimWhere` menuntut
    // `consignorId != null`, dan CHECK `listings_consignment_shape_chk` menuntut
    // `sellerId IS NOT NULL` pada setiap baris listing titipan.
    //
    // Pemeriksaan ini tetap ditulis karena ia berada DI JALUR UANG: kalau satu dari ketiga pagar
    // itu suatu saat dilonggarkan, yang terjadi tanpa blok ini adalah `balance.credit` dipanggil
    // dengan id yang tidak menunjuk siapa pun SESUDAH pembeli membayar — Hoshi memegang Rupiah
    // orang tanpa tujuan untuk menyalurkannya. Menolak DI SINI berarti listing tidak pernah
    // menyentuh SOLD dan tidak ada saldo yang bergerak, jadi Rupiah pembeli utuh dan
    // refundSafe = true.
    //
    // Kesetaraan `consignorId === sellerId` ikut diperiksa karena keduanya MENJAWAB PERTANYAAN
    // YANG SAMA lewat dua kolom: `sellerId` adalah salinan yang dibekukan saat listing dibuat,
    // `consignorId` adalah sumbernya. Keduanya tidak bisa menyimpang lewat jalur mana pun yang
    // ada hari ini (penautan menolak menimpa pemilik yang sudah ada), jadi kalau mereka BERBEDA,
    // yang benar bukan salah satunya — yang benar adalah berhenti dan me-refund.
    if (c.consignorId == null || c.consignorId !== sellerId) {
      return this.failToRefund(
        order,
        `Titipan ${consignmentId} tidak punya pemilik yang jelas saat pembayaran mendarat ` +
          `(consignorId=${c.consignorId ?? 'null'}, listing.sellerId=${sellerId}) — tidak ada ` +
          'siapa pun yang boleh dikredit. Listing TIDAK diklaim SOLD dan NOL saldo bergerak; ' +
          'Rupiah pembeli aman di-refund seluruhnya.',
      );
    }

    // 2. BASIS PAYOUT = HARGA YANG PEMBELI BENAR-BENAR BAYAR, di-backout dari `order.priceIdr`
    //    (dikunci saat order dibuat) — BUKAN `listing.priceIdrx`, yang bisa diubah admin SESUDAH
    //    invoice terbit. Alasannya identik dengan jalur P2P: tanpa ini, perubahan harga di tengah
    //    invoice membuat treasury menerima harga lama sementara pemilik dikredit harga baru →
    //    treasury terkuras + kredit berlebih. order.priceIdr = base × (1 + QRIS).
    const paidBaseIdrx = Math.floor(
      (order.priceIdr * BPS_DENOMINATOR) / (BPS_DENOMINATOR + QRIS_FEE_BPS),
    );
    // 3. KOMISI DARI SNAPSHOT PERJANJIAN, BUKAN DARI ENV. `HOSHI_MARKETPLACE_FEE_BPS` sengaja
    //    TIDAK dibaca di sini: perjanjian bertanda tangan berbunyi 5%, dan mengubah env tidak
    //    boleh mengubah apa yang dijanjikan untuk kartu yang SUDAH ada di tangan kita.
    //    Clamp 0..100% supaya nilai intake yang salah tidak bisa membuat payout NEGATIF.
    const feeBps = Math.min(Math.max(c.commissionBps, 0), BPS_DENOMINATOR);
    const commission = Math.floor((paidBaseIdrx * feeBps) / BPS_DENOMINATOR);
    const payout = paidBaseIdrx - commission;

    // 4. SATU TRANSAKSI, SEMUA-ATAU-TIDAK SAMA SEKALI.
    let settled = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        // (a) GERBANG KONKURENSI listing: dua order untuk satu kartu → tepat satu menang.
        const claimListing = await tx.listing.updateMany({
          where: { id: listing.id, status: ListingStatus.ACTIVE },
          data: {
            status: ListingStatus.SOLD,
            buyerId: user.id,
            soldAt: new Date(),
          },
        });
        if (claimListing.count !== 1) return; // kalah → settled tetap false → rollback bersih

        // (b) GERBANG CUSTODY yang DITEGAKKAN, bukan cuma dibaca. Predikatnya menamai
        //     `status: LISTED` — status sumber yang SAMA yang dinamai klaim penarikan
        //     (`takeDownClaimWhere`). Itulah sebabnya "ditarik" dan "terjual" tidak mungkin
        //     dua-duanya berhasil, berapa pun rapatnya balapannya.
        const claimConsignment = await tx.consignment.updateMany({
          where: consignmentSaleClaimWhere(consignmentId),
          data: {
            status: 'SOLD',
            soldOrderId: order.merchantOrderId,
            payoutIdrx: payout,
            commissionIdrx: commission,
          },
        });
        if (claimConsignment.count !== 1) {
          // Penarikan / kehilangan menang balapan di antara (a) dan (b). BATALKAN SELURUHNYA —
          // klaim listing di (a) ikut ter-rollback karena kita melempar di dalam transaksi.
          throw new ConsignmentCustodyRaceLost(consignmentId);
        }

        // (c) KREDIT PEMILIK. Ledger yang SUDAH ADA, bukan buku besar kedua. Idempotensi
        //     `@@unique([reason, refId])` adalah pagar KEDUA; pagar pertama adalah klaim (a).
        if (payout > 0) {
          await this.balance.credit(
            {
              userId: sellerId,
              amountIdrx: payout,
              reason: CONSIGNMENT_SALE_REASON,
              refId: order.merchantOrderId,
            },
            tx,
          );
        }

        // (d) Order FULFILLED.
        await tx.paymentOrder.update({
          where: { merchantOrderId: order.merchantOrderId },
          data: {
            status: PaymentStatus.FULFILLED,
            fulfilledAt: new Date(),
            error: null,
          },
        });

        // (e) Feed: kartu berpindah dari PEMILIK ke PEMBELI. Pemiliknya user sungguhan, jadi
        //     baris ini benar apa adanya — itulah salah satu alasan consignor WAJIB non-null.
        await tx.activity.create({
          data: {
            type: ActivityType.SALE_CARD,
            listingId: listing.id,
            itemName: listing.name,
            itemImage: listing.image,
            category: listing.category,
            set: listing.set,
            amount: paidBaseIdrx,
            fromId: sellerId,
            fromLabel: listing.sellerAddress,
            toId: user.id,
            toLabel: user.walletAddress,
          },
        });

        // (f) JEJAK AUDIT: setiap perubahan keadaan titipan menulis siapa/kapan/apa.
        await tx.consignmentEvent.create({
          data: {
            consignmentId,
            kind: 'SOLD',
            fromStatus: 'LISTED',
            toStatus: 'SOLD',
            actorId: user.id,
            actorLabel: user.walletAddress,
            note:
              `Terjual lewat order ${order.merchantOrderId}. Dibayar Rp ${paidBaseIdrx} ` +
              `(di luar fee QRIS); komisi ${feeBps} bps = Rp ${commission}; payout pemilik ` +
              `Rp ${payout}.`,
          },
        });
        settled = true;
      });
    } catch (err) {
      if (err instanceof ConsignmentCustodyRaceLost) {
        // Seluruh transaksi ter-rollback: listing TIDAK jadi SOLD, pemilik TIDAK dikredit.
        return this.failToRefund(
          order,
          `Kartu titipan ${consignmentId} berpindah keadaan (ditarik pemiliknya / ditandai ` +
            'hilang) tepat saat settlement berjalan. Seluruh transaksi dibatalkan: listing tetap ' +
            'seperti semula, pemilik TIDAK dikredit, NOL kartu bergerak. Rupiah pembeli aman ' +
            'di-refund seluruhnya.',
        );
      }
      // Kegagalan DB transien: TIDAK ADA yang ter-commit (semuanya satu transaksi), jadi aman
      // diulang. Lepas klaim order ke PAID supaya reconciler memungutnya lagi.
      return this.releaseClaimForRetry(
        order,
        `Settlement titipan gagal: ${errorMessage(err)}`,
      );
    }

    if (!settled) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} (titipan ${consignmentId}) sudah tidak ACTIVE — terjual lebih ` +
          'dulu atau ditarik. Tidak ada yang diselesaikan dan pemilik tidak dikredit; Rupiah ' +
          'pembeli aman di-refund.',
      );
    }

    this.logger.log(
      `TITIPAN TERJUAL: listing ${listing.id} ("${listing.name}", titipan ${consignmentId}) ke ` +
        `user ${user.id}. Dibayar Rp ${paidBaseIdrx}; komisi Hoshi ${feeBps} bps = ` +
        `Rp ${commission}; pemilik ${sellerId} dikredit Rp ${payout}. NOL USDC, NOL SOL, NOL ` +
        `on-chain (order ${order.merchantOrderId} FULFILLED).`,
    );

    // ── "KAMI AKAN MEMBERITAHUMU" — halaman titipan menjanjikannya; ini yang menepatinya ──
    //
    // DI SINI, dan bukan di dalam transaksi, dengan sengaja: baris ini hanya terjangkau setelah
    // settlement TERBUKTI commit (`settled === true` dan penjaga di atasnya sudah lewat), jadi
    // tidak mungkin ada email "kartumu terjual" untuk penjualan yang di-rollback. Angkanya
    // diambil dari variabel yang SAMA yang baru saja ditulis ke ledger, bukan dihitung ulang —
    // email dan buku besar tidak boleh bisa menyebut angka yang berbeda.
    this.consignmentNotify.notifySold(
      ConsignmentNotifyService.target({
        id: c.id,
        consignorId: c.consignorId,
        cardName: c.cardName,
        consignorNameAtIntake: c.consignorNameAtIntake,
        consignorPhoneAtIntake: c.consignorPhoneAtIntake,
      }),
      {
        paidBaseIdr: paidBaseIdrx,
        commissionIdr: commission,
        payoutIdr: payout,
        commissionBps: feeBps,
      },
    );
    return 'FULFILLED';
  }

  private async fulfilHoshiInventory(
    order: PaymentOrder,
    listing: Listing,
    user: { id: string; walletAddress: string },
  ): Promise<FulfilOutcome> {
    // PERTAHANAN BERLAPIS. Jalur ini menyimpan SELURUH harga sebagai kas Hoshi. Menjalankannya
    // untuk kartu TITIPAN berarti menjual kartu orang lain dan TIDAK MEMBAYARNYA SEPESER PUN.
    // Harusnya tidak terjangkau: `isHoshiSellableStock` menuntut `sellerId == null` dan CHECK
    // constraint memaku `sellerId IS NOT NULL` untuk baris titipan. Kalau baris ini pernah
    // menyala, salah satu dari keduanya sudah dilonggarkan — dan yang benar adalah BERHENTI,
    // bukan menyelesaikan penjualannya.
    if (listing.consignmentId != null) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} adalah kartu TITIPAN (consignment ${listing.consignmentId}) tapi ` +
          'mendarat di jalur inventaris Hoshi, yang menyimpan 100% harga dan TIDAK mengkredit ' +
          'pemilik kartunya. TIDAK diselesaikan; Rupiah pembeli aman di-refund. Ini berarti ada ' +
          'predikat yang dilonggarkan — periksa isHoshiSellableStock dan urutan cabang fulfilListing.',
      );
    }
    const claimedCount = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.listing.updateMany({
        where: { id: listing.id, status: ListingStatus.ACTIVE },
        data: {
          status: ListingStatus.SOLD,
          buyerId: user.id,
          soldAt: new Date(),
        },
      });
      if (claim.count !== 1) return claim.count;
      await tx.paymentOrder.update({
        where: { merchantOrderId: order.merchantOrderId },
        data: {
          status: PaymentStatus.FULFILLED,
          fulfilledAt: new Date(),
          error: null,
        },
      });
      await tx.activity.create({
        data: {
          type: ActivityType.SALE_CARD,
          listingId: listing.id,
          itemName: listing.name,
          itemImage: listing.image,
          category: listing.category,
          set: listing.set,
          amount: listing.priceIdrx,
          fromLabel: 'Hoshi',
          toId: user.id,
          toLabel: user.walletAddress,
        },
      });
      return claim.count;
    });
    if (claimedCount !== 1) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} sudah terjual lebih dulu — pembayaran perlu di-refund manual.`,
      );
    }
    this.logger.log(
      `Inventaris Hoshi: listing ${listing.id} (${listing.name}) terjual ke user ${user.id} — ` +
        `Rp ${listing.priceIdrx} masuk kas Hoshi (order ${order.merchantOrderId} FULFILLED).`,
    );
    return 'FULFILLED';
  }

  /**
   * Settlement jual-beli antar USER (P2P Flow B). Pembeli sudah bayar Rupiah (priceIdrx + fee
   * QRIS) → treasury terima. Di sini: kirim kartu penjual (dari escrow) ke pembeli + kredit
   * saldo penjual (priceIdrx − komisi). Hoshi TIDAK membeli apa pun (nol USDC/treasury).
   *
   * GANDA-GERBANG seperti reseller:
   *   • MOCK (staging/devnet, CC_MOCK): simulasi — kredit saldo penjual (DB) + tandai SOLD, TANPA
   *     on-chain (kartu tak benar-benar pindah). Cukup untuk menguji UX + payout.
   *   • REAL tapi HOSHI_P2P_ENABLED MATI (default): TIDAK settle; refund manual.
   *   • REAL + flag NYALA: escrow benar-benar transfer kartu ke pembeli, lalu kredit penjual.
   */
  private async fulfilUserListing(
    order: PaymentOrder,
    listing: Listing,
    user: { id: string; walletAddress: string },
  ): Promise<FulfilOutcome> {
    // PERTAHANAN BERLAPIS, DAN INI YANG PALING PENTING DARI SEMUANYA.
    //
    // Jalur ini menyelesaikan penjualan dengan MEMINDAHKAN CORE ASSET KELUAR DARI WALLET ESCROW.
    // Kartu titipan tidak punya aset on-chain dan tidak akan pernah punya, jadi menjalankannya di
    // sini berarti gagal SESUDAH pembeli membayar — mode kegagalan paling mahal di repo ini.
    //
    // HARUSNYA TIDAK TERJANGKAU, dan berlapis tiga:
    //   1. `fulfilListing` bercabang ke `fulfilConsignment` DI ATAS cabang `sellerId != null`;
    //   2. CHECK constraint `listings_consignment_shape_chk` memaku `ccNftAddress` dan
    //      `escrowedAt` NULL untuk baris titipan, sehingga `isEscrowBackedUserListing` MUSTAHIL
    //      true dan gerbang ARMED di bawah menolak lebih dulu;
    //   3. baris ini.
    // Kalau baris ini pernah menyala, urutan cabang (1) sudah diubah — dan pesannya mengatakan itu.
    if (listing.consignmentId != null) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} adalah kartu TITIPAN (consignment ${listing.consignmentId}) tapi ` +
          'mendarat di jalur settlement P2P, yang menyerahkan kartu DARI WALLET ESCROW. Escrow ' +
          'tidak memegang apa pun untuk kartu titipan dan tidak akan pernah. TIDAK diselesaikan, ' +
          'listing TIDAK diklaim SOLD; Rupiah pembeli aman di-refund. Periksa urutan cabang di ' +
          'fulfilListing — cabang CONSIGNMENT harus DI ATAS cabang sellerId != null.',
      );
    }

    const sellerId = listing.sellerId;
    if (!sellerId) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} tak punya penjual — order tidak bisa diselesaikan.`,
      );
    }

    const mode = this.p2pMode();
    const mock = mode === 'MOCK';
    if (mode === 'OFF') {
      return this.failToRefund(
        order,
        'Jual-beli antar user belum diaktifkan (HOSHI_P2P_ENABLED=false) — pembayaran perlu di-refund manual.',
      );
    }

    // B — GERBANG "BISA DISELESAIKAN?", DIJALANKAN SEBELUM SATU BARIS PUN DIKLAIM.
    //
    // Predikatnya BUKAN salinan lokal lagi: `isEscrowBackedUserListing` adalah fungsi yang SAMA
    // yang dipakai gerbang penerbitan tagihan, feed publik, dashboard admin, dan serializer.
    // Salinan lokal yang lama berbunyi `listing.ccNftAddress && listing.escrowedAt == null` —
    // yaitu ia MELEWATKAN listing user ber-ccNftAddress NULL sepenuhnya. Baris seperti itu lolos
    // sampai ke klaim ACTIVE→SOLD di bawah, menang klaim, lalu ditolak TANPA rollback: pembeli
    // kehilangan Rupiah, penjual tidak dikredit, dan listing tertinggal SOLD atas nama pembeli.
    //
    // DUA SYARAT, keduanya wajib, karena settlement di bawah butuh keduanya:
    //   • ccNftAddress — ADA aset yang bisa diserahkan escrow;
    //   • escrowedAt   — escrow TERBUKTI memegangnya (FAKTA tersimpan, bukan flag saat ini).
    //
    // Menolak DI SINI (bukan sesudah klaim, bukan sesudah 30 detik polling RPC) berarti:
    // listing tidak pernah menyentuh SOLD, offer tidak pernah diklaim, dan pesan REFUND_DUE-nya
    // menyebut SEBAB yang sebenarnya, bukan gejalanya.
    if (mode === 'ARMED' && !isEscrowBackedUserListing(listing)) {
      return this.failToRefund(
        order,
        listing.ccNftAddress == null
          ? `Listing ${listing.id} TIDAK PUNYA aset on-chain (ccNftAddress null) — ia dibuat lewat ` +
              `POST /marketplace tanpa fromPackMemo, jadi tidak ada kartu yang bisa diserahkan escrow ` +
              `dan TIDAK PERNAH ada jalur settlement untuknya. NOL kartu bergerak, listing TIDAK ` +
              `diklaim SOLD; Rupiah pembeli aman di-refund. Penjual ${sellerId} harus membatalkan ` +
              'listing ini (tidak bisa dipulihkan dengan relist — tak ada kartu untuk dititipkan).'
          : `Listing ${listing.id} TIDAK PERNAH dititipkan ke escrow (escrowedAt null) — ia dibuat ` +
              `sebelum HOSHI_P2P_ENABLED dinyalakan, jadi escrow tak memegang kartu ${listing.ccNftAddress} ` +
              `untuk diserahkan. NOL kartu bergerak; Rupiah pembeli aman di-refund. Penjual ${sellerId} ` +
              'harus memajang ulang (relist) supaya kartunya dititipkan lebih dulu.',
      );
    }

    // GERBANG OFFER (order bayar-offer, offerId != null). Settle HANYA jika offer ini MASIH yang
    // diterima penjual. Klaim atomik ACCEPTED→PAID (tepat satu pemenang) MENUTUP balapan TOCTOU: kalau
    // penjual sudah men-supersede offer ini (accept offer lain → offer ini REJECTED) atau menolaknya
    // selagi invoice pembeli masih hidup, klaim gagal (count 0) → pembeli DI-REFUND, kartu TIDAK
    // pindah, penjual TIDAK dikredit di harga basi. Klaim ini SEBELUM klaim listing ACTIVE→SOLD =
    // gerbang keputusan; kegagalannya tidak menyentuh listing. (Order beli-langsung offerId=null →
    // lewati; single-winner-nya cukup dijaga klaim listing.)
    if (order.offerId) {
      const offerClaim = await this.prisma.offer.updateMany({
        where: { id: order.offerId, status: OfferStatus.ACCEPTED },
        data: { status: OfferStatus.PAID },
      });
      if (offerClaim.count !== 1) {
        return this.failToRefund(
          order,
          `Offer ${order.offerId} bukan lagi penawaran yang diterima penjual ` +
            `(sudah di-supersede / ditolak / dibatalkan) — pembayaran perlu di-refund manual.`,
        );
      }
    }

    // BASIS payout = harga yang PEMBELI BENAR-BENAR BAYAR, di-backout dari order.priceIdr (dikunci
    // saat order dibuat), BUKAN listing.priceIdrx yang bisa diubah penjual SESUDAH order terbit.
    // Tanpa ini: penjual menaikkan harga di tengah invoice → treasury cuma terima harga lama tapi
    // penjual dikredit harga baru → treasury drain + over-credit. order.priceIdr = base × (1 + QRIS),
    // jadi base = order.priceIdr × BPS / (BPS + QRIS_FEE).
    const paidBaseIdrx = Math.floor(
      (order.priceIdr * BPS_DENOMINATOR) / (BPS_DENOMINATOR + QRIS_FEE_BPS),
    );
    // Komisi Hoshi diambil dari sisi PENJUAL. Clamp 0..100% supaya salah setting env tidak bikin
    // payout NEGATIF (penjual malah "berutang").
    const feeBps = Math.min(
      this.intConfig('HOSHI_MARKETPLACE_FEE_BPS', 500, 0),
      BPS_DENOMINATOR,
    );
    const commission = Math.floor((paidBaseIdrx * feeBps) / BPS_DENOMINATOR);
    const payout = paidBaseIdrx - commission;

    if (mock) {
      // MOCK: klaim ACTIVE→SOLD + kredit penjual (DB, nyata biar payout kelihatan) + order
      // FULFILLED — ALL-OR-NOTHING dalam SATU transaksi (parity dgn reseller MOCK): crash di
      // tengah rollback bersih, order tetap bisa maju via klaim ulang, bukan half-state. NOL
      // on-chain (kartu tak benar-benar pindah).
      let claimedMock = false;
      await this.prisma.$transaction(async (tx) => {
        const c = await tx.listing.updateMany({
          where: { id: listing.id, status: ListingStatus.ACTIVE },
          data: {
            status: ListingStatus.SOLD,
            buyerId: user.id,
            soldAt: new Date(),
          },
        });
        if (c.count !== 1) return; // kalah klaim → claimedMock tetap false → tak kredit/FULFILLED
        if (payout > 0) {
          await this.balance.credit(
            {
              userId: sellerId,
              amountIdrx: payout,
              reason: 'P2P_SALE',
              refId: order.merchantOrderId,
            },
            tx,
          );
        }
        await tx.paymentOrder.update({
          where: { merchantOrderId: order.merchantOrderId },
          data: {
            status: PaymentStatus.FULFILLED,
            fulfilledAt: new Date(),
            error: null,
          },
        });
        claimedMock = true;
      });
      if (!claimedMock) {
        return this.failToRefund(
          order,
          `Listing ${listing.id} sudah terjual lebih dulu — refund manual (belum settle).`,
        );
      }
      this.logger.warn(
        `MOCK P2P: listing ${listing.id} (${listing.name}) "terjual" ke ${user.id}; penjual ` +
          `${sellerId} dikredit Rp ${payout} (komisi Rp ${commission}) TANPA on-chain ` +
          `(order ${order.merchantOrderId} FULFILLED).`,
      );
      return 'FULFILLED';
    }

    // ALAMAT ASET DIBACA SEBELUM KLAIM, BUKAN SESUDAH. Gerbang di atas sudah menjaminnya untuk
    // mode ARMED; ini pagar kedua yang sengaja tetap ada, dan LETAKNYA yang penting: versi lama
    // memeriksa hal yang sama SESUDAH klaim ACTIVE→SOLD menang, lalu `return failToRefund` TANPA
    // mengembalikan listing ke ACTIVE — satu-satunya early-return di fungsi ini yang menyisakan
    // listing SOLD atas nama pembeli padahal NOL kartu berpindah. Menolak sebelum klaim membuat
    // pertanyaan "perlu rollback atau tidak" tidak pernah muncul.
    const assetAddress = listing.ccNftAddress;
    if (!assetAddress) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} tak punya alamat NFT (escrow) — refund manual (belum diklaim, ` +
          'listing tetap ACTIVE).',
      );
    }

    // REAL (armed): klaim ACTIVE→SOLD DULU (gerbang konkurensi) SEBELUM transfer on-chain — dua
    // order satu kartu → satu menang; kalah klaim → refund tanpa transfer.
    const claimed = await this.prisma.listing.updateMany({
      where: { id: listing.id, status: ListingStatus.ACTIVE },
      data: {
        status: ListingStatus.SOLD,
        buyerId: user.id,
        soldAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      return this.failToRefund(
        order,
        `Listing ${listing.id} sudah terjual lebih dulu — refund manual (belum settle).`,
      );
    }
    // SESUDAH BARIS INI listing SUDAH diklaim SOLD atas nama pembeli. Setiap keluar dari sini
    // WAJIB memilih SECARA SADAR antara rollback (pra-kirim: kartu belum bergerak) dan TIDAK
    // rollback (pasca-kirim: kartu mungkin sudah pindah) — tidak ada pilihan ketiga.
    let transferSig: string;
    try {
      transferSig = await this.escrow.transferCoreAssetTo({
        assetAddress,
        newOwner: user.walletAddress,
      });
    } catch (err) {
      if (err instanceof EscrowTransferIndeterminateError) {
        // Kartu MUNGKIN sudah pindah ke pembeli (kirim lolos, confirm gagal). JANGAN refund,
        // JANGAN balikin listing → cek on-chain + kredit penjual manual bila kartu sudah pindah.
        return this.failToRefund(
          order,
          `Kartu P2P ${listing.ccNftAddress} MUNGKIN sudah terkirim ke pembeli tapi konfirmasi ` +
            `gagal. CEK ON-CHAIN (owner kartu) — JANGAN refund; kredit penjual ${sellerId} manual ` +
            `bila kartu sudah pindah. (${err.message})`,
          false, // PASCA-transfer: kartu mungkin sudah pindah → JANGAN refund (rugi dobel).
        );
      }
      // Pra-kirim (mis. escrow belum memiliki kartunya) → belum ada yang pindah → rollback + refund.
      await this.prisma.listing.updateMany({
        where: { id: listing.id, status: ListingStatus.SOLD, buyerId: user.id },
        data: { status: ListingStatus.ACTIVE, buyerId: null, soldAt: null },
      });
      return this.failToRefund(
        order,
        `Transfer kartu P2P gagal sebelum terkirim: ${errorMessage(err)} — refund manual.`,
      );
    }

    // Kartu SUDAH terkirim ke pembeli. DARI SINI JANGAN refund/rollback. Kredit penjual (idempoten)
    // + order FULFILLED; kalau gagal, log keras untuk diselesaikan manual (JANGAN refund).
    try {
      if (payout > 0) {
        await this.balance.credit({
          userId: sellerId,
          amountIdrx: payout,
          reason: 'P2P_SALE',
          refId: order.merchantOrderId,
        });
      }
      await this.prisma.paymentOrder.update({
        where: { merchantOrderId: order.merchantOrderId },
        data: {
          status: PaymentStatus.FULFILLED,
          fulfilledAt: new Date(),
          txHash: transferSig,
          error: null,
        },
      });
    } catch (dbErr) {
      this.logger.error(
        `P2P: kartu ${listing.ccNftAddress} SUDAH terkirim ke pembeli (sig ${transferSig}) tapi ` +
          `kredit/FULFILLED gagal: ${errorMessage(dbErr)}. Kredit penjual ${sellerId} Rp ${payout} ` +
          'manual + set FULFILLED — JANGAN refund.',
      );
    }
    this.logger.warn(
      `REAL P2P: listing ${listing.id} (${listing.name}) terjual ke ${user.id}; penjual ${sellerId} ` +
        `dikredit Rp ${payout} (komisi Rp ${commission}), transfer ${transferSig}.`,
    );
    return 'FULFILLED';
  }

  /** MOCK CC aktif: staging/devnet + CC_MOCK=1 + bukan sinyal produksi. Sama dgn GachaService. */
  private ccMockEnabled(): boolean {
    return (
      this.config.get<string>('CC_MOCK') === '1' &&
      detectProductionSignal() === null
    );
  }

  /**
   * Mode settlement P2P yang BERLAKU SEKARANG — MOCK / ARMED / OFF. Sumbernya SATU fungsi yang
   * juga dipakai MarketplaceService (src/marketplace/p2p.gate.ts), supaya keputusan "listing ini
   * butuh escrow atau tidak" saat DIBUAT tidak bisa menyimpang dari keputusan "settlement mana
   * yang dijalankan" saat DIBAYAR. Nilainya identik dengan pasangan `ccMockEnabled()` +
   * pembacaan HOSHI_P2P_ENABLED yang dipakai `fulfilUserListing` sebelum pass ini.
   */
  private p2pMode(): P2pMode {
    return p2pModeOf(this.config);
  }

  /* ─────────────────────────── Reconciler ─────────────────────────── */

  /**
   * SUMBER KEBENARAN yang sesungguhnya — bukan callback.
   *
   * Callback IDRX dikirim SEKALI dan TIDAK PERNAH DIULANG. Kalau backend kita sedang deploy,
   * 502, atau OOM selama tiga detik itu, callback-nya hilang SELAMANYA: user sudah membayar
   * ratusan ribu rupiah dan tidak ada satu pun proses yang akan pernah menyadarinya. Fungsi
   * inilah proses itu. Ia juga yang menyelamatkan kita dari URL callback yang salah didaftarkan
   * di dashboard IDRX — kesalahan yang gejalanya nol (mint-request sukses, user bayar, IDRX
   * senang, dan 100% order diam-diam tidak pernah tertebus).
   *
   * Dipanggil dari endpoint admin (proyek ini sengaja tidak punya scheduler), jadi cadence-nya
   * ditentukan cron eksternal.
   *
   * TIGA HIMPUNAN, TIGA QUERY TERPISAH (sengaja tidak digabung — lihat alasannya di masing-masing):
   *   1. PENDING/PAID  — order yang BISA maju. Ditebus.
   *   2. FULFILLING    — macet di tengah belanja treasury. Hanya DILAPORKAN (risiko dobel-bayar).
   *   3. EXPIRED baru  — B1: sabuk-dan-bretel balapan kedaluwarsa-vs-pembayaran. Diverifikasi
   *      ulang ke IDRX; kalau ternyata DIBAYAR → utang tercatat. TIDAK PERNAH mengirim barangnya.
   */
  async reconcile(olderThanMinutes = 5): Promise<ReconcileSummary> {
    const now = Date.now();
    const cutoff = new Date(now - olderThanMinutes * 60_000);
    const floor = new Date(now - RECONCILE_MAX_AGE_MS);

    // Order yang BISA maju (PENDING/PAID) dipindai terpisah dari yang macet di FULFILLING.
    // Kalau digabung dalam satu batch oldest-first, tumpukan FULFILLING tua yang tidak pernah
    // beres akan memenuhi kuota 50 dan MENYANDERA order PAID baru — user yang sudah bayar tak
    // pernah ditebus. Batch RECONCILE_BATCH_MAX disediakan penuh untuk yang bisa ditindak.
    const stale = await this.prisma.paymentOrder.findMany({
      where: {
        OR: [
          // PENDING (rupiah BELUM masuk): dibatasi `floor` — lewat RECONCILE_MAX_AGE_MS ia
          // sudah mati (invoice IDRX kedaluwarsa) dan tak ada dana yang dipertaruhkan, jadi
          // aman berhenti memindainya supaya reconciler tidak bekerja tanpa batas.
          {
            status: PaymentStatus.PENDING,
            createdAt: { lte: cutoff, gte: floor },
          },
          // PAID (rupiah SUDAH masuk treasury sebagai IDRX): TANPA `floor`. Order ini menahan
          // uang user; kalau ikut di-floor, sebuah PAID yang tak tertebus > 7 hari akan diam-diam
          // hilang dari SEMUA polling → uang yatim tanpa yang menandai. Harus dipoll sampai
          // tertebus atau di-refund.
          { status: PaymentStatus.PAID, createdAt: { lte: cutoff } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: RECONCILE_BATCH_MAX,
    });

    // FULFILLING yang benar-benar tersangkut (updatedAt sudah lewat cutoff, bukan yang sedang
    // ditebus callback SEKARANG) hanya DILAPORKAN — klaim atomik menolak menebusnya lagi, dan
    // USDC treasury mungkin sudah keluar, jadi menebus ulang berisiko dobel-bayar. Query ini
    // TERPISAH agar tidak memakan jatah batch order yang masih bisa maju.
    const stuck = await this.prisma.paymentOrder.findMany({
      where: {
        status: PaymentStatus.FULFILLING,
        // TANPA `floor`: FULFILLING = proses tebus mati di tengah, USDC treasury MUNGKIN sudah
        // keluar. Ini hanya DILAPORKAN (tidak ditebus ulang — risiko dobel-bayar), jadi harus
        // tetap muncul di laporan sampai manusia menuntaskannya, bukan diam-diam hilang > 7 hari.
        updatedAt: { lte: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: RECONCILE_BATCH_MAX,
    });

    // ── B1 — SAPUAN EXPIRED (sabuk-dan-bretel atas kedua jalur utang balapan) ────────────────────
    // Kedua interleaving balapan kedaluwarsa-vs-pembayaran sampai sekarang HANYA ketahuan kalau
    // sebuah callback kebetulan datang. Callback IDRX dikirim sekali dan tidak pernah diulang.
    // Sapuan ini membuat orphan tidak lagi bergantung pada callback mana pun: ia memverifikasi
    // ulang baris EXPIRED ke IDRX sendiri, dan `verifyAndFulfil` membelokkannya ke
    // settleExpiredButPaid (yang MENCATAT UTANG, tidak pernah mengirim barangnya).
    //
    // DIBATASI DUA ARAH supaya tidak pernah memindai sejarah purba selamanya:
    //   - `updatedAt >= now - RECONCILE_EXPIRED_SWEEP_MS`: hanya baris yang BARU SAJA jadi EXPIRED.
    //   - batch TERPISAH & lebih kecil: tidak bisa memakan jatah order PENDING/PAID yang bisa maju.
    // IDEMPOTEN: begitu utangnya tercatat, statusnya REFUND_DUE dan filter `status = EXPIRED` ini
    // tidak melihatnya lagi — sapuan berikutnya TIDAK BISA membuat utang kedua. Dan tulisan
    // settleExpiredButPaid sendiri berpagar `status IN (EXPIRED)`, jadi dua sapuan yang bersamaan
    // pun hanya memindahkan SATU baris.
    // B2 — KONVERGENSI. Tanpa ini sapuan bertanya ULANG ke IDRX untuk baris yang SAMA di setiap
    // tick selama sejam (baris jujur-kedaluwarsa tidak pernah ditulis → `updatedAt`-nya tak
    // bergerak → ia tetap lolos filter): 25 baris × 30 tick = 750 panggilan History per jam yang
    // semuanya menjawab hal yang sama. `notIn` dipakai DI DALAM query, bukan filter sesudahnya,
    // supaya baris yang sudah dijawab juga tidak memakan jatah `take` dan tidak bisa menyandera
    // baris EXPIRED yang lebih baru. Isinya cuma jadwal bertanya — lihat quietExpiredSweep.
    const quiet = this.activeExpiredSweepQuiet(now);
    const expiredSweep = await this.prisma.paymentOrder.findMany({
      where: {
        status: PaymentStatus.EXPIRED,
        updatedAt: { gte: new Date(now - RECONCILE_EXPIRED_SWEEP_MS) },
        ...(quiet.length > 0 ? { merchantOrderId: { notIn: quiet } } : {}),
      },
      orderBy: { updatedAt: 'asc' },
      take: RECONCILE_EXPIRED_BATCH_MAX,
    });

    const summary: ReconcileSummary = {
      scanned: stale.length + stuck.length + expiredSweep.length,
      fulfilled: 0,
      expired: 0,
      refundDue: 0,
      stillPending: 0,
      verifyFailed: 0,
    };

    for (const order of stuck) {
      // Proses mati di tengah belanja treasury. Satu-satunya jalan keluar yang jujur: manusia
      // mencocokkan ke ledger CcPackPurchase (lewat packMemo/userId).
      // B1/B2: SEBUT BARANGNYA, dan sebut jalan keluarnya. Order ONGKIR yang macet di sini dulu
      // ikut MENGUNCI kartunya (redemption-nya tersangkut AWAITING_PAYMENT tanpa jalan keluar).
      // Sekarang ada jalan keluar, dan operator harus tahu namanya — bukan cuma "periksa manual".
      const stuckSubject = orderSubject(order);
      this.logger.error(
        `Order ${stuckSubject} ${order.merchantOrderId} macet di FULFILLING sejak ` +
          `${order.updatedAt.toISOString()}. TIDAK ditebus ulang otomatis (risiko dobel-bayar ` +
          'treasury) — butuh pemeriksaan manual terhadap ledger CcPackPurchase.' +
          (stuckSubject === 'ONGKIR KIRIM FISIK'
            ? ` Redemption ${order.redemptionId ?? '?'} kemungkinan tersangkut AWAITING_PAYMENT: ` +
              'user bisa POST /redemptions/:id/cancel, atau operator POST ' +
              '/admin/redemptions/:id/cancel-awaiting-payment — keduanya menandai order ini ' +
              'REFUND_DUE (utang tercatat) dan membebaskan mint-nya.'
            : ''),
      );
      summary.stillPending += 1;
    }

    for (const order of stale) {
      const outcome = await this.verifyAndFulfil(order.merchantOrderId);
      switch (outcome) {
        case 'FULFILLED':
          summary.fulfilled += 1;
          break;
        case 'EXPIRED':
          summary.expired += 1;
          break;
        case 'REFUND_DUE':
          summary.refundDue += 1;
          break;
        case 'VERIFY_FAILED':
        case 'PIN_UNVERIFIABLE':
          summary.verifyFailed += 1;
          break;
        default:
          summary.stillPending += 1;
          break;
      }
    }

    // B1 — sapuan EXPIRED. `verifyAndFulfil` membelokkan setiap baris ini ke settleExpiredButPaid:
    // 'REFUND_DUE' = pembayarannya ternyata NYATA → utang tercatat (barangnya TIDAK dikirim);
    // 'ALREADY_CLAIMED' = IDRX menegaskan memang tak pernah dibayar → tetap EXPIRED, nol tulisan.
    // Yang terakhir dihitung sebagai `expired`, BUKAN `stillPending`: kedaluwarsa yang jujur bukan
    // pekerjaan yang tertunda, dan mencampurnya akan membuat angka "masih menunggu" jadi bohong.
    for (const order of expiredSweep) {
      const outcome = await this.verifyAndFulfil(order.merchantOrderId);
      switch (outcome) {
        case 'REFUND_DUE':
          summary.refundDue += 1;
          break;
        case 'VERIFY_FAILED':
        case 'PIN_UNVERIFIABLE':
          summary.verifyFailed += 1;
          break;
        default:
          summary.expired += 1;
          break;
      }
    }

    if (summary.scanned > 0) {
      this.logger.log(
        `Reconcile: ${summary.scanned} dipindai, ${summary.fulfilled} ditebus, ` +
          `${summary.expired} kedaluwarsa, ${summary.refundDue} berutang refund, ` +
          `${summary.stillPending} masih menunggu, ${summary.verifyFailed} gagal diverifikasi.`,
      );
    }
    if (summary.refundDue > 0) {
      // JANGAN klaim semua REFUND_DUE = "boleh refund". Operator wajib cek kolom `refundSafe`
      // per order, BUKAN status/teks doang. B2 — refundSafe=false punya DUA sebab sekarang:
      // pasca-belanja (barang sudah/mungkin terkirim) DAN pin menyimpang (uangnya tidak terbukti
      // pernah kami terima). Keduanya = jangan transfer sebelum diverifikasi di luar sistem ini.
      this.logger.error(
        `${summary.refundDue} order REFUND_DUE — CEK kolom refundSafe PER ORDER sebelum refund. ` +
          `refundSafe=true → uang TERBUKTI kami pegang & barang TERBUKTI belum diserahkan → refund benar. ` +
          `refundSafe=false → JANGAN REFUND dulu: treasury SUDAH bayar + kartu SUDAH terkirim (cek on-chain), ` +
          `ATAU pin IDRX menyimpang sehingga Rupiah-nya tidak terbukti mendarat di treasury kami (cek dashboard IDRX). ` +
          `Teks \`error\` menyebut yang mana. JANGAN refund massal.`,
      );
    }
    return summary;
  }

  /* ─────────────────────────── Baca ─────────────────────────── */

  /** Order milik user login, terbaru dulu. */
  async myOrders(userId: string): Promise<PaymentOrderDto[]> {
    const rows = await this.prisma.paymentOrder.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPaymentOrderDto);
  }

  /**
   * Satu order milik user login. merchantOrderId itu PUBLIK (kita sendiri yang menyerahkannya
   * ke frontend), jadi ia kunci join — BUKAN kapabilitas. Tanpa cek pemilik ini, siapa pun yang
   * tahu sebuah merchantOrderId bisa mengintip nominal, QR, dan wallet order orang lain.
   */
  async getOrder(
    merchantOrderId: string,
    user: AuthUser,
  ): Promise<PaymentOrderDto> {
    const order = await this.prisma.paymentOrder.findUnique({
      where: { merchantOrderId },
    });
    if (!order) throw new NotFoundException('Order tidak ditemukan.');
    if (order.userId !== user.id) {
      this.logger.warn(
        `Akses order ${merchantOrderId} ditolak untuk user ${user.id} (pemilik: ${order.userId}).`,
      );
      throw new ForbiddenException('Order ini bukan milik Anda.');
    }

    // Poll frontend jadi PEMICU fulfilment. Kalau order belum final, coba fulfil SEKARANG:
    // verifyAndFulfil idempoten + fail-closed (klaim atomik PENDING|PAID→FULFILLING; no-op bila
    // IDRX belum PAID+MINTED), jadi aman dipanggil tiap poll. Callback IDRX + reconciler tetap
    // jaring pengaman. Tanpa ini, reveal baru main saat callback/sweep tiba (bisa telat).
    if (
      order.status === PaymentStatus.PENDING ||
      order.status === PaymentStatus.PAID
    ) {
      try {
        await this.verifyAndFulfil(merchantOrderId);
        const refreshed = await this.prisma.paymentOrder.findUnique({
          where: { merchantOrderId },
        });
        if (refreshed) return toPaymentOrderDto(refreshed);
      } catch {
        // Kembalikan status apa adanya; callback/reconciler yang menyusul.
      }
    }
    return toPaymentOrderDto(order);
  }

  /* ─────────────────────────── Internal: harga ─────────────────────────── */

  /**
   * Harga rupiah sebuah pack. IDRX dipatok 1:1 ke IDR, jadi `buyAmount` dari
   * GET /api/transaction/rates untuk sejumlah USDC ADALAH harga rupiahnya.
   *
   * SEMUA aritmetika di sini INTEGER dan dibulatkan KE ATAS. Rupiah pecahan tidak ada, dan
   * pembulatan ke bawah = tiap pack menjual sedikit di bawah modal, selamanya.
   *
   * PUBLIK: RedemptionService memakainya untuk mengubah ongkir USDC (dari CC) → Rupiah, memakai
   * SUMBER HARGA yang sama dengan invoice ongkir (createShippingOrder) — supaya taksiran yang
   * dilihat user dan tagihan yang diterbitkan tidak lahir dari dua kalkulasi yang bisa melenceng.
   */
  async quoteRupiah(priceUsdc: number): Promise<number> {
    // usdtAmount dibangun dari base unit integer TANPA float: harga pack IEEE-754 = bug uang
    // yang tak terlacak. Contoh: 50_500_000 → "50.5", 50_000_000 → "50".
    const usdtAmount = usdcBaseUnitsToDecimalString(priceUsdc);

    const rate = await this.idrx.rates(usdtAmount);
    // IDRX mengetik buyAmount `string | number` (dokumentasi tidak memastikan) — parse eksplisit.
    const buyAmount = Number(rate.data.buyAmount);
    if (!Number.isFinite(buyAmount) || buyAmount <= 0) {
      this.logger.error(
        `Kurs IDRX mengembalikan buyAmount tidak masuk akal untuk ${usdtAmount} USDC. Order ditolak.`,
      );
      throw new ServiceUnavailableException(
        'Kurs IDRX sedang tidak tersedia. Coba lagi sebentar lagi.',
      );
    }

    const baseIdr = Math.ceil(buyAmount);
    const marginBps = this.intConfig(
      'HOSHI_PACK_MARGIN_BPS',
      DEFAULT_MARGIN_BPS,
      0,
    );
    const withMargin = applyBps(baseIdr, BPS_DENOMINATOR + marginBps);
    // Biaya QRIS dibebankan IDRX DI ATAS jumlah yang di-mint → kalau tidak dimasukkan ke harga
    // jual, treasury menerima kurang dari harga pack dan tiap penjualan rugi diam-diam.
    const priceIdr = applyBps(withMargin, BPS_DENOMINATOR + QRIS_FEE_BPS);

    if (priceIdr < IDRX_MIN_MINT_IDR || priceIdr > IDRX_MAX_MINT_IDR) {
      this.logger.error(
        `Harga Rp ${priceIdr} di luar batas mint IDRX (Rp ${IDRX_MIN_MINT_IDR}–${IDRX_MAX_MINT_IDR}).`,
      );
      throw new BadRequestException(
        'Harga pack ini di luar batas nominal pembayaran yang didukung. Pilih pack lain.',
      );
    }
    return priceIdr;
  }

  /**
   * Apakah harga mesin masih layak ditebus dengan snapshot yang dibayar user. Membedakan
   * "harga terbukti terlalu tinggi" (permanen → REFUND_DUE) dari "harga tak terbaca" (transien →
   * lepas klaim, coba lagi) — keduanya PRA-belanja, jadi tidak ada USDC treasury yang bergerak.
   */
  private async assertPriceStillHonourable(
    order: PaymentOrder,
  ): Promise<PriceCheck> {
    let currentUsdc: number;
    try {
      const machines = await this.gacha.machines();
      const machine = machines.find((m) => m.code === order.packType);
      if (!machine) {
        // Mesin hilang dari katalog CC = kondisi menetap, bukan blip jaringan → permanen.
        return {
          permanent: true,
          reason: `Mesin "${order.packType}" tidak lagi tersedia di CollectorCrypt.`,
        };
      }
      currentUsdc = machine.priceUsdcBaseUnits;
    } catch (err) {
      // CC tak bisa dihubungi = transien. Order belum menyentuh treasury → aman dilepas & diulang.
      return {
        permanent: false,
        reason: `Harga CollectorCrypt tidak bisa dibaca: ${errorMessage(err)}`,
      };
    }

    const maxBps = this.intConfig(
      'HOSHI_MAX_SLIPPAGE_BPS',
      DEFAULT_MAX_SLIPPAGE_BPS,
      0,
    );
    const ceiling = applyBps(order.priceUsdc, BPS_DENOMINATOR + maxBps);
    if (currentUsdc > ceiling) {
      return {
        permanent: true,
        reason:
          `Harga mesin ${order.packType} naik dari ${order.priceUsdc} ke ${currentUsdc} ` +
          `(USDC base unit), melewati plafon slippage ${maxBps} bps (${ceiling}).`,
      };
    }
    return null;
  }

  /* ─────────────────────────── Internal: status order ─────────────────────────── */

  /**
   * Order yang belum PAID+MINTED. Kolom idrx* MENTAH ditulis untuk audit — bukan sebagai gerbang:
   * gerbangnya kolom `status`, dan itu cuma bergerak setelah verifikasi server-to-server.
   */
  private async recordUnfulfilled(
    order: PaymentOrder,
    record: IdrxMintRecord,
    paymentStatus: string,
    userMintStatus: string,
  ): Promise<FulfilOutcome> {
    const expired = paymentStatus === 'EXPIRED';
    // Rupiah SUDAH masuk, IDRX-nya yang belum selesai di-mint. Barisnya naik ke PAID supaya
    // (a) ia tetap terpindai reconciler dan (b) klaim atomik nanti tetap mengenalinya.
    const paid = paymentStatus === 'PAID';

    // B1 — SATU TRANSAKSI: "order ini EXPIRED" dan "klaim redemption-nya dilepas" adalah SATU
    // fakta. Kalau dipisah, sebuah crash di antara keduanya meninggalkan persis bug yang sedang
    // diperbaiki: order mati, baris redemption terkunci AWAITING_PAYMENT selamanya.
    const releasedRedemptions = await this.prisma.$transaction(async (tx) => {
      const moved = await tx.paymentOrder.updateMany({
        // Predikat status: verifikasi yang datang telat TIDAK BOLEH menurunkan order yang sudah
        // FULFILLING/FULFILLED — itu akan membuka jalan pembelian pack kedua.
        where: {
          merchantOrderId: order.merchantOrderId,
          status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
        },
        data: {
          idrxPaymentStatus: paymentStatus,
          idrxUserMintStatus: userMintStatus,
          txHash: typeof record.txHash === 'string' ? record.txHash : null,
          ...(expired ? { status: PaymentStatus.EXPIRED } : {}),
          ...(paid
            ? { status: PaymentStatus.PAID, paidAt: order.paidAt ?? new Date() }
            : {}),
        },
      });

      // ── B1: invoice ongkir yang MATI harus MELEPAS redemption-nya ────────────────────────────
      // Tanpa ini AWAITING_PAYMENT tidak punya jalan keluar sama sekali: user menekan "Bayar
      // ongkir", menutup tab IDRX, invoice-nya kedaluwarsa, dan kartunya terkunci selamanya.
      //
      // KENAPA CALLBACK YANG TELAT SELALU MENANG ATAS KEDALUWARSA (empat lapis, berurutan):
      //  1. Cabang ini hanya tercapai kalau panggilan SERVER-KE-SERVER ke IDRX barusan menjawab
      //     paymentStatus === 'EXPIRED' — vonis terminal IDRX sendiri untuk "tidak pernah dibayar".
      //     Bukan body callback, bukan jam kita, bukan kolom idrx* tersimpan.
      //  2. Pelepasan hanya jalan kalau updateMany DI ATAS benar-benar MEMINDAHKAN order ini
      //     (count === 1). Jalur sukses yang bersamaan mengklaim order PENDING|PAID → FULFILLING
      //     lebih dulu; predikat status kita lalu cocok 0 baris → nol pelepasan.
      //  3. Pelepasannya sendiri updateMany BERPAGAR dan head-to-head dengan klaim fulfilShipping
      //     (AWAITING_PAYMENT → READY_TO_FUND, predikat yang sama + paymentOrderId yang sama).
      //     Postgres menyerialkan keduanya di baris itu: tepat satu menang.
      //  4. Kalau kedaluwarsa yang menang lalu verifikasi PAID datang belakangan, order-nya sudah
      //     EXPIRED → verifyAndFulfil membelokkannya ke settleExpiredButPaid, yang memverifikasi
      //     ulang ke IDRX dan menandainya REFUND_DUE (predikat [EXPIRED]) begitu paymentStatus
      //     terbukti PAID. Uangnya jadi UTANG YANG TERCATAT.
      //     ⚠️ KALIMAT INI DULU BOHONG (B2). Yang tertulis di sini adalah "fulfilShipping mendapat
      //     count !== 1 → failToRefund" — padahal fulfilShipping TIDAK PERNAH TERCAPAI: verifikasi
      //     berikutnya berhenti di penjaga terminal verifyAndFulfil (EXPIRED) jauh sebelum klaim
      //     atomik. Hasilnya: Rupiah mendarat, nol baris REFUND_DUE, nol log ERROR, dan user
      //     melihat "Menunggu pembayaran ongkir" lalu membayar untuk KEDUA KALINYA. Kalau nanti
      //     ada yang mengembalikan EXPIRED ke daftar short-circuit itu, lubang ini terbuka lagi.
      // PIN paymentOrderId: kedaluwarsanya order X tidak akan pernah melepas baris yang sudah
      // berjalan lagi dengan invoice Y. fundingSignature/refundSafe ikut jadi predikat (dibaca,
      // tidak pernah ditulis) supaya baris berjejak PASCA-danai tak mungkin tersentuh.
      if (
        !expired ||
        moved.count !== 1 ||
        order.packType !== 'SHIPPING' ||
        !order.redemptionId
      ) {
        return 0;
      }
      const released = await tx.cardRedemption.updateMany({
        where: {
          id: order.redemptionId,
          status: RedemptionStatus.AWAITING_PAYMENT,
          paymentOrderId: order.id,
          fundingSignature: null,
          refundSafe: true,
        },
        data: { status: RedemptionStatus.REQUESTED },
      });
      return released.count;
    });

    if (expired) {
      if (releasedRedemptions === 1) {
        this.logger.log(
          `Order ongkir ${order.merchantOrderId} EXPIRED (IDRX) → redemption ${order.redemptionId} ` +
            'dilepas AWAITING_PAYMENT → REQUESTED. Nol Rupiah masuk; user bisa minta tagihan baru.',
        );
      } else if (order.packType === 'SHIPPING' && order.redemptionId) {
        // BUKAN error: baris bisa saja sudah maju sendiri (pembayaran mendarat duluan), sudah
        // dibatalkan user, atau sudah terikat invoice yang lebih baru.
        this.logger.log(
          `Order ongkir ${order.merchantOrderId} EXPIRED (IDRX) tapi redemption ` +
            `${order.redemptionId} TIDAK dilepas — baris sudah bergerak / bukan lagi milik order ini.`,
        );
      }
      return 'EXPIRED';
    }
    if (paid) {
      // Rupiah masuk tapi mint-nya gagal/ditolak di sisi IDRX: token tidak pernah sampai ke
      // treasury, jadi refund-nya urusan IDRX — bukan utang kita. Tetap dicatat keras supaya
      // ada manusia yang melihatnya, karena user tetap merasa sudah membayar.
      if (['FAILED', 'REJECTED', 'REFUND'].includes(userMintStatus)) {
        this.logger.error(
          `Order ${order.merchantOrderId}: paymentStatus=PAID tapi userMintStatus=${userMintStatus}. ` +
            'IDRX tidak mengirim token ke treasury — butuh pemeriksaan manual.',
        );
      } else {
        this.logger.log(
          `Order ${order.merchantOrderId}: sudah dibayar, menunggu IDRX menyelesaikan mint ` +
            `(userMintStatus=${userMintStatus}).`,
        );
      }
    }
    return 'AWAITING_PAYMENT';
  }

  /**
   * Catatan IDRX harus benar-benar milik order INI. IdrxClient sudah menolak record yang
   * merchantOrderId-nya tidak cocok (fail-closed), jadi pin di sini adalah pertahanan berlapis:
   *
   *  - destinationWalletAddress: field pin PRIMER. Tipe IDRX menandainya OPSIONAL (dokumentasi
   *    history meng-elide-nya), dan doc-nya tegas: KETIDAKHADIRAN = GAGAL VERIFIKASI, bukan lolos.
   *    Maka absennya → refund:false (tak bisa diputuskan). Hadir tapi bukan treasury → refund:true
   *    (rupiah mendarat di wallet lain, terbukti menyimpang).
   *  - toBeMinted & requestType: verifikasi BILA ADA (kita sendiri yang menetapkannya saat
   *    mint-request, jadi keyakinannya sudah tinggi); absennya tidak fatal. Menyimpang → refund:true.
   */
  private assertRecordMatchesOrder(
    order: PaymentOrder,
    record: IdrxMintRecord,
  ): PinResult {
    const treasuryAddress = this.config.get<string>('HOSHI_TREASURY_ADDRESS');
    if (!treasuryAddress || treasuryAddress.trim().length === 0) {
      // Misconfigurasi KITA (env dicabut setelah order dibuat), bukan mint ke wallet asing.
      // Jangan deklarasikan utang atas kesalahan kita sendiri — tak bisa diverifikasi, ulangi nanti.
      return {
        refund: false,
        reason:
          'HOSHI_TREASURY_ADDRESS tidak tersedia saat verifikasi (tujuan mint tak bisa dicocokkan)',
      };
    }
    const destination = record.destinationWalletAddress;
    if (typeof destination !== 'string' || destination.length === 0) {
      return {
        refund: false,
        reason:
          'respons IDRX tidak menyertakan destinationWalletAddress (tujuan mint tak bisa dipastikan)',
      };
    }
    if (destination.trim() !== treasuryAddress.trim()) {
      return {
        refund: true,
        reason: `IDRX me-mint ke ${destination}, bukan ke treasury Hoshi — rupiah tidak mendarat di wallet kita`,
      };
    }

    // Nominal: pin bila ada. Kita men-set toBeMinted = priceIdr saat request, jadi nilai yang
    // lebih kecil berarti sesuatu yang serius menyimpang.
    if (record.toBeMinted != null) {
      const minted = Number(record.toBeMinted);
      if (!Number.isFinite(minted) || minted < order.priceIdr) {
        return {
          refund: true,
          reason: `nominal yang di-mint (${String(record.toBeMinted)}) di bawah tagihan Rp ${order.priceIdr}`,
        };
      }
    }

    // requestType harus 'idrx' (bukan 'usdt') bila disebut — kita tidak pernah minta usdt di sini.
    if (record.requestType != null && record.requestType !== 'idrx') {
      return {
        refund: true,
        reason: `requestType IDRX = ${String(record.requestType)}, bukan 'idrx'`,
      };
    }

    return null;
  }

  /**
   * Tandai order sebagai UTANG. Dipakai untuk SETIAP kegagalan sesudah rupiah masuk.
   *
   * REFUND_DUE, bukan FAILED: user SUDAH membayar. FAILED cuma sah kalau kita YAKIN tidak ada
   * uang user yang tertahan. Dan status ini SENGAJA tidak pernah di-retry otomatis — sesudah
   * purchase() menyentuh submitTransaction, "gagal" tidak sama dengan "tidak ada uang yang
   * bergerak", jadi menebusnya ulang bisa membeli pack kedua dari treasury.
   */
  /**
   * Kegagalan PASCA-KLAIM (order sudah FULFILLING, dimiliki pemanggil ini). Predikatnya FULFILLING
   * saja, jadi ia tidak akan pernah menimpa baris yang sudah FULFILLED/REFUND_DUE.
   */
  private async failToRefund(
    order: PaymentOrder,
    reason: string,
    // false HANYA untuk kegagalan PASCA-belanja (treasury sudah/mungkin bayar + kartu sudah/mungkin
    // terkirim): tandai order TIDAK-aman-refund. Semua pemanggil lain = pra-belanja → aman (default).
    refundSafe = true,
  ): Promise<FulfilOutcome> {
    await this.markRefundDueRaw(
      order,
      reason,
      [PaymentStatus.FULFILLING],
      undefined,
      refundSafe,
    );
    return 'REFUND_DUE';
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B2 — KEBIJAKAN: PIN TERBUKTI MENYIMPANG ⇒ UTANG TERCATAT, TAPI refundSafe = FALSE.        ║
   * ║ INI SATU-SATUNYA TEMPAT TULISAN ITU TERBIT. KEDUA jalur (normal + kedaluwarsa) lewat sini.║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * ATURAN OPERATOR yang seluruh kolom ini ada untuk melindunginya: operator memutuskan refund
   * dengan MEMBACA `refundSafe`, BUKAN status dan BUKAN teks `error`. Maka `refundSafe = true`
   * adalah KLAIM: uang user TERBUKTI kami pegang DAN TERBUKTI belum diserahkan. Dua-duanya, bukan
   * salah satu.
   *
   * Pin yang MENYIMPANG membuktikan kebalikan dari paruh PERTAMA: `assertRecordMatchesOrder`
   * mengembalikan refund:true persis ketika catatan IDRX menunjukkan Rupiah-nya me-mint ke wallet
   * LAIN, bernominal DI BAWAH tagihan, atau ber-requestType bukan 'idrx'. Uang seperti itu TIDAK
   * TERBUKTI pernah mendarat pada kami. Menulis refundSafe=true di situ menyuruh operator yang
   * patuh mengirim Rupiah sungguhan untuk uang yang mungkin tidak pernah kami terima — rugi yang
   * dibayar DUA KALI.
   *
   * KENAPA TETAP DICATAT SEBAGAI UTANG: user memang membayar sesuatu dan TIDAK menerima apa pun
   * (klaim atomiknya tidak pernah diambil di kedua jalur). Menyembunyikannya = kehilangan diam.
   * Yang berubah hanya IZIN TRANSFER-nya, bukan keberadaan utangnya.
   *
   * KENAPA false, BUKAN "true dengan catatan": sejalan dengan setiap pilihan fail-closed lain di
   * sistem ini — yang TIDAK TERBUKTI milik kita jatuh ke kategori paling hati-hati. Ongkos yang
   * DITERIMA: rotasi HOSHI_TREASURY_ADDRESS yang jinak menandai utang yang sebenarnya sah sebagai
   * "perlu diselidiki". Itu FALSE NEGATIVE — arah yang aman, dan bisa dibereskan manusia.
   *
   * BUKAN INI: `PIN_UNVERIFIABLE` (field pin WAJIB-nya ABSEN). Itu "tidak bisa diputuskan", bukan
   * "terbukti menyimpang" — ia tetap NOL TULISAN di kedua jalur, dan TIDAK BOLEH dilipat ke sini.
   * BUKAN INI JUGA: pin LOLOS → tetap refundSafe=true lewat markRefundDueRaw/failToRefund.
   *
   * `context` ditaruh SESUDAH prefiks penyimpangan supaya alasan pin selamat dari pemotongan
   * ERROR_MAX (500 char) dan terbaca manusia lebih dulu.
   *
   * KEBIJAKAN INI JUGA DITULIS DI LUAR KODE, supaya tidak bisa hilang bersama satu refactor:
   *   - prisma/schema.prisma → PaymentOrder.refundSafe (komentar `///`)
   *   - prisma/migrations/20260917020000_document_refund_safe_policy/migration.sql
   *     (COMMENT ON COLUMN "payment_orders"."refundSafe" — yang dibaca operator dari DB langsung)
   *   - src/payments/payments.service.spec.ts, describe "B1 — pin WAJIB juga di jalur EXPIRED":
   *     satu catatan IDRX dijalankan lewat KEDUA jalur; setiap perbedaan hasil = test MERAH.
   */
  private async markProvenDeviationRefundDue(
    order: PaymentOrder,
    pinnedReason: string,
    context: string,
    fromStatuses: PaymentStatus[],
    extra: { idrxPaymentStatus: string; idrxUserMintStatus: string },
  ): Promise<void> {
    await this.markRefundDueRaw(
      order,
      `PIN MENYIMPANG (${pinnedReason}) — UANG INI TIDAK TERBUKTI KAMI TERIMA, jadi ` +
        `refundSafe=false: JANGAN transfer apa pun sebelum kedatangan Rupiah-nya DIVERIFIKASI di ` +
        `dashboard IDRX dengan merchantOrderId ini. Utangnya tetap dicatat supaya tidak hilang. ` +
        context,
      fromStatuses,
      extra,
      false,
    );
  }

  /**
   * B2 — `refundSafe` DEFAULT true, dan defaultnya HANYA sah kalau pemanggilnya sudah membuktikan
   * KEDUANYA: uang user mendarat pada kami (pin LOLOS), dan barangnya belum diserahkan (klaim
   * atomik belum pernah diambil, atau belum menyentuh treasury). Hanya DUA pemanggil yang boleh
   * memakai default itu — settleLostClaim & jalur pin-lolos settleExpiredButPaid. Keduanya berada
   * sesudah pin lolos, TAPI pin lolos SAJA tidak cukup: pin membuktikan TUJUAN mint-nya, bukan
   * bahwa mint-nya TERJADI. Karena itu default `true` masih disaring GERBANG MINT di bawah, yang
   * menurunkannya ke false kecuali `extra.idrxUserMintStatus === 'MINTED'`.
   * Yang meleset dari salah satu paruhnya WAJIB mengoper false:
   *   - pasca-belanja (treasury sudah/mungkin bayar)  → failToRefund(..., false)
   *   - pin TERBUKTI menyimpang (uang tak terbukti kami terima) → markProvenDeviationRefundDue
   */
  private async markRefundDueRaw(
    order: PaymentOrder,
    reason: string,
    fromStatuses: PaymentStatus[],
    extra?: { idrxPaymentStatus: string; idrxUserMintStatus: string },
    refundSafe = true,
  ): Promise<void> {
    // ╔══════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ GERBANG MINT — refundSafe=true WAJIB punya bukti KEDUA paruhnya, dan paruh "uangnya      ║
    // ║ benar-benar masuk" TIDAK dibuktikan oleh pin.                                            ║
    // ║                                                                                          ║
    // ║ Pin (assertRecordMatchesOrder) membaca destinationWalletAddress, toBeMinted, requestType ║
    // ║ — ia membuktikan TUJUAN mint-nya, BUKAN bahwa mint-nya TERJADI. `userMintStatus=REFUND`  ║
    // ║ berarti IDRX SUDAH mengembalikan uangnya ke user; `FAILED`/`REJECTED` berarti token-nya  ║
    // ║ tidak pernah sampai ke treasury kami. Menandai itu refundSafe=true = operator yang       ║
    // ║ menuruti aturan ("baca refundSafe, jangan teksnya") membayar user KEDUA kali.            ║
    // ║                                                                                          ║
    // ║ Karena itu gerbangnya ditaruh DI SINI, di titik tulisnya — bukan sebagai `if` di satu    ║
    // ║ pemanggil. Bukti mint-nya sudah ada di tangan lewat `extra`, jadi fungsi ini menurunkan  ║
    // ║ sendiri kesimpulannya dan tidak bergantung pada itikad baik pemanggil. Pemanggil baru     ║
    // ║ yang lupa memikirkannya otomatis dapat jawaban yang hati-hati, bukan yang optimistis.    ║
    // ║                                                                                          ║
    // ║ SATU ATURAN, tanpa pengecualian per-nilai: hanya `MINTED` yang boleh true. PENDING/      ║
    // ║ PROCESSING ikut false — uang yang masih di perjalanan bukan uang yang terbukti diterima. ║
    // ║ ONGKOS YANG DITERIMA: pembayaran yang belakangan sukses mint meninggalkan utang          ║
    // ║ refundSafe=false yang harus dibereskan operator manual. Itu negatif-palsu — arah aman.   ║
    // ║ `extra` tidak diisi (semua pemanggil failToRefund) = PASCA-KLAIM, yang hanya tercapai    ║
    // ║ sesudah gerbang `userMintStatus==='MINTED'` di verifyAndFulfil → paruhnya sudah terbukti.║
    // ╚══════════════════════════════════════════════════════════════════════════════════════════╝
    const mintProven =
      extra === undefined || extra.idrxUserMintStatus === 'MINTED';
    if (refundSafe && !mintProven) {
      this.logger.warn(
        `Order ${order.merchantOrderId}: refundSafe DITURUNKAN ke false oleh gerbang mint — ` +
          `idrxUserMintStatus=${extra?.idrxUserMintStatus}, bukan MINTED. Utangnya tetap dicatat.`,
      );
    }
    refundSafe = refundSafe && mintProven;
    const message = reason.slice(0, ERROR_MAX);
    // B2 — SEBUT BARANGNYA. Kalimat lama selalu berbunyi "pack"; sebuah utang ONGKIR KIRIM FISIK
    // yang dilaporkan sebagai utang pack tidak akan pernah ditemukan operator yang mencarinya.
    const subject = orderSubject(order);
    if (refundSafe) {
      this.logger.error(
        `REFUND_DUE[${subject}] ${order.merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): ${message} ` +
          '— user SUDAH BAYAR dan belum menerima apa pun. Ini utang, bukan kegagalan.',
      );
    } else {
      // JANGAN samakan dengan utang-refund biasa. B2 — refundSafe=false sekarang punya DUA sebab,
      // dan keduanya berujung pada perintah yang SAMA untuk operator: JANGAN transfer sebelum
      // diverifikasi DI LUAR sistem ini. Sebab yang mana selalu ada DI DEPAN `message`:
      //   (a) PASCA-BELANJA — treasury sudah/mungkin bayar + barangnya sudah/mungkin terkirim →
      //       refund = RUGI DOBEL. Verifikasinya ON-CHAIN, lalu kirim ulang manual.
      //   (b) PIN MENYIMPANG — Rupiah-nya TIDAK TERBUKTI mendarat di treasury kami → refund =
      //       mengirim uang yang mungkin tak pernah kami terima. Verifikasinya di dashboard IDRX.
      this.logger.error(
        `REFUND_DUE[JANGAN-REFUND][${subject}] ${order.merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): ${message} ` +
          '— ⚠️ refundSafe=false: utang TERCATAT tapi BELUM boleh ditransfer. Verifikasi dulu ' +
          '(ON-CHAIN untuk kegagalan pasca-belanja; dashboard IDRX untuk pin yang menyimpang), ' +
          'baru putuskan. JANGAN REFUND sebelum itu.',
      );
    }
    try {
      // Predikat status: jangan pernah menimpa keadaan terminal (FULFILLED/EXPIRED/FAILED) atau
      // klaim milik racer lain. Uang tetap dilaporkan lewat log di atas walau update-nya no-op.
      await this.prisma.paymentOrder.updateMany({
        where: {
          merchantOrderId: order.merchantOrderId,
          status: { in: fromStatuses },
        },
        data: {
          status: PaymentStatus.REFUND_DUE,
          error: message,
          refundSafe,
          ...(extra ?? {}),
        },
      });
    } catch (err) {
      // Gagal menulis status TIDAK boleh menutupi utangnya — log-nya di atas sudah terbit.
      this.logger.error(
        `Gagal menandai REFUND_DUE pada order ${order.merchantOrderId}: ${errorMessage(err)}`,
      );
    }
  }

  /**
   * Lepas klaim FULFILLING → PAID supaya reconciler menebusnya lagi. HANYA sah untuk kegagalan
   * yang TERBUKTI PRA-belanja (cek harga transien): tidak ada satu pun USDC treasury yang bergerak,
   * jadi menebus ulang nanti tidak akan membeli pack kedua. JANGAN pernah dipakai untuk kegagalan
   * pasca-purchase() — di sana treasury mungkin sudah membayar, dan melepas klaim = dobel-bayar.
   */
  private async releaseClaimForRetry(
    order: PaymentOrder,
    reason: string,
  ): Promise<FulfilOutcome> {
    this.logger.warn(
      `Order ${order.merchantOrderId}: klaim dilepas ke PAID untuk diulang (${reason}). ` +
        'Tidak ada belanja treasury yang terjadi.',
    );
    try {
      await this.prisma.paymentOrder.updateMany({
        where: {
          merchantOrderId: order.merchantOrderId,
          status: PaymentStatus.FULFILLING,
        },
        data: { status: PaymentStatus.PAID },
      });
    } catch (err) {
      this.logger.error(
        `Gagal melepas klaim order ${order.merchantOrderId}: ${errorMessage(err)}`,
      );
    }
    return 'VERIFY_FAILED';
  }

  /* ─────────────────────────── Internal: konfigurasi & kuota ─────────────────────────── */

  /**
   * Alamat treasury Solana — TUJUAN rupiah user.
   *
   * WAJIB alamat publik dari HOSHI_TREASURY_SECRET_KEY. Kalau keduanya tidak cocok, IDRX
   * me-mint rupiah user ke wallet yang tidak kita kuasai SEMENTARA treasury tetap membayar
   * pack-nya — kita membagikan pack gratis dan tidak menerima apa pun, tanpa gejala apa pun.
   * (TreasuryService sengaja tidak di-export dari CollectorCryptModule — ia memegang private
   * key — jadi alamatnya datang dari env, dan pin di assertRecordMatchesOrder memastikan yang
   * kita verifikasi persis alamat yang sama dengan yang kita minta.)
   */
  private treasuryAddressOrRefuse(): string {
    const address = this.config.get<string>('HOSHI_TREASURY_ADDRESS');
    if (!address || address.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Pembayaran pack belum aktif. Set HOSHI_TREASURY_ADDRESS (alamat publik treasury Solana) di environment.',
      );
    }
    const trimmed = address.trim();
    try {
      // Salah ketik satu karakter = rupiah user mendarat entah di mana. Murah untuk dicek.
      new PublicKey(trimmed);
    } catch {
      throw new ServiceUnavailableException(
        'HOSHI_TREASURY_ADDRESS bukan alamat Solana base58 yang sah.',
      );
    }
    return trimmed;
  }

  private requiredConfig(key: string): string {
    const value = this.config.get<string>(key);
    if (!value || value.trim().length === 0) {
      throw new ServiceUnavailableException(
        `Pembayaran pack belum dikonfigurasi: ${key} belum di-set di environment.`,
      );
    }
    return value.trim();
  }

  /** Batas nominal yang salah ketik TIDAK boleh diam-diam dilewati → fail closed. */
  private intConfig(key: string, fallback: number, min: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) {
      throw new ServiceUnavailableException(
        `${key} harus bilangan bulat ≥ ${min}.`,
      );
    }
    return value;
  }

  /**
   * Kuota order menganggur per user. Bikin order itu GRATIS buat penyerang (bayarnya belakangan,
   * atau tidak sama sekali) tapi buat KITA tiap order berarti satu mint-request ke IDRX, satu
   * panggilan harga ke CC, dan satu baris permanen yang harus dipoll reconciler selamanya.
   */
  private async assertOrderQuota(userId: string): Promise<void> {
    const max = this.intConfig(
      'HOSHI_MAX_OPEN_ORDERS',
      DEFAULT_MAX_OPEN_ORDERS,
      1,
    );
    const open = await this.prisma.paymentOrder.count({
      where: {
        userId,
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PAID] },
        expiresAt: { gt: new Date() },
      },
    });
    if (open >= max) {
      throw new BadRequestException(
        `Anda masih punya ${open} order pembayaran yang belum selesai. ` +
          'Selesaikan atau tunggu kedaluwarsa dulu sebelum membuat order baru.',
      );
    }
  }

  /**
   * Plafon belanja treasury 24 jam — dicek SEBELUM tagihan diterbitkan.
   *
   * Plafonnya sendiri juga ditegakkan di dalam purchase(), tapi DI SANA ia menyala SESUDAH user
   * membayar: pengaman kita berubah jadi alat merampok pelanggan yang sudah setor rupiah.
   * Menolak menjual itu gratis; menolak SESUDAH dibayar berarti kita berutang refund.
   *
   * DIHITUNG DARI ORDER, BUKAN DARI PACK YANG SUDAH TUNTAS. Tiap belanja treasury berawal dari
   * sebuah order yang sudah menagih user, jadi order adalah sumber kebenaran kewajiban. Kalau kita
   * hanya menghitung baris CcPackPurchase (yang baru lahir SAAT penebusan), maka order PENDING/PAID
   * yang sudah menagih user menyumbang 0 — sebar 30 order barengan, semua baca total di bawah plafon,
   * semua lolos, lalu 20 di antaranya jadi REFUND_DUE sesudah dibayar. Menghitung obligasi order yang
   * masih hidup menutup lubang itu: order berurutan kini saling terlihat.
   *
   * SISA RACE (didokumentasikan jujur, bukan diabaikan): dua PEMBUAT order yang benar-benar bersamaan
   * masih bisa sama-sama membaca total sebelum salah satunya menyisipkan barisnya, sehingga overshoot
   * sebanyak konkurensi. Itu terbatas (butuh pembayaran rupiah NYATA per order, bukan kehendak
   * penyerang) dan tertutup di produksi dengan menjaga treasury didanai di atas plafon. Penutup
   * sejati untuk mainnet: reservasi baris + advisory lock Postgres di sekitar cek+insert.
   */
  private async assertTreasuryCapacity(
    priceUsdc: number,
    perItemCapUsdc?: number,
  ): Promise<void> {
    // Plafon harga SATU item, dicek DI SINI — sebelum order terbit — bukan cuma di dalam
    // purchase(). GachaService menegakkan plafon yang sama saat fulfillment; kalau order
    // sudah terlanjur terbit, penegakan itu jatuh SESUDAH rupiah user masuk dan berubah
    // jadi REFUND_DUE: user bayar, pack tidak pernah datang. Sama persis alasannya dengan
    // plafon harian di bawah — plafon pengaman kita tidak boleh jadi alat merampok user
    // yang SUDAH bayar. Konstanta di-import dari GachaService agar tidak mungkin melenceng.
    //
    // Default = plafon per-pack gacha ($100). Jalur reseller CC MENGOPER plafon per-kartu
    // tersendiri (HOSHI_CC_MAX_CARD_PRICE_USDC): kartu graded CC rutin di atas $100, jadi
    // plafon pack gacha akan menolak hampir semua kartu di depan. Plafon HARIAN + preflight
    // saldo on-chain di bawah tetap berlaku identik untuk kedua jalur.
    const usingDefaultCap = perItemCapUsdc == null;
    const maxItem = usingDefaultCap
      ? this.intConfig(
          'GACHA_MAX_PACK_PRICE_USDC',
          TREASURY_MAX_PACK_PRICE_USDC,
          1,
        )
      : perItemCapUsdc;
    if (priceUsdc > maxItem) {
      this.logger.error(
        `Harga item ${priceUsdc} melewati plafon per-item ${maxItem} (USDC base unit). ` +
          'Order TIDAK diterbitkan — tidak ada rupiah user yang masuk.',
      );
      throw new BadRequestException(
        usingDefaultCap
          ? 'Pack ini melebihi batas nominal pembelian kami saat ini. Pilih pack lain — ' +
              'tidak ada dana Anda yang terpotong.'
          : 'Nominal pembelian kartu ini melebihi batas kami saat ini — ' +
              'tidak ada dana Anda yang terpotong.',
      );
    }

    const cap = this.intConfig(
      'GACHA_TREASURY_DAILY_CAP_USDC',
      TREASURY_DAILY_CAP_USDC,
      1,
    );
    // Status yang MENAHAN/MEMAKAI USDC treasury: sudah menagih user (PENDING/PAID),
    // sedang ditebus (FULFILLING), atau sudah dibelanjakan (FULFILLED). EXPIRED/FAILED
    // tidak jadi belanja; REFUND_DUE = utang rupiah, bukan USDC keluar.
    const committed = await this.prisma.paymentOrder.aggregate({
      _sum: { priceUsdc: true },
      where: {
        status: {
          in: [
            PaymentStatus.PENDING,
            PaymentStatus.PAID,
            PaymentStatus.FULFILLING,
            PaymentStatus.FULFILLED,
          ],
        },
        createdAt: { gte: new Date(Date.now() - TREASURY_SPEND_WINDOW_MS) },
      },
    });
    const alreadyCommitted = committed._sum.priceUsdc ?? 0;
    if (alreadyCommitted + priceUsdc > cap) {
      this.logger.error(
        `Plafon treasury 24 jam tercapai: ${alreadyCommitted} + ${priceUsdc} > ${cap} (USDC base unit). ` +
          'Order TIDAK diterbitkan — tidak ada rupiah user yang masuk.',
      );
      throw new ServiceUnavailableException(
        'Kuota pembelian pack sedang penuh. Coba lagi nanti — tidak ada dana Anda yang terpotong.',
      );
    }

    // Preflight kecukupan dana ON-CHAIN. Plafon di atas adalah pengaman STATIS (config);
    // ini membaca saldo NYATA treasury dan menolak invoice bila tak cukup menutup pack ini
    // + gas — supaya tidak pernah ada rupiah yang diterima untuk order yang tak bisa ditebus
    // (yang akan jadi REFUND_DUE: user bayar, pack tak datang). Saldo `null` = tak diketahui
    // (RPC mati / belum dikonfigurasi) → LEWATI dan andalkan plafon; jangan blokir order
    // hanya karena pembacaan saldo gagal.
    const balance = await this.gacha.treasuryBalances();
    if (balance) {
      const buffer = this.intConfig('TREASURY_USDC_BUFFER_USDC', 0, 0);
      if (balance.usdcBaseUnits < priceUsdc + buffer) {
        this.logger.error(
          `Preflight saldo: USDC treasury ${balance.usdcBaseUnits} < harga ${priceUsdc}` +
            (buffer ? ` (+buffer ${buffer})` : '') +
            ' (USDC base unit). Order TIDAK diterbitkan — tidak ada rupiah user yang masuk.',
        );
        throw new ServiceUnavailableException(
          'Stok pembelian pack sedang tidak mencukupi. Coba lagi nanti — tidak ada dana Anda yang terpotong.',
        );
      }
      if (balance.solLamports < TREASURY_MIN_GAS_LAMPORTS) {
        this.logger.error(
          `Preflight saldo: SOL treasury ${balance.solLamports} lamports < minimum gas ` +
            `${TREASURY_MIN_GAS_LAMPORTS}. Order TIDAK diterbitkan — tidak ada rupiah user yang masuk.`,
        );
        throw new ServiceUnavailableException(
          'Layanan pembelian pack sedang sibuk. Coba lagi nanti — tidak ada dana Anda yang terpotong.',
        );
      }
    }
  }
}

/**
 * SATU-SATUNYA field yang boleh dibaca dari body callback IDRX.
 *
 * Body-nya tidak ditandatangani, jadi paymentStatus/userMintStatus/txHash/amount di dalamnya
 * adalah klaim dari orang tak dikenal. Membaca salah satunya sebagai kebenaran = siapa pun yang
 * tahu URL ini bisa mengarang "PAID" dan menguras treasury satu pack (~$50) per order.
 */
function readMerchantOrderId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).merchantOrderId;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * USDC base unit (integer, 6 desimal) → string desimal EKSAK, tanpa pernah menyentuh float.
 * 50_000_000 → "50", 50_500_000 → "50.5", 49_999_999 → "49.999999". Dipakai HANYA sebagai
 * argumen kuotasi kurs IDRX; nilai ini tidak pernah dibukukan. Float di jalur uang = bug rupiah
 * yang tak terlacak, jadi konversi dilakukan lewat aritmetika integer + string.
 */
function usdcBaseUnitsToDecimalString(baseUnits: number): string {
  const whole = Math.floor(baseUnits / USDC_UNITS);
  const frac = baseUnits % USDC_UNITS;
  if (frac === 0) return String(whole);
  const fracStr = String(frac).padStart(6, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/**
 * `value * bps / 10.000`, dibulatkan KE ATAS, MURNI INTEGER.
 *
 * `(a - (a % b)) / b` itu pembagian eksak untuk safe integer — beda dari Math.ceil(a / b), yang
 * bisa salah satu rupiah saat pembagiannya tidak bisa direpresentasikan tepat di IEEE-754.
 * Untuk uang, "salah satu rupiah, kadang-kadang" adalah bug yang tidak akan pernah bisa dilacak.
 */
function applyBps(value: number, bps: number): number {
  const numerator = value * bps;
  if (!Number.isSafeInteger(numerator)) {
    throw new ServiceUnavailableException(
      'Perhitungan harga melampaui batas bilangan bulat aman.',
    );
  }
  const remainder = numerator % BPS_DENOMINATOR;
  const quotient = (numerator - remainder) / BPS_DENOMINATOR;
  return remainder === 0 ? quotient : quotient + 1;
}

/**
 * Baris order → bentuk publik. `error` sengaja tidak ikut: isinya untuk log kita, bukan untuk klien.
 *
 * B3 — `refundSafe` juga TIDAK ikut. Yang ikut adalah TURUNANNYA (`refundState`/`refundNotice`),
 * sehingga user tahu apakah uangnya kembali TANPA membaca alasan operasional kita.
 */
function toPaymentOrderDto(order: PaymentOrder): PaymentOrderDto {
  const refundState = deriveRefundState(order);
  return {
    merchantOrderId: order.merchantOrderId,
    packType: order.packType,
    priceIdr: order.priceIdr,
    priceUsdc: order.priceUsdc,
    paymentMethod: order.paymentMethod,
    status: order.status,
    qrContent: order.qrContent,
    virtualAccountNo: order.virtualAccountNo,
    paymentUrl: order.paymentUrl,
    packMemo: order.packMemo,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    fulfilledAt: order.fulfilledAt,
    refundState,
    refundNotice: REFUND_NOTICE[refundState],
  };
}
