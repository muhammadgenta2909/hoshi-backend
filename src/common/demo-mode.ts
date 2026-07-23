import { ServiceUnavailableException } from '@nestjs/common';

/**
 * Penjaga untuk jalur yang MENYERAHKAN NILAI TANPA PEMBAYARAN.
 *
 * Beberapa jalur di POC ini sengaja memberi kartu tanpa settlement — marketplace
 * buy()/acceptOffer() (lihat TODO(pembayaran) di sana), packs open(), dan vault
 * claim(). Di devnet itu wajar: kartunya test, uangnya mainan, dan demo memang
 * butuh jalur cepat. Di mainnet, jalur yang sama berarti SIAPA PUN YANG LOGIN
 * BISA MENGAMBIL KARTU ASLI GRATIS — dan identitas di sini gratis, karena
 * /auth/nonce meng-upsert user untuk alamat Solana apa pun.
 *
 * Yang membedakan keduanya sekarang hanyalah komentar di kode. Fungsi ini
 * mengubahnya jadi pagar yang dieksekusi: begitu deployment terlihat produksi,
 * jalur-jalur itu berhenti bekerja — tanpa perlu ada manusia yang ingat
 * mencabutnya satu per satu saat migrasi.
 *
 * ARAH KEBERPIHAKAN (disengaja): kita menolak hanya ketika produksi TERLIHAT
 * JELAS, bukan ketika devnet tidak terbukti. Alasannya praktis — env yang belum
 * lengkap tidak boleh mematikan demo yang sedang berjalan. Pilihan ini tetap
 * menutup bahaya yang nyata, karena pindah ke mainnet MUSTAHIL dilakukan tanpa
 * menyalakan salah satu sinyal di bawah: RPC, cluster, atau base URL CC.
 */
export function detectProductionSignal(): string | null {
  const cluster = (process.env.SOLANA_CLUSTER ?? '').trim().toLowerCase();
  if (cluster === 'mainnet-beta' || cluster === 'mainnet') {
    return `SOLANA_CLUSTER=${cluster}`;
  }

  const rpc = (process.env.SOLANA_RPC_URL ?? '').toLowerCase();
  if (rpc.includes('mainnet')) {
    return 'SOLANA_RPC_URL menunjuk mainnet';
  }

  // Base URL CC produksi = kartu ASLI milik orang lain, bukan kartu test.
  const cc = (process.env.COLLECTORCRYPT_GACHA_BASE_URL ?? '').toLowerCase();
  if (cc.includes('collectorcrypt.com') && !cc.includes('dev-gacha')) {
    return 'COLLECTORCRYPT_GACHA_BASE_URL menunjuk gacha produksi';
  }

  return null;
}

/**
 * Hentikan jalur tanpa-settlement di lingkungan produksi.
 *
 * @param action deskripsi singkat jalurnya, muncul di log & pesan error supaya
 *               yang menemukannya tahu persis apa yang barusan ditolak.
 */
export function assertDemoOnly(action: string): void {
  const signal = detectProductionSignal();
  if (!signal) return;
  throw new ServiceUnavailableException(
    `${action} dinonaktifkan: jalur ini menyerahkan kartu TANPA pembayaran dan ` +
      `hanya sah di lingkungan demo, sedangkan deployment ini terlihat produksi ` +
      `(${signal}). Selesaikan settlement pembayaran sebelum mengaktifkannya kembali.`,
  );
}
