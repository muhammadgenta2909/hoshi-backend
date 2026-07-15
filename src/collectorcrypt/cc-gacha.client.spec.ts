import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CcGachaClient } from './cc-gacha.client';

// Bentuk satu mesin persis seperti yang dikirim /api/machines devnet CC: harga DOLAR PENUH
// (250, bukan 250_000_000) dan key rarity huruf-kecil.
const MACHINE = {
  code: 'pokemon_250',
  name: 'Pokemon $250',
  shortName: 'PKMN 250',
  price: 250,
  ev: 270.2,
  odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 },
  stock: { common: 29, uncommon: 86, rare: 460, epic: 17 },
  tierRanges: {},
};

function mockFetchOnce(payload: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

describe('CcGachaClient.machines', () => {
  let client: CcGachaClient;

  beforeEach(async () => {
    const config = {
      get: (k: string) =>
        k === 'COLLECTORCRYPT_GACHA_API_KEY'
          ? 'test-key'
          : k === 'COLLECTORCRYPT_GACHA_BASE_URL'
            ? 'https://dev-gacha.collectorcrypt.com'
            : undefined,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [CcGachaClient, { provide: ConfigService, useValue: config }],
    }).compile();
    client = moduleRef.get(CcGachaClient);
  });

  afterEach(() => jest.restoreAllMocks());

  // REGRESI: respons asli CC membungkus array di { machines: [...] }. Sempat kita perlakukan
  // sebagai array telanjang → `raw.map is not a function` → SELURUH halaman Open Packs 500.
  it('parses the real wrapped shape { machines: [...] } and normalises price to base units', async () => {
    mockFetchOnce({ machines: [MACHINE] });

    const list = await client.machines();

    expect(list).toHaveLength(1);
    expect(list[0].code).toBe('pokemon_250');
    // $250 (dolar penuh) -> 250_000_000 base units; `price` mentah tidak boleh lolos.
    expect(list[0].priceUsdcBaseUnits).toBe(250_000_000);
    expect(list[0].priceUsdcDollars).toBe(250);
    expect('price' in list[0]).toBe(false);
  });

  // Tetap toleran kalau suatu saat CC mengirim array langsung — perubahan bentuk mereka
  // tidak boleh langsung menjatuhkan halaman.
  it('still tolerates a bare array response', async () => {
    mockFetchOnce([MACHINE]);

    const list = await client.machines();

    expect(list).toHaveLength(1);
    expect(list[0].priceUsdcBaseUnits).toBe(250_000_000);
  });

  // "Machine is empty" (di `details`, bukan `error`) harus jadi kalimat yang jelas untuk
  // user — bukan "Internal server error" mentah yang sempat tampil di halaman.
  it('turns a CC "Machine is empty" 500 into a friendly, actionable message', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            error: 'Internal server error',
            details: 'Machine is empty',
          }),
        ),
    });

    await expect(client.stock()).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('sedang tidak tersedia') as string,
    });
    // Teks teknis CC tidak boleh bocor ke pesan yang dilihat user.
    await expect(client.stock()).rejects.not.toMatchObject({
      message: expect.stringContaining('Internal server error') as string,
    });
  });
});
