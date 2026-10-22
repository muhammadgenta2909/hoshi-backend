import { createHash, randomInt } from 'node:crypto';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KODE KLAIM TITIPAN — secarik kertas yang BERPINDAH TANGAN BERSAMA KARTUNYA.                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * MASALAH YANG DISELESAIKANNYA. PM mendatangi kolektor lokal di rumahnya. Kolektor itu belum punya
 * akun Hoshi, dan tidak ada seorang pun yang bisa mengetikkan id database di ponsel sambil pemilik
 * kartunya berdiri di depannya. Kartunya tetap harus bisa diterima HARI ITU JUGA, dan pemiliknya
 * tetap harus bisa dihubungkan ke catatan itu NANTI, tanpa Hoshi perlu menebak siapa dia.
 *
 * KENAPA KODE INI KUAT, dan satu-satunya alasannya: ia berpindah tangan PADA DETIK YANG SAMA
 * dengan kartunya, di tanda terima bertanda tangan yang dipegang pemiliknya. Siapa pun yang
 * memegang kode ini ADALAH orang yang menyerahkan kartunya. Kekuatannya BUKAN dari kerahasiaan
 * saluran (tidak ada saluran — kertas), melainkan dari SERAH-TERIMA FISIK yang sudah terjadi dan
 * sudah difoto.
 *
 * KENAPA BUKAN EMAIL. `User.email` di schema ini `String?` — TIDAK unik dan TIDAK PERNAH
 * diverifikasi; siapa pun bisa mengetik alamat orang lain di setelan profilnya sendiri. Hanya
 * `walletAddress` yang `@unique`. Menautkan kartu senilai puluhan juta Rupiah ke siapa pun yang
 * MENGAKU memiliki sebuah alamat email adalah kelas bug terburuk yang bisa dipunyai fitur ini.
 *
 * ── SIFAT KODENYA ─────────────────────────────────────────────────────────────────────────────
 *
 *  BENTUK      10 simbol Crockford Base32 (`0-9` + huruf TANPA I, L, O, U), ditampilkan sebagai
 *              dua kelompok lima: `4T9KM-2X7PQ`. Alfabetnya dipilih supaya kode yang DITULIS
 *              TANGAN di tanda terima lalu DIKETIK ULANG di ponsel tidak bisa salah baca:
 *              `normalizeClaimCode` memetakan O→0 dan I/L→1 secara deterministik, dan U memang
 *              tidak pernah dihasilkan (aturan Crockford: menghindari kata yang tidak sopan).
 *
 *  ENTROPI     32^10 = 2^50 ≈ 1,13 × 10^15 kemungkinan, dari `crypto.randomInt` (CSPRNG, uniform
 *              — 32 membagi habis rentangnya, jadi tidak ada bias modulo). Rute penukarannya
 *              dibatasi 5 percobaan/menit/IP (`@Throttle` di consignment.controller.ts). Pada laju
 *              itu, menebak SATU kode yang sedang hidup butuh ~10^8 tahun. Menambah panjang tidak
 *              menambah keamanan yang berarti; ia hanya menambah salah ketik.
 *
 *  PENYIMPANAN HANYA SHA-256-nya yang disimpan (`Consignment.claimCodeHash`). Teks kodenya ada
 *              TEPAT SEKALI dalam hidup proses: di body respons rute penerbitan. Ia TIDAK PERNAH
 *              di-log, TIDAK PERNAH masuk baris audit, dan TIDAK ADA rute yang bisa membacanya
 *              kembali — dump database, layar admin, maupun berkas log tidak memuat kode yang
 *              bisa dipakai. SHA-256 polos SUDAH CUKUP di sini justru karena entropinya 50 bit:
 *              tidak ada kamus untuk diserang, jadi KDF lambat hanya akan memperlambat penukaran
 *              yang jujur. (Bandingkan `passwordHash`, yang melindungi rahasia PILIHAN MANUSIA
 *              berentropi rendah — di sana KDF lambat memang wajib.)
 *
 *  SEKALI PAKAI Penukaran yang berhasil MENGOSONGKAN `claimCodeHash` di transaksi yang sama dengan
 *              penautan pemiliknya. Jadi "sekali pakai" bukan janji kode melainkan bentuk baris:
 *              sesudah ditukarkan, kode itu tidak cocok dengan apa pun di tabel.
 *
 *  KEDALUWARSA 30 hari (`CLAIM_CODE_TTL_DAYS`). Cukup panjang supaya pemiliknya tidak terburu-buru
 *              membuat akun, cukup pendek supaya secarik kertas yang tertinggal di laci setahun
 *              BUKAN kunci yang masih hidup. Kertas hilang / kode kedaluwarsa BUKAN jalan buntu:
 *              admin menerbitkan ulang (POST /admin/consignments/:id/claim-code), dan penerbitan
 *              ulang MENIMPA hash yang lama — kertas lama langsung mati.
 */

/**
 * Alfabet Crockford Base32. 32 simbol, TANPA `I`, `L`, `O`, `U`.
 *
 * I/L/O dibuang karena tertukar dengan 1/1/0 pada tulisan tangan; U dibuang mengikuti Crockford
 * supaya kode acak tidak pernah tidak sengaja mengeja kata yang tidak pantas di tanda terima
 * bertanda tangan milik orang lain.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 10 simbol × 5 bit = 50 bit entropi. Lihat blok di atas untuk hitungannya. */
export const CLAIM_CODE_LENGTH = 10;

/** Umur kode klaim sejak diterbitkan. Lihat blok di atas. */
export const CLAIM_CODE_TTL_DAYS = 30;

/** Ukuran kelompok saat kode dicetak di tanda terima: `4T9KM-2X7PQ`. */
const GROUP = 5;

/**
 * Kode klaim BARU. `crypto.randomInt` (CSPRNG) dipanggil per simbol; karena 32 membagi habis
 * rentangnya, distribusinya seragam tanpa bias modulo.
 *
 * NILAI KEMBALIANNYA ADALAH RAHASIA. Pemanggil hanya boleh: (a) menyimpan `hashClaimCode(kode)`,
 * dan (b) mengembalikan teksnya SEKALI di body respons. JANGAN di-log, jangan ditulis ke baris
 * audit, jangan disimpan di kolom mana pun.
 */
export function generateClaimCode(): string {
  let out = '';
  for (let i = 0; i < CLAIM_CODE_LENGTH; i++) {
    out += ALPHABET[randomInt(0, ALPHABET.length)];
  }
  return out;
}

/**
 * Bentuk cetak untuk tanda terima: `4T9KM-2X7PQ`. Tanda hubungnya KOSMETIK —
 * `normalizeClaimCode` membuangnya, jadi pemilik kartu boleh mengetik dengan atau tanpa tanda
 * hubung, huruf besar atau kecil.
 */
export function formatClaimCode(code: string): string {
  const groups: string[] = [];
  for (let i = 0; i < code.length; i += GROUP) {
    groups.push(code.slice(i, i + GROUP));
  }
  return groups.join('-');
}

/**
 * Bentuk KANONIK dari apa pun yang diketik manusia, atau `null` kalau bentuknya tidak mungkin
 * menjadi kode klaim.
 *
 * Toleransi yang DISENGAJA (kertas → ponsel), semuanya deterministik:
 *   • huruf kecil  → huruf besar
 *   • spasi, tanda hubung, garis bawah → dibuang
 *   • `O`/`o` → `0`, `I`/`i`/`L`/`l` → `1`   (aturan Crockford; inilah alasan alfabetnya begitu)
 *
 * SEMUA yang lain ditolak — termasuk `U` (tidak pernah dihasilkan) dan panjang yang tidak tepat.
 * `null` di sini BUKAN pesan untuk pengguna: pemanggil WAJIB menjawabnya dengan penolakan yang
 * SAMA PERSIS dengan penolakan "kode tidak ditemukan", supaya bentuk kode pun tidak bocor.
 */
export function normalizeClaimCode(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (ch === '-' || ch === ' ' || ch === '_') continue;
    const mapped = ch === 'O' ? '0' : ch === 'I' || ch === 'L' ? '1' : ch;
    if (!ALPHABET.includes(mapped)) return null;
    out += mapped;
    if (out.length > CLAIM_CODE_LENGTH) return null;
  }
  return out.length === CLAIM_CODE_LENGTH ? out : null;
}

/**
 * SHA-256 hex dari bentuk KANONIK. Satu-satunya nilai yang pernah menyentuh database.
 *
 * Pemanggil WAJIB memberi hasil `normalizeClaimCode`, bukan teks mentah — kalau tidak, `4t9km-2x7pq`
 * dan `4T9KM2X7PQ` akan menghasilkan dua hash berbeda untuk satu kode yang sama.
 */
export function hashClaimCode(normalized: string): string {
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** Kapan sebuah kode yang diterbitkan `now` berhenti berlaku. */
export function claimCodeExpiryFrom(now: Date): Date {
  return new Date(now.getTime() + CLAIM_CODE_TTL_DAYS * 24 * 60 * 60 * 1000);
}
