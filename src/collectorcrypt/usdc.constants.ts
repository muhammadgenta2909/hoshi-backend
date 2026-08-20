/**
 * Konstanta SPL USDC — SATU sumber kebenaran, dipakai lintas service di modul ini.
 *
 * Sebelumnya mint per-cluster hidup sebagai const lokal di gacha.service.ts (dipakai untuk
 * MEMBACA saldo USDC treasury). treasury.service.ts kini juga butuh mint yang SAMA untuk
 * MEMINDAHKAN USDC (fundUsdc). Menaruhnya di sini menutup kemungkinan dua salinan yang
 * melenceng — dan melencengnya mint di jalur uang bukan bug kecil: transfer bisa mendarat
 * di token yang salah, atau saldo dibaca dari mint yang bukan yang kita bayar.
 */

/** Mint SPL USDC per cluster. Mainnet = USDC Circle; devnet = USDC faucet. Override lewat env USDC_MINT. */
export const USDC_MINT_MAINNET = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

/** USDC selalu 6 desimal — dibutuhkan transferChecked (yang memverifikasi desimal on-chain). */
export const USDC_DECIMALS = 6;

/**
 * Program SPL Token + Associated Token — dipakai membangun instruksi transfer/ATA SECARA MANUAL
 * (repo ini sengaja TIDAK memasang @solana/spl-token; lihat treasury.service.ts fundUsdc).
 */
export const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_ASSOCIATED_TOKEN_PROGRAM_ID =
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Pilih mint USDC yang sah untuk cluster ini. `USDC_MINT` (env) menang bila di-set — jalan keluar
 * kalau suatu saat butuh mint uji khusus tanpa menyentuh kode.
 */
export function resolveUsdcMintAddress(
  cluster: string | undefined,
  override: string | undefined,
): string {
  if (override && override.trim().length > 0) return override.trim();
  return (cluster ?? 'devnet').toLowerCase() === 'mainnet-beta'
    ? USDC_MINT_MAINNET
    : USDC_MINT_DEVNET;
}
