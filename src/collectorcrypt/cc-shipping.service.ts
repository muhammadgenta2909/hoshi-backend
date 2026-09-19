import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedemptionStatus } from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcShippingClient } from './cc-shipping.client';
import type {
  CcBurnResponse,
  CcBurnResultEntry,
  CcShipmentStatus,
  CcShippingAddressInput,
  CcSiwsNonceResponse,
  CcSiwsRefreshResponse,
  CcSiwsVerifyResponse,
} from './cc-shipping.types';
import {
  CC_BURN_DUPLICATE_ERROR,
  CC_SHIPPING_DELIST_ERRORS_KEY,
  readCcShippingErrorMeta,
} from './cc-shipping.types';
import { assertCcRail } from '../common/hoshi-domestic-shipping';
import {
  SHIPPING_ERROR_CODE,
  SHIPPING_STAGE,
  noEffectError,
  preFundUnavailable,
  shippingError,
  shippingErrorBody,
  type ShippingErrorCode,
  type ShippingErrorStage,
} from './cc-shipping.errors';
import { burnTxSetIdentity } from './cc-shipping.txset';
import {
  TreasuryFundIndeterminateError,
  TreasuryService,
} from './treasury.service';
import { usdDollarsToUsdcBaseUnits } from './cc-gacha.types';

/** Perusahaan kurir default untuk prepare/estimate. */
const DEFAULT_DELIVERY_COMPANY = 'ups';

/**
 * Berapa jauh ongkir OTORITATIF dari /redeem/prepare boleh MELEBIHI yang user bayar (di-snapshot
 * ke order saat invoice terbit) sebelum kita menolak MENDANAI. Default 10% — ongkir bisa bergeser
 * antara "user bayar" dan "user menandatangani". Selisih di dalam plafon ini ditanggung treasury.
 */
const SHIPPING_MAX_SLIPPAGE_BPS = 1000;
const BPS_DENOMINATOR = 10_000;

/** Batas panjang pesan error yang disimpan/di-log. */
const ERROR_MAX = 500;

/**
 * DUA kegagalan burn yang dokumen CC nyatakan TEGAS tidak membakar apa pun:
 *  - 403 "Transaction was not issued by this server" -> "Nothing recognised - you sent nothing, only
 *    de-list legs, or an expired batch." (kasus NORMAL: set transaksi 15 menit kedaluwarsa)
 *  - 409 yang membawa `delistErrors` -> "A de-list leg failed. Nothing was burned."
 *
 * DUA SINYAL INI BERBEDA SIFATNYA — dan hanya SATU yang boleh dibaca dari prosa:
 *  - 403: kalimatnya MEMANG menumpang di pesan body error CC, jadi dicocokkan sebagai teks.
 *    Kelas exception tidak bisa dipakai: klien memetakan 403 CC ke UnauthorizedException
 *    (HTTP 401!), jadi 401 dan 403 tampak sama — karena itu `(HTTP 403)` dari pesan bentukan
 *    klien ikut diperiksa.
 *  - 409: `delistErrors` adalah KUNCI JSON, BUKAN kalimat. Pada body bergaya Nest
 *    ({"statusCode":409,"message":"De-list failed","error":"Conflict","delistErrors":[...]}) pesan
 *    bentukan klien hanya "De-list failed" — nama kuncinya lenyap; pemotongan 300 char bisa
 *    membuangnya juga. Maka 409 DIBACA DARI SINYAL TERSTRUKTUR yang dilampirkan klien
 *    (readCcShippingErrorMeta), bukan dari message.includes().
 * 403 LAIN ("not the complete set this server issued", "not issued for this shipment", token
 * basi) HARUS tetap dihitung INDETERMINATE. Lihat documentedNothingBurned() di bawah.
 */
const CC_BURN_NOT_ISSUED_BY_SERVER =
  'Transaction was not issued by this server';

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

/**
 * Kegagalan SETELAH USDC treasury didanai ke wallet user (fundUsdc SUKSES/INDETERMINATE) tetapi
 * burn+ship belum tuntas. Ditangani KHUSUS oleh pemanggil: USDC sudah/mungkin ada di wallet user →
 * JANGAN auto-refund Rupiah (rugi dobel; user memegang USDC ter-earmark); selesaikan lewat
 * resume/reclaim. Sepadan dengan ResellerPostBuyError.
 *
 * HTTP 422 UNPROCESSABLE ENTITY — dipilih SADAR, bukan 500 dan bukan 409:
 *  - Dulu ini `Error` biasa, dan satu-satunya filter global cuma menangkap error Prisma → Nest
 *    mengembalikannya sebagai 500 "Internal server error". Frontend tidak bisa membedakannya dari
 *    kegagalan yang aman diulang, lalu menawarkan tombol "tanda tangan lagi" untuk KEDUANYA.
 *  - 409 SUDAH dipakai cabang yang AMAN DIULANG (ShippingBurnRetryableError) dan juga oleh error
 *    409 milik CC yang dipetakan klien. Memakai 409 lagi di sini membuat dua cabang itu tak
 *    terbedakan dari statusnya saja — persis bug yang sedang diperbaiki.
 *  - 422 tidak pernah terbit dari jalur lain mana pun di kontrak ini, jadi UI bisa bercabang dari
 *    status saja bahkan sebelum membaca `code`.
 *  - Dan ia BUKAN 5xx: proxy/SDK/error-tracker tidak akan menganggapnya gangguan sementara lalu
 *    MENGULANG requestnya sendiri. Mengulang otomatis submit-burn PASCA-danai adalah hal yang
 *    paling tidak boleh terjadi di jalur ini.
 */
export class ShippingPostFundError extends HttpException {
  readonly code: ShippingErrorCode;

  constructor(
    message: string,
    readonly redemptionId: string,
    code: ShippingErrorCode = SHIPPING_ERROR_CODE.POST_FUND_INDETERMINATE,
    stage: ShippingErrorStage = SHIPPING_STAGE.POST_FUND,
  ) {
    super(
      shippingErrorBody({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code,
        message,
        stage,
        redemptionId,
      }),
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    this.name = 'ShippingPostFundError';
    this.code = code;
  }
}

/**
 * Burn DITOLAK CC pada dua kondisi yang dokumennya JAMIN nol kartu terbakar (403 "Transaction was
 * not issued by this server" = batch kedaluwarsa, atau 409 dengan `delistErrors` = "Nothing was
 * burned"). BEDA TAJAM dari ShippingPostFundError: di sini tidak ada yang indeterminate — kita TAHU
 * tidak ada yang terbakar dan tidak ada yang hilang, jadi barisnya DILEPAS balik ke FUNDED dan
 * seluruhnya BISA DIULANG (reprepareBurn -> tanda tangan -> submitBurn).
 *
 * TETAP BUKAN alasan me-refund Rupiah: USDC ongkir sudah ada di wallet user (refundSafe tetap
 * false). HTTP 409 supaya frontend bisa membedakannya dari 400 validasi biasa.
 */
export class ShippingBurnRetryableError extends ConflictException {
  readonly code: ShippingErrorCode;

  constructor(
    message: string,
    readonly redemptionId: string,
    code: ShippingErrorCode = SHIPPING_ERROR_CODE.BURN_RETRYABLE,
  ) {
    super(
      shippingErrorBody({
        status: HttpStatus.CONFLICT,
        code,
        message,
        // `stage: FUNDED` = JANJI bahwa barisnya TERBUKTI duduk di FUNDED. Kelas ini hanya boleh
        // dilempar di dua tempat yang membuktikannya: klaim yang belum pernah diambil (tolak set
        // basi) atau pelepasan klaim yang TERKONFIRMASI (updateMany count === 1).
        stage: SHIPPING_STAGE.FUNDED,
        redemptionId,
      }),
    );
    this.name = 'ShippingBurnRetryableError';
    this.code = code;
  }
}

export interface ShippingEstimate {
  /** USD (dolar penuh) dari CC. */
  usd: number;
  /** USDC base unit (6 desimal) — yang nanti didanai/dibayar. */
  usdcBaseUnits: number;
}

export interface FundAndPrepareResult {
  /** base64 UNSIGNED — wallet user yang menandatangani. */
  transactions: string[];
  delistTransactions: string[];
  outboundShipmentId: string;
  /** USDC base unit yang SUDAH didanai treasury ke wallet user. */
  totalCostUsdc: number;
}

/**
 * Hasil RE-PREPARE: transaksi burn BARU untuk baris yang uangnya SUDAH berpindah. Dua angka sengaja
 * DIPISAH supaya tidak ada yang mengira jalur ini mendanai apa pun:
 *  - `fundedUsdc`    = USDC yang SUDAH dikirim treasury ke wallet user (tercatat saat FUNDED).
 *  - `totalCostUsdc` = ongkir yang dilaporkan CC pada prepare ULANG ini (sudah lolos plafon
 *    slippage terhadap `fundedUsdc`). NOL dana berpindah di jalur ini.
 */
export interface ReprepareResult {
  /** base64 UNSIGNED baru — wallet user yang menandatangani. */
  transactions: string[];
  delistTransactions: string[];
  outboundShipmentId: string;
  /** USDC yang SUDAH didanai sebelumnya. TIDAK didanai ulang. */
  fundedUsdc: number;
  /** totalCost BARU dari CC (informasi; tidak menimpa catatan yang sudah didanai). */
  totalCostUsdc: number;
}

/**
 * Orkestrasi CC Vault Shipping — kirim kartu fisik keluar dari vault CC. Hidup DI DALAM
 * CollectorCryptModule karena butuh TreasuryService (private key) untuk MENDANAI USDC ongkir ke
 * wallet user just-in-time — pola yang sama dengan GachaService & ResellerSettlementService.
 *
 * ALUR (user Indonesia bayar Rupiah, tidak punya USDC/SOL):
 *   redeem → bayar Rupiah (IDRX) → READY_TO_FUND → fundAndPrepare (treasury danai USDC + CC prepare)
 *   → user TANDA TANGAN burn → submitBurn (CC burn+ship) → refreshStatus (tracking).
 * USDC adalah PASS-THROUGH TERIKAT yang didanai oleh Rupiah yang dibayar (net-neutral).
 *
 * DIGERBANG: HOSHI_CC_SHIPPING_ENABLED !== 'true' → seluruh jalur real ini menolak (record-only
 * tetap seperti apa adanya). Gerbang ada di assertEnabled() + di PaymentsService (createShippingOrder).
 */
@Injectable()
export class CcShippingService {
  private readonly logger = new Logger(CcShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: CcShippingClient,
    private readonly treasury: TreasuryService,
  ) {}

  /** Gerbang fitur. Pola sama dengan CcBuyService.assertEnabled. */
  assertEnabled(): void {
    const on =
      (this.config.get<string>('HOSHI_CC_SHIPPING_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
    if (!on) {
      throw noEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        SHIPPING_ERROR_CODE.DISABLED,
        'Kirim kartu fisik (CC Vault Shipping) belum diaktifkan di deployment ini ' +
          '(set HOSHI_CC_SHIPPING_ENABLED=true setelah alurnya diuji).',
      );
    }
  }

  /**
   * Taksiran ongkir untuk satu redemption. TIDAK membuat shipment dan TIDAK menyentuh dana.
   * Mengembalikan USD + USDC base unit.
   *
   * Kontrak CC: /redeem/estimate HANYA menerima empat field (nftAddresses, shippingAddressId,
   * deliveryCompany, payCustomsDuties) — objek alamat DITOLAK 400. Karena itu alamat harus sudah
   * ada di CC dulu: ensureCcShippingAddress membuatnya (idempoten, dari SNAPSHOT redemption yang
   * sudah diverifikasi kepemilikannya — bukan dari body klien) dan menyimpan idnya. Itu satu-satunya
   * efek samping di sini: menulis alamat, BUKAN shipment, BUKAN uang.
   *
   * Angka otoritatif estimate adalah `total` (bukan `totalCost`; field itu milik /redeem/prepare).
   *
   * Konversi ke Rupiah dilakukan pemanggil (RedemptionService / PaymentsService.createShippingOrder)
   * lewat PaymentsService.quoteRupiah — service ini SENGAJA tidak bergantung pada PaymentsService
   * supaya tidak ada import melingkar (PaymentsModule sudah meng-import CollectorCryptModule).
   */
  async estimateForRedemption(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<ShippingEstimate> {
    this.assertEnabled();
    const row = await this.ownedRedemption(redemptionId, user);
    const shippingAddressId = await this.ensureCcShippingAddress(
      row,
      ccAccessToken,
    );
    const res = await this.client.estimate(ccAccessToken, {
      nftAddresses: [row.nftAddress],
      shippingAddressId,
      deliveryCompany: DEFAULT_DELIVERY_COMPANY,
    });
    return this.toEstimate(res.total);
  }

  /**
   * INTI MONEY-CRITICAL. Danai USDC treasury ke wallet user lalu bangun transaksi burn+ship
   * UNSIGNED untuk ditandatangani user. URUTAN = properti keamanannya (jangan ditukar):
   *
   *   1. Muat redemption; pastikan milik user + status READY_TO_FUND.
   *   2. Pastikan alamat kirim CC ada (buat bila belum), persist ccShippingAddressId.
   *   3. CC /redeem/prepare → totalCost(USD) OTORITATIF + outboundShipmentId + tx UNSIGNED.
   *      TIDAK ADA yang dipersist di sini. (Semua langkah 1–3 = PRA-danai → refundSafe TETAP true.)
   *   4. Guard slippage: totalCost tidak boleh melebihi plafon dari yang user BAYAR. Lewat → tolak (masih pra-danai).
   *   5. Klaim ATOMIK READY_TO_FUND → FUNDING (count===1) — dua sesi tak bisa double-fund. B4:
   *      outboundShipmentId/totalCostUsdc/burnTxSetHash ditulis DI DALAM klaim ini, supaya sesi
   *      yang kalah klaim tidak bisa menimpa angka yang benar-benar didanai.
   *   6. treasury.fundUsdc(...). Sukses → FUNDED + fundingSignature + refundSafe=FALSE (PASCA-danai).
   *        - fundUsdc throw PRA-broadcast → LEPAS klaim balik ke READY_TO_FUND, refundSafe TETAP true.
   *        - fundUsdc INDETERMINATE → status TETAP FUNDING + refundSafe=FALSE + ShippingPostFundError; JANGAN refund.
   *   7. Kembalikan tx UNSIGNED untuk ditandatangani frontend.
   */
  async fundAndPrepare(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<FundAndPrepareResult> {
    this.assertEnabled();

    // 1. Muat + cek pemilik + status.
    const row = await this.ownedRedemption(redemptionId, user);
    if (row.status !== RedemptionStatus.READY_TO_FUND) {
      // NO_EFFECT, bukan PRE_FUND: status bisa saja SUDAH FUNDED/BURN_SUBMITTED — menyatakan
      // "pra-danai" di sini akan berarti "Rupiah aman di-refund", yang belum tentu benar.
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.NOT_READY_TO_FUND,
        `Redemption ini belum siap didanai (status ${row.status}). ` +
          'Selesaikan pembayaran ongkir Rupiah dulu.',
      );
    }

    // 2. Alamat kirim CC (buat bila belum). PRA-danai.
    const ccAddressId = await this.ensureCcShippingAddress(row, ccAccessToken);

    // 3. CC prepare → OTORITATIF. PRA-danai.
    //    TIDAK ADA field `insurance` di kontrak CC (asuransi otomatis; mengirimnya → 400
    //    "property insurance should not exist"). Memanggil prepare lagi dengan input IDENTIK
    //    mengembalikan shipment yang SAMA dengan transaksi baru — itulah pemulihan yang benar
    //    kalau batch 15-menitnya kedaluwarsa (BUKAN bikin shipment baru).
    const email = await this.userEmail(user.id);
    const prepared = await this.client.prepare(ccAccessToken, {
      nftAddresses: [row.nftAddress],
      shippingAddressId: ccAddressId,
      coin: 'USDC',
      deliveryCompany: DEFAULT_DELIVERY_COMPANY,
      ...(email ? { email } : {}),
    });
    if (
      !prepared.outboundShipmentId ||
      !Array.isArray(prepared.transactions) ||
      prepared.transactions.length === 0
    ) {
      throw preFundUnavailable(
        SHIPPING_ERROR_CODE.CC_PREPARE_INVALID,
        'CollectorCrypt tidak mengembalikan transaksi burn yang bisa ditandatangani.',
      );
    }
    // `totalCost` (BUKAN `total`) = angka otoritatif prepare. toEstimate menolak nilai <= 0 /
    // non-finite: CC memang bisa mengirim 0 untuk shipment yang SUDAH dibayar atau pembayaran
    // kartu — dua-duanya bukan jalur kita (crypto, belum dibayar), jadi 0 di sini = anomali dan
    // ditolak PRA-danai (nol dana berpindah, Rupiah tetap aman di-refund).
    const totalCostUsdc = this.toEstimate(prepared.totalCost).usdcBaseUnits;
    const delistTransactions = Array.isArray(prepared.delistTransactions)
      ? prepared.delistTransactions
      : [];

    // IDENTITAS set transaksi yang BARU SAJA diterbitkan CC — dipakai submitBurn untuk menolak
    // batch BASI secara LOKAL (lihat cc-shipping.txset.ts). null = tidak bisa dikanonikalisasi →
    // kolomnya null → submitBurn berperilaku persis seperti sebelum fitur ini ada.
    const burnTxSetHash = burnTxSetIdentity({
      outboundShipmentId: prepared.outboundShipmentId,
      transactions: prepared.transactions,
      delistTransactions,
    });

    // 4. Guard slippage terhadap yang user BAYAR (snapshot order). PRA-danai → aman ditolak.
    //    Dijalankan SEBELUM apa pun dipersist: kalau ditolak, baris ini tidak berubah sama sekali.
    try {
      await this.assertCostWithinPaid(row, totalCostUsdc);
    } catch (err) {
      // Shipment CC-nya TERLANJUR ada di sisi CC tapi id-nya sengaja TIDAK dipersist (lihat
      // langkah 5). Jejaknya diselamatkan di log supaya ops tetap bisa menelusurinya.
      this.logger.warn(
        `fundAndPrepare ${row.id}: guard biaya MENOLAK — shipment CC ` +
          `${prepared.outboundShipmentId} (ongkir ${totalCostUsdc}) TIDAK dipersist. Baris belum ` +
          'diklaim dan nol dana bergerak; Rupiah tetap aman di-refund.',
      );
      throw err;
    }

    // 5. Klaim ATOMIK READY_TO_FUND → FUNDING. Dua sesi tak bisa dua kali danai.
    //
    //    B4 — outboundShipmentId / totalCostUsdc / burnTxSetHash DITULIS DI SINI, DI DALAM KLAIM,
    //    bukan sebelum klaim. Dulu ketiganya ditulis lebih dulu lewat update() tanpa predikat,
    //    sehingga sesi yang KALAH klaim tetap bisa menimpa angkanya: dua tab di READY_TO_FUND,
    //    A prepare→tulis→klaim→danai→FUNDED, lalu B (round-trip CC lebih lambat) menulis
    //    totalCostUsdc MILIKNYA SENDIRI setelah A selesai mendanai, baru kemudian kalah klaim.
    //    row.totalCostUsdc jadi mencatat harga B, bukan yang benar-benar dikirim treasury — dan
    //    kolom itu adalah (i) basis plafon assertCostWithinFunded DAN (ii) suku penjumlahan pada
    //    plafon treasury 24 jam (treasury.service.ts meng-aggregate _sum.totalCostUsdc atas baris
    //    ber-fundingSignature). Digabung ke dalam updateMany berpredikat, yang kalah menulis NOL.
    const claimed = await this.prisma.cardRedemption.updateMany({
      where: { id: row.id, status: RedemptionStatus.READY_TO_FUND },
      data: {
        status: RedemptionStatus.FUNDING,
        outboundShipmentId: prepared.outboundShipmentId,
        totalCostUsdc,
        burnTxSetHash,
      },
    });
    if (claimed.count !== 1) {
      // Sesi LAIN memenangkan klaim. Dari sudut request INI nol dana bergerak, tapi kami TIDAK
      // BISA menyatakan uang redemption ini masih aman — sesi pemenang mungkin sedang mendanai.
      // Fail-closed: stage UNKNOWN, retryable=false.
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: SHIPPING_ERROR_CODE.FUNDING_IN_PROGRESS,
        message:
          'Pendanaan ongkir untuk redemption ini sedang/sudah diproses. ' +
          'Jangan ulangi — cek statusnya.',
        stage: SHIPPING_STAGE.UNKNOWN,
        redemptionId: row.id,
      });
    }

    // 6. DANAI USDC. Titik peralihan PRA→PASCA-danai.
    let fundingSignature: string;
    try {
      const funded = await this.treasury.fundUsdc({
        toWallet: user.walletAddress,
        amountBaseUnits: totalCostUsdc,
      });
      fundingSignature = funded.signature;
    } catch (err) {
      if (err instanceof TreasuryFundIndeterminateError) {
        // INDETERMINATE: USDC MUNGKIN sudah pindah → refundSafe=FALSE, status TETAP FUNDING (tersangkut,
        // diselesaikan manual/reclaim). JANGAN lepas klaim (itu jalur pra-danai). JANGAN auto-refund.
        await this.markPostFund(
          row.id,
          err.signature,
          RedemptionStatus.FUNDING,
          `fundUsdc INDETERMINATE: ${err.message}`,
        );
        throw new ShippingPostFundError(
          `Pendanaan USDC ongkir (redemption ${row.id}) TIDAK PASTI — USDC mungkin sudah pindah ke ` +
            `wallet user. CEK ON-CHAIN & reclaim; JANGAN refund Rupiah. (${err.message})`,
          row.id,
        );
      }
      // PRA-broadcast: belum ada USDC keluar → LEPAS klaim balik ke READY_TO_FUND, refundSafe TETAP true.
      await this.prisma.cardRedemption.updateMany({
        where: { id: row.id, status: RedemptionStatus.FUNDING },
        data: { status: RedemptionStatus.READY_TO_FUND },
      });
      this.logger.warn(
        `fundAndPrepare ${row.id}: fundUsdc gagal PRA-broadcast (${errorMessage(err)}). ` +
          'Klaim dilepas balik ke READY_TO_FUND — tidak ada USDC keluar, refundSafe tetap true.',
      );
      // Dulu error treasury dilempar APA ADANYA. Yang bukan HttpException (mis. RPC melempar Error
      // telanjang) keluar sebagai 500 "Internal server error" TANPA kode — persis lubang kontrak
      // yang sedang ditutup. Sekarang dibungkus: status & pesan HttpException asli DIPERTAHANKAN,
      // error tak dikenal jadi 503 dengan pesan generik (detail cuma masuk log).
      throw shippingError({
        status:
          err instanceof HttpException
            ? err.getStatus()
            : HttpStatus.SERVICE_UNAVAILABLE,
        code: SHIPPING_ERROR_CODE.FUND_FAILED_PRE_BROADCAST,
        message:
          err instanceof HttpException
            ? errorMessage(err)
            : 'Pendanaan USDC ongkir gagal disiapkan. Tidak ada dana yang berpindah — coba lagi.',
        // Klaim SUDAH dilepas balik ke READY_TO_FUND di atas dan fundUsdc melempar PRA-broadcast:
        // nol USDC keluar, refundSafe baris tetap true. Ini satu-satunya tempat di jalur danai
        // yang boleh menyatakan PRE_FUND setelah klaim diambil.
        stage: SHIPPING_STAGE.PRE_FUND,
        redemptionId: row.id,
      });
    }

    // Sukses terkonfirmasi → FUNDED + refundSafe=FALSE. Dari sini USDC ada di wallet user.
    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: {
        status: RedemptionStatus.FUNDED,
        fundingSignature,
        refundSafe: false,
      },
    });
    this.logger.warn(
      `fundAndPrepare ${row.id}: FUNDED — ${totalCostUsdc} USDC base unit didanai ke ` +
        `${user.walletAddress} (sig ${fundingSignature}). refundSafe=false; JANGAN auto-refund Rupiah.`,
    );

    // 7. Kembalikan tx UNSIGNED untuk ditandatangani frontend.
    return {
      transactions: prepared.transactions,
      delistTransactions,
      outboundShipmentId: prepared.outboundShipmentId,
      totalCostUsdc,
    };
  }

  /**
   * Teruskan transaksi burn+ship yang SUDAH ditandatangani user ke CC. burn TIDAK idempoten dari
   * sisi KITA → satu redemption hanya boleh burn SEKALI. Klaim ATOMIK FUNDED → BURN_SUBMITTED
   * (count===1) lebih dulu (dua submit paralel → satu menang), lalu panggil CC.
   *
   * DUA ARRAY TERPISAH: `transactions` dan `delistTransactions` dikirim sebagai field berbeda —
   * CC memvalidasi keduanya sebagai "the complete set this server issued" (403 bila digabung,
   * kurang, atau dobel), dan leg de-list yang tidak ikut membuat leg burn GAGAL on-chain.
   *
   * TIGA MODE KEGAGALAN. Yang PERTAMA punya jaminan dokumen "Nothing was burned" -> klaimnya
   * DILEPAS balik ke FUNDED supaya user bisa menyelesaikan (reprepareBurn -> TTD -> submit lagi):
   *   0. CC menolak batch TANPA membakar apa pun: 403 "Transaction was not issued by this server"
   *      (batch 15 menit kedaluwarsa) atau 409 yang membawa `delistErrors` ("Nothing was burned").
   *      -> LEPAS klaim BURN_SUBMITTED -> FUNDED, refundSafe TETAP false (USDC tetap di wallet
   *         user), lalu ShippingBurnRetryableError — SENGAJA BUKAN ShippingPostFundError.
   * DUA SISANYA AMBIGU dan PASCA-danai (status TETAP BURN_SUBMITTED, refundSafe=FALSE,
   * JANGAN refund/unfund → ShippingPostFundError):
   *   a. throw dari client.burn (jaringan/HTTP non-2xx) = INDETERMINATE — CC mungkin sudah menyiarkan.
   *   b. HTTP 200 dengan ARRAY yang salah satu elemennya punya `error` non-null = leg itu TIDAK
   *      mendarat. 200 di sini BUKAN bukti sukses; setiap elemen WAJIB diperiksa. Satu-satunya
   *      `error` yang bukan kegagalan adalah "Duplicate transaction result" (leg yang sudah tercatat
   *      dari body identik yang dikirim ulang).
   */
  async submitBurn(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
    signedTransactions: string[],
    signedDelistTransactions: string[] = [],
  ): Promise<{ status: RedemptionStatus; burnSignature: string | null }> {
    this.assertEnabled();

    if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.NO_SIGNED_TRANSACTIONS,
        'signedTransactions kosong.',
      );
    }
    const delistTransactions = Array.isArray(signedDelistTransactions)
      ? signedDelistTransactions.filter(isNonEmptyString)
      : [];

    const row = await this.ownedRedemption(redemptionId, user);
    if (row.status !== RedemptionStatus.FUNDED) {
      // Tolak BURN_SUBMITTED/terminal — burn tidak boleh diulang. BURN_SUBMITTED = burn sudah
      // jalan dan hasilnya TIDAK kita ketahui dari sini → UNKNOWN (fail-closed), bukan retryable.
      const submitted = row.status === RedemptionStatus.BURN_SUBMITTED;
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: submitted
          ? SHIPPING_ERROR_CODE.BURN_ALREADY_SUBMITTED
          : SHIPPING_ERROR_CODE.BURN_NOT_FUNDED,
        message: submitted
          ? 'Burn untuk redemption ini sedang/sudah diproses — jangan submit ulang (burn tidak bisa diulang).'
          : `Redemption ini belum siap di-burn (status ${row.status}).`,
        stage: submitted ? SHIPPING_STAGE.UNKNOWN : SHIPPING_STAGE.NO_EFFECT,
        redemptionId: row.id,
      });
    }
    if (!row.outboundShipmentId) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.NOT_PREPARED,
        'Shipment CC belum disiapkan — jalankan fund-and-prepare dulu.',
      );
    }

    // ── B2: TOLAK BATCH BASI DI SINI — SEBELUM klaim atomik dan SEBELUM CC dipanggil ──────────
    // Dua modal (dua tab / HP + desktop) yang sama-sama memanggil /re-prepare menerima
    // outboundShipmentId yang SAMA dengan transaksi BARU. Kalau user menyetujui prompt wallet yang
    // LEBIH TUA duluan, CC menjawab 403 "The transactions submitted are not the complete set this
    // server issued" — dan tabel error dokumen CC TIDAK memberi jaminan "nothing was burned" untuk
    // 403 itu, jadi ia jatuh ke cabang INDETERMINATE dan barisnya nyangkut di BURN_SUBMITTED tanpa
    // jalan keluar otomatis (reprepareBurn cuma menerima FUNDED).
    // Maka: dicegah, bukan diklasifikasikan. Barisnya TIDAK PERNAH keluar dari FUNDED, refundSafe
    // tidak disentuh, klaim tidak terpakai, CC tidak pernah dipanggil.
    // Baris LAMA (burnTxSetHash null) dan set yang tidak bisa dikanonikalisasi → dilewati, persis
    // perilaku sebelum fitur ini ada (lihat cc-shipping.txset.ts).
    if (row.burnTxSetHash) {
      const submittedHash = burnTxSetIdentity({
        outboundShipmentId: row.outboundShipmentId,
        transactions: signedTransactions,
        delistTransactions,
      });
      if (submittedHash === null) {
        this.logger.warn(
          `submitBurn ${row.id}: set transaksi yang disubmit TIDAK bisa dikanonikalisasi — ` +
            'pemeriksaan batch-basi DILEWATI (perilaku lama). Lanjut ke klaim + CC.',
        );
      } else if (submittedHash !== row.burnTxSetHash) {
        this.logger.warn(
          `submitBurn ${row.id}: DITOLAK LOKAL — set transaksi yang disubmit bukan set terakhir ` +
            `yang diterbitkan untuk shipment ${row.outboundShipmentId} (sesi modal basi). Baris ` +
            'TETAP FUNDED, refundSafe tidak disentuh, CC TIDAK dipanggil.',
        );
        throw new ShippingBurnRetryableError(
          'Transaksi yang kamu tanda tangani berasal dari sesi yang lebih lama. Kamu punya sesi ' +
            'lain yang lebih baru — lanjutkan dari sana, atau minta transaksi baru (re-prepare) ' +
            'di halaman ini lalu tanda tangani lagi. Tidak ada kartu yang terbakar dan tidak ada ' +
            'biaya tambahan.',
          row.id,
          SHIPPING_ERROR_CODE.BURN_STALE_SESSION,
        );
      }
    }

    // Klaim ATOMIK FUNDED → BURN_SUBMITTED sebelum menyentuh CC. count!==1 = ada yang menang duluan.
    const claimed = await this.prisma.cardRedemption.updateMany({
      where: { id: row.id, status: RedemptionStatus.FUNDED },
      data: { status: RedemptionStatus.BURN_SUBMITTED },
    });
    if (claimed.count !== 1) {
      // Sesi lain memenangkan klaim → burn-nya mungkin sedang/sudah jalan. Kita TIDAK TAHU
      // hasilnya → UNKNOWN, retryable=false.
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: SHIPPING_ERROR_CODE.BURN_ALREADY_SUBMITTED,
        message:
          'Burn untuk redemption ini sedang/sudah diproses — jangan submit ulang.',
        stage: SHIPPING_STAGE.UNKNOWN,
        redemptionId: row.id,
      });
    }

    let res: CcBurnResponse;
    try {
      res = await this.client.burn(ccAccessToken, row.outboundShipmentId, {
        transactions: signedTransactions,
        delistTransactions,
      });
    } catch (err) {
      // (0) DUA kegagalan yang DOKUMEN CC jamin nol kartu terbakar (403 batch kedaluwarsa / 409
      //     delistErrors). Tidak ada yang indeterminate: LEPAS klaim balik ke FUNDED supaya baris
      //     bisa diulang lewat reprepareBurn. refundSafe TETAP false — USDC ongkir tetap ada di
      //     wallet user, jadi ini TETAP bukan alasan me-refund Rupiah. FAIL-CLOSED: apa pun yang
      //     tidak cocok PERSIS jatuh ke jalur (a) indeterminate di bawah, apa adanya.
      const nothingBurned = documentedNothingBurned(err);
      if (nothingBurned) {
        const released = await this.releaseBurnClaimToFunded(
          row.id,
          `submitBurn DITOLAK CC tanpa membakar apa pun: ${nothingBurned}. Klaim dilepas balik ke ` +
            'FUNDED; USDC ongkir TETAP di wallet user (refundSafe=false) — ulangi lewat re-prepare.',
        );
        if (!released) {
          // Fakta "nol terbakar" tetap PASTI, TAPI barisnya TIDAK terbukti kembali ke FUNDED
          // (baris keburu bergerak/hilang, atau tulisan DB gagal). Menyebutnya "retryable" akan
          // MELEBIH-LEBIHKAN keamanan: user disuruh tanda tangan lagi padahal barisnya nyangkut di
          // BURN_SUBMITTED dan submit berikutnya pasti ditolak. Jadi: butuh manusia (lihat aksi
          // pemulihan admin), stage UNKNOWN, retryable=false.
          this.logger.error(
            `submitBurn ${row.id} NYANGKUT: ${nothingBurned}, tapi pelepasan klaim ke FUNDED GAGAL ` +
              '(baris tetap BURN_SUBMITTED). Butuh pemulihan admin. JANGAN refund Rupiah.',
          );
          throw new ShippingPostFundError(
            `CollectorCrypt menolak transaksinya SEBELUM apa pun dibakar (tidak ada kartu yang ` +
              `hilang), tetapi status redemption ${row.id} tidak bisa dikembalikan otomatis. ` +
              'Hubungi support dan sebutkan id ini — jangan tanda tangan ulang.',
            row.id,
            SHIPPING_ERROR_CODE.BURN_RELEASE_FAILED,
            SHIPPING_STAGE.UNKNOWN,
          );
        }
        this.logger.warn(
          `submitBurn ${row.id}: ${nothingBurned} (shipment ${row.outboundShipmentId}). Status ` +
            'dilepas balik ke FUNDED — user bisa minta transaksi baru (POST :id/re-prepare) lalu ' +
            'submit ulang. JANGAN refund Rupiah: USDC ongkir sudah didanai ke wallet user.',
        );
        throw new ShippingBurnRetryableError(
          'Transaksi burn kedaluwarsa / ditolak CollectorCrypt SEBELUM apa pun dibakar — tidak ada ' +
            'kartu yang hilang dan tidak ada biaya tambahan. Minta transaksi baru (re-prepare) lalu ' +
            'tanda tangani lagi.',
          row.id,
        );
      }

      // (a) INDETERMINATE PASCA-danai. Status SUDAH BURN_SUBMITTED (dari klaim). refundSafe=FALSE.
      await this.markBurnPostFundFailure(
        row.id,
        `submitBurn INDETERMINATE: ${errorMessage(err)}`,
      );
      this.logger.error(
        `submitBurn ${row.id} KRITIS: burn CC (shipment ${row.outboundShipmentId}) GAGAL/INDETERMINATE: ` +
          `${errorMessage(err)}. CC MUNGKIN sudah membakar+mengirim. JANGAN refund/unfund. Selesaikan manual.`,
      );
      throw new ShippingPostFundError(
        `Burn redemption ${row.id} TIDAK PASTI — CC mungkin sudah membakar. JANGAN refund. (${errorMessage(err)})`,
        row.id,
      );
    }

    // (b) HTTP 200 ≠ sukses: periksa SETIAP elemen array. Satu `error` non-null (selain duplikat)
    //     = leg itu tidak mendarat → perlakukan sebagai kegagalan PASCA-danai, sama disiplinnya.
    const legFailure = firstBurnLegFailure(res);
    if (legFailure) {
      await this.markBurnPostFundFailure(
        row.id,
        `submitBurn LEG GAGAL: ${legFailure}`,
      );
      this.logger.error(
        `submitBurn ${row.id} KRITIS: CC menjawab 200 tapi ada leg GAGAL (shipment ` +
          `${row.outboundShipmentId}): ${legFailure}. USDC ongkir SUDAH di wallet user → JANGAN ` +
          'refund/unfund. Pemulihan: POST /redeem/complete/:shipmentId di CC (membangun ulang leg ' +
          'untuk kartu yang BELUM terbakar); kalau 409 → support@collectorcrypt.com.',
      );
      throw new ShippingPostFundError(
        `Burn redemption ${row.id} GAGAL di salah satu leg — JANGAN refund (USDC sudah didanai). (${legFailure})`,
        row.id,
        SHIPPING_ERROR_CODE.BURN_LEG_FAILED,
      );
    }

    const burnSignature = firstLandedTransactionId(res);

    // B4 — SATU-SATUNYA tulisan di jalur pasca-danai yang dulu TIDAK dibungkus, padahal
    // tetangganya (markBurnPostFundFailure / releaseBurnClaimToFunded) semuanya dibungkus. Sebuah
    // blip DB di sini akan melempar SETELAH burn-nya BERHASIL, dan pemanggil akan menampilkan
    // layar terminal "butuh manusia" untuk pengiriman yang sebenarnya sukses — sekaligus membuang
    // signature-nya. Sekarang: gagal-tulis DI-LOG (berikut signature-nya, supaya bisa dipulihkan)
    // lalu jalan terus. Aman karena tulisan ini tidak membawa fakta keamanan yang baru:
    //  - status baris SUDAH BURN_SUBMITTED sejak klaim atomik, dan
    //  - refundSafe SUDAH false sejak fundAndPrepare menandai FUNDED; `false` di sini cuma
    //    penegasan, bukan perubahan arah (tidak ada satu pun tempat yang menulis `true`).
    // burnSignature sendiri adalah JEJAK, bukan sumber kebenaran (sumbernya CC/on-chain).
    try {
      await this.prisma.cardRedemption.update({
        where: { id: row.id },
        data: { burnSignature, refundSafe: false },
      });
    } catch (err) {
      this.logger.error(
        `submitBurn ${row.id}: burn CC BERHASIL (shipment ${row.outboundShipmentId}` +
          `${burnSignature ? `, sig ${burnSignature}` : ''}) tapi tulisan DB-nya GAGAL: ` +
          `${errorMessage(err)}. Baris TETAP BURN_SUBMITTED dan refundSafe TETAP false. Simpan ` +
          'signature di atas — poll status (refreshStatus) akan tetap memajukan barisnya. ' +
          'JANGAN refund dan JANGAN suruh user tanda tangan ulang.',
      );
    }
    this.logger.warn(
      `submitBurn ${row.id}: BURN_SUBMITTED (shipment ${row.outboundShipmentId}` +
        `${burnSignature ? `, sig ${burnSignature}` : ''}).`,
    );
    return { status: RedemptionStatus.BURN_SUBMITTED, burnSignature };
  }

  /**
   * RE-PREPARE — terbitkan ULANG transaksi burn untuk baris yang uangnya SUDAH berpindah.
   * Dokumen CC: "Calling prepare again with identical input returns the same shipment with fresh
   * transactions. That is the correct recovery when a blockhash expires."
   *
   * Ini jalan keluar dari submitBurn yang ditolak CC tanpa membakar apa pun (403 batch kedaluwarsa /
   * 409 delistErrors): submitBurn melepas klaimnya balik ke FUNDED, user memanggil rute ini untuk
   * dapat transaksi segar, menandatanganinya, lalu submit lagi.
   *
   * PAGAR KERAS (JANGAN dilonggarkan):
   *  - HANYA status FUNDED. READY_TO_FUND itu milik fundAndPrepare (jalur yang MENDANAI);
   *    BURN_SUBMITTED/IN_TRANSIT/dst berarti burn mungkin sudah jalan — bukan urusan rute ini.
   *  - TIDAK PERNAH memanggil treasury.fundUsdc. Uang SUDAH pindah saat FUNDED; rute ini cuma
   *    menerbitkan ulang transaksi. Tidak ada klaim status & tidak ada perubahan refundSafe, jadi
   *    memanggilnya berkali-kali tidak bisa double-fund maupun double-claim (idempotent-safe).
   *  - Guard biaya dijalankan ULANG terhadap yang SUDAH didanai, plafon slippage SAMA. Lewat plafon
   *    -> TOLAK dan baris DIBIARKAN FUNDED untuk penyelesaian manual; kita tidak pernah diam-diam
   *    menerima ongkir yang lebih mahal (dan tidak menambah dana). B3: guard itu dijalankan DUA
   *    KALI — sekali sebagai PRA-CEK atas /redeem/estimate SEBELUM prepare (supaya percobaan yang
   *    sudah pasti ditolak tidak menggantikan set transaksi yang sedang ditandatangani user), dan
   *    sekali lagi secara OTORITATIF atas totalCost dari prepare. Penolakannya BUKAN retryable
   *    (stage POST_FUND): tanda tangan ulang tidak menurunkan harga CC.
   *  - `totalCostUsdc` yang tersimpan TIDAK ditimpa: itu catatan uang yang BENAR-BENAR keluar dan
   *    sekaligus basis plafon — menimpanya membuat plafon "merangkak" +10% tiap re-prepare.
   */
  async reprepareBurn(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<ReprepareResult> {
    this.assertEnabled();

    const row = await this.ownedRedemption(redemptionId, user);
    if (row.status !== RedemptionStatus.FUNDED) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.REPREPARE_NOT_FUNDED,
        'Transaksi burn baru hanya bisa diterbitkan untuk redemption yang ongkirnya SUDAH didanai ' +
          `dan belum di-burn (status FUNDED) — status sekarang ${row.status}.`,
      );
    }

    // Input WAJIB IDENTIK dengan fundAndPrepare: itu syarat CC mengembalikan shipment yang SAMA
    // (mengubah alamat / payCustomsDuties SENGAJA membuat shipment BARU).
    const ccAddressId = await this.ensureCcShippingAddress(row, ccAccessToken);

    // ── B3: PRA-CEK HARGA SEBELUM prepare ────────────────────────────────────────────────────
    // prepare BUKAN panggilan gratis: dokumen CC menyatakan "calling prepare again with identical
    // input returns the same shipment with FRESH transactions" — artinya SETIAP prepare
    // MENGGANTIKAN set yang mungkin BARU SAJA ditandatangani user di tab lain. Percobaan yang
    // sudah pasti ditolak guard biaya tidak boleh membakar set hidup itu.
    // /redeem/estimate aman dipakai untuk itu: dokumen CC menyebutnya "optional, priced preview",
    // ia TIDAK membuat shipment dan TIDAK menerbitkan transaksi apa pun. Angka otoritatifnya
    // `total` — field yang sama yang dipakai saat menetapkan harga invoice ongkir.
    // BEST-EFFORT DENGAN SENGAJA: kalau estimate-nya sendiri gagal (CC down, bentuk respons aneh),
    // kita LANJUT ke prepare — guard OTORITATIF sesudah prepare tetap berjalan tanpa perubahan,
    // jadi pra-cek ini hanya bisa MENOLAK LEBIH AWAL, tidak pernah meloloskan apa pun.
    let preCheckUsdc: number | null = null;
    try {
      const preview = await this.client.estimate(ccAccessToken, {
        nftAddresses: [row.nftAddress],
        shippingAddressId: ccAddressId,
        deliveryCompany: DEFAULT_DELIVERY_COMPANY,
      });
      preCheckUsdc = this.toEstimate(preview.total).usdcBaseUnits;
    } catch (err) {
      this.logger.warn(
        `reprepareBurn ${row.id}: pra-cek ongkir lewat /redeem/estimate gagal ` +
          `(${errorMessage(err)}) — DILEWATI. Guard biaya OTORITATIF sesudah prepare tetap berlaku.`,
      );
    }
    if (preCheckUsdc !== null) {
      // DI LUAR try: penolakan guard harus keluar apa adanya, bukan ditelan sebagai "estimate gagal".
      await this.assertCostWithinFunded(row, preCheckUsdc);
    }

    const email = await this.userEmail(user.id);
    const prepared = await this.client.prepare(ccAccessToken, {
      nftAddresses: [row.nftAddress],
      shippingAddressId: ccAddressId,
      coin: 'USDC',
      deliveryCompany: DEFAULT_DELIVERY_COMPANY,
      ...(email ? { email } : {}),
    });
    if (
      !prepared.outboundShipmentId ||
      !Array.isArray(prepared.transactions) ||
      prepared.transactions.length === 0
    ) {
      // RE-PREPARE: uang SUDAH pindah (baris FUNDED) tapi jalur ini tidak mengklaim status apa
      // pun, jadi barisnya TERBUKTI masih FUNDED → stage FUNDED (boleh dicoba lagi), bukan PRE_FUND.
      throw shippingError({
        status: HttpStatus.SERVICE_UNAVAILABLE,
        code: SHIPPING_ERROR_CODE.CC_PREPARE_INVALID,
        message:
          'CollectorCrypt tidak mengembalikan transaksi burn yang bisa ditandatangani.',
        stage: SHIPPING_STAGE.FUNDED,
        redemptionId: row.id,
      });
    }
    const totalCostUsdc = this.toEstimate(prepared.totalCost).usdcBaseUnits;

    const delistTransactions = Array.isArray(prepared.delistTransactions)
      ? prepared.delistTransactions
      : [];

    // Dokumen: input identik = shipment yang SAMA. Kalau CC toh mengembalikan id lain, id baru itu
    // WAJIB dipersist — kalau tidak, submitBurn memposting transaksi baru ke shipment lama dan kena
    // 403 "These transactions were not issued for this shipment".
    if (prepared.outboundShipmentId !== row.outboundShipmentId) {
      this.logger.warn(
        `reprepareBurn ${row.id}: CC mengembalikan outboundShipmentId BERBEDA ` +
          `(${row.outboundShipmentId ?? 'kosong'} -> ${prepared.outboundShipmentId}). Id baru ` +
          'dipersist; shipment lama perlu dicek manual.',
      );
    }

    // B2: identitas set BARU ini menggantikan yang lama — SELALU ditulis, bahkan kalau shipment
    // id-nya sama, karena justru itu kasusnya (id sama, transaksi baru). Ditulis SEBELUM transaksi
    // dikembalikan ke frontend, supaya set yang baru saja diterbitkan sudah jadi satu-satunya set
    // yang diterima submitBurn. Menulisnya juga TIDAK menyentuh status maupun refundSafe.
    const burnTxSetHash = burnTxSetIdentity({
      outboundShipmentId: prepared.outboundShipmentId,
      transactions: prepared.transactions,
      delistTransactions,
    });
    // B3 — URUTAN YANG DIPILIH: PERSIST DULU, GUARD BELAKANGAN.
    // Begitu prepare kembali, CC SUDAH menggantikan set transaksinya; itu fakta yang sudah terjadi
    // dan tidak bisa dibatalkan. Kalau guard biaya di bawah menolak DAN kita belum menulis
    // identitas set baru, kolom burnTxSetHash jadi BASI relatif terhadap yang CC anggap berlaku:
    // user yang lalu men-submit set LAMA lolos pemeriksaan lokal, kita ambil klaim
    // FUNDED→BURN_SUBMITTED, panggil CC, dan CC menjawab 403 "not issued by this server" —
    // pemulihan yang HANYA berhasil kalau pelepasan klaimnya berhasil; kalau gagal, barisnya
    // nyangkut di BURN_SUBMITTED dan butuh admin. Menulisnya LEBIH DULU membuat submit set lama
    // ditolak SECARA LOKAL (BURN_STALE_SESSION): nol panggilan CC, nol klaim, baris tetap FUNDED.
    // Tulisan ini tidak menyentuh status, refundSafe, maupun totalCostUsdc — jadi ia tidak bisa
    // memperburuk posisi uang apa pun; ia hanya menyamakan catatan kita dengan kenyataan di CC.
    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: {
        ...(prepared.outboundShipmentId !== row.outboundShipmentId
          ? { outboundShipmentId: prepared.outboundShipmentId }
          : {}),
        burnTxSetHash,
      },
    });

    // Guard biaya OTORITATIF (basis: yang BENAR-BENAR didanai). Gagal = baris tetap FUNDED apa
    // adanya, tidak ada transaksi yang dikembalikan, dan vonisnya "butuh manusia" (stage
    // POST_FUND) — bukan "tanda tangan lagi". Dalam praktik pra-cek di atas sudah menangkap
    // sebagian besar kasus ini SEBELUM prepare dipanggil.
    await this.assertCostWithinFunded(row, totalCostUsdc);

    this.logger.warn(
      `reprepareBurn ${row.id}: transaksi burn BARU diterbitkan (shipment ` +
        `${prepared.outboundShipmentId}, ongkir CC ${totalCostUsdc}, sudah didanai ` +
        `${row.totalCostUsdc ?? 0}). NOL dana berpindah di jalur ini; refundSafe tetap false.`,
    );

    return {
      transactions: prepared.transactions,
      delistTransactions,
      outboundShipmentId: prepared.outboundShipmentId,
      fundedUsdc: row.totalCostUsdc ?? 0,
      totalCostUsdc,
    };
  }

  /**
   * Poll status shipment CC (tak ada webhook) → petakan ke status Hoshi + persist tracking.
   * Hanya MEMAJUKAN (BURN_SUBMITTED→IN_TRANSIT→DELIVERED/…); tidak pernah memundurkan status yang
   * sudah lebih jauh (CC yang flaky tidak boleh menurunkan DELIVERED).
   */
  async refreshStatus(
    redemptionId: string,
    user: AuthUser,
    ccAccessToken: string,
  ): Promise<CardRedemption> {
    this.assertEnabled();
    const row = await this.ownedRedemption(redemptionId, user);
    if (!row.outboundShipmentId) {
      // Belum di-prepare → tidak ada yang bisa di-poll. Kembalikan apa adanya.
      return row;
    }

    const remote = await this.client.getShipment(
      ccAccessToken,
      row.outboundShipmentId,
    );
    if (remote === null) {
      // Kontrak CC: id tak dikenal = HTTP 200 BODY KOSONG (bukan 404) → klien memetakannya ke null.
      // Jangan menulis apa pun: shipment mungkin belum terlihat oleh sesi ini / id salah. Status
      // yang sudah maju TIDAK boleh dimundurkan hanya karena poll ini kosong.
      this.logger.warn(
        `refreshStatus ${row.id}: shipment ${row.outboundShipmentId} tidak dikenal CC ` +
          '(200 body kosong). Baris dibiarkan apa adanya.',
      );
      return row;
    }
    const trackingIds = Array.isArray(remote.trackingIds)
      ? remote.trackingIds.filter(isNonEmptyString)
      : [];
    const trackingUrls = Array.isArray(remote.trackingUrls)
      ? remote.trackingUrls.filter(isNonEmptyString)
      : [];

    const mapped = mapCcShipmentStatus(remote.status);
    // Hanya maju dari BURN_SUBMITTED/IN_TRANSIT ke IN_TRANSIT/DELIVERED/SHIP_FAILED_POST_BURN.
    const advanceTo =
      mapped &&
      (mapped === RedemptionStatus.IN_TRANSIT ||
        mapped === RedemptionStatus.DELIVERED ||
        mapped === RedemptionStatus.SHIP_FAILED_POST_BURN)
        ? mapped
        : undefined;

    await this.prisma.cardRedemption.updateMany({
      where: {
        id: row.id,
        status: {
          in: [RedemptionStatus.BURN_SUBMITTED, RedemptionStatus.IN_TRANSIT],
        },
      },
      data: {
        trackingIds,
        trackingUrls,
        ...(advanceTo ? { status: advanceTo } : {}),
      },
    });

    const refreshed = await this.prisma.cardRedemption.findUnique({
      where: { id: row.id },
    });
    return refreshed ?? row;
  }

  /* ---------------------- SIWS (Track B) — login handshake CC ----------------------
     Relay PRA-AUTH murni untuk user wallet (Phantom) agar dapat sesi CC. TANPA DB, TANPA
     persistensi — sama seperti sikap "token identitas tak pernah dipersist" di jalur shipping:
     kita cuma meneruskan dan mengembalikan token ke frontend. DIGERBANG HOSHI_CC_SHIPPING_ENABLED
     lewat assertEnabled() (pola sama dengan estimate/fund/burn/status). Kepemilikan wallet
     (body.wallet === user.walletAddress) ditegakkan di controller. */

  /** nonce: suntik partnerAppId/domain/uri dari config lalu relay. Config kosong → 503 (siwsConfig). */
  async siwsNonce(wallet: string): Promise<CcSiwsNonceResponse> {
    this.assertEnabled();
    const { partnerAppId, domain, uri } = this.siwsConfig();
    return this.client.siwsNonce({ wallet, partnerAppId, domain, uri });
  }

  /** verify: relay message+signature apa adanya → token sesi CC (cca_/ccr_). */
  // async: assertEnabled() throw jadi rejected promise (bukan sync throw), konsisten dgn method lain.
  async siwsVerify(
    message: string,
    signature: string,
  ): Promise<CcSiwsVerifyResponse> {
    this.assertEnabled();
    return this.client.siwsVerify({ message, signature });
  }

  /** refresh: relay refreshToken apa adanya → pasangan token baru. */
  async siwsRefresh(refreshToken: string): Promise<CcSiwsRefreshResponse> {
    this.assertEnabled();
    return this.client.siwsRefresh({ refreshToken });
  }

  /* --- Internal --- */

  /**
   * Baca config SIWS LAZY (pola sama endpoint() di client). Salah satu kosong → 503 jelas
   * ("SIWS not configured …") supaya kita TIDAK memanggil CC dengan partnerAppId/domain/uri
   * undefined. Hanya jalur nonce yang butuh config; verify/refresh tidak.
   */
  private siwsConfig(): { partnerAppId: string; domain: string; uri: string } {
    const read = (k: string): string =>
      (this.config.get<string>(k) ?? '').trim();
    const partnerAppId = read('COLLECTORCRYPT_PARTNER_APP_ID');
    const domain = read('COLLECTORCRYPT_SIWS_DOMAIN');
    const uri = read('COLLECTORCRYPT_SIWS_URI');
    const missing = [
      partnerAppId ? '' : 'COLLECTORCRYPT_PARTNER_APP_ID',
      domain ? '' : 'COLLECTORCRYPT_SIWS_DOMAIN',
      uri ? '' : 'COLLECTORCRYPT_SIWS_URI',
    ].filter((k) => k.length > 0);
    if (missing.length > 0) {
      throw noEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        SHIPPING_ERROR_CODE.SIWS_NOT_CONFIGURED,
        `SIWS not configured — set ${missing.join(', ')}.`,
      );
    }
    // Kontrak CC: `domain` WAJIB hostname TELANJANG — tanpa skema, tanpa port, tanpa path (dan
    // harus ada di allowlist mereka). Config yang salah bentuk lebih baik gagal di sini dengan
    // pesan jelas daripada ditolak CC sebagai 400 yang tak menyebut sebabnya.
    if (/[:/]/.test(domain)) {
      throw noEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        SHIPPING_ERROR_CODE.SIWS_DOMAIN_INVALID,
        'SIWS misconfigured — COLLECTORCRYPT_SIWS_DOMAIN harus hostname telanjang ' +
          `(tanpa skema/port/path), mis. "hoshimarket.xyz"; sekarang "${domain}".`,
      );
    }
    return { partnerAppId, domain, uri };
  }

  /**
   * Redemption milik user login. Kepemilikan lewat LEDGER (userId), bukan klaim klien — id
   * redemption bisa bocor tapi bukan kapabilitas.
   */
  private async ownedRedemption(
    redemptionId: string,
    user: AuthUser,
  ): Promise<CardRedemption> {
    const row = await this.prisma.cardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!row) {
      throw noEffectError(
        HttpStatus.NOT_FOUND,
        SHIPPING_ERROR_CODE.REDEMPTION_NOT_FOUND,
        'Redemption tidak ditemukan.',
      );
    }
    if (row.userId !== user.id) {
      this.logger.warn(
        `Akses redemption ${redemptionId} ditolak untuk user ${user.id} (pemilik: ${row.userId}).`,
      );
      throw noEffectError(
        HttpStatus.FORBIDDEN,
        SHIPPING_ERROR_CODE.REDEMPTION_NOT_YOURS,
        'Redemption ini bukan milik Anda.',
      );
    }
    // ╔══════════════════════════════════════════════════════════════════════════════════════╗
    // ║ GERBANG RAIL — SATU chokepoint untuk SELURUH jalur CC Vault.                         ║
    // ╚══════════════════════════════════════════════════════════════════════════════════════╝
    // Setiap rute money-critical jalur CC (estimate / fundAndPrepare / reprepareBurn /
    // submitBurn / refreshStatus) memuat barisnya LEWAT SINI. Sebuah baris jalur DOMESTIK
    // (listingId non-null) tidak punya NFT untuk dibakar dan tidak punya ongkir CC untuk
    // ditaksir; membiarkannya masuk berarti kita mengirim `nftAddress` bernilai
    // `hoshi-listing:<id>` ke CollectorCrypt dan — lebih buruk — membuka kemungkinan USDC
    // treasury didanai untuk kartu yang pengirimannya sudah dibayar lewat ongkir Rupiah.
    // Ditolak DI SINI, sekali, bukan di lima rute yang bisa lupa satu-satu.
    assertCcRail(row);
    return row;
  }

  /** Buat alamat kirim di CC bila belum ada; persist id-nya. Idempoten via kolom ccShippingAddressId. */
  private async ensureCcShippingAddress(
    row: CardRedemption,
    ccAccessToken: string,
  ): Promise<string> {
    if (row.ccShippingAddressId) return row.ccShippingAddressId;
    const created = await this.client.createShippingAddress(
      ccAccessToken,
      this.toCcAddress(row),
    );
    if (!created.id) {
      throw noEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        SHIPPING_ERROR_CODE.CC_ADDRESS_INVALID,
        'CollectorCrypt tidak mengembalikan id alamat kirim.',
      );
    }
    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: { ccShippingAddressId: created.id },
    });
    return created.id;
  }

  /**
   * Guard slippage: ongkir OTORITATIF (prepare) tidak boleh melebihi plafon dari yang user BAYAR
   * (di-snapshot ke PaymentOrder.priceUsdc saat invoice). Lewat = pra-danai → tolak & refund aman.
   */
  private async assertCostWithinPaid(
    row: CardRedemption,
    totalCostUsdc: number,
    // Helper ini dipakai DUA jalur: fundAndPrepare (benar-benar pra-danai) dan, sebagai cadangan,
    // assertCostWithinFunded untuk baris lama yang belum menyimpan totalCostUsdc (uang SUDAH
    // pindah). Stage-nya karena itu DISUNTIK pemanggil — supaya cabang pasca-danai tidak pernah
    // ikut mengklaim "PRE_FUND / Rupiah aman di-refund".
    stage: ShippingErrorStage = SHIPPING_STAGE.PRE_FUND,
  ): Promise<void> {
    const order = row.paymentOrderId
      ? await this.prisma.paymentOrder.findUnique({
          where: { id: row.paymentOrderId },
        })
      : await this.prisma.paymentOrder.findFirst({
          where: { redemptionId: row.id, packType: 'SHIPPING' },
          orderBy: { createdAt: 'desc' },
        });
    if (!order || order.priceUsdc <= 0) {
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: SHIPPING_ERROR_CODE.PAID_ORDER_NOT_FOUND,
        message:
          'Tidak menemukan order ongkir Rupiah yang sudah dibayar untuk redemption ini.',
        stage,
        redemptionId: row.id,
      });
    }
    const ceiling = applyBpsCeil(
      order.priceUsdc,
      BPS_DENOMINATOR + SHIPPING_MAX_SLIPPAGE_BPS,
    );
    if (totalCostUsdc > ceiling) {
      // B3: pesannya IKUT stage. Dari fundAndPrepare (PRE_FUND) memang benar "nol dana berpindah,
      // Rupiah bisa di-refund". Dari jalur PASCA-danai kalimat itu BOHONG — USDC sudah ada di
      // wallet user — dan menjanjikan retry yang tidak mungkin berhasil.
      const preFund = stage === SHIPPING_STAGE.PRE_FUND;
      this.logger.warn(
        `${preFund ? 'fundAndPrepare' : 'reprepareBurn'} ${row.id} TOLAK: ongkir CC ` +
          `${totalCostUsdc} > plafon ${ceiling} (dibayar ${order.priceUsdc} + ` +
          `${SHIPPING_MAX_SLIPPAGE_BPS} bps). Stage ${stage}.`,
      );
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: SHIPPING_ERROR_CODE.COST_EXCEEDS_PAID,
        message: preFund
          ? 'Ongkir kirim naik melebihi yang Anda bayar — pendanaan dibatalkan. ' +
            'Tidak ada dana yang berpindah; ongkir Rupiah bisa di-refund.'
          : 'Ongkir CollectorCrypt naik melebihi plafon dari ongkir yang sudah dibayar — transaksi ' +
            'baru tidak diterbitkan. Menandatangani ulang TIDAK akan menolong (harga CC tidak ' +
            'turun karenanya). Hubungi support untuk penyelesaian manual; USDC ongkir sudah ada ' +
            'di wallet Anda, jadi ini BUKAN kasus refund.',
        stage,
        redemptionId: row.id,
      });
    }
  }

  /**
   * Guard biaya untuk RE-PREPARE (PASCA-danai). Basisnya yang BENAR-BENAR sudah didanai ke wallet
   * user (`totalCostUsdc`) dengan plafon slippage yang SAMA PERSIS dengan jalur pra-danai. Baris
   * lama yang belum sempat menyimpan angka itu jatuh ke assertCostWithinPaid (basis harga order
   * Rupiah) — plafon yang sama, bukan plafon yang lebih longgar.
   *
   * Beda tegas dari fundAndPrepare: di sini TIDAK ADA dana tambahan yang dikirim, jadi ongkir yang
   * melewati plafon WAJIB ditolak dan barisnya DIBIARKAN FUNDED untuk penyelesaian manual.
   *
   * B3 — STAGE-nya POST_FUND, bukan FUNDED, di KEDUA cabang. Bukan karena kami ragu apa kartunya
   * terbakar (tidak, baris ini tidak pernah keluar dari FUNDED), tapi karena FUNDED berarti
   * "silakan tanda tangan lagi" dan pengulangan TIDAK BISA menolong di sini: yang ditolak adalah
   * HARGA CC, dan harga tidak turun karena user menandatangani ulang. Ini vonis "butuh manusia".
   */
  private async assertCostWithinFunded(
    row: CardRedemption,
    totalCostUsdc: number,
  ): Promise<void> {
    const funded = row.totalCostUsdc ?? 0;
    if (funded <= 0) {
      // PASCA-danai: uang sudah pindah, jadi cabang ini TIDAK boleh mewarisi stage PRE_FUND.
      // B3: dan juga tidak boleh FUNDED — itu berarti "silakan tanda tangan lagi", padahal
      // pengulangan tidak bisa menurunkan harga CC. Lihat catatan stage di assertCostWithinFunded.
      await this.assertCostWithinPaid(
        row,
        totalCostUsdc,
        SHIPPING_STAGE.POST_FUND,
      );
      return;
    }
    const ceiling = applyBpsCeil(
      funded,
      BPS_DENOMINATOR + SHIPPING_MAX_SLIPPAGE_BPS,
    );
    if (totalCostUsdc > ceiling) {
      this.logger.error(
        `reprepareBurn ${row.id} TOLAK: ongkir CC baru ${totalCostUsdc} > plafon ${ceiling} ` +
          `(sudah didanai ${funded} + ${SHIPPING_MAX_SLIPPAGE_BPS} bps). Baris DIBIARKAN FUNDED ` +
          'untuk penyelesaian manual; NOL dana tambahan dikirim.',
      );
      throw shippingError({
        status: HttpStatus.BAD_REQUEST,
        code: SHIPPING_ERROR_CODE.COST_EXCEEDS_FUNDED,
        message:
          'Ongkir CollectorCrypt naik melebihi plafon dari ongkir yang sudah didanai — transaksi ' +
          'baru tidak diterbitkan. Menandatangani ulang TIDAK akan menolong: harga CC tidak turun ' +
          'karena kamu tanda tangan lagi. Hubungi support untuk penyelesaian manual. USDC ongkir ' +
          'sudah ada di wallet-mu, jadi ini BUKAN kasus refund.',
        // B3 — BUKAN stage FUNDED. `retryable` diturunkan dari stage, dan FUNDED berarti "minta
        // transaksi baru lalu tanda tangan lagi" → UI merender "Coba tanda tangani lagi" yang
        // memanggil re-prepare, yang menjalankan ULANG guard yang sama terhadap totalCostUsdc yang
        // sama dan gagal dengan cara yang sama: LOOP TAK BERUJUNG (dan dulu setiap putarannya
        // menerbitkan batch CC baru yang menggantikan set yang sudah user tanda tangani).
        // POST_FUND = "butuh manusia": retryable=false, dan TIDAK menyiratkan refund — di FUNDED
        // USDC sudah pindah. Barisnya sendiri DIBIARKAN FUNDED apa adanya (tidak ada klaim, tidak
        // ada dana tambahan, refundSafe tidak disentuh); yang berubah cuma vonis yang kita
        // sampaikan. Fail-closed membolehkan ini: melebihkan KEHATI-HATIAN boleh, melebihkan
        // KEAMANAN tidak.
        stage: SHIPPING_STAGE.POST_FUND,
        redemptionId: row.id,
      });
    }
    if (totalCostUsdc > funded) {
      this.logger.warn(
        `reprepareBurn ${row.id}: ongkir CC baru ${totalCostUsdc} > yang sudah didanai ${funded} ` +
          '(masih di dalam plafon). TIDAK ada dana tambahan dikirim — selisihnya harus tertutup ' +
          'saldo USDC user sendiri, kalau kurang transaksinya gagal on-chain.',
      );
    }
  }

  /**
   * LEPAS klaim burn: BURN_SUBMITTED -> FUNDED. HANYA untuk dua kegagalan yang DOKUMEN CC jamin
   * tidak membakar apa pun. Berpagar status di updateMany, jadi baris yang sudah maju (IN_TRANSIT/
   * DELIVERED/…) TIDAK PERNAH dimundurkan. refundSafe TETAP false — USDC ongkir sudah di wallet
   * user; ini jalur COBA LAGI, bukan jalur refund.
   *
   * Kegagalan menulis DB di-log saja (tidak dilempar), TAPI dilaporkan lewat nilai kembali:
   * `false` = barisnya TIDAK terbukti kembali ke FUNDED. Pemanggil WAJIB memakai itu — kode
   * "retryable" (stage FUNDED = "silakan tanda tangan lagi") cuma boleh terbit kalau pelepasannya
   * TERKONFIRMASI; kalau tidak, user akan disuruh menandatangani ulang sesuatu yang pasti ditolak.
   *
   * @returns true HANYA bila updateMany benar-benar memindahkan tepat satu baris ke FUNDED.
   */
  private async releaseBurnClaimToFunded(
    id: string,
    note: string,
  ): Promise<boolean> {
    try {
      const released = await this.prisma.cardRedemption.updateMany({
        where: { id, status: RedemptionStatus.BURN_SUBMITTED },
        data: {
          status: RedemptionStatus.FUNDED,
          refundSafe: false,
          note: note.slice(0, ERROR_MAX),
        },
      });
      if (released.count !== 1) {
        this.logger.error(
          `Klaim burn redemption ${id} TIDAK jadi dilepas (count=${released.count}) — baris sudah ` +
            'bergerak/hilang. Cek manual; JANGAN refund Rupiah (USDC ongkir sudah didanai).',
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.error(
        `Gagal melepas klaim burn redemption ${id} kembali ke FUNDED: ${errorMessage(err)} ` +
          `(asli: ${note})`,
      );
      return false;
    }
  }

  /**
   * Tandai kegagalan burn PASCA-danai: refundSafe=FALSE + catatan, TANPA menyentuh status (status
   * sudah BURN_SUBMITTED dari klaim atomik dan tidak boleh di-walk-back). Kegagalan menulis DB
   * di-log tapi tidak dilempar — pemanggil WAJIB tetap mendapat ShippingPostFundError supaya
   * gerbang refund tidak pernah melihat kegagalan biasa.
   */
  private async markBurnPostFundFailure(
    id: string,
    note: string,
  ): Promise<void> {
    try {
      await this.prisma.cardRedemption.update({
        where: { id },
        data: { refundSafe: false, note: note.slice(0, ERROR_MAX) },
      });
    } catch (err) {
      this.logger.error(
        `Gagal menandai kegagalan PASCA-danai burn redemption ${id}: ${errorMessage(err)} (asli: ${note})`,
      );
    }
  }

  /** Tandai state PASCA-danai (indeterminate): refundSafe=false, simpan sig + catatan. */
  private async markPostFund(
    id: string,
    signature: string,
    status: RedemptionStatus,
    note: string,
  ): Promise<void> {
    try {
      await this.prisma.cardRedemption.update({
        where: { id },
        data: {
          status,
          refundSafe: false,
          fundingSignature: signature,
          note: note.slice(0, ERROR_MAX),
        },
      });
    } catch (err) {
      this.logger.error(
        `Gagal menandai state PASCA-danai redemption ${id}: ${errorMessage(err)} (asli: ${note})`,
      );
    }
  }

  private async userEmail(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? undefined;
  }

  /**
   * Snapshot alamat redemption → bentuk alamat CC.
   *
   * WHITELIST KETAT: POST /shipping-address/create hanya menerima streetAddress, city, state,
   * country (wajib) + fullName, apartment, zip, phoneNumber, isDefault (opsional). Field lain —
   * termasuk `email`, yang dulu kita kirim — dijawab 400. Jadi JANGAN menambah field di sini.
   *
   * `state` WAJIB di CC "even where the concept does not apply", sementara di ledger kita ia
   * nullable. Kalau kosong kita menolak LEBIH AWAL dengan pesan yang jelas: 400 CC untuk field
   * wajib berbunyi "Invalid request." tanpa menyebut field-nya, dan jalur ini masih PRA-bayar /
   * PRA-danai — nol dana berpindah.
   */
  private toCcAddress(row: CardRedemption): CcShippingAddressInput {
    const state = (row.state ?? '').trim();
    if (!state) {
      throw noEffectError(
        HttpStatus.BAD_REQUEST,
        SHIPPING_ERROR_CODE.ADDRESS_STATE_REQUIRED,
        'Alamat tujuan belum punya provinsi/state, padahal CollectorCrypt mewajibkannya. ' +
          'Lengkapi provinsi di alamat kirim lalu ulangi.',
      );
    }
    return {
      streetAddress: row.street,
      city: row.city,
      state,
      country: row.country,
      fullName: row.recipientName,
      apartment: row.apt ?? undefined,
      zip: row.zip,
      phoneNumber: row.phoneNumber ?? undefined,
      isDefault: true,
    };
  }

  /**
   * Ongkir CC `totalCost` = USD dolar penuh (seperti field harga CC lain) → USDC base unit.
   * Validasi ketat: jalur uang tidak boleh menerima NaN/negatif/tak-hingga.
   */
  private toEstimate(totalCostUsd: unknown): ShippingEstimate {
    const usd = Number(totalCostUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw noEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        SHIPPING_ERROR_CODE.CC_COST_INVALID,
        'Ongkir dari CollectorCrypt tidak masuk akal. Coba lagi nanti.',
      );
    }
    return { usd, usdcBaseUnits: usdDollarsToUsdcBaseUnits(usd) };
  }
}

/** `value * bps / 10.000`, dibulatkan KE ATAS, MURNI INTEGER (sama pola applyBps PaymentsService). */
function applyBpsCeil(value: number, bps: number): number {
  const numerator = value * bps;
  if (!Number.isSafeInteger(numerator)) {
    throw noEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      SHIPPING_ERROR_CODE.COST_OVERFLOW,
      'Perhitungan ongkir melampaui batas bilangan bulat aman.',
    );
  }
  const remainder = numerator % BPS_DENOMINATOR;
  const quotient = (numerator - remainder) / BPS_DENOMINATOR;
  return remainder === 0 ? quotient : quotient + 1;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Periksa respons burn (HTTP 200, ARRAY TELANJANG, kegagalan di depan) dan kembalikan alasan
 * kegagalan PERTAMA — atau null bila SEMUA leg mendarat.
 *
 * Aturan dari dokumen CC:
 *  - "Inspect every element — a 200 with a non-null error on any element means that leg did not land."
 *  - "Re-posting the identical body is safe, but legs already recorded come back as
 *    { error: 'Duplicate transaction result' }. Do not read that as a failure."
 * Bentuk yang tidak dikenal (bukan array, array kosong, elemen bukan objek, `error` bukan
 * string/null) SENGAJA dihitung gagal: jalur ini sudah PASCA-danai, jadi ambiguitas harus
 * memicu penyelesaian manual, bukan diam-diam dianggap sukses.
 */
/**
 * Apakah nilai `delistErrors` benar-benar BERISI sesuatu? Kunci yang ada tapi kosong/null
 * (`[]`, `{}`, string kosong, `null`) atau bertipe aneh (number/boolean) TIDAK membuktikan
 * apa pun -> fail-closed: dihitung TIDAK terverifikasi, baris tetap lewat jalur indeterminate.
 */
function hasDelistErrorContent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return false;
}

/**
 * Kenali DUA kegagalan burn yang menurut DOKUMEN CC berarti NOL kartu terbakar — satu-satunya
 * kondisi di mana klaim BURN_SUBMITTED boleh dilepas balik ke FUNDED:
 *   - 403 "Transaction was not issued by this server" -> "Nothing recognised — you sent nothing,
 *     only de-list legs, or an expired batch." (kasus normal: batch 15 menit lewat)
 *   - 409 yang membawa `delistErrors` -> "A de-list leg failed. Nothing was burned."
 *
 * CARA MEMBACANYA SENGAJA BERBEDA:
 *
 *  403 -> DARI PESAN. Kalimat "Transaction was not issued by this server" memang datang di body
 *  error CC dan selamat sampai ke pesan bentukan klien ("CollectorCrypt Shipping POST <path>
 *  gagal (HTTP 403): <pesan CC>"). Status ikut dicek lewat `(HTTP 403)` karena kelas
 *  exception-nya tidak membedakan (klien memetakan 403 CC -> UnauthorizedException/401).
 *
 *  409 -> DARI SINYAL TERSTRUKTUR, TIDAK PERNAH dari pesan. `delistErrors` adalah KUNCI JSON,
 *  bukan kalimat: pada body bergaya Nest ({"statusCode":409,"message":"De-list failed",
 *  "error":"Conflict","delistErrors":[...]}) klien hanya mengambil `message` -> "De-list failed"
 *  dan nama kuncinya HILANG; pemotongan 300 char bisa membuangnya juga. Karena itu dipakai meta
 *  yang DILAMPIRKAN klien ke exception (CC_SHIPPING_ERROR_META, lihat cc-shipping.types.ts):
 *  status CC ASLI + apakah body benar-benar objek JSON + apakah kunci `delistErrors` benar-benar
 *  ada + isinya.
 *
 * FAIL-CLOSED di SETIAP titik. Meta tidak ada (error bukan dari klien ini / bentuk meta tak
 * dikenal), body bukan objek JSON (non-JSON, array, skalar), kunci tidak ada, atau isinya
 * kosong/aneh -> null, dan pemanggil memakai jalur INDETERMINATE PASCA-danai yang LAMA, apa
 * adanya. 409 yang TIDAK terverifikasi TIDAK PERNAH dibaca sebagai "tidak ada yang terbakar".
 * Jadi 403 LAIN, 409 LAIN ("awaiting card payment confirmation"), time-out, 5xx, dan error tak
 * dikenal tetap diperlakukan seperti sebelumnya.
 */
function documentedNothingBurned(err: unknown): string | null {
  const message = err instanceof Error ? err.message : '';
  if (
    message.includes('(HTTP 403)') &&
    message.includes(CC_BURN_NOT_ISSUED_BY_SERVER)
  ) {
    return (
      `CC 403 "${CC_BURN_NOT_ISSUED_BY_SERVER}" — batch tidak dikenali/kedaluwarsa; ` +
      'dokumen CC: tidak ada yang terbakar'
    );
  }

  const meta = readCcShippingErrorMeta(err);
  if (
    meta !== null &&
    meta.status === 409 &&
    meta.jsonBody &&
    meta.delistErrorsPresent &&
    hasDelistErrorContent(meta.delistErrors)
  ) {
    return (
      `CC 409 dengan kunci ${CC_SHIPPING_DELIST_ERRORS_KEY} di body error — leg de-list gagal; ` +
      'dokumen CC: "Nothing was burned"'
    );
  }
  return null;
}

function firstBurnLegFailure(res: CcBurnResponse): string | null {
  if (!Array.isArray(res)) {
    return 'respons burn CC bukan array (kontrak: HTTP 200 + array telanjang)';
  }
  if (res.length === 0) {
    return 'respons burn CC berupa array KOSONG — tidak ada leg yang tercatat';
  }
  for (const entry of res as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      return 'ada elemen respons burn yang bukan objek';
    }
    const { error } = entry as CcBurnResultEntry;
    // HANYA `error === null` yang berarti leg itu MENDARAT — dokumen: "a 200 with a non-null error
    // on any element means that leg did not land". Plus satu-satunya pengecualian yang dokumennya
    // sebut: literal PERSIS "Duplicate transaction result".
    if (error === null) continue;
    if (error === CC_BURN_DUPLICATE_ERROR) continue;
    // Sisanya AMBIGU dan ini keputusan PASCA-danai -> ambiguitas dibaca sebagai GAGAL.
    // `undefined` = kunci `error` HILANG (bukan "null" yang dijanjikan kontrak); '' = string kosong.
    if (error === undefined) {
      return 'ada elemen respons burn TANPA field error (kunci hilang) — ambigu, dihitung GAGAL';
    }
    if (typeof error !== 'string') {
      return 'ada elemen respons burn dengan field error bertipe tak dikenal';
    }
    if (error === '') {
      return 'ada elemen respons burn dengan field error STRING KOSONG — ambigu, dihitung GAGAL';
    }
    return error.slice(0, ERROR_MAX);
  }
  return null;
}

/**
 * Ambil `transactionId` pertama yang mendarat (disimpan sebagai burnSignature — jejak, bukan
 * sumber kebenaran). Dokumen: respons burn TIDAK punya `id`/`status`/`transactionUrls`; yang ada
 * hanya transactionId/transactionUrl per elemen. Dipanggil HANYA setelah firstBurnLegFailure null.
 */
function firstLandedTransactionId(res: CcBurnResponse): string | null {
  for (const entry of res) {
    if (
      entry &&
      typeof entry === 'object' &&
      isNonEmptyString(entry.transactionId)
    ) {
      return entry.transactionId;
    }
  }
  return null;
}

/**
 * Petakan status shipment CC → status redemption Hoshi. null = tak dikenal (abaikan).
 * Dokumen hanya mengenal EMPAT status: Pending (diterima) · Shipped · Delivered · Cancelled —
 * status lain di luar daftar itu tidak ditebak, cukup diabaikan (tracking tetap ditulis, status
 * tidak pernah mundur).
 */
function mapCcShipmentStatus(
  status: CcShipmentStatus | string,
): RedemptionStatus | null {
  switch (status) {
    case 'Pending':
      // "accepted" — belum bergerak; setara BURN_SUBMITTED, jadi bukan status yang memajukan.
      return RedemptionStatus.BURN_SUBMITTED;
    case 'Shipped':
      return RedemptionStatus.IN_TRANSIT;
    case 'Delivered':
      return RedemptionStatus.DELIVERED;
    case 'Cancelled':
      return RedemptionStatus.SHIP_FAILED_POST_BURN;
    default:
      return null;
  }
}
