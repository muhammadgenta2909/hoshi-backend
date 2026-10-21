import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  DUITKU_TX_NOT_FOUND,
  DuitkuClient,
  duitkuCallbackSignature,
  duitkuInvoiceSignature,
  duitkuStatusSignature,
} from './duitku.client';

/**
 * Klien Duitku. Tiga hal yang diuji keras di sini, karena tiga-tiganya gagal DIAM-DIAM kalau
 * salah:
 *   1. rumus tanda tangan — dicocokkan ke library PHP RESMI Duitku, bukan ke port pihak ketiga;
 *   2. pagar sandbox — sandbox di produksi berarti kartu sungguhan diserahkan tanpa bayar;
 *   3. jawaban yang tidak cocok diperlakukan TIDAK DITEMUKAN, bukan lunas.
 */
describe('DuitkuClient', () => {
  const ORIG_ENV = { ...process.env };
  const CFG = {
    DUITKU_ENV: 'sandbox',
    DUITKU_MERCHANT_CODE: 'DS12345',
    DUITKU_API_KEY: 'kunci-uji-coba',
    DUITKU_CALLBACK_URL: 'https://api.hoshi.test/api/payments/duitku/callback',
    DUITKU_CUSTOMER_EMAIL: 'pembayaran@hoshimarket.xyz',
  };
  let fetchMock: jest.Mock;

  const client = (over: Record<string, string | undefined> = {}) =>
    new DuitkuClient({
      get: (k: string) =>
        (({ ...CFG, ...over }) as Record<string, string | undefined>)[k],
    } as unknown as ConfigService);

  const respond = (body: unknown, status = 200) =>
    fetchMock.mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });

  const sent = () => {
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    return {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
    };
  };

  beforeEach(() => {
    // Mesin uji = BUKAN produksi, supaya sandbox boleh hidup.
    process.env.SOLANA_CLUSTER = 'devnet';
    delete process.env.SOLANA_RPC_URL;
    delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    process.env = { ...ORIG_ENV };
    jest.restoreAllMocks();
  });

  describe('rumus tanda tangan (library PHP resmi Duitku)', () => {
    it('createInvoice: sha256 BIASA atas merchantCode + timestamp + apiKey — bukan HMAC', () => {
      const expected = createHash('sha256')
        .update('DS1234517000000000kunci')
        .digest('hex');
      expect(duitkuInvoiceSignature('DS12345', '17000000000', 'kunci')).toBe(
        expected,
      );
    });

    it('transactionStatus: md5 atas merchantCode + merchantOrderId + apiKey', () => {
      const expected = createHash('md5')
        .update('DS12345DK1kunci')
        .digest('hex');
      expect(duitkuStatusSignature('DS12345', 'DK1', 'kunci')).toBe(expected);
    });

    it('callback: md5 atas merchantCode + amount + merchantOrderId + apiKey', () => {
      const expected = createHash('md5')
        .update('DS1234520000DK1kunci')
        .digest('hex');
      expect(duitkuCallbackSignature('DS12345', '20000', 'DK1', 'kunci')).toBe(
        expected,
      );
    });
  });

  describe('pagar konfigurasi', () => {
    it('DUITKU_ENV kosong → menolak, tanpa satu panggilan jaringan pun', async () => {
      await expect(
        client({ DUITKU_ENV: undefined }).transactionStatus('DK1'),
      ).rejects.toThrow(/DUITKU_ENV/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('SANDBOX di deployment produksi → DITOLAK (pembayaran sandbox gratis = kartu gratis)', async () => {
      process.env.SOLANA_CLUSTER = 'mainnet-beta';

      await expect(client().transactionStatus('DK1')).rejects.toThrow(
        /SANDBOX ditolak/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('PRODUCTION di deployment produksi → boleh, ke host produksi', async () => {
      process.env.SOLANA_CLUSTER = 'mainnet-beta';
      respond({ merchantOrderId: 'DK1', amount: '20000', statusCode: '01' });

      await client({ DUITKU_ENV: 'production' }).transactionStatus('DK1');

      expect(sent().url).toBe(
        'https://passport.duitku.com/webapi/api/merchant/transactionStatus',
      );
    });
  });

  describe('createInvoice', () => {
    it('mengirim header bertanda tangan dan body yang benar ke host sandbox', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000);
      respond({
        merchantCode: 'DS12345',
        reference: 'DS1234526ABC',
        paymentUrl: 'https://sandbox.duitku.com/topup/v2/x',
        statusCode: '00',
        statusMessage: 'SUCCESS',
      });

      const invoice = await client().createInvoice({
        paymentAmount: 20_000,
        merchantOrderId: 'DK1',
        productDetails: 'Hoshi Titipan Charizard VMAX',
        returnUrl: 'https://hoshimarket.xyz/vault',
        expiryPeriod: 30,
      });

      const { url, headers, body } = sent();
      expect(url).toBe(
        'https://api-sandbox.duitku.com/api/merchant/createInvoice',
      );
      expect(headers['x-duitku-merchantcode']).toBe('DS12345');
      expect(headers['x-duitku-timestamp']).toBe('1791000000000');
      expect(headers['x-duitku-signature']).toBe(
        duitkuInvoiceSignature('DS12345', '1791000000000', 'kunci-uji-coba'),
      );
      expect(body).toMatchObject({
        paymentAmount: 20_000,
        merchantOrderId: 'DK1',
        email: 'pembayaran@hoshimarket.xyz',
        customerVaName: 'Hoshimarket',
        callbackUrl: CFG.DUITKU_CALLBACK_URL,
        returnUrl: 'https://hoshimarket.xyz/vault',
        expiryPeriod: 30,
      });
      expect(invoice).toEqual({
        reference: 'DS1234526ABC',
        paymentUrl: 'https://sandbox.duitku.com/topup/v2/x',
      });
    });

    it('Duitku menjawab bukan "00" → menolak, order tidak boleh lahir', async () => {
      respond({ statusCode: '01', statusMessage: 'Invalid signature' });

      await expect(
        client().createInvoice({
          paymentAmount: 20_000,
          merchantOrderId: 'DK1',
          productDetails: 'x',
          returnUrl: 'https://hoshimarket.xyz/vault',
        }),
      ).rejects.toThrow(/Invalid signature/);
    });

    it('nominal pecahan → menolak sebelum menghubungi Duitku', async () => {
      await expect(
        client().createInvoice({
          paymentAmount: 20_000.5,
          merchantOrderId: 'DK1',
          productDetails: 'x',
          returnUrl: 'https://hoshimarket.xyz/vault',
        }),
      ).rejects.toThrow(/rupiah utuh/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('transactionStatus', () => {
    it('jawaban untuk order LAIN → null (tidak ditemukan), bukan lunas', async () => {
      respond({
        merchantOrderId: 'DK-ORANG-LAIN',
        amount: '20000',
        statusCode: '00',
      });

      await expect(client().transactionStatus('DK1')).resolves.toBeNull();
    });

    it('mengirim tanda tangan md5 yang benar', async () => {
      respond({
        merchantOrderId: 'DK1',
        amount: '20000',
        statusCode: '00',
        reference: 'R1',
      });

      const status = await client().transactionStatus('DK1');

      expect(sent().body).toEqual({
        merchantCode: 'DS12345',
        merchantOrderId: 'DK1',
        signature: duitkuStatusSignature('DS12345', 'DK1', 'kunci-uji-coba'),
      });
      expect(status).toMatchObject({ statusCode: '00', amount: '20000' });
    });

    // Host POP TIDAK punya endpoint ini (404 generik di sandbox) — salah host = tidak satu pun
    // pembayaran bisa diverifikasi.
    it('cek status dikirim ke host WEBAPI, bukan host POP', async () => {
      respond({ merchantOrderId: 'DK1', amount: '20000', statusCode: '01' });
      await client().transactionStatus('DK1');
      expect(sent().url).toBe(
        'https://sandbox.duitku.com/webapi/api/merchant/transactionStatus',
      );
    });

    // Jawaban persis yang diamati di sandbox (host webapi) untuk tagihan yang belum dibuka.
    it('HTTP 404 {"Message":"Transaction not found"} → NOT_FOUND (belum dibuka), bukan error', async () => {
      respond({ Message: 'Transaction not found' }, 404);

      await expect(client().transactionStatus('DK1')).resolves.toBe(
        DUITKU_TX_NOT_FOUND,
      );
    });

    it('HTTP 400 "Transaction not found" → juga NOT_FOUND', async () => {
      respond('Transaction not found', 400);

      await expect(client().transactionStatus('DK1')).resolves.toBe(
        DUITKU_TX_NOT_FOUND,
      );
    });

    it('HTTP 400 dengan pesan LAIN (mis. tanda tangan salah) → tetap error, bukan "belum dibuka"', async () => {
      respond({ Message: 'Wrong signature' }, 400);

      await expect(client().transactionStatus('DK1')).rejects.toThrow(
        /HTTP 400/,
      );
    });

    it('HTTP 500 → tetap error (Duitku ngadat ≠ belum bayar)', async () => {
      respond('Transaction not found', 500);

      await expect(client().transactionStatus('DK1')).rejects.toThrow(
        /HTTP 500/,
      );
    });
  });

  describe('tanda tangan callback', () => {
    const signed = (amount: string) => ({
      merchantCode: 'DS12345',
      amount,
      merchantOrderId: 'DK1',
      resultCode: '00',
      signature: duitkuCallbackSignature(
        'DS12345',
        amount,
        'DK1',
        'kunci-uji-coba',
      ),
    });

    it('callback asli → sah', () => {
      expect(client().isCallbackSignatureValid(signed('20000'))).toBe(true);
    });

    it('nominalnya diubah setelah ditandatangani → TIDAK sah', () => {
      expect(
        client().isCallbackSignatureValid({ ...signed('20000'), amount: '1' }),
      ).toBe(false);
    });

    it('merchant lain (tanda tangannya sendiri sah) → TIDAK sah untuk kita', () => {
      expect(
        client().isCallbackSignatureValid({
          ...signed('20000'),
          merchantCode: 'DS99999',
          signature: duitkuCallbackSignature(
            'DS99999',
            '20000',
            'DK1',
            'kunci-uji-coba',
          ),
        }),
      ).toBe(false);
    });

    it('Duitku belum dikonfigurasi → tidak ada callback yang sah', () => {
      expect(
        client({ DUITKU_API_KEY: undefined }).isCallbackSignatureValid(
          signed('20000'),
        ),
      ).toBe(false);
    });
  });
});
