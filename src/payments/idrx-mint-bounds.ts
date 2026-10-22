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

/**
 * ╔═══ MAKSIMUM SATU TAGIHAN YANG BENAR-BENAR BISA DIBAYAR PEMBELI: Rp 10 JUTA, BUKAN Rp 1 MILIAR ═══╗
 *
 * Gateway IDRX menerima mint sampai Rp 1 miliar, tapi itu batas KESELURUHAN. Batas per kanalnya
 * (docs.idrx.co, halaman Fees): QRIS Rp 10 juta, Virtual Account Rp 100 juta. Dan VA TIDAK BISA
 * dipakai pembeli Hoshi sama sekali: IDRX hanya menerima transfer VA dari rekening atas nama
 * PEMILIK akun IDRX (Mandiri/BRI malah harus dari rekening bank yang sama), sementara Hoshi
 * memakai satu akun IDRX untuk semua pembeli. Transfer yang namanya tidak cocok ditolak bank,
 * atau kalau sempat masuk, baru dikembalikan dalam 14 hari kerja.
 *
 * Jadi satu-satunya kanal yang bisa dipakai pembeli adalah QRIS, dan batas QRIS-lah batas kita.
 * Dulu angkanya Rp 1 miliar: kartu Rp 50 juta lolos semua pemeriksaan, tayang, tagihannya terbit,
 * lalu tidak ada satu cara bayar pun yang bisa menyelesaikannya. Itu lebih buruk daripada
 * menolaknya sejak formulir titipan, karena penitip sudah dijanjikan kartunya akan dijual.
 *
 * Kalau IDRX menaikkan batas QRIS akun Hoshi, atau Hoshi mendaftarkan pembeli sebagai anggota
 * IDRX (Onboarding API + `memberId`, sehingga VA terikat ke rekening pembeli sendiri), angka ini
 * yang diubah. Semua batas turunannya (rentang harga titipan, harga kartu, tarif ongkir) ikut.
 */
export const IDRX_MAX_MINT_IDR = 10_000_000;

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

/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ IDRX TERENDAH YANG SAH TERCETAK UNTUK SEBUAH TAGIHAN — BUKAN TAGIHANNYA SENDIRI.           ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Kita mengirim `toBeMinted = tagihan` saat mint-request, dan pemeriksa catatan IDRX dulu
 * menuntut `toBeMinted >= tagihan`. Untuk QRIS itu MUSTAHIL dipenuhi: menurut dokumentasi IDRX
 * (halaman Fees dan Callback), biaya QRIS 0,7% DIPOTONG DARI IDRX YANG DICETAK, dan `toBeMinted`
 * di catatannya adalah angka SESUDAH potongan. Contoh di dokumentasinya sendiri persis kasus kita:
 * tagihan Rp 20.000, `toBeMinted: "19860"`, baris biaya "Payment Method Fee" 140.
 *
 * Akibatnya dulu: SETIAP pembayaran QRIS yang berhasil dicap PIN MENYIMPANG → REFUND_DUE. Kartu
 * tidak diserahkan, uang pembeli tertahan, dan tidak ada kode yang mengembalikannya.
 *
 * Kanal lain (VA, OVO, DANA) MENAMBAHKAN biayanya di atas tagihan, jadi untuk mereka
 * `toBeMinted === tagihan`. QRIS satu-satunya yang memotong, jadi potongan QRIS-lah lantainya.
 * Biaya dibulatkan KE ATAS: itu lantai paling longgar yang masih jujur, dan masih menolak setiap
 * catatan yang kurang lebih dari biaya QRIS itu sendiri.
 *
 * Catatan jujur soal uangnya: karena fee digandakan dulu ke atas (`chargeableIdrFor`) lalu
 * dipotong dari angka yang SUDAH digandakan, yang mendarat di treasury bisa sedikit DI BAWAH
 * harga kartu — sekitar Rp 49 per Rp 1 juta. Itu bukan penyimpangan yang patut dijadikan utang.
 */
export const minimumMintedFor = (chargedIdr: number): number =>
  chargedIdr - applyBpsCeil(chargedIdr, QRIS_FEE_BPS);

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
  `Rp ${CHARGEABLE_PRICE_MAX_IDRX.toLocaleString('id-ID')}. Batas atasnya batas QRIS, satu-satunya ` +
  'cara bayar yang bisa dipakai pembeli: maksimal Rp 10 juta per pembayaran, sudah termasuk biaya ' +
  'layanan ~0,7% yang ditambahkan di atas harga. Kartu di atas itu belum bisa dijual lewat Hoshi.';
