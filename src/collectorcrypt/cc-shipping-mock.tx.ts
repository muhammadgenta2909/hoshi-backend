import { createHash } from 'node:crypto';
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';

/**
 * TRANSAKSI SOLANA ASLI (tapi MATI) untuk mock CC Vault Shipping.
 *
 * KENAPA HARUS ASLI. Frontend menandatangani lewat `useSignSerializedTransaction`, yang melakukan
 * `VersionedTransaction.deserialize(bytes)` dengan fallback `Transaction.from(bytes)`. Versi mock
 * yang lama mengembalikan base64 dari JSON — kedua pemanggilan itu MELEMPAR, jadi dry-run di
 * browser mati persis di langkah tanda tangan: satu-satunya langkah yang paling perlu dilatih.
 * Maka leg burn/de-list sekarang adalah transaksi Solana betulan: bisa dideserialisasi, bisa
 * ditandatangani Phantom maupun Privy, bisa diserialisasi ulang, dan tetap kami kenali kembali.
 *
 * ══════════════════ KENAPA INI TIDAK BISA MEMINDAHKAN NILAI APA PUN ══════════════════
 * Tiga lapis, masing-masing sudah cukup sendirian:
 *
 *  1. INSTRUKSINYA TIDAK PUNYA KEWENANGAN APA PUN. Satu-satunya instruksi di dalamnya menunjuk
 *     SPL Memo program (`MemoSq4g…`) dengan `keys: []` — NOL akun. Memo hanya menuliskan datanya
 *     ke log transaksi; ia tidak punya CPI, tidak memegang akun mana pun, dan tidak bisa
 *     memindahkan lamport atau token. Tidak ada satu pun instruksi System / SPL-Token /
 *     Metaplex / burn di sini — bukan "kebetulan tidak ada", memang tidak pernah dibangun.
 *
 *  2. BLOCKHASH-NYA TIDAK PERNAH ADA. `recentBlockhash` adalah sha256 sintetis dari identitas
 *     leg (lihat syntheticBlockhash) — bukan blockhash yang pernah diterbitkan cluster mana pun.
 *     Validator menolak transaksi yang blockhash-nya tidak ada di antrean blockhash terkini
 *     (`BlockhashNotFound`), jadi transaksi ini tidak bisa DIPROSES sama sekali, apalagi
 *     memindahkan sesuatu. Ia juga tidak bisa "matang" kelak: blockhash ini tidak akan pernah
 *     muncul di antrean itu.
 *
 *  3. FEE PAYER-NYA WALLET USER SENDIRI. Seandainya dua lapis di atas runtuh sekaligus, satu-
 *     satunya nilai yang bisa berubah adalah biaya transaksi dari dompet user sendiri — bukan
 *     treasury, bukan kartu, bukan USDC. Tidak ada penerima dana di dalam transaksi ini.
 *
 * Konsekuensi yang DISENGAJA: Phantom akan menampilkan peringatan "simulasi gagal". Itu memang
 * benar dan memang harusnya begitu — transaksi ini TIDAK BOLEH bisa mendarat.
 *
 * ══════════════════ IDENTITAS LEG ══════════════════
 * Marker JSON (shipment / batch / jenis leg / index / mint) dibawa sebagai DATA memo, jadi ia ikut
 * di dalam BYTE PESAN. Menandatangani hanya mengisi slot tanda tangan dan TIDAK menyentuh pesan,
 * sehingga salinan yang sudah ditandatangani tetap kami kenali dengan marker yang sama — persis
 * seperti blob lama, tapi kini di atas transaksi sungguhan.
 *
 * EFEK SAMPING YANG MEMANG DIINGINKAN: `transactionMessageBytes` (cc-shipping.txset.ts) dulu
 * mengembalikan null untuk blob JSON → penjaga batch-basi DILEWATI (fail-open). Dengan transaksi
 * asli ia mengembalikan byte pesan yang stabil lintas tanda tangan → penjaga itu AKTIF beneran.
 */

/** SPL Memo v2. Dipilih justru karena ia program paling tidak berdaya di Solana. */
const MEMO_PROGRAM_ID = new PublicKey(
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
);

/** Penanda milik mock — dicari lagi saat burn untuk mencocokkan leg. */
export const MOCK_TX_MARKER = 'cc-mock-tx';

export interface MockLegMarker {
  /** marker konstan */
  m: string;
  /** outboundShipmentId */
  s: string;
  /** batchId */
  b: string;
  /** 'burn' | 'delist' */
  k: string;
  /** index di dalam grup-nya */
  i: number;
  /** nftAddress */
  n: string;
}

/**
 * Blockhash palsu yang DETERMINISTIK per leg: sha256 32 byte, base58. Deterministik supaya
 * `prepare` dengan input identik tetap menghasilkan byte BERBEDA antar batch (batchId ikut ke
 * dalam seed) — itulah yang membuat batch lama terdeteksi basi — tanpa pernah menyentuh jaringan.
 */
function syntheticBlockhash(seed: string): string {
  return bs58.encode(
    createHash('sha256')
      .update(`hoshi.cc-shipping-mock.blockhash.v1\n${seed}`)
      .digest(),
  );
}

/**
 * Fee payer. Wallet user kalau ada (jalur SIWS — inilah yang membuat Phantom/Privy mau
 * menandatangani: dompetnya memang penanda tangan yang diminta). Jalur API key tidak punya wallet,
 * jadi dipakai pubkey turunan deterministik dari userId — 32 byte yang sah sebagai alamat tapi
 * (hampir pasti) di luar kurva, sehingga tidak ada kunci privat mana pun yang memilikinya.
 */
function resolveFeePayer(walletOrUserId: {
  wallet?: string | null;
  userId: string;
}): PublicKey {
  const wallet = walletOrUserId.wallet;
  if (typeof wallet === 'string' && wallet.trim().length > 0) {
    try {
      return new PublicKey(wallet.trim());
    } catch {
      /* jatuh ke turunan di bawah */
    }
  }
  return new PublicKey(
    createHash('sha256')
      .update(`hoshi.cc-shipping-mock.payer.v1\n${walletOrUserId.userId}`)
      .digest(),
  );
}

/**
 * Bangun satu leg sebagai transaksi legacy base64 TANPA tanda tangan.
 *
 * Legacy (bukan v0) DISENGAJA: `VersionedTransaction.deserialize` menerima pesan legacy juga, jadi
 * bentuk ini lolos KEDUA cabang `deserialize()` di frontend — dan `Transaction.from` di cabang
 * fallback tetap bekerja untuk dompet yang lebih tua.
 */
export function encodeLeg(
  marker: Omit<MockLegMarker, 'm'>,
  owner: { wallet?: string | null; userId: string },
): string {
  const payload: MockLegMarker = { m: MOCK_TX_MARKER, ...marker };
  const tx = new Transaction();
  tx.feePayer = resolveFeePayer(owner);
  tx.recentBlockhash = syntheticBlockhash(
    `${marker.s}|${marker.b}|${marker.k}|${marker.i}|${marker.n}`,
  );
  tx.add(
    new TransactionInstruction({
      keys: [],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(JSON.stringify(payload), 'utf8'),
    }),
  );
  // requireAllSignatures:false — yang kami terbitkan memang belum ditandatangani siapa pun.
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

/** Semua data instruksi memo di dalam satu transaksi base64 (legacy maupun v0). */
function memoDatas(b64: string): Uint8Array[] {
  let raw: Buffer;
  try {
    raw = Buffer.from(String(b64), 'base64');
  } catch {
    return [];
  }
  if (raw.length === 0) return [];

  try {
    const vtx = VersionedTransaction.deserialize(raw);
    const keys = vtx.message.staticAccountKeys;
    return vtx.message.compiledInstructions
      .filter((ix) => keys[ix.programIdIndex]?.equals(MEMO_PROGRAM_ID))
      .map((ix) => ix.data);
  } catch {
    /* bukan bentuk versioned/legacy yang bisa dibaca di jalur itu — coba jalur legacy murni */
  }
  try {
    const tx = Transaction.from(raw);
    return tx.instructions
      .filter((ix) => ix.programId.equals(MEMO_PROGRAM_ID))
      .map((ix) => new Uint8Array(ix.data));
  } catch {
    return [];
  }
}

/**
 * Baca marker leg dari satu transaksi base64 — versi UNSIGNED maupun SIGNED sama-sama dikenali,
 * karena marker-nya hidup di byte pesan yang tidak berubah saat ditandatangani.
 *
 * null = bukan leg terbitan mock ini.
 */
export function decodeLeg(b64: string): MockLegMarker | null {
  for (const data of memoDatas(b64)) {
    try {
      const parsed: unknown = JSON.parse(Buffer.from(data).toString('utf8'));
      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as MockLegMarker).m === MOCK_TX_MARKER
      ) {
        return parsed as MockLegMarker;
      }
    } catch {
      /* instruksi memo lain — lanjut cari */
    }
  }
  return null;
}
