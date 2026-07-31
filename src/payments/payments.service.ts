import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListingStatus, PaymentStatus } from '@prisma/client';
import type { PaymentOrder } from '@prisma/client';
import { detectProductionSignal } from '../common/demo-mode';
import { PublicKey } from '@solana/web3.js';
import type { AuthUser } from '../auth/jwt.strategy';
import {
  GachaService,
  TREASURY_MAX_PACK_PRICE_USDC,
} from '../collectorcrypt/gacha.service';
import { PrismaService } from '../prisma/prisma.service';
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

/** Batas nominal mint-request milik IDRX. Di luar ini permintaan pasti ditolak mereka. */
const IDRX_MIN_MINT_IDR = 20_000;
const IDRX_MAX_MINT_IDR = 1_000_000_000;

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

const ERROR_MAX = 500;

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly idrx: IdrxClient,
    private readonly gacha: GachaService,
    private readonly config: ConfigService,
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
    await this.assertOrderQuota(user.id);

    // 0. Listing WAJIB kartu katalog CC yang masih dijual: source=COLLECTORCRYPT, TANPA penjual
    //    user (sellerId null = mirror katalog, bukan kartu user), ACTIVE, punya alamat on-chain.
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
    });
    if (!listing || listing.status !== 'ACTIVE') {
      throw new BadRequestException(
        'Listing tidak ditemukan atau sudah tidak dijual.',
      );
    }
    if (
      listing.source !== 'COLLECTORCRYPT' ||
      listing.sellerId != null ||
      !listing.ccNftAddress ||
      listing.ccPriceUsd == null
    ) {
      throw new BadRequestException(
        'Kartu ini bukan produk katalog CollectorCrypt — belum bisa dibeli lewat jalur ini.',
      );
    }

    // 1. Biaya CC (USDC base unit) di-snapshot dari harga dolar terakhir yang tersimpan. Ini
    //    PLAFON saat treasury menebus: kalau harga live CC naik melewati ini, fulfilment tolak
    //    (refund) alih-alih diam-diam menggerus treasury — persis semantik snapshot pack gacha.
    const priceUsdc = Math.round(listing.ccPriceUsd * 1_000_000);
    if (!Number.isSafeInteger(priceUsdc) || priceUsdc <= 0) {
      this.logger.error(
        `Harga CC listing ${listingId} tidak masuk akal: ccPriceUsd=${listing.ccPriceUsd}. Order ditolak.`,
      );
      throw new ServiceUnavailableException(
        'Harga kartu dari CollectorCrypt sedang tidak wajar. Coba lagi nanti.',
      );
    }

    // 2. Harga KITA (priceIdrx = yang harus DITERIMA treasury, sudah termasuk margin) wajib
    //    menutup biaya CC dalam rupiah. Kalau admin menyetel di bawah modal → tolak, jangan
    //    jual rugi. Kurs pembanding sama dengan yang dipakai market-sync (HOSHI_USD_IDR_RATE).
    const usdIdrRate = this.intConfig('HOSHI_USD_IDR_RATE', 16_000, 1);
    const ccCostIdr = Math.ceil(listing.ccPriceUsd * usdIdrRate);
    if (listing.priceIdrx < ccCostIdr) {
      this.logger.error(
        `Listing ${listingId} priceIdrx ${listing.priceIdrx} < biaya CC ${ccCostIdr} IDR — jual rugi, order ditolak.`,
      );
      throw new ServiceUnavailableException(
        'Harga kartu ini sedang tidak wajar. Coba lagi nanti.',
      );
    }

    // 3. Treasury akan membelanjakan ~priceUsdc → plafon HARIAN + preflight saldo SAMA dengan
    //    gacha, tapi plafon PER-ITEM pakai batas per-kartu tersendiri (bukan plafon pack $100
    //    gacha, yang akan menolak hampir semua kartu graded CC di depan).
    await this.assertTreasuryCapacity(
      priceUsdc,
      this.intConfig('HOSHI_CC_MAX_CARD_PRICE_USDC', 5_000_000_000, 1),
    );

    // 4. Pembeli bayar HARGA KITA + fee QRIS di atasnya (treasury tetap menerima priceIdrx).
    const priceIdr = applyBps(listing.priceIdrx, BPS_DENOMINATOR + QRIS_FEE_BPS);
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
    const mint = await this.idrx.mintRequest({
      toBeMinted: String(priceIdr),
      destinationWalletAddress: treasuryAddress,
      networkChainId: this.requiredConfig('IDRX_NETWORK_CHAIN_ID'),
      returnUrl: this.requiredConfig('HOSHI_PAYMENT_RETURN_URL'),
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
    if (
      order.status === PaymentStatus.FULFILLED ||
      order.status === PaymentStatus.REFUND_DUE ||
      order.status === PaymentStatus.EXPIRED ||
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
        // Terbukti menyimpang → utang manual.
        await this.markRefundDue(order, pinned.reason, record);
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
      this.logger.log(
        `Order ${merchantOrderId} sudah diklaim pihak lain — tidak ada pack kedua yang dibeli.`,
      );
      return 'ALREADY_CLAIMED';
    }

    return this.fulfilClaimed(order);
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
      return this.failToRefund(order, errorMessage(err));
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
      // TODO(phase-2-real): treasury cc-buy (wallet=treasury → TreasuryService.sign → broadcast)
      // + transfer NFT CC ke user.walletAddress; margin (IDRX masuk − USDC keluar) di treasury.
      return this.failToRefund(
        order,
        'Settlement reseller CC real belum diimplement — pembayaran perlu di-refund manual.',
      );
    }

    // MOCK: klaim listing ACTIVE→SOLD (dua order untuk satu listing → satu menang) lalu tandai
    // order FULFILLED — DALAM SATU transaksi. Kalau write kedua gagal (transient / pod restart),
    // seluruh transaksi rollback: listing TIDAK jadi SOLD dan order tetap FULFILLING (bisa
    // di-retry), bukan kondisi setengah jadi "listing terjual tapi order nyangkut selamanya".
    // TIDAK ADA USDC/SOL treasury yang bergerak.
    const claimedCount = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.listing.updateMany({
        where: { id: listing.id, status: ListingStatus.ACTIVE },
        data: { status: ListingStatus.SOLD, buyerId: user.id, soldAt: new Date() },
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

  /** MOCK CC aktif: staging/devnet + CC_MOCK=1 + bukan sinyal produksi. Sama dgn GachaService. */
  private ccMockEnabled(): boolean {
    return (
      this.config.get<string>('CC_MOCK') === '1' &&
      detectProductionSignal() === null
    );
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

    const summary: ReconcileSummary = {
      scanned: stale.length + stuck.length,
      fulfilled: 0,
      expired: 0,
      refundDue: 0,
      stillPending: 0,
      verifyFailed: 0,
    };

    for (const order of stuck) {
      // Proses mati di tengah belanja treasury. Satu-satunya jalan keluar yang jujur: manusia
      // mencocokkan ke ledger CcPackPurchase (lewat packMemo/userId).
      this.logger.error(
        `Order ${order.merchantOrderId} macet di FULFILLING sejak ${order.updatedAt.toISOString()}. ` +
          'TIDAK ditebus ulang otomatis (risiko dobel-bayar treasury) — butuh pemeriksaan manual ' +
          'terhadap ledger CcPackPurchase.',
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

    if (summary.scanned > 0) {
      this.logger.log(
        `Reconcile: ${summary.scanned} dipindai, ${summary.fulfilled} ditebus, ` +
          `${summary.expired} kedaluwarsa, ${summary.refundDue} berutang refund, ` +
          `${summary.stillPending} masih menunggu, ${summary.verifyFailed} gagal diverifikasi.`,
      );
    }
    if (summary.refundDue > 0) {
      this.logger.error(
        `${summary.refundDue} order berstatus REFUND_DUE: user SUDAH BAYAR dan belum menerima pack.`,
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
   */
  private async quoteRupiah(priceUsdc: number): Promise<number> {
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

    await this.prisma.paymentOrder.updateMany({
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

    if (expired) return 'EXPIRED';
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
  ): Promise<FulfilOutcome> {
    await this.markRefundDueRaw(order, reason, [PaymentStatus.FULFILLING]);
    return 'REFUND_DUE';
  }

  /**
   * Kegagalan PIN PRA-KLAIM (order masih PENDING/PAID). Predikatnya PENDING|PAID: kalau pemenang
   * lain sudah mengklaim, mark ini jadi no-op — bukan menimpa klaim yang sah.
   */
  private async markRefundDue(
    order: PaymentOrder,
    reason: string,
    record: IdrxMintRecord,
  ): Promise<void> {
    await this.markRefundDueRaw(
      order,
      reason,
      [PaymentStatus.PENDING, PaymentStatus.PAID],
      {
        idrxPaymentStatus: String(record.paymentStatus),
        idrxUserMintStatus: String(record.userMintStatus),
      },
    );
  }

  private async markRefundDueRaw(
    order: PaymentOrder,
    reason: string,
    fromStatuses: PaymentStatus[],
    extra?: { idrxPaymentStatus: string; idrxUserMintStatus: string },
  ): Promise<void> {
    const message = reason.slice(0, ERROR_MAX);
    this.logger.error(
      `REFUND_DUE ${order.merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}): ${message} ` +
        '— user SUDAH BAYAR dan belum menerima pack. Ini utang, bukan kegagalan.',
    );
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
      ? this.intConfig('GACHA_MAX_PACK_PRICE_USDC', TREASURY_MAX_PACK_PRICE_USDC, 1)
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

/** Baris order → bentuk publik. `error` sengaja tidak ikut: isinya untuk log kita, bukan untuk klien. */
function toPaymentOrderDto(order: PaymentOrder): PaymentOrderDto {
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
  };
}
