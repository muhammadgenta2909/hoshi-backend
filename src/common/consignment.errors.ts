import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * KONTRAK ERROR JALUR TITIPAN (konsinyasi) — dibaca MESIN, bukan manusia.
 *
 * BENTUKNYA SENGAJA IDENTIK dengan kontrak P2P (`p2p.errors.ts`) dan kontrak kirim fisik
 * (`cc-shipping.errors.ts`):
 *
 *   { statusCode, error, code, message, stage, retryable, listingId?, consignmentId? }
 *
 * supaya frontend memakai percabangan yang SAMA (`body.code`, `body.stage`) untuk ketiganya.
 *
 * KENAPA NAMESPACE KODENYA SENDIRI (`CONSIGNMENT_*`) DAN BUKAN MEMAKAI ULANG `P2P_*`. Kartu
 * titipan MIRIP listing P2P bagi kode yang membaca bentuk (`sellerId != null`), dan itulah
 * justru bahayanya. Kalau penolakannya memakai kode P2P, frontend akan menawarkan pemulihan P2P:
 * "pajang ulang supaya kartunya dititipkan ke escrow" — nasihat yang TIDAK BISA BERHASIL untuk
 * kartu yang tidak punya aset on-chain sama sekali dan memang tidak akan pernah punya. Kode yang
 * berbohong tentang jalur pemulihannya lebih buruk daripada tidak ada kode.
 *
 * SEMUA penolakan di file ini terbit SEBELUM mint-request IDRX dibuat, jadi stage-nya NO_EFFECT:
 * NOL Rupiah diambil. Itu janji setiap call-site: penolakan titipan yang terbit SESUDAH uang
 * bergerak WAJIB memakai stage lain (fail-closed), bukan menumpang NO_EFFECT.
 */

/** Di mana uang pembeli berada saat error terbit. Fail-closed: kalau ragu → UNKNOWN. */
export const CONSIGNMENT_STAGE = {
  /** Ditolak TANPA menyentuh apa pun dan TANPA menerbitkan tagihan. NOL Rupiah diambil. */
  NO_EFFECT: 'NO_EFFECT',
  /** Tidak bisa dipastikan. Default fail-closed. Tidak dipakai jalur ini hari ini. */
  UNKNOWN: 'UNKNOWN',
} as const;

export type ConsignmentErrorStage =
  (typeof CONSIGNMENT_STAGE)[keyof typeof CONSIGNMENT_STAGE];

/** Kode error STABIL. Nilai string-nya KONTRAK dengan frontend. */
export const CONSIGNMENT_ERROR_CODE = {
  /**
   * Kartu titipan ini TIDAK SEDANG berada di tangan Hoshi sekarang: entah serah-terimanya belum
   * pernah tercatat (`custodyAcceptedAt` null), entah kartunya sudah keluar (`custodyReleasedAt`
   * terisi — ditarik pemilik, dikirim ke pembeli, atau hilang).
   *
   * BAGI PEMBELI: tidak ada yang bisa dibeli, dan tidak ada Rupiah yang diambil.
   * BAGI UI: JANGAN tawarkan "pajang ulang" — tidak ada aset on-chain yang bisa dititipkan.
   */
  NOT_IN_CUSTODY: 'CONSIGNMENT_NOT_IN_CUSTODY',
  /**
   * Aksi ini memang tidak berlaku untuk kartu TITIPAN (menawar, memajang ulang, escrow, ubah
   * harga lewat rute penjual, batalkan lewat rute penjual). `message` menyebut rute yang benar.
   */
  UNSUPPORTED_ACTION: 'CONSIGNMENT_UNSUPPORTED_ACTION',
  /** Perpindahan status yang diminta tidak sah dari status sekarang (klaim atomik kalah/ditolak). */
  BAD_TRANSITION: 'CONSIGNMENT_BAD_TRANSITION',
  /**
   * Syarat BUKTI belum terpenuhi saat menerima custody: foto depan/belakang (dan foto sertifikat
   * bila ada nomor sertifikat), catatan kondisi, lokasi penyimpanan.
   *
   * Menerima kartu orang lain TANPA foto adalah kegagalan yang membuat SETIAP sengketa nanti
   * tidak bisa dimenangkan oleh SIAPA PUN — termasuk oleh pemiliknya.
   */
  EVIDENCE_REQUIRED: 'CONSIGNMENT_EVIDENCE_REQUIRED',
} as const;

export type ConsignmentErrorCode =
  (typeof CONSIGNMENT_ERROR_CODE)[keyof typeof CONSIGNMENT_ERROR_CODE];

export interface ConsignmentErrorBody {
  statusCode: number;
  error: string;
  code: ConsignmentErrorCode;
  message: string;
  stage: ConsignmentErrorStage;
  /** DITURUNKAN dari stage — tidak bisa diset manual, jadi tidak bisa dilebih-lebihkan. */
  retryable: boolean;
  listingId?: string;
  consignmentId?: string;
}

const REASON: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  503: 'Service Unavailable',
};

export function consignmentErrorBody(args: {
  status: number;
  code: ConsignmentErrorCode;
  message: string;
  stage: ConsignmentErrorStage;
  listingId?: string;
  consignmentId?: string;
}): ConsignmentErrorBody {
  return {
    statusCode: args.status,
    error: REASON[args.status] ?? 'Error',
    code: args.code,
    message: args.message,
    stage: args.stage,
    retryable: args.stage === CONSIGNMENT_STAGE.NO_EFFECT,
    ...(args.listingId ? { listingId: args.listingId } : {}),
    ...(args.consignmentId ? { consignmentId: args.consignmentId } : {}),
  };
}

/**
 * HttpException dengan body kontrak. KELAS Nest BAWAAN DIPERTAHANKAN, persis seperti `p2pError`:
 * `instanceof BadRequestException` tetap benar untuk pemanggil & test lama.
 */
export function consignmentError(args: {
  status: number;
  code: ConsignmentErrorCode;
  message: string;
  stage?: ConsignmentErrorStage;
  listingId?: string;
  consignmentId?: string;
}): HttpException {
  const body = consignmentErrorBody({
    ...args,
    stage: args.stage ?? CONSIGNMENT_STAGE.NO_EFFECT,
  });
  switch (args.status) {
    case 400:
      return new BadRequestException(body);
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 503:
      return new ServiceUnavailableException(body);
    default:
      return new HttpException(body, args.status);
  }
}
