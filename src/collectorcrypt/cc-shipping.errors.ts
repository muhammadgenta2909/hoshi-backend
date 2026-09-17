import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * KONTRAK ERROR JALUR KIRIM FISIK (CC Vault Shipping) — dibaca MESIN, bukan manusia.
 *
 * MASALAH yang ini pecahkan: dulu kegagalan PASCA-danai (`ShippingPostFundError`) adalah `Error`
 * biasa, jadi Nest mengembalikannya sebagai HTTP 500 "Internal server error", sementara kegagalan
 * yang AMAN DIULANG (`ShippingBurnRetryableError`) adalah 409. Frontend tidak punya cara
 * membedakan "tanda tangani lagi, kartumu aman" dari "uang sudah pindah dan kami TIDAK TAHU
 * apakah kartumu sudah dibakar" — lalu menampilkan tombol ulangi untuk KEDUANYA.
 *
 * Sekarang SETIAP kegagalan di jalur ini membawa body yang bentuknya tetap:
 *
 *   { statusCode, error, code, message, stage, retryable, redemptionId? }
 *
 * `code`  = string STABIL (jangan pernah diubah/di-reuse; tambah yang baru kalau perlu).
 * `stage` = DI MANA UANGNYA saat error ini terbit. Ini field yang WAJIB dipakai UI/ops untuk
 *           bercabang — BUKAN teks pesan, BUKAN status HTTP saja.
 *
 * ATURAN YANG TIDAK BOLEH DILANGGAR: `stage`/`retryable` TIDAK PERNAH BOLEH MELEBIH-LEBIHKAN
 * KEAMANAN. `FUNDED` (= "silakan tanda tangan lagi") hanya boleh terbit di tempat yang BENAR-BENAR
 * TERBUKTI barisnya duduk di FUNDED — klaim atomiknya tidak pernah diambil, atau dilepas balik dan
 * pelepasan itu terkonfirmasi (updateMany count === 1). Apa pun yang tidak terbukti WAJIB jatuh ke
 * `POST_FUND` atau `UNKNOWN`.
 */

/** Di mana uang treasury berada saat error terbit. Fail-closed: kalau ragu → UNKNOWN. */
export const SHIPPING_STAGE = {
  /**
   * Panggilan ini DITOLAK tanpa menyentuh state apa pun dan tanpa menggerakkan dana — gerbang
   * fitur mati, kepemilikan salah, status salah, input kosong, atau CC/konfigurasi tak bisa
   * dipakai. SENGAJA TIDAK menyatakan apa-apa tentang posisi uang redemption-nya (helper yang
   * melemparnya dipakai bersama oleh jalur pra-danai DAN pasca-danai). Aman dicoba lagi setelah
   * penyebabnya diperbaiki; BUKAN izin untuk me-refund.
   */
  NO_EFFECT: 'NO_EFFECT',
  /**
   * NOL USDC treasury pernah bergerak untuk redemption ini. Aman diulang dari awal, dan ongkir
   * Rupiah-nya masih aman di-refund (refundSafe baris tetap true).
   */
  PRE_FUND: 'PRE_FUND',
  /**
   * USDC ongkir SUDAH ada di wallet user (refundSafe=false, JANGAN refund Rupiah), TAPI barisnya
   * TERBUKTI masih/kembali di FUNDED dan burn TIDAK pernah dieksekusi CC. User boleh minta
   * transaksi baru (re-prepare) lalu tanda tangan lagi.
   */
  FUNDED: 'FUNDED',
  /**
   * USDC sudah/mungkin pindah DAN tidak ada jalan maju OTOMATIS untuk user. JANGAN auto-refund,
   * JANGAN suruh user tanda tangan ulang — butuh manusia (cek ke CollectorCrypt).
   *
   * DUA KELUARGA memakai stage ini, dan keduanya jatuh ke keputusan operasional yang SAMA:
   *  (a) HASIL BURN TIDAK DIKETAHUI — baris tersangkut (FUNDING/BURN_SUBMITTED).
   *  (b) B3 — HASIL BURN DIKETAHUI (nol terbakar, baris TETAP FUNDED) tapi mengulang TIDAK BISA
   *      menolong: ongkir CC melewati plafon dari yang SUDAH didanai (COST_EXCEEDS_FUNDED, dan
   *      COST_EXCEEDS_PAID ketika dilempar dari jalur pasca-danai). Menandainya FUNDED berarti
   *      "silakan tanda tangan lagi", dan itu LOOP TAK BERUJUNG — harga CC tidak turun karena
   *      user menandatangani ulang.
   * Yang membedakan keduanya adalah `code`; `stage`-nya sengaja sama. Untuk (b) stage ini
   * MELEBIHKAN ketidakpastian (kami tahu nol kartu terbakar) — arah yang DIBOLEHKAN: aturannya
   * melarang MELEBIH-LEBIHKAN KEAMANAN, bukan melarang lebih hati-hati.
   */
  POST_FUND: 'POST_FUND',
  /**
   * Tidak bisa dipastikan. Default FAIL-CLOSED untuk apa pun yang tidak diklasifikasikan secara
   * sadar. Perlakukan seperti POST_FUND: jangan refund, jangan ulangi otomatis.
   */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ShippingErrorStage =
  (typeof SHIPPING_STAGE)[keyof typeof SHIPPING_STAGE];

/**
 * Kode error STABIL. Nilai string-nya adalah KONTRAK dengan frontend — jangan diubah, jangan
 * dipakai ulang untuk makna lain.
 */
export const SHIPPING_ERROR_CODE = {
  /* ── gerbang / kepemilikan ── */
  DISABLED: 'SHIPPING_DISABLED',
  REDEMPTION_NOT_FOUND: 'REDEMPTION_NOT_FOUND',
  REDEMPTION_NOT_YOURS: 'REDEMPTION_NOT_YOURS',

  /* ── jalur RECORD-ONLY (POST /redemptions) — nol on-chain, nol dana ── */
  /** Kartu yang diminta bukan hasil pack / bukan pembelian user. */
  CARD_NOT_YOURS: 'REDEMPTION_CARD_NOT_YOURS',
  ADDRESS_NOT_FOUND: 'REDEMPTION_ADDRESS_NOT_FOUND',
  /** B4: sudah ada redemption IN-FLIGHT untuk kartu ini (cek API atau unique index DB). */
  ALREADY_ACTIVE: 'REDEMPTION_ALREADY_ACTIVE',
  /**
   * B1: status baris ini TIDAK boleh dibatalkan user. Batal-sendiri HANYA sah selama NOL uang
   * bergerak (REQUESTED, atau AWAITING_PAYMENT yang pembayarannya belum mendarat). READY_TO_FUND
   * ke atas = Rupiah sudah lunas / USDC sudah pindah -> penyelesaiannya lewat admin, bukan user.
   */
  CANCEL_NOT_ALLOWED: 'REDEMPTION_CANCEL_NOT_ALLOWED',
  /**
   * B1: ada order ongkir yang pembayarannya SUDAH mendarat (PAID/FULFILLING/FULFILLED/REFUND_DUE)
   * untuk redemption ini -> user tidak boleh membatalkannya sendiri; itu keputusan refund (admin).
   */
  CANCEL_PAYMENT_LANDED: 'REDEMPTION_CANCEL_PAYMENT_LANDED',
  /** B1: baris berpindah status antara baca dan tulis berpagar -> NOL baris dibatalkan. */
  CANCEL_RACE: 'REDEMPTION_CANCEL_RACE',
  /** SIWS untuk wallet yang bukan milik user login. */
  SIWS_WALLET_MISMATCH: 'SHIPPING_SIWS_WALLET_MISMATCH',

  /* ── PRA-DANAI: nol dana bergerak, aman diulang dari awal ── */
  NOT_READY_TO_FUND: 'SHIPPING_NOT_READY_TO_FUND',
  ADDRESS_STATE_REQUIRED: 'SHIPPING_ADDRESS_STATE_REQUIRED',
  CC_ADDRESS_INVALID: 'SHIPPING_CC_ADDRESS_INVALID',
  CC_PREPARE_INVALID: 'SHIPPING_CC_PREPARE_INVALID',
  CC_COST_INVALID: 'SHIPPING_CC_COST_INVALID',
  COST_OVERFLOW: 'SHIPPING_COST_OVERFLOW',
  PAID_ORDER_NOT_FOUND: 'SHIPPING_PAID_ORDER_NOT_FOUND',
  COST_EXCEEDS_PAID: 'SHIPPING_COST_EXCEEDS_PAID',
  FUND_FAILED_PRE_BROADCAST: 'SHIPPING_FUND_FAILED_PRE_BROADCAST',

  /* ── baris FUNDED, tidak ada dana baru bergerak ── */
  REPREPARE_NOT_FUNDED: 'SHIPPING_REPREPARE_NOT_FUNDED',
  COST_EXCEEDS_FUNDED: 'SHIPPING_COST_EXCEEDS_FUNDED',
  NOT_PREPARED: 'SHIPPING_NOT_PREPARED',
  NO_SIGNED_TRANSACTIONS: 'SHIPPING_NO_SIGNED_TRANSACTIONS',
  BURN_NOT_FUNDED: 'SHIPPING_BURN_NOT_FUNDED',

  /* ── AMAN DIULANG: baris TERBUKTI di FUNDED, CC tidak membakar apa pun ── */
  BURN_RETRYABLE: 'SHIPPING_BURN_RETRYABLE',
  /** B2: set transaksi yang disubmit BUKAN set terakhir yang kita terbitkan (sesi modal basi). */
  BURN_STALE_SESSION: 'SHIPPING_BURN_STALE_SESSION',

  /* ── TIDAK PASTI / butuh manusia ── */
  /** Klaim burn sedang/sudah diambil pihak lain — kami tidak bisa memastikan hasilnya. */
  BURN_ALREADY_SUBMITTED: 'SHIPPING_BURN_ALREADY_SUBMITTED',
  /** Pendanaan sedang/sudah diproses sesi lain — jangan diulang, cek status. */
  FUNDING_IN_PROGRESS: 'SHIPPING_FUNDING_IN_PROGRESS',
  /** Dokumen CC menjamin nol kartu terbakar, TAPI pelepasan baris ke FUNDED gagal → baris nyangkut. */
  BURN_RELEASE_FAILED: 'SHIPPING_BURN_RELEASE_FAILED',
  /** Uang sudah/mungkin pindah, hasil burn TIDAK DIKETAHUI. */
  POST_FUND_INDETERMINATE: 'SHIPPING_POST_FUND_INDETERMINATE',
  /** CC menjawab 200 tapi ada leg yang TIDAK mendarat. Uang sudah pindah. */
  BURN_LEG_FAILED: 'SHIPPING_BURN_LEG_FAILED',

  /* ── SIWS ── */
  SIWS_NOT_CONFIGURED: 'SHIPPING_SIWS_NOT_CONFIGURED',
  SIWS_DOMAIN_INVALID: 'SHIPPING_SIWS_DOMAIN_INVALID',

  /* ── dicap oleh filter, bukan oleh throw-site ── */
  /** HttpException sah yang belum sempat diberi kode sendiri (validasi DTO, throttler, dll). */
  UNCLASSIFIED: 'SHIPPING_UNCLASSIFIED_ERROR',
  /** Bukan HttpException sama sekali — bug/kejutan. TIDAK menyatakan apa pun soal keamanan uang. */
  UNEXPECTED: 'SHIPPING_UNEXPECTED_ERROR',
} as const;

export type ShippingErrorCode =
  (typeof SHIPPING_ERROR_CODE)[keyof typeof SHIPPING_ERROR_CODE];

/** Body error jalur kirim fisik. Bentuknya TETAP untuk semua cabang. */
export interface ShippingErrorBody {
  statusCode: number;
  /** Frasa Nest (Bad Request / Conflict / ...) — kompatibilitas dengan error Nest lain. */
  error: string;
  code: ShippingErrorCode;
  message: string;
  stage: ShippingErrorStage;
  /**
   * true HANYA kalau user boleh mencoba lagi TANPA campur tangan manusia:
   *  - PRE_FUND  → ulangi dari awal,
   *  - FUNDED    → minta transaksi baru (re-prepare) lalu tanda tangan lagi.
   * POST_FUND/UNKNOWN SELALU false.
   */
  retryable: boolean;
  /** Diisi untuk cabang yang butuh manusia supaya user bisa menyebutnya ke support. */
  redemptionId?: string;
}

const REASON: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** `retryable` DITURUNKAN dari stage — tidak bisa diset manual, jadi tidak bisa dilebih-lebihkan. */
function retryableFor(stage: ShippingErrorStage): boolean {
  return (
    stage === SHIPPING_STAGE.NO_EFFECT ||
    stage === SHIPPING_STAGE.PRE_FUND ||
    stage === SHIPPING_STAGE.FUNDED
  );
}

/** Rakit body kontrak. */
export function shippingErrorBody(args: {
  status: number;
  code: ShippingErrorCode;
  message: string;
  stage: ShippingErrorStage;
  redemptionId?: string;
}): ShippingErrorBody {
  return {
    statusCode: args.status,
    error: REASON[args.status] ?? 'Error',
    code: args.code,
    message: args.message,
    stage: args.stage,
    retryable: retryableFor(args.stage),
    ...(args.redemptionId ? { redemptionId: args.redemptionId } : {}),
  };
}

/**
 * HttpException dengan body kontrak. Dipakai semua throw-site jalur kirim fisik yang BUKAN
 * ShippingBurnRetryableError / ShippingPostFundError (dua kelas itu punya makna uang sendiri dan
 * tetap hidup di cc-shipping.service.ts).
 *
 * KELAS Nest BAWAAN DIPERTAHANKAN (BadRequestException / NotFoundException / ...), bukan
 * HttpException telanjang: semuanya menerima OBJEK sebagai body, jadi `code`/`stage` bisa
 * ditempelkan TANPA mengubah tipe error yang dilihat pemanggil & test (`instanceof` tetap benar,
 * dan `err.message` tetap kalimat kita karena Nest mengambil `message` dari objeknya).
 */
export function shippingError(args: {
  status: number;
  code: ShippingErrorCode;
  message: string;
  stage: ShippingErrorStage;
  redemptionId?: string;
}): HttpException {
  const body = shippingErrorBody(args);
  // Angka mentah, bukan anggota enum HttpStatus: `status` di sini datang juga dari
  // `err.getStatus()` (number biasa), jadi perbandingan enum akan menyesatkan.
  switch (args.status) {
    case 400:
      return new BadRequestException(body);
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 422:
      return new UnprocessableEntityException(body);
    case 503:
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, args.status);
  }
}

/**
 * Pintasan: ditolak TANPA menyentuh apa pun. Dipakai helper yang hidup di jalur pra-danai DAN
 * pasca-danai sekaligus (assertEnabled, ownedRedemption, ensureCcShippingAddress, toEstimate, ...)
 * — karena itu ia TIDAK menyatakan posisi uang.
 */
export function noEffectError(
  status: number,
  code: ShippingErrorCode,
  message: string,
  redemptionId?: string,
): HttpException {
  return shippingError({
    status,
    code,
    message,
    stage: SHIPPING_STAGE.NO_EFFECT,
    redemptionId,
  });
}

/** Pintasan: CC tak bisa dipakai di titik yang terbukti PRA-danai (sebelum fundUsdc). */
export function preFundUnavailable(
  code: ShippingErrorCode,
  message: string,
): HttpException {
  return shippingError({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    code,
    message,
    stage: SHIPPING_STAGE.PRE_FUND,
  });
}

/**
 * Apakah body sebuah exception SUDAH memakai kontrak ini? Dipakai filter supaya tidak menimpa
 * kode yang sudah dipilih throw-site.
 */
export function isShippingErrorBody(body: unknown): body is ShippingErrorBody {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Partial<ShippingErrorBody>;
  return typeof b.code === 'string' && typeof b.stage === 'string';
}
