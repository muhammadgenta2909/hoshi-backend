/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ PEMBACAAN ENV PLAFON SPONSOR GAS — SATU ATURAN, DIPAKAI SAAT BOOT *DAN* SAAT JALAN.      ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * File ini SENGAJA TANPA IMPORT APA PUN — pola yang sama dengan cc-shipping-mock.mount.ts:
 * validasi environment berjalan paling awal saat boot dan tidak boleh menarik Nest atau
 * @solana/web3.js hanya untuk membaca sebuah angka. Itulah yang membuat `env.validation.ts`
 * (yang MENOLAK START) dan `escrow-fee-sponsor.ts` (yang MEMUTUSKAN plafon) bisa memakai aturan
 * yang PERSIS SAMA, bukan dua salinan yang bisa menyimpang diam-diam.
 *
 * MASALAH YANG DIPECAHKANNYA. Versi lama membaca keempat plafon dengan
 * `Number.isSafeInteger(parsed) && parsed > 0 ? parsed : default`. Artinya "0" — satu-satunya
 * cara operator menyatakan "HENTIKAN sponsor sekarang juga" di tengah insiden — diam-diam
 * berubah menjadi plafon default 0,02 SOL/hari. Begitu juga "-1", "off", dan salah ketik apa pun.
 * Untuk sebuah BATAS BELANJA arah kegagalannya terbalik: yang tidak terbaca justru MEMBUKA keran,
 * bukan menutupnya. (Kill switch `HOSHI_ESCROW_SPONSOR_FEE=false` memang sudah ada dan tetap
 * bekerja — tapi ia mematikan sponsor SELURUHNYA; file ini tentang keempat plafon angkanya.)
 *
 * TIGA HASIL PEMBACAAN, dan ketiganya BERBEDA:
 *
 *   • `unset`   — env tidak di-set (atau isinya kosong/spasi saja). Pakai default bawaan. Ini
 *                 keadaan NORMAL deployment yang tidak pernah menyentuh plafonnya. Kosong
 *                 diperlakukan SAMA dengan tidak di-set — konsisten dengan
 *                 TreasuryService.positiveIntConfig / TreasurySwapService.int, dan tidak lebih
 *                 longgar daripada "tidak di-set" (nilainya persis sama: default bawaan).
 *
 *   • `value`   — bilangan bulat >= 0, **TERMASUK 0**. `0` berarti NOL, bukan default. Untuk tiga
 *                 plafon pertama itu berarti "jangan sponsori apa pun"; untuk cadangan SOL escrow
 *                 itu berarti "tidak ada lantai cadangan" (pilihan sadar operator, dan satu-satunya
 *                 nilai di file ini yang arahnya melonggarkan — karena ia LANTAI, bukan plafon).
 *
 *   • `invalid` — di-set ke sesuatu yang bukan bilangan bulat non-negatif: "off", "-1", "1e5",
 *                 "5.5", "20_000", atau angka di atas MAX_SAFE_INTEGER. Ini KESALAHAN OPERATOR.
 *                 Backend MENOLAK START karenanya (lihat `validateEnv`), dengan alasan yang sama
 *                 seperti interlock cutover mainnet: gagal saat BOOT jauh lebih murah daripada
 *                 gagal — atau membelanjakan — di tengah jalur uang. Dan berbeda dari plafon
 *                 treasury (yang melempar saat DIPAKAI), plafon ini dibaca di jalur yang punya
 *                 jalan mundur "penjual bayar gas": melempar di sana akan ikut mematikan jalur
 *                 mundur itu untuk penjual yang tidak ada urusannya dengan salah ketik kita.
 */

/** Keempat env plafon sponsor gas. Urutannya = urutan yang dilaporkan saat boot ditolak. */
export const SPONSOR_CAP_ENV_KEYS = [
  'HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS',
  'HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS',
  'HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H',
  'HOSHI_ESCROW_SPONSOR_RESERVE_LAMPORTS',
] as const;

export type SponsorCapEnvKey = (typeof SPONSOR_CAP_ENV_KEYS)[number];

export type SponsorCapEnvReading =
  /** Tidak di-set (atau kosong) → pakai default bawaan. */
  | { kind: 'unset' }
  /** Bilangan bulat >= 0 yang dinyatakan operator secara eksplisit. 0 berarti NOL. */
  | { kind: 'value'; value: number }
  /** Di-set tapi tidak bisa dibaca sebagai bilangan bulat >= 0 → kesalahan operator. */
  | { kind: 'invalid'; raw: string };

/**
 * Baca SATU nilai plafon. Hanya digit desimal yang diterima: `^\d+$`.
 *
 * Kenapa seketat itu — bukan `Number(raw)`: `Number("")` = 0, `Number(" 1e5")` = 100000, dan
 * `Number("0x10")` = 16. Untuk batas belanja, "kira-kira terbaca" sama buruknya dengan salah
 * baca; yang tidak ditulis PERSIS sebagai bilangan bulat non-negatif lebih baik dilaporkan
 * sebagai kesalahan daripada ditebak.
 */
export function readSponsorCapEnv(raw: unknown): SponsorCapEnvReading {
  if (raw === undefined || raw === null) return { kind: 'unset' };
  // Sumber config bisa saja sudah mengubahnya jadi number (ConfigModule + implicit conversion).
  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= 0
      ? { kind: 'value', value: raw }
      : { kind: 'invalid', raw: String(raw) };
  }
  // Tipe lain (boolean/objek/array) tidak pernah bisa jadi plafon. SENGAJA tidak di-String():
  // objek akan tercetak "[object Object]" dan pesan boot-nya jadi tidak menolong siapa pun.
  if (typeof raw !== 'string')
    return { kind: 'invalid', raw: `<${typeof raw}>` };
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'unset' };
  if (!/^\d+$/.test(trimmed)) return { kind: 'invalid', raw: trimmed };
  const value = Number(trimmed);
  return Number.isSafeInteger(value)
    ? { kind: 'value', value }
    : { kind: 'invalid', raw: trimmed };
}

/**
 * Daftar kalimat "env plafon ini tidak bisa dibaca" untuk operator — KOSONG berarti keempatnya
 * baik (di-set benar atau memang tidak di-set). Dipakai `validateEnv` untuk menolak start.
 *
 * Pesannya menyebut apa yang harus DITULIS, bukan hanya apa yang salah: operator yang mengetik
 * `=off` sedang MENCOBA mematikan sponsor, dan dia perlu tahu bahwa ejaannya adalah `=0`.
 */
export function sponsorCapEnvProblems(
  config: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  for (const key of SPONSOR_CAP_ENV_KEYS) {
    const reading = readSponsorCapEnv(config[key]);
    if (reading.kind === 'invalid') {
      problems.push(
        `${key}="${reading.raw}" bukan bilangan bulat >= 0. Tulis angkanya apa adanya ` +
          `(mis. "20000000"), atau "0" untuk MENOLKANNYA, atau kosongkan variabelnya untuk ` +
          'memakai default bawaan. Nilai yang tidak terbaca TIDAK boleh diam-diam jadi default: ' +
          'ini batas belanja.',
      );
    }
  }
  return problems;
}
