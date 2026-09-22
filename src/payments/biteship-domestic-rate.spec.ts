import { Logger } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import {
  DOMESTIC_RATE_SCOPE_COURIER_API,
  DOMESTIC_RATE_SCOPE_NATIONWIDE,
  DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
  DOMESTIC_TIER_JAWA,
  resolveDomesticShippingIdr,
} from './domestic-shipping-rate';
import {
  BITESHIP_DECLARED_VALUE_IDR,
  BITESHIP_MAX_SANE_IDR,
  BITESHIP_TIMEOUT_MS,
} from './biteship-rate.client';
import {
  BITESHIP_API_KEY_ENV,
  BITESHIP_BASE_URL_ENV,
  BITESHIP_COURIERS_ENV,
  BITESHIP_DEFAULT_BASE_URL,
  BITESHIP_DEFAULT_COURIERS,
  BITESHIP_DEFAULT_WEIGHT_GRAMS,
  BITESHIP_ORIGIN_POSTAL_CODE_ENV,
  BITESHIP_RATES_PATH,
  BITESHIP_WEIGHT_GRAMS_ENV,
} from './biteship-rate-env';
import { IDRX_MIN_MINT_IDR } from './idrx-mint-bounds';
import { validateEnv } from '../config/env.validation';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ LAPIS 0 — TARIF ONGKIR NYATA DARI KURIR (Biteship). Kontraknya, dan yang ia TIDAK boleh rusak.║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Yang dijaga file ini, dan kenapa masing-masing penting:
 *
 *  1. TARIF NYATA MENANG. Kalau API menjawab, angkanyalah yang dipakai — bukan tier penampung
 *     Rp 25.000/Rp 50.000 yang tidak pernah diputuskan siapa pun, dan bukan pula baris DB.
 *  2. TANPA KUNCI API, LAPIS INI TIDAK ADA. Nol panggilan jaringan, nol log, dan hasilnya HARUS
 *     identik byte-per-byte dengan hasil sebelum lapis ini ditambahkan. Itu keadaan produksi hari
 *     ini; sebuah lapis baru yang mengubahnya adalah regresi, bukan fitur.
 *  3. API TIDAK PERNAH MEMBLOKIR PEMBAYARAN. Mati, timeout, 401, kuota habis, JSON cacat,
 *     success:false, pricing kosong — SEMUANYA jatuh ke lapis berikutnya, dengan NOL lemparan ke
 *     pemanggil. Pembeli tidak boleh terjebak karena layanan pihak ketiga sedang mati.
 *  4. LANTAI IDRX. Tarif kurir Rp 9.000–15.000 (Jabodetabek, intra-kota) adalah rute yang PALING
 *     SERING. Ia harus DINAIKKAN ke Rp 20.000, bukan ditolak — dan angka yang DINAIKKAN itulah
 *     satu-satunya angka yang ada, supaya mustahil menampilkan Rp 12.000 lalu menagih Rp 20.000.
 *  5. BATAS ATAS. Angka mustahil DITOLAK, bukan ditagihkan.
 *  6. KUNCI API TIDAK PERNAH MUNCUL DI LOG — termasuk ketika gateway menggemakannya kembali di
 *     body error-nya, yang persis kelakuan lumrah gateway yang menolak sebuah kredensial.
 */

/* ═══════════════════════════ HARNESS ═══════════════════════════ */

const API_KEY = 'biteship_live.RAHASIA_JANGAN_SAMPAI_KE_LOG_0123456789';
const ORIGIN_ZIP = '12440';
const DEST_ZIP = '40115';

/** Alamat tujuan lengkap (Bandung, Jawa Barat) — provinsi Jawa, jadi tier penampungnya Rp 25.000. */
const DEST = {
  city: 'Bandung',
  state: 'Jawa Barat',
  country: 'ID',
  zip: DEST_ZIP,
};

/** Env LENGKAP: lapis 0 menyala. */
const envFull = (over: Record<string, string | undefined> = {}) => {
  const table: Record<string, string | undefined> = {
    [BITESHIP_API_KEY_ENV]: API_KEY,
    [BITESHIP_ORIGIN_POSTAL_CODE_ENV]: ORIGIN_ZIP,
    ...over,
  };
  return (key: string) => table[key];
};

/** Env TANPA kunci API — keadaan produksi hari ini. */
const envNoKey = (over: Record<string, string | undefined> = {}) => {
  const table: Record<string, string | undefined> = { ...over };
  return (key: string) => table[key];
};

/** Prisma palsu: hanya tabel tarif, karena hanya itu yang dibaca resolver. */
function fakePrisma(rows: Record<string, unknown>[] = []): PrismaService {
  return {
    domesticShippingRate: {
      findMany: () =>
        Promise.resolve(
          rows.map((r) => ({
            provinces: [],
            fallback: false,
            label: null,
            ...r,
          })),
        ),
    },
  } as unknown as PrismaService;
}

/** Satu baris DB flat nasional — lapis 4, jaring yang HARUS menangkap setiap kegagalan lapis 0. */
const DB_ROW = {
  scope: DOMESTIC_RATE_SCOPE_NATIONWIDE,
  priceIdr: 37_000,
  active: true,
};

/** Respons `pricing` Biteship yang bentuknya sesuai dokumentasi mereka. */
const pricingOption = (over: Record<string, unknown> = {}) => ({
  courier_code: 'jne',
  courier_name: 'JNE',
  courier_service_code: 'reg',
  courier_service_name: 'Layanan Reguler',
  duration: '2 - 3 hari',
  price: 32_000,
  type: 'reguler',
  ...over,
});

const okBody = (pricing: unknown[]) => ({
  success: true,
  object: 'courier_pricing',
  message: 'Success to retrieve courier pricing',
  code: 20001007,
  pricing,
});

/** Respons sungguhan (global `Response` Node 24) supaya `res.ok`/`res.text()` benar-benar diuji. */
const jsonResponse = (body: unknown, status = 200) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Logger yang SETIAP kalimatnya ditangkap — dipakai asersi "kunci tidak pernah masuk log". */
function spyLogger(): { logger: Logger; lines: () => string[] } {
  const lines: string[] = [];
  const logger = new Logger('biteship-test');
  for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
    jest
      .spyOn(logger, level)
      .mockImplementation((...args: unknown[]) =>
        lines.push(args.map((a) => String(a)).join(' ')),
      );
  }
  return { logger, lines: () => lines };
}

let fetchSpy: jest.Mock;

beforeEach(() => {
  fetchSpy = jest.fn();
  globalThis.fetch = fetchSpy;
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

/* ══════════════════════ 1. API MENJAWAB NORMAL → TARIFNYA YANG DIPAKAI ══════════════════════ */

describe('API menjawab normal', () => {
  it('tarif kurir dipakai, dan ia MENANG atas baris DB maupun env flat', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okBody([pricingOption()])));
    const { logger } = spyLogger();

    const quote = await resolveDomesticShippingIdr({
      prisma: fakePrisma([DB_ROW]),
      logger,
      dest: DEST,
      env: envFull({ HOSHI_DOMESTIC_SHIPPING_FLAT_IDR: '99000' }),
    });

    expect(quote).toMatchObject({
      priceIdr: 32_000,
      courierPriceIdr: 32_000,
      raisedToMintFloor: false,
      scope: DOMESTIC_RATE_SCOPE_COURIER_API,
      source: 'COURIER_API',
      region: 'COURIER_API',
      // Kurir menghitung dari KODE POS — lebih halus daripada tier mana pun, jadi tidak ada
      // wilayah yang "belum dikenali" untuk dilaporkan ke operator.
      regionUnresolved: false,
      // Provinsi TETAP dilaporkan walau yang menang tarif kurir: jejaknya harus tetap menyebut
      // wilayah yang AKAN dipakai kalau lapis 0 diam.
      province: 'jawa barat',
    });
    expect(quote.label).toContain('JNE');
  });

  it('memilih opsi TERMURAH di antara kurir yang memang kita pakai', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        okBody([
          pricingOption({ price: 45_000, courier_code: 'jne' }),
          pricingOption({ price: 28_500, courier_code: 'sicepat' }),
          pricingOption({ price: 61_000, courier_code: 'jnt' }),
        ]),
      ),
    );
    const { logger } = spyLogger();

    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      }),
    ).resolves.toMatchObject({ priceIdr: 28_500, source: 'COURIER_API' });
  });

  it('mengirim kode pos ASAL + TUJUAN, daftar kurir, berat, dan kunci MENTAH di header', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okBody([pricingOption()])));
    const { logger } = spyLogger();

    await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envFull(),
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BITESHIP_DEFAULT_BASE_URL}${BITESHIP_RATES_PATH}`);
    expect(init.method).toBe('POST');
    // Biteship memakai kunci MENTAH di header `authorization`, BUKAN `Bearer <key>`.
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(API_KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      origin_postal_code: ORIGIN_ZIP,
      destination_postal_code: DEST_ZIP,
      couriers: BITESHIP_DEFAULT_COURIERS,
      items: [
        {
          name: 'Kartu koleksi',
          value: BITESHIP_DECLARED_VALUE_IDR,
          quantity: 1,
          weight: BITESHIP_DEFAULT_WEIGHT_GRAMS,
        },
      ],
    });
  });

  it('kurir, berat, dan base URL bisa diubah lewat env tanpa deploy', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okBody([pricingOption()])));
    const { logger } = spyLogger();

    await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envFull({
        [BITESHIP_COURIERS_ENV]: ' JNE , anteraja ,jne, ',
        [BITESHIP_WEIGHT_GRAMS_ENV]: '400',
        [BITESHIP_BASE_URL_ENV]: 'https://biteship.mock.test/',
      }),
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://biteship.mock.test${BITESHIP_RATES_PATH}`);
    const body = JSON.parse(init.body as string) as {
      couriers: string;
      items: { weight: number }[];
    };
    // Dinormalkan: huruf kecil, tanpa spasi, tanpa duplikat.
    expect(body.couriers).toBe('jne,anteraja');
    expect(body.items[0].weight).toBe(400);
  });
});

/* ══════════════════════ 2. TANPA KUNCI API → LAPIS 0 DIAM SEPENUHNYA ══════════════════════ */

describe('tanpa kunci API', () => {
  it('tidak memanggil jaringan dan tidak menulis satu baris log pun', async () => {
    const { logger, lines } = spyLogger();

    const quote = await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envNoKey(),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lines()).toEqual([]);
    expect(quote).toMatchObject({
      priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      scope: DOMESTIC_TIER_JAWA,
      source: 'DEFAULT_TIER',
      courierPriceIdr: null,
      raisedToMintFloor: false,
    });
  });

  it('hasilnya IDENTIK dengan sebelum lapis ini ada — var Biteship lain tidak mengubah apa pun', async () => {
    const { logger } = spyLogger();
    const run = (env: (key: string) => string | undefined) =>
      resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env,
      });

    // Kiri: env yang TIDAK PERNAH mendengar tentang Biteship sama sekali.
    // Kanan: seluruh var Biteship terisi KECUALI kuncinya. Saklarnya cuma satu, dan ini buktinya.
    await expect(run(envNoKey())).resolves.toEqual(
      await run(
        envNoKey({
          [BITESHIP_ORIGIN_POSTAL_CODE_ENV]: ORIGIN_ZIP,
          [BITESHIP_COURIERS_ENV]: 'jne,sicepat',
          [BITESHIP_WEIGHT_GRAMS_ENV]: '250',
          [BITESHIP_BASE_URL_ENV]: BITESHIP_DEFAULT_BASE_URL,
        }),
      ),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ 3. API GAGAL → JATUH KE LAPIS BERIKUTNYA, NOL LEMPARAN ══════════════ */

describe('API gagal dalam segala bentuknya', () => {
  /** Setiap baris: satu cara Biteship bisa mengecewakan kita di produksi. */
  const KEGAGALAN: [string, () => unknown][] = [
    ['jaringan mati', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['DNS tidak ketemu', () => Promise.reject(new Error('ENOTFOUND'))],
    [
      '401 kunci salah/dicabut',
      () => jsonResponse({ error: 'Unauthorized' }, 401),
    ],
    ['402 kuota habis', () => jsonResponse({ error: 'Quota exceeded' }, 402)],
    ['429 rate limit', () => jsonResponse({ error: 'Too many requests' }, 429)],
    ['500 mereka rusak', () => jsonResponse({ error: 'oops' }, 500)],
    [
      'body BUKAN JSON (halaman HTML proxy)',
      () => jsonResponse('<html>502</html>'),
    ],
    ['body kosong', () => jsonResponse('')],
    [
      '200 tapi success:false',
      () => jsonResponse({ success: false, error: 'no route' }),
    ],
    ['tanpa field pricing', () => jsonResponse({ success: true })],
    [
      'pricing bukan array',
      () => jsonResponse({ success: true, pricing: 'jne' }),
    ],
    ['pricing kosong', () => jsonResponse(okBody([]))],
    [
      'price bukan angka',
      () => jsonResponse(okBody([pricingOption({ price: '32000' })])),
    ],
    [
      'price nol/negatif',
      () =>
        jsonResponse(
          okBody([pricingOption({ price: 0 }), pricingOption({ price: -5 })]),
        ),
    ],
    ['pricing berisi null', () => jsonResponse(okBody([null, undefined]))],
    ['respons null', () => jsonResponse('null')],
  ];

  it.each(KEGAGALAN)(
    '%s → jatuh ke lapis berikutnya, NOL lemparan ke pemanggil',
    async (_label, respond) => {
      fetchSpy.mockImplementation(() => {
        const r = respond();
        return r instanceof Promise ? r : Promise.resolve(r);
      });
      const { logger, lines } = spyLogger();

      const quote = await resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      });

      // Jaring lapis 4 menangkapnya. Pembeli tetap bisa membayar.
      expect(quote).toMatchObject({
        priceIdr: 37_000,
        source: 'DB',
        courierPriceIdr: null,
        raisedToMintFloor: false,
      });
      // LOG KERAS: kegagalan lapis 0 tidak boleh senyap, atau tarif penampung akan menagih
      // pembeli berbulan-bulan tanpa ada yang tahu API-nya sebenarnya mati.
      expect(lines().join('\n')).toContain('jatuh ke tarif tier');
    },
  );

  it('timeout: dibatalkan di BITESHIP_TIMEOUT_MS dan jatuh ke lapis berikutnya', async () => {
    // Pembeli sedang menunggu di layar; di belakang lapis ini ada tujuh lapis yang SELALU
    // menghasilkan angka, jadi menunggu lebih lama tidak pernah membeli sebuah tagihan.
    fetchSpy.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new Error('The operation was aborted')),
          );
        }),
    );
    const { logger, lines } = spyLogger();
    jest.useFakeTimers();

    const pending = resolveDomesticShippingIdr({
      prisma: fakePrisma([DB_ROW]),
      logger,
      dest: DEST,
      env: envFull(),
    });
    await jest.advanceTimersByTimeAsync(BITESHIP_TIMEOUT_MS + 1);

    await expect(pending).resolves.toMatchObject({
      priceIdr: 37_000,
      source: 'DB',
    });
    expect(lines().join('\n')).toContain(`timeout ${BITESHIP_TIMEOUT_MS}ms`);
  });

  it('tanpa baris DB maupun env, kegagalan API tetap mendarat di tier penampung', async () => {
    fetchSpy.mockRejectedValue(new Error('ECONNRESET'));
    const { logger } = spyLogger();

    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(),
        logger,
        dest: DEST,
        env: envFull(),
      }),
    ).resolves.toMatchObject({
      priceIdr: DOMESTIC_SHIPPING_FLAT_IDR_PLACEHOLDER,
      source: 'DEFAULT_TIER',
    });
  });

  it('kunci ADA tapi kode pos gudang KOSONG → tidak memanggil apa pun, dan LOG KERAS', async () => {
    const { logger, lines } = spyLogger();

    const quote = await resolveDomesticShippingIdr({
      prisma: fakePrisma([DB_ROW]),
      logger,
      dest: DEST,
      env: envFull({ [BITESHIP_ORIGIN_POSTAL_CODE_ENV]: undefined }),
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(quote).toMatchObject({ priceIdr: 37_000, source: 'DB' });
    // Arah gagal paling berbahaya di seluruh fitur ini: seseorang memasang kunci, mengira tarif
    // nyata menyala, dan tidak pernah tahu yang ditagihkan masih angka penampung.
    expect(lines().join('\n')).toContain(BITESHIP_ORIGIN_POSTAL_CODE_ENV);
  });

  it('alamat tujuan tanpa kode pos 5 digit → lapis 0 dilewati, bukan error', async () => {
    const { logger } = spyLogger();

    for (const zip of [undefined, null, '', '123', 'ABCDE', '123456']) {
      await expect(
        resolveDomesticShippingIdr({
          prisma: fakePrisma([DB_ROW]),
          logger,
          dest: { ...DEST, zip },
          env: envFull(),
        }),
      ).resolves.toMatchObject({ priceIdr: 37_000, source: 'DB' });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ══════════════════════ 4. DI BAWAH MINIMUM IDRX → DINAIKKAN, BUKAN DIBUANG ══════════════════ */

describe('tarif kurir DI BAWAH minimum mint IDRX', () => {
  /**
   * Rute Jabodetabek/intra-kota adalah rute yang PALING MURAH DAN PALING SERING. Kalau angka
   * segini ditolak (sikap yang BENAR untuk tarif yang diketik admin), justru rute tersibuklah
   * yang gagal: pembeli di Jakarta menekan "Bayar ongkir" dan tagihannya tidak pernah terbit.
   */
  it.each([9_000, 12_000, 15_000, IDRX_MIN_MINT_IDR - 1])(
    'Rp %s → DINAIKKAN ke minimum, dan tarif mentahnya tetap terjejak',
    async (courierPrice) => {
      fetchSpy.mockResolvedValue(
        jsonResponse(okBody([pricingOption({ price: courierPrice })])),
      );
      const { logger } = spyLogger();

      const quote = await resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      });

      expect(quote).toMatchObject({
        priceIdr: IDRX_MIN_MINT_IDR,
        courierPriceIdr: courierPrice,
        raisedToMintFloor: true,
        source: 'COURIER_API',
      });
    },
  );

  it('YANG DITAMPILKAN = YANG DITAGIH: hanya ada SATU angka harga di hasilnya', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(okBody([pricingOption({ price: 12_000 })])),
    );
    const { logger } = spyLogger();

    const quote = await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envFull(),
    });

    // `priceIdr` adalah satu-satunya field yang dibaca layar MAUPUN penerbit tagihan IDRX
    // (payments.service.ts: mintRequest toBeMinted = String(rate.priceIdr), dan PaymentOrder
    // .priceIdr = rate.priceIdr). Kalau ia sudah bernilai angka yang dinaikkan, tidak ada jalan
    // untuk menampilkan Rp 12.000 lalu menagih Rp 20.000.
    expect(quote.priceIdr).toBe(IDRX_MIN_MINT_IDR);
    expect(quote.priceIdr).toBeGreaterThanOrEqual(IDRX_MIN_MINT_IDR);
    // Tarif mentah hidup TERPISAH, sebagai jejak — dan ia TIDAK pernah jadi `priceIdr`.
    expect(quote.courierPriceIdr).toBe(12_000);
    expect(quote.raisedToMintFloor).toBe(true);
    // Dan kenaikannya DIAKUI, bukan disembunyikan: kalimatnya menyebut KEDUA angka, supaya layar
    // yang cuma merender `label` pun mengatakan yang sebenarnya.
    expect(quote.label).toContain('12.000');
    expect(quote.label).toContain('20.000');
    expect(quote.label).toContain('minimum penerbitan tagihan');
  });

  it('tepat DI minimum tidak dianggap dinaikkan', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(okBody([pricingOption({ price: IDRX_MIN_MINT_IDR })])),
    );
    const { logger } = spyLogger();

    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(),
        logger,
        dest: DEST,
        env: envFull(),
      }),
    ).resolves.toMatchObject({
      priceIdr: IDRX_MIN_MINT_IDR,
      courierPriceIdr: IDRX_MIN_MINT_IDR,
      raisedToMintFloor: false,
    });
  });

  it('harga pecahan dibulatkan KE ATAS — membulatkan ke bawah = menagih kurang dari ongkosnya', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(okBody([pricingOption({ price: 32_000.2 })])),
    );
    const { logger } = spyLogger();

    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma(),
        logger,
        dest: DEST,
        env: envFull(),
      }),
    ).resolves.toMatchObject({ priceIdr: 32_001, courierPriceIdr: 32_001 });
  });
});

/* ══════════════════════ 5. ANGKA MUSTAHIL → DITOLAK, JATUH KE LAPIS BERIKUTNYA ══════════════ */

describe('tarif kurir yang MUSTAHIL', () => {
  it.each([BITESHIP_MAX_SANE_IDR + 1, 5_000_000, 999_999_999])(
    'Rp %s DITOLAK dan ongkir jatuh ke lapis berikutnya — bukan ditagihkan',
    async (absurd) => {
      fetchSpy.mockResolvedValue(
        jsonResponse(okBody([pricingOption({ price: absurd })])),
      );
      const { logger, lines } = spyLogger();

      const quote = await resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      });

      expect(quote).toMatchObject({ priceIdr: 37_000, source: 'DB' });
      expect(lines().join('\n')).toContain('MELEWATI batas kewajaran');
    },
  );

  it('tepat DI batas atas masih diterima', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(okBody([pricingOption({ price: BITESHIP_MAX_SANE_IDR })])),
    );
    const { logger } = spyLogger();

    await expect(
      resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      }),
    ).resolves.toMatchObject({
      priceIdr: BITESHIP_MAX_SANE_IDR,
      source: 'COURIER_API',
    });
  });

  it('batas atasnya JAUH lebih ketat dari batas mint IDRX — itu memang maksudnya', () => {
    // Rp 1.000.000.000 untuk mengirim satu kartu adalah persis jenis jawaban yang tidak boleh
    // pernah menjelma tagihan, dan batas mint sendirian tidak akan pernah menangkapnya.
    expect(BITESHIP_MAX_SANE_IDR).toBeGreaterThan(IDRX_MIN_MINT_IDR);
    expect(BITESHIP_MAX_SANE_IDR).toBeLessThan(1_000_000);
  });
});

/* ══════════════════════ 6. KUNCI API TIDAK PERNAH MUNCUL DI LOG ══════════════════════ */

describe('kerahasiaan kunci API', () => {
  /** Gateway yang menolak sebuah kredensial memang lumrah MENGGEMAKANNYA di body error-nya. */
  const MENGGEMA: [string, () => unknown][] = [
    [
      '401 yang menggemakan kuncinya',
      () =>
        jsonResponse(
          {
            success: false,
            error: `Invalid auth token: ${API_KEY}`,
            code: 40101001,
          },
          401,
        ),
    ],
    [
      '200 success:false yang menggemakan kuncinya',
      () =>
        jsonResponse({ success: false, error: `key ${API_KEY} has no quota` }),
    ],
    [
      'error jaringan yang memuat kuncinya (URL ber-query)',
      () => Promise.reject(new Error(`connect ECONNREFUSED ?token=${API_KEY}`)),
    ],
    [
      'body non-JSON yang menggemakan kuncinya',
      () => jsonResponse(`FORBIDDEN ${API_KEY}`),
    ],
  ];

  it.each(MENGGEMA)(
    '%s → kuncinya DISARING dari log',
    async (_label, respond) => {
      fetchSpy.mockImplementation(() => {
        const r = respond();
        return r instanceof Promise ? r : Promise.resolve(r);
      });
      const { logger, lines } = spyLogger();

      await resolveDomesticShippingIdr({
        prisma: fakePrisma([DB_ROW]),
        logger,
        dest: DEST,
        env: envFull(),
      });

      const all = lines().join('\n');
      expect(all).not.toContain(API_KEY);
      // Bukan cuma kuncinya YANG INI: seluruh bentuk kunci Biteship disaring, supaya kunci lama
      // yang masih disebut pesan error mereka pun tidak ikut mendarat di log droplet.
      expect(all).not.toMatch(/biteship_(live|test)\./);
      expect(all).toContain('[REDACTED]');
    },
  );

  it('SELURUH log lapis 0 di jalur SUKSES pun tidak memuat kuncinya', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(okBody([pricingOption()])));
    const { logger, lines } = spyLogger();

    await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envFull(),
    });

    expect(lines().join('\n')).not.toContain(API_KEY);
    expect(lines().join('\n')).not.toMatch(/biteship_(live|test)\./);
  });

  it('kuncinya juga tidak bocor lewat hasil yang dikembalikan ke pemanggil', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(okBody([pricingOption({ courier_name: API_KEY })])),
    );
    const { logger } = spyLogger();

    const quote = await resolveDomesticShippingIdr({
      prisma: fakePrisma(),
      logger,
      dest: DEST,
      env: envFull(),
    });

    // Hasil ini diserialisasi apa adanya ke browser lewat GET /redemptions/:id/domestic-quote.
    // Yang boleh keluar dari sana cuma angka dan kalimat kurir — bukan apa pun dari env kita.
    expect(JSON.stringify(quote)).not.toContain(API_KEY);
  });
});

/* ══════════════════════ 7. BOOT: MEMPERINGATKAN, TIDAK PERNAH MENOLAK START ══════════════════ */

describe('validasi env saat boot', () => {
  const baseEnv = {
    DATABASE_URL: 'postgresql://localhost:5432/hoshi',
    JWT_SECRET: 'x'.repeat(40),
  };

  // `console`, bukan Logger Nest: validateEnv berjalan SEBELUM aplikasi (dan logger-nya) berdiri,
  // jadi di situlah peringatan boot benar-benar mendarat.
  let consoleError: jest.SpyInstance<void, unknown[]>;
  const printed = () =>
    consoleError.mock.calls.map((c) => String(c[0])).join('\n');

  beforeEach(() => {
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
  });

  it('tanpa var Biteship sama sekali: boot bersih, nol peringatan tentang Biteship', () => {
    expect(() => validateEnv({ ...baseEnv })).not.toThrow();
    expect(printed()).not.toContain('Biteship');
  });

  it.each([
    ['kode pos gudang KOSONG', { BITESHIP_API_KEY: 'biteship_live.k' }],
    [
      'kode pos gudang bukan 5 digit',
      {
        BITESHIP_API_KEY: 'biteship_live.k',
        BITESHIP_ORIGIN_POSTAL_CODE: '124',
      },
    ],
    [
      'berat bukan angka',
      {
        BITESHIP_API_KEY: 'biteship_live.k',
        BITESHIP_ORIGIN_POSTAL_CODE: '12440',
        BITESHIP_WEIGHT_GRAMS: 'dua ratus',
      },
    ],
    [
      'base URL cacat',
      {
        BITESHIP_API_KEY: 'biteship_live.k',
        BITESHIP_ORIGIN_POSTAL_CODE: '12440',
        BITESHIP_BASE_URL: 'biteship.com',
      },
    ],
  ])(
    '%s → MEMPERINGATKAN keras, tapi backend TETAP MENYALA',
    (_label, over: Record<string, string>) => {
      // Menolak start di sini akan menukar "lapis tarif tambahan mati" dengan
      // api.hoshimarket.xyz MATI SELURUHNYA — marketplace, vault, riwayat, semuanya.
      expect(() => validateEnv({ ...baseEnv, ...over })).not.toThrow();
      expect(printed()).toContain('Biteship');
    },
  );

  it('konfigurasi Biteship yang UTUH tidak memicu peringatan apa pun', () => {
    validateEnv({
      ...baseEnv,
      BITESHIP_API_KEY: 'biteship_live.k',
      BITESHIP_ORIGIN_POSTAL_CODE: '12440',
      BITESHIP_COURIERS: 'jne,sicepat',
      BITESHIP_WEIGHT_GRAMS: '250',
      BITESHIP_BASE_URL: BITESHIP_DEFAULT_BASE_URL,
    });
    expect(printed()).not.toContain('Biteship');
  });
});
