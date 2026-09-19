import { HttpStatus, Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DOMESTIC_ERROR_CODE,
  domesticError,
} from '../common/hoshi-domestic-shipping';
import { IDRX_MAX_MINT_IDR, IDRX_MIN_MINT_IDR } from './idrx-mint-bounds';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TARIF ONGKIR DOMESTIK — BERTINGKAT PER-WILAYAH (Jawa vs luar Jawa). TIER-nya DATA.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * PEMILIK PRODUK sudah memutuskan MODEL-nya (bertingkat per wilayah, mulai dari pembelahan baku
 * Indonesia: Jawa vs luar Jawa) tapi BELUM memutuskan daftar tier finalnya maupun ANGKA-nya, dan
 * sudah menyatakan mungkin ingin pembelahan yang lebih halus nanti. Maka file ini disusun supaya
 * MENAMBAH TIER TIDAK PERNAH BUTUH PERUBAHAN KODE:
 *
 *   • Sebuah TIER = SATU BARIS di tabel `domestic_shipping_rates`. Barisnya membawa harganya
 *     (`priceIdr`) DAN daftar provinsi miliknya (`provinces`) — jadi "provinsi mana masuk tier
 *     mana" adalah DATA, bukan `switch` di kode.
 *   • Menambah tier          = satu PUT /api/admin/shipping/domestic-rates dengan scope baru.
 *   • Memindah satu provinsi = edit `provinces` di dua baris lewat rute yang sama.
 *   • Satu provinsi berharga sendiri = baris ber-scope `STATE:<provinsi>` (tanpa daftar provinces).
 *   Nol deploy, nol migrasi, nol restart untuk ketiganya.
 *
 * Konstanta di file ini HANYA menyediakan LAPIS DASAR ketika belum ada satu pun baris: dua tier
 * PENAMPUNG yang angkanya SENGAJA dibuat kelihatan sebagai penampung (lihat DOMESTIC_DEFAULT_TIERS
 * dan labelnya). Ia ada supaya jalurnya bisa jalan end-to-end sebelum keputusan pemilik turun —
 * BUKAN supaya ia jadi harga yang dipakai selamanya.
 *
 * ┌──────────────────── LAPIS RESOLUSI, dari yang paling spesifik ─────────────────────────────┐
 * │ 1. baris DB AKTIF ber-scope `STATE:<provinsi>`   → harga khusus satu provinsi               │
 * │ 2. baris DB AKTIF yang `provinces`-nya memuat provinsi tujuan → TIER wilayah                │
 * │ 3. baris DB AKTIF ber-`fallback=true`            → tier penampung (provinsi tak dikenal)    │
 * │ 4. baris DB AKTIF ber-scope '*'                  → flat nasional (bentuk LAMA, tetap sah)   │
 * │ 5. env HOSHI_DOMESTIC_SHIPPING_FLAT_IDR          → flat nasional yang diputuskan operator   │
 * │ 6. DOMESTIC_DEFAULT_TIERS (penampung di kode)    → Jawa / luar Jawa                         │
 * │ 7. DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER        → jaring terakhir                          │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * NOL DANA TREASURY di seluruh file ini: ia hanya MENGHITUNG nominal Rupiah yang akan ditagihkan
 * ke user. Tidak ada USDC, tidak ada plafon treasury yang relevan (jalur domestik tidak pernah
 * mendanai apa pun), dan karena itu jalur ini SENGAJA tidak memanggil assertTreasuryCapacity —
 * memanggilnya justru akan MENOLAK pengiriman gara-gara plafon dana yang tak pernah dipakai.
 */

/* ═══════════════════════════════ BENTUK SCOPE ═══════════════════════════════ */

/** Scope tarif FLAT NASIONAL — bentuk LAMA, tetap sah, dan tetap jadi jaring di lapis 4. */
export const DOMESTIC_RATE_SCOPE_NATIONWIDE = '*';

/** Prefix scope sebuah TIER wilayah. Isinya bebas: `TIER:JAWA`, `TIER:SUMATRA`, `TIER:TIMUR`, … */
export const DOMESTIC_RATE_SCOPE_TIER_PREFIX = 'TIER:';

/**
 * Prefix scope harga KHUSUS SATU PROVINSI — pembelahan paling halus, dan jalan keluar kalau satu
 * provinsi ternyata butuh angkanya sendiri tanpa membuat tier baru.
 * Nilai sesudah prefix dicocokkan SETELAH dinormalkan (lihat normalizeRegionKey), jadi
 * `STATE:DKI Jakarta` dan `STATE:dki jakarta` adalah scope yang sama.
 */
export const DOMESTIC_RATE_SCOPE_STATE_PREFIX = 'STATE:';

/* ═══════════════════════════ NEGARA: GERBANG, BUKAN TARIF ═══════════════════════════ */

/**
 * Nama/kode negara yang dibaca sebagai INDONESIA.
 *
 * KENAPA ADA GERBANG NEGARA SAMA SEKALI. Buku alamat user adalah buku alamat DUNIA: pemilih
 * negaranya memuat ~250 negara, dan ketika CSC_API_KEY kosong ia MEROSOT JADI INPUT TEKS BEBAS
 * (components/account/AddAddressModal.tsx di frontend). Tanpa gerbang ini, alamat di Amerika akan
 * ditagih tarif "domestik" Rp 25.000 — paket yang tidak akan pernah bisa dikirim dengan uang itu,
 * dan yang berujung refund manual sesudah user merasa sudah membayar. Itu persis arah gagal
 * "menagih angka yang tidak masuk akal".
 *
 * Daftarnya sengaja LONGGAR ke arah MENERIMA (nama Indonesia, nama Inggris, ISO2/ISO3, dengan atau
 * tanpa kata "republik") karena teks bebas manusia bervariasi — tapi apa pun DI LUAR daftar ini
 * DITOLAK, bukan ditebak.
 *
 * MENAMBAH EJAAN BARU: di sini (butuh deploy). Ini gerbang KESELAMATAN, bukan harga — karena itu
 * ia sengaja TIDAK bisa diubah lewat dashboard: tidak ada operator yang boleh bisa "memperbaiki"
 * ongkir dengan cara diam-diam mengizinkan negara lain masuk jalur domestik.
 */
export const DOMESTIC_COUNTRY_ALIASES: readonly string[] = [
  'id',
  'idn',
  'indonesia',
  'republik indonesia',
  'republic of indonesia',
];

/* ═══════════════════════════ NORMALISASI NAMA WILAYAH ═══════════════════════════ */

/** Diakritik Unicode (combining marks) — dibuang supaya "Yogyakartá" = "yogyakarta". */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Bentuk baku sebuah nama wilayah untuk dicocokkan: huruf kecil, tanpa diakritik, tanda baca jadi
 * spasi, spasi dirapatkan.
 *
 * SENGAJA TIDAK membuang kata seperti "kepulauan"/"provinsi": membuang "kepulauan" akan MENYATUKAN
 * "Kepulauan Riau" dengan "Riau" — dua provinsi berbeda. Variasi ejaan ditangani DAFTAR ALIAS di
 * data (`provinces`), bukan tebakan algoritmik yang tidak bisa dilihat operator.
 */
export function normalizeRegionKey(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** true ⇔ alamat ini terbaca sebagai alamat INDONESIA. Fail-closed untuk apa pun yang lain. */
export function isIndonesianDestination(
  country: string | null | undefined,
): boolean {
  return DOMESTIC_COUNTRY_ALIASES.includes(normalizeRegionKey(country));
}

/* ═══════════════════════════ TIER PENAMPUNG (LAPIS 6) ═══════════════════════════ */

/**
 * ⚠️⚠️ ANGKA DI BAWAH ADALAH PENAMPUNG, BUKAN HARGA YANG DIPUTUSKAN PEMILIK PRODUK. ⚠️⚠️
 *
 * Dipakai HANYA kalau (a) tidak ada satu pun baris tarif AKTIF di DB dan (b) env
 * HOSHI_DOMESTIC_SHIPPING_FLAT_IDR kosong. Dipilih KONSERVATIF, bukan disurvei:
 *   • bulat besar, supaya jelas ia bukan hasil tarif kurir sungguhan;
 *   • ≥ Rp 20.000 (minimum mint IDRX) atau invoice ongkirnya TIDAK AKAN PERNAH BISA TERBIT;
 *   • tier penampung (luar Jawa) dibuat LEBIH MAHAL, supaya provinsi yang tidak dikenali tidak
 *     pernah ditagih kurang dari ongkos yang wajar.
 *
 * ┌──── PEMILIK PRODUK: DI SINI TEMPAT MENGGANTINYA (urut dari yang paling dianjurkan) ────────┐
 * │ 1. Dashboard admin — TANPA deploy, TANPA restart:                                          │
 * │      GET  /api/admin/shipping/domestic-rates   ← daftar tier + mana yang MASIH PENAMPUNG    │
 * │                                                  (`placeholder: true`) + `actionRequired`   │
 * │      PUT  /api/admin/shipping/domestic-rates                                                │
 * │        { "scope":"TIER:JAWA",      "priceIdr":22000, "label":"Jawa" }                       │
 * │        { "scope":"TIER:LUAR_JAWA", "priceIdr":45000, "label":"Luar Jawa", "fallback":true } │
 * │      Menambah tier baru = PUT dengan scope baru + daftar `provinces`-nya. NOL kode.         │
 * │ 2. Env droplet HOSHI_DOMESTIC_SHIPPING_FLAT_IDR=30000 (flat nasional; butuh restart).      │
 * │ 3. Konstanta di bawah (butuh deploy) — pilihan TERAKHIR.                                    │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 */
export interface DomesticTierSeed {
  scope: string;
  label: string;
  priceIdr: number;
  /** Nama provinsi yang SUDAH dinormalkan (normalizeRegionKey). */
  provinces: readonly string[];
  /** true = tier ini menampung provinsi yang tidak cocok ke mana pun. Seharusnya TEPAT SATU. */
  fallback: boolean;
}

/**
 * ⚠️ PENAMPUNG. Ongkir Jawa, sekaligus jaring terakhir flat nasional (lapis 7) — satu konstanta
 * supaya tidak ada dua angka "default" yang bisa melenceng.
 */
export const DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER = 25_000;

/** ⚠️ PENAMPUNG. Ongkir luar Jawa — sengaja LEBIH MAHAL (lihat blok di atas). */
export const DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER = 50_000;

/** Scope tier bawaan. Dipakai rute admin sebagai contoh, dan oleh lapis 6. */
export const DOMESTIC_TIER_JAWA = `${DOMESTIC_RATE_SCOPE_TIER_PREFIX}JAWA`;
export const DOMESTIC_TIER_LUAR_JAWA = `${DOMESTIC_RATE_SCOPE_TIER_PREFIX}LUAR_JAWA`;

/**
 * Enam provinsi Pulau Jawa, beserta EJAAN yang benar-benar akan muncul di kolom `state`.
 *
 * KENAPA ALIAS-nya BANYAK. Kolom itu diisi dari dropdown geo (countrystatecity.in, yang untuk
 * Indonesia memakai sebagian nama INGGRIS: "West Java", "Special Region of Yogyakarta") ATAU
 * DIKETIK BEBAS oleh user ketika CSC_API_KEY kosong ("Jabar", "DKI", "Jogja"). Daftar yang cuma
 * memuat nama resmi Indonesia akan melempar separuh pembeli Jawa ke tier luar Jawa — menagih
 * mereka lebih mahal tanpa alasan.
 *
 * Ini cuma NILAI AWAL: begitu ada baris DB, `provinces` di baris itulah yang dipakai, dan operator
 * bisa menambah ejaan lewat rute admin tanpa deploy.
 */
export const JAWA_PROVINCE_ALIASES: readonly string[] = [
  // DKI Jakarta
  'jakarta',
  'dki jakarta',
  'dki',
  'jakarta raya',
  'daerah khusus ibukota jakarta',
  'daerah khusus ibu kota jakarta',
  'special capital region of jakarta',
  'jakarta special capital region',
  // Jawa Barat
  'jawa barat',
  'jabar',
  'west java',
  // Jawa Tengah
  'jawa tengah',
  'jateng',
  'central java',
  // Jawa Timur
  'jawa timur',
  'jatim',
  'east java',
  // Banten
  'banten',
  // DI Yogyakarta
  'yogyakarta',
  'di yogyakarta',
  'diy',
  'daerah istimewa yogyakarta',
  'special region of yogyakarta',
  'yogyakarta special region',
  'jogja',
  'jogjakarta',
];

/**
 * Tier bawaan: PEMBELAHAN BAKU INDONESIA (Jawa vs luar Jawa), dengan luar Jawa sebagai PENAMPUNG.
 *
 * Perhatikan luar Jawa TIDAK mendaftar provinsinya satu per satu. Itu disengaja: daftar 32
 * provinsi non-Jawa yang ditulis tangan akan LUPA satu (provinsi baru, ejaan baru, nama Inggris
 * baru), dan yang terlupa itu akan jatuh ke... entah ke mana. Dengan luar Jawa sebagai penampung,
 * apa pun yang TIDAK terbaca sebagai Jawa otomatis masuk tier yang LEBIH MAHAL — arah gagal yang
 * tidak pernah mengirim gratis dan tidak pernah menagih kurang.
 *
 * Labelnya memuat kata PENAMPUNG dengan sengaja: ia ikut tampil di dashboard admin, jadi angka
 * yang belum diputuskan tidak bisa menyamar sebagai angka yang sudah diputuskan.
 */
export const DOMESTIC_DEFAULT_TIERS: readonly DomesticTierSeed[] = [
  {
    scope: DOMESTIC_TIER_JAWA,
    label: 'Jawa — PENAMPUNG, belum diputuskan pemilik produk',
    priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
    provinces: JAWA_PROVINCE_ALIASES,
    fallback: false,
  },
  {
    scope: DOMESTIC_TIER_LUAR_JAWA,
    label: 'Luar Jawa — PENAMPUNG, belum diputuskan pemilik produk',
    priceIdr: DOMESTIC_LUAR_JAWA_IDR_PLACEHOLDER,
    provinces: [],
    fallback: true,
  },
];

/** Env override (lapis 5). Sengaja string di env → divalidasi, bukan dipercaya. */
export const DOMESTIC_SHIPPING_FLAT_IDR_ENV =
  'HOSHI_DOMESTIC_SHIPPING_FLAT_IDR';

/* ═══════════════════════════ BENTUK HASIL ═══════════════════════════ */

/** Dari mana angka yang dipakai berasal — dikembalikan supaya admin/log bisa membuktikannya. */
export type DomesticRateSource = 'DB' | 'ENV' | 'DEFAULT_TIER' | 'PLACEHOLDER';

/** BAGAIMANA wilayah tujuan dipetakan ke tier — dikembalikan supaya bisa diaudit. */
export type DomesticRegionMatch =
  /** Baris `STATE:<provinsi>` — harga khusus satu provinsi. */
  | 'STATE'
  /** `provinces` sebuah tier memuat provinsi tujuan. */
  | 'TIER'
  /** Provinsi tujuan tidak cocok ke mana pun → tier penampung (`fallback=true`). */
  | 'FALLBACK_TIER'
  /** Tidak ada tier sama sekali → flat nasional / env / jaring terakhir. */
  | 'NATIONWIDE';

export interface DomesticShippingQuote {
  /** Ongkir Rupiah UTUH yang akan ditagihkan. */
  priceIdr: number;
  /** Scope baris/tier yang menang. */
  scope: string;
  source: DomesticRateSource;
  /** Label manusiawi tier yang menang (null kalau barisnya tidak punya). */
  label: string | null;
  /** Provinsi tujuan yang sudah dinormalkan — '' kalau alamatnya tidak menyebut provinsi/kota. */
  province: string;
  region: DomesticRegionMatch;
  /**
   * true = wilayahnya TIDAK dikenali (provinsi kosong atau tidak ada di daftar tier mana pun),
   * jadi harganya datang dari penampung. BUKAN error — tapi operator berhak melihatnya, karena ia
   * berarti "ada provinsi yang belum masuk daftar tier mana pun".
   */
  regionUnresolved: boolean;
}

/** Alamat tujuan seperlunya. */
export interface DomesticDestination {
  city: string;
  state: string | null;
  country: string;
}

/* ═══════════════════════════ VALIDASI NOMINAL ═══════════════════════════ */

/**
 * Batas kewajaran sebuah tarif. Ditegakkan di TIGA titik: saat BOOT (env — lihat
 * src/config/env.validation.ts), saat admin MENULIS (supaya salah ketik ditolak di depan
 * operator), dan saat jalur bayar MEMBACA (fail-closed, supaya baris yang entah bagaimana lolos
 * tidak menjelma invoice yang mustahil dibayar).
 *
 * Batas bawahnya BUKAN angka karangan: ia MINIMUM MINT IDRX. Tarif di bawahnya menghasilkan baris
 * yang kelihatan benar di dashboard tapi invoice-nya ditolak gateway — kegagalan yang baru terlihat
 * saat user pertama menekan "Bayar ongkir".
 */
export function assertSaneRate(priceIdr: number, scope?: string): void {
  if (
    !Number.isInteger(priceIdr) ||
    priceIdr < IDRX_MIN_MINT_IDR ||
    priceIdr > IDRX_MAX_MINT_IDR
  ) {
    throw domesticError({
      status: HttpStatus.BAD_REQUEST,
      code: DOMESTIC_ERROR_CODE.RATE_UNAVAILABLE,
      message:
        `Tarif ongkir domestik${scope ? ` (${scope})` : ''} harus bilangan bulat Rupiah antara ` +
        `Rp ${IDRX_MIN_MINT_IDR} dan Rp ${IDRX_MAX_MINT_IDR} (batas mint IDRX) — ` +
        `diberikan: ${priceIdr}.`,
    });
  }
}

/**
 * Gerbang alamat: jalur domestik HANYA melayani Indonesia.
 *
 * DITOLAK, bukan ditebak — dan penolakan ini tidak menjebak apa pun: barisnya tetap di REQUESTED,
 * yang punya jalan keluar (batal sendiri oleh user, atau batal/majukan oleh admin).
 */
export function assertServiceableDestination(dest: DomesticDestination): void {
  if (!isIndonesianDestination(dest.country)) {
    throw domesticError({
      status: HttpStatus.BAD_REQUEST,
      code: DOMESTIC_ERROR_CODE.ADDRESS_UNSUPPORTED,
      message:
        'Kirim domestik hanya untuk alamat di Indonesia, dan negara pada alamat tujuanmu ' +
        `terbaca sebagai "${dest.country}". Perbaiki negara di alamatmu lalu coba lagi — atau ` +
        'hubungi support kalau kartunya memang harus dikirim ke luar negeri.',
    });
  }
}

/* ═══════════════════════════ RESOLUSI ═══════════════════════════ */

/** Baris tarif seperlunya — bentuk struktural supaya `select` sempit tetap cocok. */
export interface DomesticRateRow {
  scope: string;
  priceIdr: number;
  provinces: string[];
  fallback: boolean;
  label: string | null;
}

/** `STATE:DKI Jakarta` dan `STATE:dki  jakarta` adalah scope yang SAMA. */
export function normalizeScope(scope: string): string {
  const trimmed = scope.trim();
  if (
    !trimmed.toUpperCase().startsWith(DOMESTIC_RATE_SCOPE_STATE_PREFIX.toUpperCase())
  ) {
    return trimmed;
  }
  return (
    DOMESTIC_RATE_SCOPE_STATE_PREFIX +
    normalizeRegionKey(trimmed.slice(DOMESTIC_RATE_SCOPE_STATE_PREFIX.length))
  );
}

/**
 * Pilih tier untuk satu provinsi dari sekumpulan baris. Dipisah dari I/O supaya bisa diuji tanpa
 * DB, DAN supaya lapis DB (1–4) dan lapis penampung (6) memakai ATURAN PENCOCOKAN YANG SAMA PERSIS
 * — dua implementasi pencocokan adalah dua implementasi yang bisa melenceng.
 *
 * AMBIGU (satu provinsi terdaftar di DUA tier, atau dua tier sama-sama `fallback`) = salah
 * konfigurasi. Yang dipilih adalah yang TERMAHAL, dan kejadiannya di-log sebagai error: arah itu
 * tidak pernah menagih kurang, dan operator tetap diberi tahu supaya bisa membereskan datanya.
 */
export function pickTier(
  rows: readonly DomesticRateRow[],
  province: string,
  logger?: Logger,
): { row: DomesticRateRow; region: DomesticRegionMatch } | null {
  const dearest = (xs: DomesticRateRow[]) =>
    xs.reduce((a, b) => (b.priceIdr > a.priceIdr ? b : a));

  // 1. Harga khusus satu provinsi.
  if (province) {
    const wanted = normalizeScope(
      `${DOMESTIC_RATE_SCOPE_STATE_PREFIX}${province}`,
    );
    const exact = rows.filter((r) => normalizeScope(r.scope) === wanted);
    if (exact.length > 0) return { row: dearest(exact), region: 'STATE' };
  }

  // 2. Tier yang daftar provinsinya memuat provinsi tujuan.
  if (province) {
    const hits = rows.filter((r) =>
      (r.provinces ?? []).some((p) => normalizeRegionKey(p) === province),
    );
    if (hits.length > 1) {
      logger?.error(
        `Provinsi '${province}' terdaftar di ${hits.length} tier ongkir sekaligus ` +
          `(${hits.map((h) => h.scope).join(', ')}). Dipakai yang TERMAHAL supaya tidak ada ` +
          'pengiriman yang ditagih kurang — tapi datanya perlu dibereskan lewat ' +
          'PUT /api/admin/shipping/domestic-rates.',
      );
    }
    if (hits.length > 0) return { row: dearest(hits), region: 'TIER' };
  }

  // 3. Tier penampung — provinsi kosong ATAU tidak dikenal.
  const fallbacks = rows.filter((r) => r.fallback === true);
  if (fallbacks.length > 0) {
    if (fallbacks.length > 1) {
      logger?.error(
        `Ada ${fallbacks.length} tier ongkir yang sama-sama ditandai fallback ` +
          `(${fallbacks.map((f) => f.scope).join(', ')}). Dipakai yang TERMAHAL. Seharusnya ` +
          'TEPAT SATU — bereskan lewat PUT /api/admin/shipping/domestic-rates.',
      );
    }
    return { row: dearest(fallbacks), region: 'FALLBACK_TIER' };
  }

  // 4. Flat nasional (bentuk lama).
  const nationwide = rows.filter(
    (r) => r.scope.trim() === DOMESTIC_RATE_SCOPE_NATIONWIDE,
  );
  if (nationwide.length > 0) {
    return { row: dearest(nationwide), region: 'NATIONWIDE' };
  }

  return null;
}

/**
 * Resolusi tarif untuk satu tujuan. Tujuh lapis (lihat blok kepala file), dan SETIAP hasilnya
 * divalidasi ulang ke batas mint IDRX.
 *
 * KEGAGALAN BACA DB tidak dianggap "tidak ada tarif": ia dilog KERAS dan jatuh ke lapis
 * berikutnya, karena satu blip DB tidak boleh menghentikan semua pengiriman domestik. Perhatikan
 * lapis berikutnya untuk provinsi luar Jawa tetap tier PENAMPUNG luar Jawa (lebih mahal), bukan
 * tarif Jawa — jadi blip DB pun tidak membuat kiriman luar Jawa ditagih tarif Jawa.
 *
 * ┌──── ARAH GAGAL — DIPILIH SADAR, DAN INI RINGKASANNYA ──────────────────────────────────────┐
 * │ • negara BUKAN Indonesia / tidak terbaca → DITOLAK (assertServiceableDestination).          │
 * │   Menagih ongkir domestik untuk paket internasional adalah "menagih angka yang tak masuk    │
 * │   akal", dan paketnya tidak akan pernah bisa dikirim dengan uang itu.                       │
 * │ • provinsi KOSONG atau TIDAK DIKENAL     → tier PENAMPUNG (termahal di antara fallback).    │
 * │   TIDAK ditolak: kolom `state` memang nullable dan banyak alamat Indonesia ditulis tanpa    │
 * │   provinsi; menolaknya akan memblokir pembeli yang sah. Tidak pernah gratis, tidak pernah   │
 * │   ditagih kurang — dan `regionUnresolved: true` membuatnya TERLIHAT, bukan senyap.          │
 * │ • angka TIDAK MASUK AKAL di lapis mana pun → DITOLAK (fail-closed). Lebih baik user melihat │
 * │   "ongkir belum bisa dihitung" daripada dikirimi tagihan Rp 1 yang ditolak gateway.         │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 */
export async function resolveDomesticShippingIdr(args: {
  prisma: PrismaService;
  logger: Logger;
  dest: DomesticDestination;
  /** Pembaca env (ConfigService.get). Opsional supaya mudah diuji. */
  env?: (key: string) => string | undefined;
}): Promise<DomesticShippingQuote> {
  const { prisma, logger, dest, env } = args;

  // GERBANG NEGARA — sebelum apa pun. Alamat luar negeri tidak punya "ongkir domestik".
  assertServiceableDestination(dest);

  // Provinsi dulu; kalau kosong, COBA KOTA sebagai nama provinsi. Banyak alamat Indonesia ditulis
  // dengan kota saja ("Jakarta"), dan kota itu memang nama provinsinya. Cuma DICOBA, tidak
  // diklaim: kalau kotanya tidak dikenal juga, hasilnya tetap tier penampung.
  const province =
    normalizeRegionKey(dest.state) || normalizeRegionKey(dest.city);

  // Tabel ini berisi SEGELINTIR baris (satu per tier), jadi seluruh baris aktif ditarik lalu
  // dipilih di sini. Itu juga yang membuat aturan pencocokan hidup di SATU fungsi (pickTier)
  // alih-alih separuh di SQL dan separuh di JS.
  let rows: DomesticRateRow[] = [];
  try {
    rows = await prisma.domesticShippingRate.findMany({
      where: { active: true },
      select: {
        scope: true,
        priceIdr: true,
        provinces: true,
        fallback: true,
        label: true,
      },
    });
  } catch (err) {
    logger.error(
      `Gagal membaca tarif ongkir domestik dari DB (${err instanceof Error ? err.message : String(err)}). ` +
        `Jatuh ke ${DOMESTIC_SHIPPING_FLAT_IDR_ENV} / tier penampung di kode.`,
    );
  }

  const fromDb = pickTier(rows, province, logger);
  if (fromDb) {
    assertSaneRate(fromDb.row.priceIdr, fromDb.row.scope);
    return {
      priceIdr: fromDb.row.priceIdr,
      scope: fromDb.row.scope,
      source: 'DB',
      label: fromDb.row.label ?? null,
      province,
      region: fromDb.region,
      regionUnresolved:
        fromDb.region === 'FALLBACK_TIER' || fromDb.region === 'NATIONWIDE',
    };
  }

  // Lapis 5 — flat nasional yang DIPUTUSKAN operator lewat env. Ia menang atas tier penampung di
  // kode karena ia keputusan manusia; tier penampung cuma nilai awal yang belum diputuskan.
  const raw = (env?.(DOMESTIC_SHIPPING_FLAT_IDR_ENV) ?? '').trim();
  if (raw) {
    const parsed = Number(raw);
    assertSaneRate(parsed, DOMESTIC_SHIPPING_FLAT_IDR_ENV);
    return {
      priceIdr: parsed,
      scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
      source: 'ENV',
      label: null,
      province,
      region: 'NATIONWIDE',
      regionUnresolved: true,
    };
  }

  // Lapis 6 — tier PENAMPUNG di kode, dicocokkan dengan ATURAN YANG SAMA (pickTier).
  const seeds: DomesticRateRow[] = DOMESTIC_DEFAULT_TIERS.map((t) => ({
    scope: t.scope,
    priceIdr: t.priceIdr,
    provinces: [...t.provinces],
    fallback: t.fallback,
    label: t.label,
  }));
  const fromSeed = pickTier(seeds, province, logger);
  if (fromSeed) {
    assertSaneRate(fromSeed.row.priceIdr, fromSeed.row.scope);
    return {
      priceIdr: fromSeed.row.priceIdr,
      scope: fromSeed.row.scope,
      source: 'DEFAULT_TIER',
      label: fromSeed.row.label ?? null,
      province,
      region: fromSeed.region,
      regionUnresolved: fromSeed.region === 'FALLBACK_TIER',
    };
  }

  // Lapis 7 — jaring terakhir. Hanya tercapai kalau DOMESTIC_DEFAULT_TIERS dikosongkan.
  assertSaneRate(DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER);
  return {
    priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
    scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
    source: 'PLACEHOLDER',
    label: null,
    province,
    region: 'NATIONWIDE',
    regionUnresolved: true,
  };
}
