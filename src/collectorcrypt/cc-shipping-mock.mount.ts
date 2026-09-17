/**
 * Prefix mount mock CC Vault Shipping — SATU definisi, dipakai dua pihak yang tidak boleh
 * saling meng-import:
 *
 *   • cc-shipping-mock.controller.ts — memasang rutenya (@Controller(CC_SHIPPING_MOCK_MOUNT));
 *   • config/env.validation.ts       — interlock cutover mainnet MENOLAK BOOT kalau
 *     COLLECTORCRYPT_SHIPPING_BASE_URL masih menunjuk ke sini saat cluster mainnet-beta.
 *
 * KENAPA FILE TERSENDIRI. Kalau env.validation meng-import konstanta ini dari controller-nya, ia
 * ikut menarik Nest + core mock + @solana/web3.js ke dalam validasi env yang jalan PALING AWAL saat
 * boot — mahal, dan rantai ESM-nya juga yang bikin jest harus mem-mock web3 di beberapa spec.
 * File ini sengaja TANPA import apa pun, jadi kedua sisi memakai string yang sama tanpa ongkos.
 *
 * Base URL yang dipakai staging: <URL backend publik>/api/cc-shipping-mock
 * (`/api` berasal dari global prefix, lihat main.ts — bukan bagian dari konstanta ini.)
 */
export const CC_SHIPPING_MOCK_MOUNT = 'cc-shipping-mock';
