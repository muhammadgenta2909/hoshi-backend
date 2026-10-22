import { Logger } from '@nestjs/common';
import {
  BITESHIP_API_KEY_ENV,
  BITESHIP_RATES_PATH,
  biteshipConfigProblems,
  isBiteshipRequested,
  readBiteshipConfig,
  readDestinationPostalCode,
  redactApiKey,
} from './biteship-rate-env';
import { IDRX_MAX_MINT_IDR, IDRX_MIN_MINT_IDR } from './idrx-mint-bounds';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TARIF ONGKIR NYATA DARI KURIR (Biteship) — LAPIS 0 resolusi ongkir domestik.                 ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Ia TIDAK menggantikan apa pun. Kalau ia tidak menghasilkan angka — karena belum dikonfigurasi,
 * karena Biteship mati, karena kuncinya salah, karena jawabannya cacat, atau karena angkanya tidak
 * masuk akal — resolusi lanjut ke lapis 1 dan seterusnya PERSIS seperti sebelum file ini ada.
 * Lihat blok kepala `domestic-shipping-rate.ts` untuk ketujuh lapis di bawahnya.
 *
 * KENAPA BITESHIP DAN BUKAN RAJAONGKIR. Biteship menerima KODE POS langsung
 * (`destination_postal_code`); RajaOngkir menuntut ID kota internal mereka, yang berarti kita harus
 * memelihara tabel pemetaan kota Indonesia — tabel yang pasti melenceng seiring kota dimekarkan dan
 * dinamai ulang, dan yang melencengnya tidak akan ketahuan sampai ada pembeli yang ditagih salah.
 * Model alamat kita sudah menyimpan kode pos (`CardRedemption.zip`), jadi tidak ada yang perlu
 * dipetakan sama sekali.
 *
 * ┌──── EMPAT ATURAN YANG TIDAK BOLEH DILANGGAR FILE INI ──────────────────────────────────────┐
 * │ 1. TIDAK PERNAH MELEMPAR. Fungsi publiknya mengembalikan `null` untuk SETIAP kegagalan.     │
 * │    Pembeli sedang berdiri di depan tombol "Bayar ongkir"; ia tidak boleh terjebak karena    │
 * │    layanan pihak ketiga sedang mati.                                                        │
 * │ 2. TIMEOUT PENDEK (BITESHIP_TIMEOUT_MS). Alasannya di konstantanya.                         │
 * │ 3. BATAS ATAS TETAP BERLAKU. Jawaban yang mustahil DITOLAK, bukan ditagihkan.               │
 * │ 4. KUNCI API TIDAK PERNAH MASUK LOG (redactApiKey) dan tidak pernah sampai ke browser —     │
 * │    file ini hanya dipanggil dari jalur server, dan yang dikembalikannya cuma angka.         │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 */

/* ═══════════════════════════ KONSTANTA KEPUTUSAN ═══════════════════════════ */

/**
 * Batas waktu satu panggilan tarif.
 *
 * KENAPA JAUH LEBIH PENDEK dari klien lain di repo ini (IDRX 15 detik, CC Shipping 20 detik):
 * panggilan-panggilan itu TIDAK punya jalan mundur — kalau IDRX tidak menjawab, tidak ada tagihan,
 * titik, jadi menunggu lama memang sepadan. Panggilan ini punya TUJUH lapis di belakangnya yang
 * SELALU menghasilkan angka. Menunggu lebih lama di sini tidak pernah membeli sebuah tagihan; ia
 * cuma membeli layar yang membeku. Lima detik cukup untuk jaringan Indonesia yang normal dan cukup
 * pendek untuk tidak terasa seperti kegagalan.
 */
export const BITESHIP_TIMEOUT_MS = 5_000;

/**
 * ⚠️ BATAS ATAS KEWAJARAN satu tarif kurir untuk SATU paket kartu (Rupiah).
 *
 * BUKAN batas mint IDRX: batas itu Rp 1.000.000.000, dan "satu miliar rupiah untuk mengirim satu
 * kartu" adalah persis jenis jawaban yang tidak boleh pernah menjelma tagihan. Dipilih Rp 500.000
 * karena kiriman ±250 g ke titik TERJAUH di Indonesia dengan layanan TERMAHAL masih jauh di bawah
 * angka itu — jadi apa pun di atasnya bukan tarif, melainkan satuan yang salah (sen? rupiah per
 * kg? paket lain?), respons dari akun yang bukan milik kita, atau kesalahan di sisi mereka.
 *
 * Arah gagalnya sadar: melewati batas ini berarti lapis 0 DILEWATI dan tarif tier yang dipakai —
 * bukan berarti pengiriman ditolak. Tidak ada pembeli yang terjebak; yang terjadi cuma kita
 * kembali ke angka yang kita tentukan sendiri, dan log-nya keras supaya operator melihatnya.
 */
export const BITESHIP_MAX_SANE_IDR = 500_000;

/**
 * Nilai barang yang DIDEKLARASIKAN ke Biteship (`items[].value`). Field-nya WAJIB ada.
 *
 * SENGAJA nominal, BUKAN harga kartunya yang sebenarnya, karena dua hal:
 *   • kita TIDAK membeli asuransi kurir di sini (`courier_insurance` tidak pernah dikirim), jadi
 *     nilai ini tidak ikut menentukan `price` — ia cuma mengisi field wajib;
 *   • mengirim harga kartu sungguhan berarti membocorkan data harga kami ke pihak ketiga, dan di
 *     sebagian kurir nilai tinggi justru memicu biaya asuransi otomatis — menaikkan tagihan
 *     pembeli demi sebuah angka yang tidak pernah kita butuhkan.
 */
export const BITESHIP_DECLARED_VALUE_IDR = 10_000;

/** Potong body respons yang kepanjangan sebelum masuk log. */
const BITESHIP_LOG_BODY_MAX = 300;

/**
 * Panjang maksimum kalimat kurir yang kita teruskan.
 *
 * Kalimat itu disusun dari STRING PIHAK KETIGA, dan ia ikut ke BROWSER PEMBELI lewat
 * GET /redemptions/:id/domestic-quote. Teks remote tanpa batas panjang yang menjelma field tanpa
 * batas panjang di respons kita adalah hal yang tidak pernah perlu kita izinkan.
 */
const BITESHIP_LABEL_MAX = 120;

/** Nama yang dipakai di setiap baris log, supaya mudah di-grep di droplet. */
const TAG = 'Biteship rates';

/* ═══════════════════════════ BENTUK HASIL ═══════════════════════════ */

export interface BiteshipRateResult {
  /**
   * ONGKIR YANG AKAN DITAGIHKAN. Sudah dinaikkan ke lantai mint IDRX bila perlu — lihat
   * `applyMintFloor`. Ini, dan hanya ini, angka yang boleh ditampilkan DAN ditagihkan.
   */
  priceIdr: number;
  /** Tarif MENTAH dari kurir, sebelum lantai rail pembayaran. Untuk jejak, bukan untuk ditagih. */
  courierPriceIdr: number;
  /** true = tarif kurirnya di bawah minimum mint IDRX dan sudah dinaikkan ke minimum itu. */
  raisedToMintFloor: boolean;
  /** Kalimat manusiawi: kurir, layanan, dan — kalau dinaikkan — ALASAN kenaikannya. */
  label: string;
  courierCode: string;
  courierServiceCode: string;
}

/* ═══════════════════════════ LANTAI RAIL PEMBAYARAN ═══════════════════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ JEBAKAN UTAMA SELURUH FITUR INI, DAN INILAH PENANGANANNYA.                                  ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Tarif kurir NYATA untuk jarak dekat sering Rp 9.000–15.000 (Jabodetabek, intra-kota). Minimum
 * SATU mint-request IDRX adalah Rp 20.000 (IDRX_MIN_MINT_IDR). Artinya: begitu API dinyalakan,
 * rute yang PALING MURAH DAN PALING SERING justru yang gagal — pembeli di Jakarta menekan "Bayar
 * ongkir" dan tagihannya tidak pernah bisa terbit.
 *
 * Resolver lama MENOLAK angka di bawah Rp 20.000 sebagai "tidak masuk akal" (`assertSaneRate`).
 * Untuk tarif yang DIKETIK ADMIN sikap itu BENAR: seorang admin yang mengetik Rp 5.000 membuat
 * baris yang tak akan pernah bisa ditagihkan, dan menolaknya di depan si pengetik adalah
 * satu-satunya cara memberitahunya. Untuk tarif NYATA DARI KURIR sikap itu SALAH TOTAL: Rp 12.000
 * bukan salah ketik, itu harga yang benar. Yang tidak sanggup menagihnya adalah RAIL PEMBAYARAN
 * KITA, bukan kurirnya.
 *
 * ┌──── KARENA ITU: LANTAINYA MILIK RAIL, BUKAN MILIK KURIR ───────────────────────────────────┐
 * │ Tarif di bawah minimum DINAIKKAN ke minimum, TIDAK dibuang. Dan angka yang dinaikkan itulah │
 * │ yang dikembalikan sebagai `priceIdr` — satu-satunya angka yang dibaca layar MAUPUN penerbit  │
 * │ tagihan. Tidak ada jalan untuk menampilkan Rp 12.000 lalu menagih Rp 20.000, karena tidak    │
 * │ ada dua angka: yang mentah hidup terpisah di `courierPriceIdr`, sebagai JEJAK, dan tidak     │
 * │ pernah masuk ke mana pun yang menagih.                                                       │
 * │                                                                                              │
 * │ Selisihnya (di contoh: Rp 8.000) BUKAN keuntungan tersembunyi — ia konsekuensi batas gateway │
 * │ yang tidak bisa kita turunkan. `raisedToMintFloor` dan `label` membawa FAKTA itu keluar      │
 * │ bersama angkanya, supaya layar bisa mengatakannya apa adanya alih-alih menyembunyikannya.    │
 * │ Itu perbedaan antara menagih minimum dan MENGAKU menagih minimum.                             │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Yang JUJUR tapi TIDAK bisa dikerjakan di sini: menggabungkan ongkir ke dalam tagihan kartunya
 * (satu mint, satu minimum) akan menghapus selisih ini sepenuhnya. Itu perubahan alur pembelian,
 * bukan perubahan resolver — dicatat, tidak dikerjakan.
 */
export function applyMintFloor(courierPriceIdr: number): {
  priceIdr: number;
  raisedToMintFloor: boolean;
} {
  if (courierPriceIdr < IDRX_MIN_MINT_IDR) {
    return { priceIdr: IDRX_MIN_MINT_IDR, raisedToMintFloor: true };
  }
  return { priceIdr: courierPriceIdr, raisedToMintFloor: false };
}

/* ═══════════════════════════ PARSING RESPONS ═══════════════════════════ */

/** Satu opsi kurir dari `pricing[]`. Semua field DIPERLAKUKAN sebagai tak terpercaya. */
interface BiteshipPricingOption {
  courier_code?: unknown;
  courier_name?: unknown;
  courier_service_code?: unknown;
  courier_service_name?: unknown;
  price?: unknown;
  duration?: unknown;
}

const asString = (v: unknown): string =>
  typeof v === 'string' ? v.trim() : '';

/**
 * Pilih opsi TERMURAH yang angkanya bisa dipakai.
 *
 * KENAPA TERMURAH: `couriers` yang kita kirim hanya berisi kurir yang benar-benar kita pakai
 * (env BITESHIP_COURIERS), jadi setiap opsi yang kembali adalah tarif yang memang bisa kita beli.
 * Di antara tarif yang sama-sama bisa dibeli, yang termurah adalah satu-satunya yang jujur untuk
 * ditagihkan ke pembeli — selisih apa pun di atasnya adalah biaya yang tidak pernah kita keluarkan.
 *
 * Harga pecahan (seharusnya tidak pernah terjadi) DIBULATKAN KE ATAS: membulatkan ke bawah berarti
 * menagih kurang dari ongkos yang dibayar. `price` <= 0 DIBUANG — ongkir gratis dari kurir bukan
 * fakta, itu jawaban yang tidak terbaca.
 */
export function pickCheapestPricing(
  pricing: readonly unknown[],
): { priceIdr: number; option: BiteshipPricingOption } | null {
  let best: { priceIdr: number; option: BiteshipPricingOption } | null = null;
  for (const raw of pricing) {
    if (raw === null || typeof raw !== 'object') continue;
    const option = raw as BiteshipPricingOption;
    const price = option.price;
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
      continue;
    }
    const priceIdr = Math.ceil(price);
    if (best === null || priceIdr < best.priceIdr) best = { priceIdr, option };
  }
  return best;
}

/**
 * Kalimat kurir yang ikut ke layar. Tanpa harga — harga hidup di field-nya sendiri.
 *
 * DISARING DAN DIPOTONG, dan itu bukan formalitas: setiap potongnya adalah STRING YANG DIKARANG
 * PIHAK KETIGA, dan kalimat ini diteruskan apa adanya ke browser pembeli (lewat
 * GET /redemptions/:id/domestic-quote) DAN ke log droplet. Apa pun yang digemakan respons mereka —
 * termasuk kredensial yang kita kirimkan sendiri — tidak boleh menumpang keluar lewat sini.
 */
function courierLabel(option: BiteshipPricingOption, apiKey: string): string {
  const courier =
    asString(option.courier_name) || asString(option.courier_code) || 'Kurir';
  const service =
    asString(option.courier_service_name) ||
    asString(option.courier_service_code);
  const duration = asString(option.duration);
  const raw =
    `${courier}${service ? ` ${service}` : ''}` +
    `${duration ? ` (${duration})` : ''}`;
  return redactApiKey(raw, apiKey).slice(0, BITESHIP_LABEL_MAX);
}

/* ═══════════════════════════ PANGGILAN ═══════════════════════════ */

/**
 * Tarif kurir NYATA untuk satu kode pos tujuan, atau `null`.
 *
 * TIDAK PERNAH MELEMPAR — itu kontraknya, dan seluruh badannya dibungkus `try` terakhir supaya
 * bahkan kegagalan yang tidak terbayangkan (fetch tidak ada, JSON.stringify gagal) pun keluar
 * sebagai `null`. Setiap `null` yang BUKAN "belum dikonfigurasi" dilog KERAS.
 */
export async function fetchBiteshipRateIdr(args: {
  logger: Logger;
  /** Pembaca env (ConfigService.get). */
  env: (key: string) => string | undefined;
  /** Kode pos tujuan dari alamat user (`CardRedemption.zip`). */
  destinationZip: string | null | undefined;
}): Promise<BiteshipRateResult | null> {
  const { logger, env, destinationZip } = args;

  // ── DIAM SEPENUHNYA kalau lapis ini memang tidak dipakai ────────────────────────────────────
  // Ini keadaan produksi HARI INI. Bukan error, bukan warning, bukan satu baris log pun: sistem
  // harus berjalan persis seperti sebelum lapis ini ada.
  if (!isBiteshipRequested(env)) return null;

  try {
    // ── Kunci ADA tapi konfigurasinya setengah jadi = KESALAHAN OPERATOR, dan ia harus KERAS.
    // Diam di sini berarti seseorang memasang kunci API, mengira tarif nyata sudah menyala, dan
    // tidak pernah tahu bahwa yang ditagihkan masih angka penampung.
    const problems = biteshipConfigProblems(env);
    const config = readBiteshipConfig(env);
    if (!config) {
      logger.error(
        `${TAG}: ${BITESHIP_API_KEY_ENV} terisi tetapi konfigurasinya belum lengkap — tarif ` +
          'kurir NYATA TIDAK dipakai, ongkir jatuh ke tarif tier/penampung. ' +
          problems.join(' '),
      );
      return null;
    }
    if (problems.length > 0) {
      // Masalah yang PUNYA bawaan aman (kurir/berat/base URL): lapisnya tetap jalan, tapi
      // operator tetap diberi tahu bahwa yang dipakai bukan nilai yang ia tulis.
      logger.warn(`${TAG}: ${problems.join(' ')}`);
    }

    const destination = readDestinationPostalCode(destinationZip);
    if (!destination) {
      logger.warn(
        `${TAG}: alamat tujuan tidak punya kode pos 5 digit yang terbaca ` +
          `(zip="${String(destinationZip ?? '')}") — tarif kurir dilewati, ongkir jatuh ke ` +
          'tarif tier. Minta pembeli melengkapi kode pos di alamatnya.',
      );
      return null;
    }

    const body = JSON.stringify({
      origin_postal_code: config.originPostalCode,
      destination_postal_code: destination,
      couriers: config.couriers,
      items: [
        {
          name: 'Kartu koleksi',
          value: BITESHIP_DECLARED_VALUE_IDR,
          quantity: 1,
          weight: config.weightGrams,
        },
      ],
    });

    const url = `${config.baseUrl}${BITESHIP_RATES_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BITESHIP_TIMEOUT_MS);
    const started = Date.now();

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          // Biteship: kunci MENTAH di header `authorization` — BUKAN `Bearer <key>`.
          authorization: config.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const detail = controller.signal.aborted
        ? `timeout ${BITESHIP_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : 'network error';
      logger.error(
        `${TAG}: POST ${BITESHIP_RATES_PATH} GAGAL (${redactApiKey(detail, config.apiKey)}) ` +
          `setelah ${Date.now() - started}ms. Ongkir jatuh ke tarif tier — pembayaran TIDAK ` +
          'diblokir.',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }

    const text = (await res.text().catch(() => '')).trim();
    const safeText = redactApiKey(text, config.apiKey).slice(
      0,
      BITESHIP_LOG_BODY_MAX,
    );

    if (!res.ok) {
      // 401 (kunci salah/dicabut), 402/429 (kuota habis), 4xx lain, 5xx — SEMUANYA sama akibatnya
      // di sini: lapis dilewati. Statusnya tetap dilog supaya operator tahu HARUS MEMPERBAIKI APA.
      logger.error(
        `${TAG}: POST ${BITESHIP_RATES_PATH} → HTTP ${res.status}${
          safeText ? ` — ${safeText}` : ''
        }. Ongkir jatuh ke tarif tier — pembayaran TIDAK diblokir.`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logger.error(
        `${TAG}: respons HTTP ${res.status} BUKAN JSON valid${
          safeText ? ` — ${safeText}` : ''
        }. Ongkir jatuh ke tarif tier.`,
      );
      return null;
    }

    const payload = (
      parsed !== null && typeof parsed === 'object' ? parsed : {}
    ) as {
      success?: unknown;
      error?: unknown;
      pricing?: unknown;
    };

    // Biteship bisa menjawab 200 dengan `success:false` — jawaban gagal yang menyamar jadi sukses.
    if (payload.success === false) {
      logger.error(
        `${TAG}: HTTP ${res.status} tetapi success=false${
          safeText ? ` — ${safeText}` : ''
        }. Ongkir jatuh ke tarif tier.`,
      );
      return null;
    }

    if (!Array.isArray(payload.pricing) || payload.pricing.length === 0) {
      logger.error(
        `${TAG}: respons tanpa daftar \`pricing\` yang terpakai (kurir diminta: ` +
          `${config.couriers}; tujuan ${destination})${safeText ? ` — ${safeText}` : ''}. ` +
          'Ongkir jatuh ke tarif tier.',
      );
      return null;
    }

    const cheapest = pickCheapestPricing(payload.pricing);
    if (!cheapest) {
      logger.error(
        `${TAG}: ${payload.pricing.length} opsi kurir kembali tetapi TIDAK SATU PUN punya ` +
          `\`price\` yang terbaca. Ongkir jatuh ke tarif tier.`,
      );
      return null;
    }

    // ── BATAS ATAS. Ditolak, BUKAN ditagihkan. ────────────────────────────────────────────────
    if (cheapest.priceIdr > BITESHIP_MAX_SANE_IDR) {
      logger.error(
        `${TAG}: tarif termurah Rp ${cheapest.priceIdr} MELEWATI batas kewajaran ` +
          `Rp ${BITESHIP_MAX_SANE_IDR} untuk satu paket kartu (tujuan ${destination}, ` +
          `${courierLabel(cheapest.option, config.apiKey)}). DITOLAK — ongkir jatuh ke tarif tier. Periksa ` +
          'satuan berat/kurir di konfigurasi, atau akun Biteship yang dipakai.',
      );
      return null;
    }

    const { priceIdr, raisedToMintFloor } = applyMintFloor(cheapest.priceIdr);

    // Sabuk terakhir. Lantai + batas atas di atas sudah menjamin rentangnya, tapi lapis ini
    // menyetor angka ke penerbit tagihan — dan angka yang lolos ke sana tanpa diperiksa adalah
    // tagihan yang ditolak gateway di depan pembeli.
    if (
      !Number.isInteger(priceIdr) ||
      priceIdr < IDRX_MIN_MINT_IDR ||
      priceIdr > IDRX_MAX_MINT_IDR
    ) {
      logger.error(
        `${TAG}: hasil akhir Rp ${priceIdr} di luar batas mint IDRX — DITOLAK, ongkir jatuh ke ` +
          'tarif tier.',
      );
      return null;
    }

    const base = courierLabel(cheapest.option, config.apiKey);
    const label = raisedToMintFloor
      ? `${base} — tarif kurir Rp ${cheapest.priceIdr.toLocaleString('id-ID')}, ditagihkan ` +
        `Rp ${priceIdr.toLocaleString('id-ID')} (minimum penerbitan tagihan)`
      : base;

    logger.log(
      `${TAG}: ${config.originPostalCode} → ${destination}, ${config.weightGrams} g, kurir ` +
        `[${config.couriers}] → termurah Rp ${cheapest.priceIdr} (${base})` +
        `${raisedToMintFloor ? ` → DINAIKKAN ke Rp ${priceIdr} (minimum mint IDRX)` : ''}` +
        ` dalam ${Date.now() - started}ms.`,
    );

    return {
      priceIdr,
      courierPriceIdr: cheapest.priceIdr,
      raisedToMintFloor,
      label,
      courierCode: asString(cheapest.option.courier_code),
      courierServiceCode: asString(cheapest.option.courier_service_code),
    };
  } catch (err) {
    // Jaring terakhir kontrak "TIDAK PERNAH MELEMPAR". Pesannya TIDAK disaring dengan kunci
    // (kita mungkin belum sempat membacanya) — jadi disaring dengan pola prefix saja.
    logger.error(
      `${TAG}: kegagalan tak terduga saat mengambil tarif kurir ` +
        `(${redactApiKey(err instanceof Error ? err.message : String(err), '')}). ` +
        'Ongkir jatuh ke tarif tier — pembayaran TIDAK diblokir.',
    );
    return null;
  }
}
