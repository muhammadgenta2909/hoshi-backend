import { createHash } from 'node:crypto';

/**
 * IDENTITAS SET TRANSAKSI BURN — supaya submitBurn bisa menolak batch BASI SECARA LOKAL, sebelum
 * klaim atomik dan sebelum CC disentuh.
 *
 * KENAPA PERLU (balapan yang nyata, terbukti di mock CC):
 *   Dua `POST /redeem/prepare` dengan input IDENTIK mengembalikan outboundShipmentId yang SAMA
 *   dengan transaksi BARU (itu memang pemulihan resmi menurut dokumen CC). Kalau user membuka dua
 *   modal (dua tab, atau HP + desktop), masing-masing memanggil /re-prepare, lalu user menyetujui
 *   prompt wallet yang LEBIH TUA duluan, CC menjawab:
 *       403 "The transactions submitted are not the complete set this server issued"
 *   Tabel error dokumen CC TIDAK memberi jaminan "nothing was burned" untuk 403 itu, jadi ia WAJIB
 *   masuk cabang INDETERMINATE — barisnya tersangkut di BURN_SUBMITTED, uang sudah pindah, dan
 *   `reprepareBurn` cuma menerima FUNDED → tidak ada jalan keluar otomatis.
 *   Maka: cegah di sumbernya. Kalau set yang disubmit bukan set TERAKHIR yang kita terbitkan,
 *   tolak lokal → baris tidak pernah keluar dari FUNDED, CC tidak pernah dipanggil.
 *
 * KENAPA HASH ATAS *PESAN*, BUKAN ATAS BASE64 MENTAH:
 *   Yang kita terbitkan adalah transaksi UNSIGNED; yang user submit adalah salinan DITANDATANGANI.
 *   Base64-nya BERBEDA (slot tanda tangan terisi), tapi bagian PESAN-nya identik byte demi byte —
 *   menandatangani tidak mengubah pesan. Jadi identitas yang STABIL lintas langkah tanda tangan =
 *   byte PESAN-nya.
 *
 *   Wire format Solana (legacy maupun v0) sama-sama:
 *       [compact-u16 jumlah tanda tangan][64 byte per tanda tangan][pesan...]
 *   dan byte pertama pesan menyebut `numRequiredSignatures` (legacy), atau untuk v0 byte pertama
 *   adalah 0x80|versi lalu byte kedua yang menyebutnya. Kita memakai kecocokan angka itu sebagai
 *   PEMERIKSAAN KEASLIAN: kalau jumlah tanda tangan di prefix tidak sama dengan yang diminta
 *   header pesan, berarti yang kita pegang BUKAN transaksi Solana → kita menyerah (null).
 *
 * FAIL-OPEN YANG DISENGAJA (dan kenapa itu yang benar):
 *   Kalau SATU entri saja tidak bisa dikanonikalisasi, seluruh identitas = null. Di `fundAndPrepare`
 *   /`reprepareBurn` itu berarti kolom `burnTxSetHash` ditulis null → `submitBurn` berperilaku
 *   PERSIS seperti sebelum fitur ini ada. Alternatifnya (fail-closed) akan MEMBLOKIR burn yang sah
 *   untuk baris yang uangnya SUDAH pindah — kerusakan yang lebih besar daripada balapan yang
 *   sedang kita cegah. Penjaga ini adalah LAPIS TAMBAHAN, bukan klaim keamanan: menonaktifkannya
 *   tidak pernah membuat sesuatu yang tidak aman jadi tampak aman.
 *
 * URUTAN TIDAK DIHITUNG (di dalam tiap grup):
 *   Digest per-transaksi DIURUTKAN sebelum digabung, jadi frontend yang menandatangani/mengirim
 *   dalam urutan berbeda TIDAK dianggap basi. Batch basi tetap ketahuan: blockhash-nya baru →
 *   byte pesannya berbeda → digest-nya berbeda. Grup `transactions` dan `delistTransactions`
 *   tetap DIPISAH (CC memvalidasi keduanya sebagai dua set terpisah).
 */

/** Domain separation — supaya hash ini tidak pernah bisa dikelirukan dengan hash lain. */
const DOMAIN = 'hoshi.cc-shipping.burn-txset.v1';

/** Batas akal sehat Solana: satu transaksi tak mungkin butuh lebih dari 19 penanda tangan. */
const MAX_SIGNATURES = 19;
const SIGNATURE_BYTES = 64;
/** Pesan terpendek yang masuk akal: 3 byte header + 1 byte panjang akun. */
const MIN_MESSAGE_BYTES = 4;

/** compact-u16 (shortvec) Solana: sampai 3 byte, 7 bit per byte, bit 0x80 = lanjut. */
function decodeShortVec(
  buf: Buffer,
  offset: number,
): { value: number; size: number } | null {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null;
    const byte = buf[offset + size];
    value |= (byte & 0x7f) << (size * 7);
    size += 1;
    if ((byte & 0x80) === 0) break;
    if (size >= 3) return null;
  }
  return { value, size };
}

/**
 * Buang array tanda tangan dari satu transaksi base64 → kembalikan byte PESAN-nya.
 * null = bukan transaksi Solana yang bisa kita baca (mis. blob sintetis mock) → tidak terverifikasi.
 */
export function transactionMessageBytes(b64: string): Buffer | null {
  if (typeof b64 !== 'string' || b64.length === 0) return null;
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (raw.length < 1 + SIGNATURE_BYTES + MIN_MESSAGE_BYTES) return null;

  const prefix = decodeShortVec(raw, 0);
  if (prefix === null) return null;
  if (prefix.value < 1 || prefix.value > MAX_SIGNATURES) return null;

  const messageStart = prefix.size + prefix.value * SIGNATURE_BYTES;
  if (raw.length < messageStart + MIN_MESSAGE_BYTES) return null;
  const message = raw.subarray(messageStart);

  // Keaslian: jumlah slot tanda tangan HARUS sama dengan numRequiredSignatures di header pesan.
  const first = message[0];
  const requiredSignatures =
    (first & 0x80) !== 0
      ? // v0+: byte pertama = 0x80|versi, numRequiredSignatures ada di byte berikutnya.
        message.length >= MIN_MESSAGE_BYTES + 1
        ? message[1]
        : -1
      : first;
  if (requiredSignatures !== prefix.value) return null;

  return message;
}

/** sha256 hex dari byte pesan satu transaksi. */
function messageDigest(b64: string): string | null {
  const message = transactionMessageBytes(b64);
  if (message === null) return null;
  return createHash('sha256').update(message).digest('hex');
}

/** Digest seluruh grup (urutan tidak dihitung). null bila ada satu entri pun yang tak terbaca. */
function groupDigests(entries: readonly string[]): string[] | null {
  const digests: string[] = [];
  for (const entry of entries) {
    const digest = messageDigest(entry);
    if (digest === null) return null;
    digests.push(digest);
  }
  digests.sort();
  return digests;
}

/**
 * Identitas satu set transaksi burn yang diterbitkan CC untuk satu shipment.
 *
 * @returns hex sha256, atau `null` kalau set-nya TIDAK BISA dikanonikalisasi (lihat fail-open di
 *          atas). `null` WAJIB diperlakukan sebagai "tidak terverifikasi" — bukan "tidak cocok".
 */
export function burnTxSetIdentity(input: {
  outboundShipmentId: string;
  transactions: readonly string[];
  delistTransactions: readonly string[];
}): string | null {
  if (
    typeof input.outboundShipmentId !== 'string' ||
    input.outboundShipmentId.length === 0
  ) {
    return null;
  }
  if (!Array.isArray(input.transactions) || input.transactions.length === 0) {
    return null;
  }
  const burn = groupDigests(input.transactions);
  if (burn === null) return null;
  const delist = groupDigests(input.delistTransactions ?? []);
  if (delist === null) return null;

  const hash = createHash('sha256');
  hash.update(DOMAIN);
  hash.update('\nshipment:');
  hash.update(input.outboundShipmentId);
  hash.update(`\nburn:${burn.length}\n`);
  for (const digest of burn) hash.update(`${digest}\n`);
  hash.update(`delist:${delist.length}\n`);
  for (const digest of delist) hash.update(`${digest}\n`);
  return hash.digest('hex');
}
