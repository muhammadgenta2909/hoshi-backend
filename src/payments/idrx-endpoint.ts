/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ HOST API IDRX: `https://api.idrx.co` — DAN PATH YANG DITANDATANGANI IKUT BERUBAH.          ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * IDRX memindahkan API-nya dari `https://idrx.co/api/...` ke `https://api.idrx.co/...`, dan bentuk
 * lama dimatikan 30 Oktober 2026 pukul 23:59 WIB (email IDRX ke partner). Path di host baru TIDAK
 * berawalan `/api`: `POST https://api.idrx.co/transaction/mint-request`.
 *
 * Yang membuat ini lebih dari sekadar ganti URL: `buildIdrxRequest` menandatangani PATH-nya, bukan
 * URL penuhnya. Path yang ditandatangani WAJIB sama dengan path yang benar-benar diminta — kalau
 * URL-nya pindah ke host baru tapi yang ditandatangani masih `/api/transaction/...`, setiap
 * request ditolak 401 dan tidak ada satu tagihan pun yang bisa terbit.
 *
 * Maka path logis (`/transaction/mint-request`) disusun DI SATU TEMPAT ini menjadi path yang
 * dikirim sekaligus ditandatangani:
 *
 *   IDRX_API_BASE kosong          → https://api.idrx.co   + /transaction/...  (bawaan, host baru)
 *   IDRX_API_BASE=https://idrx.co → https://idrx.co + /api/transaction/...    (bentuk lama, PERSIS
 *                                                                              seperti sebelumnya)
 *   IDRX_API_BASE=https://idrx.co/api → sama dengan baris di atas, tanpa /api dobel
 *
 * Baris kedua adalah JALAN PULANG: kalau host baru ternyata menolak tanda tangan kita, mengisi env
 * itu di droplet (lalu restart kontainer) mengembalikan perilaku lama byte-demi-byte, tanpa deploy
 * ulang. Jalan pulang itu hanya berlaku sampai 30 Oktober 2026.
 */
export function resolveIdrxEndpoint(
  apiBase: string,
  path: string,
): { origin: string; path: string } {
  const url = new URL(apiBase);
  const basePath = url.pathname.replace(/\/+$/, '');
  const legacyHost =
    url.hostname === 'idrx.co' || url.hostname === 'www.idrx.co';
  const prefix = legacyHost && basePath === '' ? '/api' : basePath;
  return { origin: url.origin, path: `${prefix}${path}` };
}
