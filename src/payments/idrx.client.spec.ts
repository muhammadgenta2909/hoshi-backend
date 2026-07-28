import { ConfigService } from '@nestjs/config';
import { IdrxClient } from './idrx.client';
import { IdrxMockStore } from './idrx-mock.store';
import type { IdrxMintRequestInput } from './idrx.types';

/**
 * Fokus: PAGAR keamanan IDRX MOCK. Mock hanya boleh aktif saat IDRX_MOCK=1 DAN deployment
 * tidak terlihat produksi (detectProductionSignal membaca process.env langsung). Kalau pagar
 * ini bocor, deployment mainnet bisa "membayar" pack tanpa rupiah asli — jadi diuji keras.
 */
describe('IdrxClient — pagar IDRX MOCK', () => {
  const ORIG_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  const makeClient = (cfg: Record<string, string | undefined>): IdrxClient => {
    const config = {
      get: (k: string) => cfg[k],
    } as unknown as ConfigService;
    return new IdrxClient(config, new IdrxMockStore());
  };

  const mintInput: IdrxMintRequestInput = {
    toBeMinted: '800000',
    destinationWalletAddress: 'HoshiTreasuryBase58',
    networkChainId: '2',
    returnUrl: 'http://frontend.local/open-packs',
  };

  it('MOCK aktif di devnet + IDRX_MOCK=1 → mint-request lokal (paymentUrl mock, tanpa kredensial)', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    delete process.env.SOLANA_RPC_URL;
    delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
    const client = makeClient({
      IDRX_MOCK: '1',
      IDRX_MOCK_PUBLIC_URL: 'http://localhost:3001',
    });

    const res = await client.mintRequest(mintInput);
    expect(res.data.merchantOrderId).toMatch(/^MOCK-/);
    expect(res.data.paymentUrl).toContain('/api/idrx-mock/pay?order=');
  });

  it('MOCK verifier: WAITING → PAID+PROCESSING (bayar) → PAID+MINTED (settle) — echo treasury', async () => {
    jest.useFakeTimers();
    try {
      process.env.SOLANA_CLUSTER = 'devnet';
      const store = new IdrxMockStore();
      const config = {
        get: (k: string) =>
          ({ IDRX_MOCK: '1', IDRX_MOCK_PUBLIC_URL: 'http://localhost:3001' })[k],
      } as unknown as ConfigService;
      const client = new IdrxClient(config, store);

      const res = await client.mintRequest(mintInput);
      const moid = res.data.merchantOrderId;

      const before = await client.findMintByMerchantOrderId(moid);
      expect(before?.paymentStatus).toBe('WAITING_FOR_PAYMENT');
      expect(before?.userMintStatus).not.toBe('MINTED');

      // Bayar, tapi mint BELUM settle → PAID + PROCESSING (fulfilment harus MENUNGGU).
      store.markPaid(moid);
      const paidNotSettled = await client.findMintByMerchantOrderId(moid);
      expect(paidNotSettled?.paymentStatus).toBe('PAID');
      expect(paidNotSettled?.userMintStatus).not.toBe('MINTED');

      // Lewat jeda settlement → baru PAID + MINTED (persis IDRX asli).
      jest.advanceTimersByTime(IdrxMockStore.SETTLE_DELAY_MS + 100);
      const settled = await client.findMintByMerchantOrderId(moid);
      expect(settled?.paymentStatus).toBe('PAID');
      expect(settled?.userMintStatus).toBe('MINTED');
      expect(settled?.destinationWalletAddress).toBe(
        mintInput.destinationWalletAddress,
      );
      expect(settled?.requestType).toBe('idrx');
    } finally {
      jest.useRealTimers();
    }
  });

  it('TANPA IDRX_MOCK → jalur ASLI (credentials() melempar karena tak ada API key)', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const client = makeClient({}); // IDRX_MOCK unset, tanpa kredensial
    await expect(client.rates('50')).rejects.toThrow(/belum dikonfigurasi/);
  });

  it('PRODUKSI (SOLANA_CLUSTER=mainnet-beta) → mock DIABAIKAN walau IDRX_MOCK=1', async () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta'; // sinyal produksi
    const client = makeClient({ IDRX_MOCK: '1' }); // flag on, tapi produksi
    // mock mati → jalur asli → credentials() melempar (tak ada key). Kalau mock BOCOR,
    // ini malah balas sukses palsu — jadi 'rejects' inilah bukti pagarnya menutup.
    await expect(client.rates('50')).rejects.toThrow(/belum dikonfigurasi/);
  });

  it('PRODUKSI via COLLECTORCRYPT_GACHA_BASE_URL gacha asli → mock DIABAIKAN', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    process.env.COLLECTORCRYPT_GACHA_BASE_URL = 'https://gacha.collectorcrypt.com';
    const client = makeClient({ IDRX_MOCK: '1' });
    await expect(client.rates('50')).rejects.toThrow(/belum dikonfigurasi/);
  });
});
