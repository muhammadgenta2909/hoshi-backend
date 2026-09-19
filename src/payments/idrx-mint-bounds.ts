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
