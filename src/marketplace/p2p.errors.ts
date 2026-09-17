import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * KONTRAK ERROR JALUR JUAL-BELI ANTAR USER (Flow B / P2P) — dibaca MESIN, bukan manusia.
 *
 * BENTUKNYA SENGAJA IDENTIK dengan kontrak jalur kirim fisik (cc-shipping.errors.ts):
 *
 *   { statusCode, error, code, message, stage, retryable, listingId? }
 *
 * supaya frontend bisa memakai percabangan yang SAMA (`body.code`, `body.stage`) untuk kedua
 * jalur. Yang beda hanya kosakata kodenya — kode `SHIPPING_*` berbicara tentang di mana USDC
 * ongkir berada, dan memakai ulang kosakata itu di sini akan berbohong.
 *
 * MASALAH yang kontrak ini pecahkan (bug A): `fulfilUserListing` memeriksa HOSHI_P2P_ENABLED dan
 * menolak menyelesaikan penjualan antar user saat flag mati — TAPI pemeriksaan itu berjalan
 * SESUDAH pembeli membayar. `createListingOrder`/`createOfferOrder` tidak memeriksanya sama
 * sekali, jadi invoice terbit, Rupiah SUNGGUHAN mendarat di treasury, lalu barulah ditolak →
 * REFUND_DUE + refund manual, padahal tidak ada perkakas refund di repo ini. Jalur kirim fisik
 * sudah melakukannya dengan benar (CcShippingService.assertEnabled dipanggil di baris pertama
 * createShippingOrder, SEBELUM tagihan dibuat); file ini membawa pola itu ke jalur P2P.
 *
 * `code`  = string STABIL. Jangan diubah, jangan dipakai ulang untuk makna lain.
 * `stage` = DI MANA UANGNYA saat error terbit. Semua penolakan di file ini terbit SEBELUM
 *           mint-request IDRX dibuat, jadi stage-nya NO_EFFECT: nol Rupiah diambil, tidak ada
 *           yang perlu di-refund. Itu janji yang harus dijaga oleh setiap call-site: kalau suatu
 *           saat ada penolakan P2P yang terbit SESUDAH uang bergerak, ia WAJIB memakai stage lain
 *           (fail-closed), bukan menumpang NO_EFFECT.
 */

/** Di mana uang pembeli berada saat error terbit. Fail-closed: kalau ragu → UNKNOWN. */
export const P2P_STAGE = {
  /**
   * Ditolak TANPA menyentuh state apa pun dan TANPA menerbitkan tagihan. NOL Rupiah diambil,
   * jadi tidak ada utang refund yang lahir dari panggilan ini. Aman dicoba lagi setelah
   * penyebabnya diperbaiki (dan "diperbaiki" di sini biasanya berarti: operator menyalakan
   * fitur, atau penjual memajang ulang kartunya).
   */
  NO_EFFECT: 'NO_EFFECT',
  /**
   * Tidak bisa dipastikan. Default FAIL-CLOSED untuk apa pun yang tidak diklasifikasikan secara
   * sadar: jangan refund otomatis, jangan ulangi otomatis.
   */
  UNKNOWN: 'UNKNOWN',
} as const;

export type P2pErrorStage = (typeof P2P_STAGE)[keyof typeof P2P_STAGE];

/** Kode error STABIL. Nilai string-nya KONTRAK dengan frontend. */
export const P2P_ERROR_CODE = {
  /**
   * Jual-beli antar user belum diaktifkan di deployment ini (HOSHI_P2P_ENABLED bukan 'true' dan
   * bukan mode mock). Frontend WAJIB bercabang ke sini alih-alih ke pesan generik: ini satu-satunya
   * cara pembeli tahu bahwa tombol bayar tidak akan pernah berhasil, SEBELUM ia membayar.
   */
  DISABLED: 'P2P_DISABLED',
  /**
   * B — listing USER ini TIDAK escrow-backed, jadi escrow tidak memegang apa pun untuk
   * diserahkan; menerbitkan tagihan untuknya berarti menjamin refund.
   *
   * SATU kode, DUA sebab, dan frontend WAJIB membedakannya lewat `ccNftAddress` di DTO
   * listing-nya — karena tindakan pemulihannya berlawanan:
   *   • ccNftAddress ADA  → kartunya tidak pernah dititipkan (listing lahir sebelum jalur P2P
   *     real dinyalakan). Pemulihan: SATU aksi `POST /marketplace/:id/relist` → listing pindah
   *     ke PENDING_ESCROW dan penjual diminta menandatangani transfer→escrow.
   *   • ccNftAddress NULL → listing dibuat lewat `POST /marketplace` tanpa fromPackMemo, jadi
   *     tidak ada aset on-chain untuk dititipkan SAMA SEKALI. relist akan menjawab kode ini
   *     lagi; satu-satunya tindakan yang benar adalah `POST /marketplace/:id/cancel`.
   * Kalimat `message` sudah menyebut yang mana, jadi UI yang menampilkannya apa adanya tetap
   * benar — percabangan hanya untuk memilih TOMBOL yang ditawarkan.
   */
  LISTING_NOT_ESCROWED: 'P2P_LISTING_NOT_ESCROWED',
  /**
   * KEBALIKAN dari LISTING_NOT_ESCROWED, dan karena itu KODE TERSENDIRI — memakai ulang kode di
   * atas untuk keadaan ini akan berbohong ke frontend (ia menawarkan tombol "pajang ulang" /
   * "batalkan", dan keduanya SALAH di sini).
   *
   * Artinya: kartu listing ini MASIH DIPEGANG wallet escrow Hoshi (atau kami belum bisa
   * membuktikan sebaliknya), jadi pemiliknya tidak bisa memajangnya ulang: ia bukan pemilik
   * on-chain-nya saat ini, jadi ia tidak bisa menandatangani penitipan baru — dan memajangnya
   * seolah-olah kartunya ada di tangannya berarti menjanjikan penyerahan yang belum tentu bisa
   * kami penuhi.
   *
   * Yang HARUS dilakukan: hubungi support. Baris seperti ini muncul di dashboard admin (daftar
   * `stranded`) dan punya aksi pemulihan tersendiri (`recoverEscrowToSeller`) yang mengembalikan
   * kartunya ke penjual lebih dulu. Sesudah kartunya kembali, memajang ulang berjalan normal.
   */
  LISTING_ESCROW_HELD: 'P2P_LISTING_ESCROW_HELD',
  /** C — wallet escrow tidak bisa menanggung gas penitipan saat ini (saldo/plafon/RPC). */
  SPONSOR_UNAVAILABLE: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
  /** C — plafon sponsor gas (per-penjual atau global 24 jam) sedang penuh. */
  SPONSOR_QUOTA: 'P2P_ESCROW_SPONSOR_QUOTA',
} as const;

export type P2pErrorCode = (typeof P2P_ERROR_CODE)[keyof typeof P2P_ERROR_CODE];

/** Body error jalur P2P. Bentuknya TETAP untuk semua cabang. */
export interface P2pErrorBody {
  statusCode: number;
  /** Frasa Nest (Bad Request / Conflict / ...) — kompatibilitas dengan error Nest lain. */
  error: string;
  code: P2pErrorCode;
  message: string;
  stage: P2pErrorStage;
  /**
   * true HANYA kalau panggilan ini boleh diulang tanpa risiko uang: NO_EFFECT saja.
   * DITURUNKAN dari stage — tidak bisa diset manual, jadi tidak bisa dilebih-lebihkan.
   *
   * BACA SEBAGAI: "nol Rupiah diambil, mengulang tidak akan menggandakan apa pun" — BUKAN
   * "mengulang sekarang akan berhasil". Untuk P2P_DISABLED, mengulang baru berhasil setelah
   * operator menyalakan fiturnya.
   */
  retryable: boolean;
  /** Diisi supaya user bisa menyebut listing-nya ke support tanpa menyalin URL. */
  listingId?: string;
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

function retryableFor(stage: P2pErrorStage): boolean {
  return stage === P2P_STAGE.NO_EFFECT;
}

/** Rakit body kontrak. */
export function p2pErrorBody(args: {
  status: number;
  code: P2pErrorCode;
  message: string;
  stage: P2pErrorStage;
  listingId?: string;
}): P2pErrorBody {
  return {
    statusCode: args.status,
    error: REASON[args.status] ?? 'Error',
    code: args.code,
    message: args.message,
    stage: args.stage,
    retryable: retryableFor(args.stage),
    ...(args.listingId ? { listingId: args.listingId } : {}),
  };
}

/**
 * HttpException dengan body kontrak. KELAS Nest BAWAAN DIPERTAHANKAN (BadRequestException /
 * ConflictException / ...) — semuanya menerima OBJEK sebagai body, jadi `code`/`stage` menempel
 * TANPA mengubah tipe error yang dilihat pemanggil & test (`instanceof` tetap benar, dan
 * `err.message` tetap kalimat kita karena Nest mengambil `message` dari objeknya).
 */
export function p2pError(args: {
  status: number;
  code: P2pErrorCode;
  message: string;
  stage: P2pErrorStage;
  listingId?: string;
}): HttpException {
  const body = p2pErrorBody(args);
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

/** Pintasan: ditolak SEBELUM tagihan terbit — nol Rupiah diambil. */
export function p2pNoEffectError(
  status: number,
  code: P2pErrorCode,
  message: string,
  listingId?: string,
): HttpException {
  return p2pError({
    status,
    code,
    message,
    stage: P2P_STAGE.NO_EFFECT,
    listingId,
  });
}

/** Apakah body sebuah exception SUDAH memakai kontrak ini? */
export function isP2pErrorBody(body: unknown): body is P2pErrorBody {
  if (body === null || typeof body !== 'object') return false;
  const b = body as Partial<P2pErrorBody>;
  return typeof b.code === 'string' && typeof b.stage === 'string';
}
