/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SATU DEFINISI "STOK HOSHI YANG BOLEH DIJUAL" — dipakai jalur BELI dan jalur KIRIM.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * KENAPA FILE INI ADA. Predikatnya dulu hidup sebagai ekspresi inline di `payments.service.ts`
 * (`isHoshiInventory`). Ketika jalur KIRIM DOMESTIK butuh predikat yang SAMA — "kartu ini benar
 * benar stok fisik Hoshi, bukan baris seed" — menuliskannya untuk kedua kali berarti dua salinan
 * yang bisa MELENCENG: satu longgar (boleh dibeli) dan satu ketat (tidak bisa dikirim), atau
 * sebaliknya. Yang kedua mengunci kartu yang sudah dibayar; yang pertama menjual kartu hantu.
 *
 * KETIGA SYARATNYA, dan kenapa masing-masing WAJIB:
 *
 *  1. `source !== COLLECTORCRYPT` — baris katalog CC fisiknya di gudang CC. Pengirimannya lewat
 *     jalur CC Vault Shipping (burn NFT + USDC + tanda tangan wallet), BUKAN kurir domestik.
 *  2. `sellerId == null` — ada penjual user ⇒ listing P2P. Kartunya milik user lain dan (kalau
 *     di-arm) dititipkan ke wallet escrow; Hoshi tidak memegang fisiknya.
 *  3. `sellable === true` — INI YANG TIDAK BOLEH DILONGGARKAN. `source=HOSHI` + `sellerId=null`
 *     adalah bentuk DEFAULT SETIAP baris listing, termasuk seed/chart-filler/placeholder yang
 *     tidak punya kartu fisik di belakangnya. Flag `sellable` default `false` justru supaya baris
 *     seperti itu tidak bisa dibeli maupun diminta kirim. Menghapus syarat ini = menjual dan
 *     menjanjikan pengiriman barang yang tidak ada.
 *
 * Bentuk argumennya SENGAJA struktural (bukan `Listing` penuh): pemanggil boleh mengoper hasil
 * `select` yang sempit, dan test tidak perlu mengarang 40 kolom.
 */
export interface HoshiStockShape {
  /** `ListingSource` apa adanya. Dibandingkan sebagai string agar `select` sempit tetap cocok. */
  source: string;
  sellerId: string | null;
  sellable: boolean;
}

/** Nilai `ListingSource` untuk baris hasil sync katalog CollectorCrypt. */
export const LISTING_SOURCE_COLLECTORCRYPT = 'COLLECTORCRYPT';

/**
 * true ⇔ baris ini adalah STOK FISIK HOSHI yang memang ditandai untuk dijual.
 *
 * Fail-closed: apa pun yang tidak memenuhi KETIGA syarat di atas → false.
 */
export function isHoshiSellableStock(listing: HoshiStockShape): boolean {
  return (
    listing.source !== LISTING_SOURCE_COLLECTORCRYPT &&
    listing.sellerId == null &&
    listing.sellable === true
  );
}
