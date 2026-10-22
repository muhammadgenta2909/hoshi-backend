import { ConfigService } from '@nestjs/config';
import { createIdrxSignature } from '../idrx/idrx.signature';
import { IdrxClient } from './idrx.client';
import { resolveIdrxEndpoint } from './idrx-endpoint';
import { IdrxMockStore } from './idrx-mock.store';

/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ MIGRASI HOST IDRX — YANG DIKIRIM DAN YANG DITANDATANGANI HARUS PATH YANG SAMA.             ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * IDRX mematikan `https://idrx.co/api` pada 30 Oktober 2026. Host barunya `https://api.idrx.co`,
 * tanpa awalan `/api`. Bug yang paling mungkin dari migrasi seperti ini BUKAN URL yang salah —
 * itu langsung kelihatan — melainkan URL yang benar dengan tanda tangan atas path yang LAMA:
 * setiap request ditolak 401, dan pesannya terbaca seperti kredensial yang rusak.
 *
 * Maka test di bawah tidak cuma memeriksa URL-nya. Ia menghitung ulang tanda tangan dari path yang
 * BENAR-BENAR diminta dan menuntut header-nya sama persis.
 */
describe('resolveIdrxEndpoint', () => {
  it.each([
    [
      'bawaan baru',
      'https://api.idrx.co',
      'https://api.idrx.co',
      '/transaction/rates',
    ],
    [
      'host lama → /api ditambahkan',
      'https://idrx.co',
      'https://idrx.co',
      '/api/transaction/rates',
    ],
    [
      'host lama dengan www',
      'https://www.idrx.co',
      'https://www.idrx.co',
      '/api/transaction/rates',
    ],
    [
      'host lama yang SUDAH menyebut /api → tidak dobel',
      'https://idrx.co/api',
      'https://idrx.co',
      '/api/transaction/rates',
    ],
    [
      'garis miring di ujung diabaikan',
      'https://api.idrx.co/',
      'https://api.idrx.co',
      '/transaction/rates',
    ],
  ])('%s', (_nama, base, origin, path) => {
    expect(resolveIdrxEndpoint(base, '/transaction/rates')).toEqual({
      origin,
      path,
    });
  });
});

describe('IdrxClient — URL dan tanda tangan setelah migrasi host', () => {
  const SECRET = Buffer.from('rahasia-uji').toString('base64');
  const TS = 1_791_000_000_000;
  const ORIG_ENV = { ...process.env };
  let fetchMock: jest.Mock;

  beforeEach(() => {
    // Jalur ASLI, bukan mock: pagar mock menolak aktif di sinyal produksi.
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    jest.spyOn(Date, 'now').mockReturnValue(TS);
    fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"statusCode":200,"data":{}}'),
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    jest.restoreAllMocks();
  });

  const client = (base?: string) =>
    new IdrxClient(
      {
        get: (k: string) =>
          ({
            IDRX_API_KEY: 'kunci',
            IDRX_API_SECRET: SECRET,
            IDRX_API_BASE: base,
          })[k],
      } as unknown as ConfigService,
      new IdrxMockStore(),
    );

  /** URL dan header yang benar-benar dikirim ke fetch. */
  const sent = () => {
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body?: string },
    ];
    return { url, init };
  };

  /** Tanda tangan yang SEHARUSNYA, dihitung dari path yang benar-benar diminta. */
  const expectedSig = (url: string, method: string, body?: unknown) => {
    const u = new URL(url);
    return createIdrxSignature(
      method,
      u.pathname + u.search,
      body,
      String(TS),
      SECRET,
    );
  };

  it('bawaan: rates ke https://api.idrx.co/transaction/rates, ditandatangani atas path itu', async () => {
    await client().rates('50');

    const { url, init } = sent();
    expect(url).toBe('https://api.idrx.co/transaction/rates?usdtAmount=50');
    expect(init.headers['idrx-api-sig']).toBe(expectedSig(url, 'GET'));
  });

  it('bawaan: mint-request ke https://api.idrx.co/transaction/mint-request, body ikut ditandatangani', async () => {
    const input = {
      toBeMinted: '20000',
      destinationWalletAddress: 'TreasuryBase58',
      networkChainId: '2',
      returnUrl: 'https://hoshimarket.xyz/vault',
    };
    await client().mintRequest(input);

    const { url, init } = sent();
    expect(url).toBe('https://api.idrx.co/transaction/mint-request');
    expect(init.headers['idrx-api-sig']).toBe(expectedSig(url, 'POST', input));
  });

  /**
   * JALAN PULANG. Mengisi IDRX_API_BASE=https://idrx.co harus menghasilkan request yang IDENTIK
   * dengan sebelum migrasi — URL dan tanda tangannya. Itu yang membuatnya aman dipakai sebagai
   * rollback tanpa deploy ulang, kalau host baru ternyata menolak.
   */
  it('IDRX_API_BASE=https://idrx.co: URL dan tanda tangan PERSIS bentuk lama', async () => {
    await client('https://idrx.co').findMintByMerchantOrderId('20261004221230');

    const { url, init } = sent();
    expect(url).toBe(
      'https://idrx.co/api/transaction/user-transaction-history' +
        '?transactionType=MINT&merchantOrderId=20261004221230&page=1&take=1',
    );
    expect(init.headers['idrx-api-sig']).toBe(
      createIdrxSignature(
        'GET',
        '/api/transaction/user-transaction-history' +
          '?transactionType=MINT&merchantOrderId=20261004221230&page=1&take=1',
        undefined,
        String(TS),
        SECRET,
      ),
    );
  });
});
