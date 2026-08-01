import { BadRequestException, Logger } from '@nestjs/common';
import { PublicKey, Transaction } from '@solana/web3.js';

/** Program marketplace CollectorCrypt V2 (sama untuk prod & devnet). */
export const CC_MARKETPLACE_PROGRAM =
  'CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr';
export const COMPUTE_BUDGET_PROGRAM =
  'ComputeBudget111111111111111111111111111111';

/** USDC 6 desimal. */
const USDC_DECIMALS = 1_000_000;

const logger = new Logger('CcBuyVerify');

/**
 * Membongkar transaksi beli bikinan CollectorCrypt dan MENOLAK apa pun yang tidak
 * sesuai kutipan. FAIL-CLOSED: bentuk yang tidak dikenali = tolak, bukan diloloskan.
 *
 * Kenapa wajib: field `price` yang dikirim ke /marketplace/buy TIDAK menentukan nominal
 * on-chain (CC memakai harga listing live-nya). Tanpa membongkar transaksinya, harga bisa
 * berubah antara kutipan dan tanda tangan dan pembayar (pembeli ATAU treasury) membayar
 * diam-diam nominal yang berbeda.
 *
 * `feePayerWallet` diparameterkan supaya SATU verifikasi ini melayani dua jalur:
 *  - pembeli tanda tangan  → feePayer = wallet pembeli
 *  - reseller (treasury)   → feePayer = wallet treasury
 */
export function assertCcBuyTxMatchesQuote(
  base64: string,
  expect: { feePayerWallet: string; sellerWallet: string; priceUsdc: number },
): void {
  let tx: Transaction;
  try {
    tx = Transaction.from(Buffer.from(base64, 'base64'));
  } catch {
    throw new BadRequestException(
      'Transaksi dari CollectorCrypt tidak bisa dibaca — pembelian dibatalkan.',
    );
  }

  // Fee payer (penanda tangan) harus persis wallet yang kita harapkan.
  if (!tx.feePayer || tx.feePayer.toBase58() !== expect.feePayerWallet)
    throw new BadRequestException(
      'Transaksi CollectorCrypt tidak ditujukan ke wallet yang seharusnya — dibatalkan.',
    );

  // Tidak boleh ada program di luar yang kita harapkan.
  const allowed = new Set([CC_MARKETPLACE_PROGRAM, COMPUTE_BUDGET_PROGRAM]);
  for (const ix of tx.instructions) {
    if (!allowed.has(ix.programId.toBase58()))
      throw new BadRequestException(
        'Transaksi CollectorCrypt memuat program tak dikenal — dibatalkan.',
      );
  }

  // WAJIB TEPAT SATU instruksi marketplace CC. Allow-list program di atas mengizinkan banyak
  // instruksi CC; untuk penandatangan TREASURY yang tak diawasi, instruksi marketplace KEDUA
  // bisa mendebit USDC tambahan dari feePayer tanpa terdeteksi (yang diverifikasi cuma yang
  // pertama). Nol atau lebih dari satu = tolak.
  const ccIxs = tx.instructions.filter(
    (i) => i.programId.toBase58() === CC_MARKETPLACE_PROGRAM,
  );
  if (ccIxs.length !== 1)
    throw new BadRequestException(
      'Transaksi CollectorCrypt memuat jumlah instruksi marketplace tak terduga — dibatalkan.',
    );
  const ccIx = ccIxs[0];

  // Layout terverifikasi: 8 byte discriminator + u64 LE harga (USDC 6 desimal).
  // Panjang lain = layout tak dikenal → tolak (jangan menebak nominal).
  if (ccIx.data.length !== 16)
    throw new BadRequestException(
      'Format instruksi CollectorCrypt tidak dikenali — pembelian dibatalkan.',
    );

  const onChain = ccIx.data.readBigUInt64LE(8);
  const quoted = BigInt(Math.round(expect.priceUsdc * USDC_DECIMALS));
  if (onChain !== quoted) {
    logger.warn(
      `CC buy ditolak: nominal on-chain ${onChain} != kutipan ${quoted}`,
    );
    throw new BadRequestException(
      `Harga di CollectorCrypt berubah (transaksi menagih ` +
        `${Number(onChain) / USDC_DECIMALS} USDC, bukan ${expect.priceUsdc}). ` +
        'Muat ulang untuk harga terbaru.',
    );
  }

  // Penjual yang dikutip harus benar-benar ada di daftar akun transaksi.
  let sellerPk: PublicKey;
  try {
    sellerPk = new PublicKey(expect.sellerWallet);
  } catch {
    throw new BadRequestException('Alamat penjual CollectorCrypt tidak valid.');
  }
  const keys = new Set(ccIx.keys.map((k) => k.pubkey.toBase58()));
  if (!keys.has(sellerPk.toBase58()))
    throw new BadRequestException(
      'Penjual pada transaksi berbeda dari listing — dibatalkan.',
    );
}
