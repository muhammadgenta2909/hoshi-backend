import type { Prisma } from '@prisma/client';
import {
  isHoshiSellableStock,
  LISTING_SOURCE_COLLECTORCRYPT,
  type HoshiStockShape,
} from './hoshi-stock';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SATU PREDIKAT, EMPAT JAWABAN: "baris listing ini JENIS APA, dan karena itu settle KE MANA?"  ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Keempatnya settle dengan cara yang BERBEDA TOTAL, dan salah menebak berarti gagal SESUDAH
 * pembeli membayar — mode kegagalan paling mahal di repo ini:
 *
 *   CONSIGNMENT  kartu ORANG LAIN, fisiknya di rak Hoshi. Settle DB-only + KREDIT SALDO PEMILIK
 *                (harga − komisi). NOL NFT, NOL escrow, NOL USDC, NOL on-chain.
 *   CC_CATALOG   baris hasil sync katalog CollectorCrypt. Treasury MEMBELI di CC (USDC) lalu
 *                mentransfer NFT-nya ke pembeli.
 *   HOSHI_STOCK  stok Hoshi sendiri. Settle DB-only, Hoshi menyimpan 100%. NOL NFT.
 *   USER_P2P     listing user. Settle dengan memindahkan Core asset KELUAR DARI WALLET ESCROW —
 *                jadi ia MENUNTUT NFT yang memang dipegang escrow.
 *   NOT_SELLABLE baris seed / chart-filler / placeholder. Default FAIL-CLOSED.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ JEBAKANNYA, dan kenapa file ini ada:                                                         │
 * │                                                                                              │
 * │ Kartu TITIPAN punya `sellerId != null` — HARUS, karena kalau tidak tidak ada siapa pun yang  │
 * │ bisa dikredit dan feed aktivitasnya berbohong. Tapi ia TIDAK punya NFT di escrow, dan tidak  │
 * │ akan pernah punya. Artinya: bagi SETIAP kode yang bertanya "sellerId ada?", kartu titipan    │
 * │ TAMPAK PERSIS SEPERTI listing P2P. Kalau ia menempuh jalur settlement P2P, ia gagal SESUDAH  │
 * │ pembeli membayar.                                                                            │
 * │                                                                                              │
 * │ Maka jenisnya dibaca dari SATU KOLOM (`Listing.consignmentId`), bukan disimpulkan dari       │
 * │ bentuk. Menyimpulkan dari bentuk (`sellerId != null && ccNftAddress == null`) adalah persis  │
 * │ kesalahan yang sudah didokumentasikan `CardRedemption.source`: "INI LABEL, BUKAN GERBANG".   │
 * │ Bentuk bukan fakta.                                                                          │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 */
export type ListingKind =
  | 'CONSIGNMENT'
  | 'CC_CATALOG'
  | 'HOSHI_STOCK'
  | 'USER_P2P'
  | 'NOT_SELLABLE';

/**
 * Bentuk argumen SENGAJA struktural (bukan `Listing` penuh), sama seperti `HoshiStockShape`:
 * pemanggil boleh mengoper hasil `select` yang sempit, dan test tidak perlu mengarang 40 kolom.
 */
export interface ListingKindShape extends HoshiStockShape {
  /** NON-NULL ⇒ TITIPAN. Satu-satunya penulisnya: ConsignmentService.createListingFor. */
  consignmentId: string | null;
}

/**
 * URUTANNYA ADALAH KONTRAKNYA — jangan diubah tanpa membaca paragraf ini.
 *
 * CONSIGNMENT DIDAHULUKAN karena ia SATU-SATUNYA jenis yang BERTABRAKAN BENTUK dengan jenis lain:
 * ia punya `sellerId != null`, jadi pertanyaan bentuk apa pun yang diajukan lebih dulu akan
 * menjawab USER_P2P — dan USER_P2P adalah satu-satunya jalur yang menyentuh escrow.
 *
 * CC_CATALOG menjawab USER_P2P saat `sellerId` terisi: itu kartu CC yang di-PULL seorang user lalu
 * dipajang ulang olehnya. Perilaku itu SUDAH ADA sebelum file ini (lihat `buy()`/`submitOffer`:
 * "hanya kartu KATALOG-SYNC (sellerId null) yang diblokir") dan sengaja tidak diubah.
 *
 * `isHoshiSellableStock` TIDAK DIMODIFIKASI oleh file ini. Ketiga syaratnya tetap apa adanya, dan
 * baris titipan gagal di syarat `sellerId == null` — yang MEMANG BENAR: kartu titipan bukan stok
 * Hoshi. Itu juga yang membuat baris titipan otomatis tersingkir dari `listUnsellableStock` dan
 * dari rute admin `setListingsSellable`, tanpa satu baris pun perubahan di sana.
 */
export function listingKindOf(row: ListingKindShape): ListingKind {
  if (row.consignmentId != null) return 'CONSIGNMENT';
  if (row.source === LISTING_SOURCE_COLLECTORCRYPT) {
    return row.sellerId == null ? 'CC_CATALOG' : 'USER_P2P';
  }
  if (row.sellerId != null) return 'USER_P2P';
  return isHoshiSellableStock(row) ? 'HOSHI_STOCK' : 'NOT_SELLABLE';
}

/**
 * true ⇔ baris ini kartu TITIPAN. Pintasan yang dibaca sendiri, supaya call-site tidak perlu
 * menuliskan `listingKindOf(row) === 'CONSIGNMENT'` di dua puluh tempat.
 *
 * Bentuknya sengaja hanya menuntut `consignmentId`: banyak call-site membaca baris dengan `select`
 * sempit yang tidak memuat `source`/`sellable`.
 */
export function isConsignedListing(row: {
  consignmentId: string | null;
}): boolean {
  return row.consignmentId != null;
}

/* ─────────────────── KEDUA SISI PERTANYAAN YANG SAMA, DALAM BENTUK SQL ─────────────────── */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SETIAP AGREGAT YANG MENGHITUNG "PENJUALAN P2P" WAJIB MEMAKAI `nonConsignedListingWhere()`.  ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Jebakan yang sama dengan yang dijelaskan di kepala file ini, tapi kali ini di jalur LAPORAN,
 * bukan settlement: baris titipan punya `sellerId != null`, jadi `where: { sellerId: { not: null } }`
 * — bentuk yang paling wajar untuk "listing milik user" — MENELAN SETIAP PENJUALAN TITIPAN dan
 * melaporkannya sebagai P2P. Akibatnya bukan sekadar angka yang meleset: komisi 5%, yaitu SELURUH
 * model bisnis titipan, tidak punya satu baris pun di layar mana pun, dan P2P tampak lebih besar
 * dari yang sebenarnya dengan selisih yang persis sama.
 *
 * Kedua fungsi ini ada supaya pertanyaan itu punya SATU jawaban tertulis, sama seperti
 * `listingKindOf` menjadi satu jawaban untuk jalur settlement. SENGAJA fungsi, bukan konstanta:
 * objek literal yang di-spread ke beberapa query Prisma akan berbagi sub-objek yang SAMA, dan
 * satu pemanggil yang memutasinya diam-diam mengubah filter pemanggil lain (alasan yang sama
 * dengan `unescrowedUserListingWhere` dan `inCustodyWhere`).
 */
export function consignedListingWhere(): Prisma.ListingWhereInput {
  return { consignmentId: { not: null } };
}

/** Kebalikannya: SEMUA baris listing yang BUKAN titipan. Lihat paragraf di atas. */
export function nonConsignedListingWhere(): Prisma.ListingWhereInput {
  return { consignmentId: null };
}
