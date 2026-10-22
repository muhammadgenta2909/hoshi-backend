/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ PEMBACAAN ENV TARIF KURIR (BITESHIP) — SATU ATURAN, DIPAKAI SAAT BOOT *DAN* SAAT JALAN.  ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * File ini SENGAJA TANPA IMPORT APA PUN — pola yang sama dengan `escrow/sponsor-cap-env.ts` dan
 * `collectorcrypt/cc-shipping-mock.mount.ts`: validasi environment berjalan paling awal saat boot
 * dan tidak boleh menarik Nest hanya untuk membaca sebuah string. Itulah yang membuat
 * `config/env.validation.ts` (yang MEMPERINGATKAN saat boot) dan `payments/biteship-rate.client.ts`
 * (yang benar-benar MEMANGGIL API-nya) memakai aturan yang PERSIS SAMA, bukan dua salinan yang
 * bisa menyimpang diam-diam.
 *
 * ┌──── KEADAAN PRODUKSI HARI INI: SEMUA VAR DI SINI KOSONG ───────────────────────────────────┐
 * │ Tanpa BITESHIP_API_KEY, lapis tarif kurir DIAM SEPENUHNYA — bukan error, bukan warning saat │
 * │ dipakai, bukan apa-apa. Resolusi ongkir berjalan PERSIS seperti sebelum file ini ada        │
 * │ (baris DB → env flat → tier penampung). Itu keadaan produksi hari ini dan ia tidak boleh    │
 * │ rusak hanya karena lapis baru ditambahkan di atasnya.                                       │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 */

/* ═══════════════════════════ NAMA ENV ═══════════════════════════ */

/**
 * Kunci API Biteship (`biteship_live.…` / `biteship_test.…`). KOSONG = lapis tarif kurir MATI.
 * RAHASIA: tidak pernah dikirim ke browser, dan setiap teks yang dilog disaring `redactApiKey`.
 */
export const BITESHIP_API_KEY_ENV = 'BITESHIP_API_KEY';

/** Kode pos GUDANG HOSHI (asal kiriman), 5 digit. Tanpa ini, API tidak bisa menghitung apa pun. */
export const BITESHIP_ORIGIN_POSTAL_CODE_ENV = 'BITESHIP_ORIGIN_POSTAL_CODE';

/** Daftar kode kurir yang benar-benar kita pakai, dipisah koma, mis. "jne,sicepat,jnt". */
export const BITESHIP_COURIERS_ENV = 'BITESHIP_COURIERS';

/** Berat satu kiriman dalam GRAM. Kosong = BITESHIP_DEFAULT_WEIGHT_GRAMS. */
export const BITESHIP_WEIGHT_GRAMS_ENV = 'BITESHIP_WEIGHT_GRAMS';

/** Base URL API. Kosong = BITESHIP_DEFAULT_BASE_URL. Ada supaya staging bisa diarahkan ke mock. */
export const BITESHIP_BASE_URL_ENV = 'BITESHIP_BASE_URL';

/* ═══════════════════════════ NILAI BAWAAN ═══════════════════════════ */

/** Base URL produksi Biteship. Kunci `biteship_test.…` memakai host yang SAMA (mode ikut kunci). */
export const BITESHIP_DEFAULT_BASE_URL = 'https://api.biteship.com';

/** Endpoint tarif. POST, body JSON. */
export const BITESHIP_RATES_PATH = '/v1/rates/couriers';

/**
 * Kurir bawaan kalau BITESHIP_COURIERS kosong. SENGAJA PENDEK dan SENGAJA hanya berisi kurir
 * reguler nasional yang pasti dikenal Biteship: satu kode kurir yang tidak dikenal membuat
 * Biteship menolak SELURUH request (400), dan lapis ini lalu diam — jadi daftar bawaan yang
 * "lengkap" justru arah gagal yang buruk. Tambah kurir lewat env, bukan lewat deploy.
 */
export const BITESHIP_DEFAULT_COURIERS = 'jne,sicepat,jnt';

/**
 * Berat bawaan satu kiriman, GRAM.
 *
 * Satu slab kartu ter-grading ±90 g; dengan bubble wrap dan kardus kecil, satu paket Hoshi ada di
 * kisaran 150–200 g. Dipilih 250 g — DI ATAS taksiran itu, dengan sengaja: berat yang KURANG
 * menghasilkan tarif yang KURANG, dan tarif yang kurang berarti kita menagih pembeli lebih murah
 * daripada ongkos yang benar-benar dibayar ke kurir. Arah gagal yang mahal harus ditanggung
 * angka bawaan, bukan pembelinya. (Kurir domestik menagih per kg dibulatkan ke atas, jadi 150 g
 * dan 250 g praktis selalu jatuh di pita tarif yang sama — ini murni jaring pengaman.)
 */
export const BITESHIP_DEFAULT_WEIGHT_GRAMS = 250;

/** Kode pos Indonesia: TEPAT 5 digit. */
const POSTAL_CODE_RE = /^\d{5}$/;

/** Berat yang masih masuk akal untuk satu paket kartu (gram). Di luar ini = salah ketik. */
const WEIGHT_MIN_GRAMS = 1;
const WEIGHT_MAX_GRAMS = 30_000;

/* ═══════════════════════════ PEMBACAAN ═══════════════════════════ */

/** Bentuk konfigurasi yang SUDAH divalidasi — satu-satunya bentuk yang boleh memanggil API. */
export interface BiteshipConfig {
  apiKey: string;
  originPostalCode: string;
  /** Sudah dinormalkan: huruf kecil, tanpa spasi, tanpa duplikat, dipisah koma. */
  couriers: string;
  weightGrams: number;
  /** Tanpa garis miring di ujung. */
  baseUrl: string;
}

const str = (env: (key: string) => string | undefined, key: string): string =>
  (env(key) ?? '').trim();

/**
 * Apakah lapis tarif kurir DIMINTA sama sekali? Satu-satunya saklarnya adalah kunci API.
 *
 * Dipisah dari `readBiteshipConfig` supaya "tidak diminta" (→ DIAM) tidak pernah tertukar dengan
 * "diminta tapi setengah jadi" (→ LOG KERAS). Keduanya sama-sama menghasilkan `null`, tapi yang
 * satu keadaan normal dan yang satu kesalahan operator yang harus terlihat.
 */
export const isBiteshipRequested = (
  env: (key: string) => string | undefined,
): boolean => str(env, BITESHIP_API_KEY_ENV).length > 0;

/**
 * Normalkan daftar kurir: huruf kecil, buang spasi, buang yang kosong, buang duplikat.
 * Duplikat tidak salah, tapi ia membuat body request dan log jadi lebih berisik tanpa guna.
 */
export function normalizeCouriers(raw: string): string {
  const parts = raw
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0);
  return [...new Set(parts)].join(',');
}

/**
 * Daftar MASALAH konfigurasi Biteship, dalam kalimat yang bisa langsung dibaca operator.
 * Kosong = konfigurasinya utuh ATAU lapis ini memang tidak dipakai (kunci API kosong).
 *
 * Dipakai DUA kali dengan sikap berbeda, dan perbedaannya disengaja:
 *   • saat BOOT  — dicetak sebagai peringatan (lihat warnIfBiteshipConfigIncomplete);
 *   • saat JALAN — dilog sebagai error oleh klien, lalu lapisnya dilewati.
 */
export function biteshipConfigProblems(
  env: (key: string) => string | undefined,
): string[] {
  if (!isBiteshipRequested(env)) return [];
  const problems: string[] = [];

  const origin = str(env, BITESHIP_ORIGIN_POSTAL_CODE_ENV);
  if (!origin) {
    problems.push(
      `${BITESHIP_API_KEY_ENV} terisi tetapi ${BITESHIP_ORIGIN_POSTAL_CODE_ENV} KOSONG. ` +
        'Tanpa kode pos gudang asal, tarif kurir tidak bisa dihitung sama sekali — isi kode pos ' +
        'gudang Hoshi, mis. BITESHIP_ORIGIN_POSTAL_CODE=12440.',
    );
  } else if (!POSTAL_CODE_RE.test(origin)) {
    problems.push(
      `${BITESHIP_ORIGIN_POSTAL_CODE_ENV}="${origin}" bukan kode pos Indonesia (harus TEPAT 5 ` +
        'digit, mis. 12440).',
    );
  }

  const couriers = normalizeCouriers(str(env, BITESHIP_COURIERS_ENV));
  const rawCouriers = str(env, BITESHIP_COURIERS_ENV);
  if (rawCouriers && !couriers) {
    problems.push(
      `${BITESHIP_COURIERS_ENV}="${rawCouriers}" tidak memuat satu pun kode kurir. Isi daftar ` +
        `dipisah koma, mis. ${BITESHIP_DEFAULT_COURIERS}.`,
    );
  }

  const weightRaw = str(env, BITESHIP_WEIGHT_GRAMS_ENV);
  if (weightRaw && readWeightGrams(weightRaw) === null) {
    problems.push(
      `${BITESHIP_WEIGHT_GRAMS_ENV}="${weightRaw}" bukan berat gram yang masuk akal (bilangan ` +
        `bulat ${WEIGHT_MIN_GRAMS}–${WEIGHT_MAX_GRAMS}). Dipakai bawaan ` +
        `${BITESHIP_DEFAULT_WEIGHT_GRAMS} g.`,
    );
  }

  const baseUrl = str(env, BITESHIP_BASE_URL_ENV);
  if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    problems.push(
      `${BITESHIP_BASE_URL_ENV}="${baseUrl}" bukan URL lengkap berikut protokolnya, mis. ` +
        `${BITESHIP_DEFAULT_BASE_URL}.`,
    );
  }

  return problems;
}

/**
 * Baca berat GRAM. Hanya digit desimal yang diterima — bukan `Number(raw)`, karena `Number("")`=0,
 * `Number(" 2e2")`=200 dan `Number("0x10")`=16; untuk sebuah angka yang ikut menentukan tarif,
 * "kira-kira terbaca" sama buruknya dengan salah baca. `null` = tidak terbaca.
 */
export function readWeightGrams(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < WEIGHT_MIN_GRAMS || parsed > WEIGHT_MAX_GRAMS) return null;
  return parsed;
}

/**
 * Konfigurasi siap-pakai, atau `null` kalau lapis ini tidak bisa dipakai.
 *
 * `null` punya DUA arti yang dibedakan pemanggil lewat `isBiteshipRequested`:
 *   • kunci API kosong          → lapis tidak diminta. DIAM.
 *   • kunci ada, sisanya cacat  → kesalahan operator. LOG KERAS, lalu lewati lapisnya.
 *
 * Nilai yang PUNYA bawaan aman (kurir, berat, base URL) TIDAK pernah membuat fungsi ini `null`:
 * bawaan yang benar lebih baik daripada mematikan lapis tarif nyata gara-gara satu salah ketik
 * di var yang tidak esensial. Salah ketiknya tetap dilaporkan `biteshipConfigProblems`.
 */
export function readBiteshipConfig(
  env: (key: string) => string | undefined,
): BiteshipConfig | null {
  const apiKey = str(env, BITESHIP_API_KEY_ENV);
  if (!apiKey) return null;

  const originPostalCode = str(env, BITESHIP_ORIGIN_POSTAL_CODE_ENV);
  if (!POSTAL_CODE_RE.test(originPostalCode)) return null;

  const couriers =
    normalizeCouriers(str(env, BITESHIP_COURIERS_ENV)) ||
    BITESHIP_DEFAULT_COURIERS;

  const weightGrams =
    readWeightGrams(str(env, BITESHIP_WEIGHT_GRAMS_ENV)) ??
    BITESHIP_DEFAULT_WEIGHT_GRAMS;

  const rawBase = str(env, BITESHIP_BASE_URL_ENV);
  const baseUrl = (
    /^https?:\/\/[^\s]+$/i.test(rawBase) ? rawBase : BITESHIP_DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  return { apiKey, originPostalCode, couriers, weightGrams, baseUrl };
}

/** Kode pos TUJUAN dari alamat user. `null` = tidak bisa dipakai memanggil API. */
export function readDestinationPostalCode(
  zip: string | null | undefined,
): string | null {
  const trimmed = typeof zip === 'string' ? zip.trim() : '';
  return POSTAL_CODE_RE.test(trimmed) ? trimmed : null;
}

/* ═══════════════════════════ PENYARINGAN RAHASIA ═══════════════════════════ */

/**
 * Buang kunci API dari teks apa pun SEBELUM ia masuk log atau pesan exception.
 *
 * KENAPA ADA SAMA SEKALI, padahal kita tidak pernah menulis kunci ke log dengan sengaja: teks yang
 * dilog di sini sebagian datang dari BODY RESPONS PIHAK KETIGA, dan gateway yang menolak sebuah
 * kredensial memang lumrah menggemakannya kembali ("invalid token: biteship_live.xxx"). Log kita
 * dikirim ke penyimpanan log droplet dan dibaca banyak mata. Satu `replaceAll` adalah harga yang
 * sangat murah untuk jaminan bahwa kunci tidak bisa bocor lewat jalur itu.
 *
 * Disaring juga PREFIX-nya (`biteship_live.` / `biteship_test.` sampai spasi berikutnya), supaya
 * kunci LAIN — mis. kunci lama yang masih disebut pesan error Biteship — ikut tersaring.
 */
export function redactApiKey(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join('[REDACTED]');
  return out.replace(/biteship_(live|test)\.[A-Za-z0-9._-]+/g, '[REDACTED]');
}
