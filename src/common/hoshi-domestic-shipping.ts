import { HttpStatus, HttpException } from '@nestjs/common';
import { RedemptionStatus } from '@prisma/client';
import {
  SHIPPING_ERROR_CODE,
  SHIPPING_STAGE,
  shippingError,
  type ShippingErrorCode,
} from '../collectorcrypt/cc-shipping.errors';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ JALUR KIRIM DOMESTIK (STOK HOSHI) — kurir lokal Indonesia. BUKAN CC Vault Shipping.          ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * FAKTA PRODUK yang menjadikan jalur ini ADA: kartu stok Hoshi disimpan FISIK oleh Hoshi di
 * Indonesia — tidak dititipkan di vault CollectorCrypt. Jadi pengirimannya paket domestik biasa:
 *
 *   NOL NFT · NOL burn · NOL USDC treasury · NOL panggilan CollectorCrypt · NOL tanda tangan wallet
 *
 * Satu-satunya uang yang bergerak adalah ONGKIR RUPIAH dari user ke treasury, lewat rail invoice
 * IDRX yang SUDAH ADA (`packType='SHIPPING'`). Karena itu jalur ini secara STRUKTURAL tidak bisa
 * melahirkan kelas bahaya yang menghabiskan sepuluh putaran review di jalur CC — "uang sudah
 * pindah, burn-nya gagal, dan kami tidak tahu apakah kartunya terkirim". Di sini tidak ada
 * "uang sudah pindah" selain ongkir Rupiah, dan ongkir itu SELALU aman di-refund.
 *
 * ┌──────────── DUA JALUR TIDAK BOLEH BISA TERTUKAR. INI GERBANGNYA. ────────────────────────────┐
 * │ FAKTA PERSISTEN pembeda railnya adalah SATU kolom: `CardRedemption.listingId`.               │
 * │   • listingId NON-NULL → jalur DOMESTIK (stok Hoshi, kurir lokal).                           │
 * │   • listingId NULL     → jalur CC Vault (pack / katalog CC / P2P).                           │
 * │                                                                                              │
 * │ Kenapa kolom, bukan flag env dan bukan string `source`: ini pelajaran `escrowedAt` — gerbang │
 * │ harus membaca FAKTA YANG TERSIMPAN, bukan konfigurasi yang bisa berubah sesudah baris lahir. │
 * │ `source` TIDAK cukup: ia free-form, nullable untuk baris lama, dan baris warisan bisa        │
 * │ berbunyi 'HOSHI' padahal identitasnya alamat NFT sungguhan (jalur CC).                       │
 * │                                                                                              │
 * │ `listingId` juga IMMUTABLE: tidak ada satu pun kode yang menulisnya sesudah create. Itu yang │
 * │ membuat "baca rail lalu tulis berpagar" aman dari balapan — railnya tidak bisa berubah di    │
 * │ antara baca dan tulis. Meski begitu setiap tulisan rail-sensitif TETAP memasang railnya      │
 * │ sebagai PREDIKAT (`listingId: null` / `{ not: null }`), supaya properti itu ditegakkan DB.   │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 */

/* ───────────────────────────────── IDENTITAS KARTU ───────────────────────────────── */

/**
 * Prefix identitas kartu stok Hoshi di kolom `CardRedemption.nftAddress`.
 *
 * KENAPA ADA SENTINEL SAMA SEKALI. Kartu stok Hoshi settle DATABASE-ONLY
 * (`fulfilHoshiInventory`: "nol on-chain") — ia TIDAK punya alamat NFT, dan tidak akan pernah
 * punya. Tapi `nftAddress` adalah kolom NOT NULL dan sekaligus kunci PARTIAL UNIQUE INDEX
 * anti-dobel-redeem (`card_redemptions_active_nft_uniq`). Menuliskan identitas listing ke kolom
 * itu dengan prefix membuat gerbang konkurensi yang SUDAH TERBUKTI ITU berlaku juga untuk jalur
 * domestik — tanpa membuat kolomnya nullable (yang akan mengubah bentuk DTO ke frontend) dan
 * tanpa jalur kode anti-dobel yang kedua.
 *
 * KENAPA TIDAK MUNGKIN BENTROK dengan alamat NFT sungguhan: alfabet base58 Solana tidak memuat
 * `-` maupun `:`. Jadi tidak ada alamat Solana yang bisa menyamai bentuk di bawah, dan tidak ada
 * baris domestik yang bisa menyamai alamat Solana.
 */
export const HOSHI_LISTING_REF_PREFIX = 'hoshi-listing:';

/** Identitas kartu untuk jalur domestik: turunan MURNI dari id listing (deterministik). */
export function hoshiListingRef(listingId: string): string {
  return `${HOSHI_LISTING_REF_PREFIX}${listingId}`;
}

/** true ⇔ string ini identitas stok Hoshi (bukan alamat NFT). */
export function isHoshiListingRef(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(HOSHI_LISTING_REF_PREFIX);
}

/* ─────────────────────────────── DISKRIMINATOR RAIL ─────────────────────────────── */

/** Bentuk minimal yang dibutuhkan untuk menentukan rail sebuah baris redemption. */
export interface RedemptionRailShape {
  listingId: string | null;
}

/** true ⇔ baris ini jalur DOMESTIK (stok Hoshi, kurir lokal). Baca FAKTA, bukan flag. */
export function isDomesticRedemption(row: RedemptionRailShape): boolean {
  return row.listingId != null;
}

/**
 * Status yang BOLEH dilalui sebuah baris jalur DOMESTIK. Semuanya status yang SUDAH ADA di jalur
 * record-only — jalur ini SENGAJA tidak menambah satu pun nilai enum baru, supaya invariant
 * keterjangkauan-jalan-keluar (`redemption-exit-reachability.spec.ts`) tetap utuh tanpa driver
 * baru: REQUESTED dan AWAITING_PAYMENT sudah punya jalan keluar yang teruji, dan PACKING/SHIPPED
 * digerakkan admin (PATCH status) seperti selama ini.
 *
 *   REQUESTED        → permintaan tercatat, nol uang.
 *   AWAITING_PAYMENT → invoice ongkir Rupiah terbit, nol uang mendarat di BARIS ini.
 *   PACKING          → ongkir LUNAS; Hoshi mengemas paketnya. (Jalur CC memakai READY_TO_FUND di
 *                      titik ini — status itu berarti "siap danai USDC" dan TIDAK PERNAH BOLEH
 *                      muncul di baris domestik.)
 *   SHIPPED          → paket diserahkan ke kurir; resi diisi admin.
 *   DELIVERED        → sampai. Terminal.
 *   CANCELED         → dibatalkan. Terminal.
 */
export const DOMESTIC_ALLOWED_STATUSES: readonly RedemptionStatus[] = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.AWAITING_PAYMENT,
  RedemptionStatus.PACKING,
  RedemptionStatus.SHIPPED,
  RedemptionStatus.DELIVERED,
  RedemptionStatus.CANCELED,
];

/**
 * Status yang HANYA milik jalur CC Vault dan TIDAK BOLEH pernah tertulis di baris domestik.
 * Dienumerasi sebagai KOMPLEMEN yang dihitung, bukan didaftar tangan: status enum BARU otomatis
 * masuk daftar terlarang ini sampai seseorang sadar-sadar memasukkannya ke
 * DOMESTIC_ALLOWED_STATUSES. Diuji lengkap terhadap enum di hoshi-domestic-shipping.spec.ts.
 */
export const DOMESTIC_FORBIDDEN_STATUSES: readonly RedemptionStatus[] =
  Object.values(RedemptionStatus).filter(
    (s) => !DOMESTIC_ALLOWED_STATUSES.includes(s),
  );

/* ─────────────────────────────── KONTRAK ERROR ─────────────────────────────── */

/**
 * Kode error jalur domestik. Namespace `HOSHI_DOMESTIC_*` — TIDAK PERNAH dipakai jalur CC, dan
 * kode CC tidak pernah dipakai di sini kecuali yang memang MILIK BERSAMA jalur record-only
 * (REDEMPTION_NOT_FOUND / NOT_YOURS / ALREADY_ACTIVE / ADDRESS_NOT_FOUND / CARD_NOT_YOURS —
 * `request()` dan `cancel()` memang satu implementasi untuk kedua rail).
 */
export const DOMESTIC_ERROR_CODE = {
  /** Body POST /redemptions tidak menyebut nftAddress MAUPUN listingId (atau menyebut keduanya). */
  TARGET_REQUIRED: 'HOSHI_DOMESTIC_TARGET_REQUIRED',
  /** listingId yang disebut bukan stok Hoshi yang sellable / bukan SOLD ke pemanggil. */
  NOT_YOUR_STOCK: 'HOSHI_DOMESTIC_NOT_YOUR_STOCK',
  /** Rute domestik dipanggil untuk baris jalur CC (atau sebaliknya) — dua rail tidak boleh tertukar. */
  WRONG_RAIL: 'HOSHI_DOMESTIC_WRONG_RAIL',
  /** Baris tidak dalam status yang bisa dibuatkan tagihan ongkir. */
  NOT_BILLABLE: 'HOSHI_DOMESTIC_NOT_BILLABLE',
  /** Tarif ongkir domestik belum dikonfigurasi / nilainya tidak masuk akal. */
  RATE_UNAVAILABLE: 'HOSHI_DOMESTIC_RATE_UNAVAILABLE',
  /**
   * Alamat tujuan di LUAR jangkauan jalur domestik — hari ini artinya: negaranya bukan Indonesia
   * (atau tidak terbaca sebagai Indonesia).
   *
   * SENGAJA TERPISAH dari RATE_UNAVAILABLE. Keduanya sama-sama "ongkir tidak bisa dihitung", tapi
   * yang diperbaiki BERBEDA: RATE_UNAVAILABLE adalah kesalahan KAMI (tarif belum di-set) dan
   * jalan keluarnya support/admin; yang ini adalah data di alamat USER, dan jalan keluarnya user
   * sendiri yang membetulkan alamatnya. Meratakan keduanya akan mengirim setiap pembeli ke
   * support untuk hal yang bisa mereka benahi sendiri dalam sepuluh detik.
   */
  ADDRESS_UNSUPPORTED: 'HOSHI_DOMESTIC_ADDRESS_UNSUPPORTED',
  /** Tagihan ongkir untuk baris ini sudah/sedang diproses — jangan terbitkan yang kedua. */
  ORDER_IN_PROGRESS: 'HOSHI_DOMESTIC_ORDER_IN_PROGRESS',
} as const;

export type DomesticErrorCode =
  (typeof DOMESTIC_ERROR_CODE)[keyof typeof DOMESTIC_ERROR_CODE];

/**
 * Stage yang BOLEH dibawa error domestik — hanya dua, dan itu BUKAN kebetulan.
 *
 * `FUNDED` / `POST_FUND` / `UNKNOWN` adalah kosakata UANG TREASURY jalur CC: "USDC sudah ada di
 * wallet user", "USDC sudah/mungkin pindah dan hasil burn tak diketahui". Di jalur domestik
 * kalimat itu TIDAK PERNAH BENAR — tidak ada USDC dan tidak ada burn. Membiarkan stage itu bocor
 * ke sini akan membuat UI dan operator mengambil keputusan refund berdasarkan bahaya yang tidak
 * ada (dan, lebih buruk, MENAHAN refund ongkir yang sebenarnya wajib dibalikkan).
 *
 * Batasan ini ditegakkan TIPE (lihat `domesticError` di bawah), bukan sekadar konvensi.
 */
export type DomesticErrorStage =
  | typeof SHIPPING_STAGE.NO_EFFECT
  | typeof SHIPPING_STAGE.PRE_FUND;

/**
 * Error jalur domestik dengan body kontrak yang SAMA bentuknya (statusCode/error/code/message/
 * stage/retryable/redemptionId) supaya `ShippingExceptionFilter` dan frontend tidak butuh cabang
 * kedua — tapi dengan KODE dan STAGE yang tidak bisa menyamar jadi jalur CC.
 */
export function domesticError(args: {
  status: number;
  code: DomesticErrorCode;
  message: string;
  /** Default NO_EFFECT: ditolak tanpa menyentuh apa pun. */
  stage?: DomesticErrorStage;
  redemptionId?: string;
}): HttpException {
  return shippingError({
    status: args.status,
    // Cast SATU ARAH yang disengaja: `code` di body kontrak bertipe ShippingErrorCode, dan
    // namespace HOSHI_DOMESTIC_* sengaja TIDAK dimasukkan ke SHIPPING_ERROR_CODE supaya tidak ada
    // throw-site jalur CC yang bisa memakainya karena kelihatan "tersedia".
    code: args.code as unknown as ShippingErrorCode,
    message: args.message,
    stage: args.stage ?? SHIPPING_STAGE.NO_EFFECT,
    redemptionId: args.redemptionId,
  });
}

/**
 * Gerbang rail untuk rute yang HANYA sah di jalur domestik. Dipakai di awal setiap rute domestik.
 * Kebalikannya (`assertCcRail`) dipakai di awal rute CC — dua-duanya WAJIB ada, karena "tidak bisa
 * tertukar" cuma benar kalau KEDUA arah ditolak.
 */
export function assertDomesticRail(
  row: RedemptionRailShape & { id: string },
): void {
  if (!isDomesticRedemption(row)) {
    throw domesticError({
      status: HttpStatus.BAD_REQUEST,
      code: DOMESTIC_ERROR_CODE.WRONG_RAIL,
      message:
        'Permintaan kirim ini bukan kartu stok Hoshi (kartunya ada di vault CollectorCrypt), jadi ' +
        'tidak bisa diproses lewat jalur kirim domestik. Pakai alur kirim CollectorCrypt.',
      redemptionId: row.id,
    });
  }
}

/** Gerbang rail untuk rute CC: baris jalur DOMESTIK ditolak dengan kode CC yang sudah ada. */
export function assertCcRail(row: RedemptionRailShape & { id: string }): void {
  if (isDomesticRedemption(row)) {
    throw shippingError({
      status: HttpStatus.BAD_REQUEST,
      code: SHIPPING_ERROR_CODE.CARD_NOT_YOURS,
      message:
        'Permintaan kirim ini adalah kartu stok Hoshi yang dikirim kurir domestik — tidak ada NFT ' +
        'untuk dibakar dan tidak ada ongkir CollectorCrypt untuk ditaksir. Pakai alur kirim domestik.',
      stage: SHIPPING_STAGE.NO_EFFECT,
      redemptionId: row.id,
    });
  }
}
