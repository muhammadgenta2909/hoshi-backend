/**
 * Batas nominal satu mint-request IDRX. DIPINDAH ke file sendiri (dari konstanta privat di
 * payments.service.ts) karena jalur ONGKIR DOMESTIK harus memvalidasi tarif yang di-set ADMIN
 * terhadap batas YANG SAMA: tarif di bawah minimum IDRX menghasilkan baris tarif yang kelihatan
 * benar di dashboard tapi invoice-nya TIDAK PERNAH BISA TERBIT — kegagalan yang baru terlihat saat
 * user pertama menekan "Bayar ongkir".
 *
 * File ini TIDAK mengimpor apa pun (tak ada risiko siklus impor).
 */

/** Minimum satu mint IDRX. Nominal di bawah ini ditolak gateway. */
export const IDRX_MIN_MINT_IDR = 20_000;

/** Maksimum satu mint IDRX. */
export const IDRX_MAX_MINT_IDR = 1_000_000_000;

export const BPS_DENOMINATOR = 10_000;

/**
 * Biaya layanan pembayaran (QRIS/e-wallet), ~0,7%, DITAMBAHKAN DI ATAS harga kartu — keputusan
 * pemilik produk, supaya treasury menerima harga penuh. Rumahnya di sini, bukan privat di
 * payments.service.ts, karena harga yang DITENTUKAN MANUSIA (tarif ongkir admin, harga titipan)
 * harus diuji terhadap batas yang sama dengan yang nanti benar-benar ditagihkan.
 */
export const QRIS_FEE_BPS = 70;

/**
 * `value * bps / 10.000` dibulatkan KE ATAS, MURNI INTEGER — salinan sengaja dari `applyBps` di
 * payments.service.ts, dan HARUS tetap sama. `(a - (a % b)) / b` adalah pembagian eksak untuk
 * safe integer; `Math.ceil(a / b)` bisa meleset satu rupiah saat pembagiannya tidak terwakili
 * tepat di IEEE-754, dan "salah satu rupiah, kadang-kadang" adalah bug yang tak akan terlacak.
 */
function applyBpsCeil(value: number, bps: number): number {
  const numerator = value * bps;
  if (!Number.isSafeInteger(numerator)) {
    throw new RangeError(
      'Perhitungan harga melampaui batas bilangan bulat aman.',
    );
  }
  const remainder = numerator % BPS_DENOMINATOR;
  const quotient = (numerator - remainder) / BPS_DENOMINATOR;
  return remainder === 0 ? quotient : quotient + 1;
}

/** Yang BENAR-BENAR ditagihkan ke pembeli untuk kartu berharga `priceIdrx` (harga + fee QRIS). */
export const chargeableIdrFor = (priceIdrx: number): number =>
  applyBpsCeil(priceIdrx, BPS_DENOMINATOR + QRIS_FEE_BPS);

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   RENTANG HARGA KARTU YANG BENAR-BENAR BISA DITAGIHKAN

   Batas IDRX di atas berlaku pada nominal yang DITAGIHKAN, bukan pada harga kartunya. Karena fee
   QRIS ditambahkan di atas harga, rentang harga kartu yang sah lebih SEMPIT daripada rentang mint:
   sebuah kartu Rp 19.900 terlihat di atas minimum Rp 20.000? tidak — ia justru di bawahnya
   sebelum fee, dan Rp 999.999.999 melewati maksimum SESUDAH fee.

   Dihitung, tidak diketik: kalau fee-nya berubah, kedua angka ini ikut berubah sendiri. Ada test
   yang membuktikan bahwa satu rupiah di luar rentang ini benar-benar ditolak jalur bayar.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Harga kartu terendah yang tagihannya masih bisa terbit. */
export const CHARGEABLE_PRICE_MIN_IDRX = (() => {
  const approx = Math.ceil(
    (IDRX_MIN_MINT_IDR * BPS_DENOMINATOR) / (BPS_DENOMINATOR + QRIS_FEE_BPS),
  );
  // Dirapatkan dari hasil perkiraan IEEE-754 ke batas yang BENAR menurut `chargeableIdrFor`.
  let p = approx;
  while (p > 1 && chargeableIdrFor(p - 1) >= IDRX_MIN_MINT_IDR) p -= 1;
  while (chargeableIdrFor(p) < IDRX_MIN_MINT_IDR) p += 1;
  return p;
})();

/** Harga kartu tertinggi yang tagihannya masih bisa terbit. */
export const CHARGEABLE_PRICE_MAX_IDRX = (() => {
  const approx = Math.floor(
    (IDRX_MAX_MINT_IDR * BPS_DENOMINATOR) / (BPS_DENOMINATOR + QRIS_FEE_BPS),
  );
  let p = approx;
  while (chargeableIdrFor(p + 1) <= IDRX_MAX_MINT_IDR) p += 1;
  while (p > 1 && chargeableIdrFor(p) > IDRX_MAX_MINT_IDR) p -= 1;
  return p;
})();

/** Apakah harga kartu ini benar-benar bisa ditagihkan? Sumber tunggal untuk layar dan server. */
export const isChargeablePrice = (priceIdrx: number): boolean =>
  Number.isInteger(priceIdrx) &&
  priceIdrx >= CHARGEABLE_PRICE_MIN_IDRX &&
  priceIdrx <= CHARGEABLE_PRICE_MAX_IDRX;

/** Kalimat yang menyebut ANGKANYA — layar dan pesan error tidak boleh menyuruh orang menebak. */
export const chargeablePriceRangeSentence = (): string =>
  `Harga harus antara Rp ${CHARGEABLE_PRICE_MIN_IDRX.toLocaleString('id-ID')} dan ` +
  `Rp ${CHARGEABLE_PRICE_MAX_IDRX.toLocaleString('id-ID')} (batas penerbitan tagihan IDRX, ` +
  'sudah memperhitungkan biaya layanan pembayaran ~0,7% yang ditambahkan di atas harga).';
