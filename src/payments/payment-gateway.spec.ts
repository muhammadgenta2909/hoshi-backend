import { ConfigService } from '@nestjs/config';
import 'reflect-metadata';
import { DuitkuClient } from './duitku.client';
import { IdrxClient } from './idrx.client';
import {
  duitkuStatusToRecord,
  isDuitkuOrderId,
  newDuitkuOrderId,
  PaymentGateway,
} from './payment-gateway';
import { PaymentsModule } from './payments.module';
import { PaymentsService } from './payments.service';

/**
 * Gerbang dua rel. Yang paling mahal kalau salah di sini bukan "tagihan terbit di rel yang
 * salah" — itu langsung kelihatan — melainkan BUKTI yang diambil dari rel yang salah: order IDRX
 * yang masih menggantung saat saklar dipindah ke Duitku tidak boleh ikut ditanyakan ke Duitku.
 */
describe('PaymentGateway', () => {
  let idrx: {
    mintRequest: jest.Mock;
    findMintByMerchantOrderId: jest.Mock;
    rates: jest.Mock;
  };
  let duitku: {
    createInvoice: jest.Mock;
    transactionStatus: jest.Mock;
    readConfig: jest.Mock;
    isCallbackSignatureValid: jest.Mock;
  };

  const gateway = (provider?: string) =>
    new PaymentGateway(
      idrx as unknown as IdrxClient,
      duitku as unknown as DuitkuClient,
      {
        get: (k: string) => (k === 'PAYMENT_PROVIDER' ? provider : undefined),
      } as unknown as ConfigService,
    );

  const input = {
    toBeMinted: '20000',
    destinationWalletAddress: 'Treasury',
    networkChainId: '2',
    returnUrl: 'https://hoshimarket.xyz/vault',
    expiryPeriod: 30,
    productDetails: 'Hoshi Titipan Charizard VMAX',
  };

  beforeEach(() => {
    idrx = {
      mintRequest: jest.fn().mockResolvedValue({
        statusCode: 200,
        data: { merchantOrderId: '20261009021827' },
      }),
      findMintByMerchantOrderId: jest.fn().mockResolvedValue(null),
      rates: jest.fn(),
    };
    duitku = {
      createInvoice: jest
        .fn()
        .mockResolvedValue({ reference: 'R1', paymentUrl: 'https://pay' }),
      transactionStatus: jest.fn().mockResolvedValue(null),
      readConfig: jest.fn().mockReturnValue({ merchantCode: 'DS12345' }),
      isCallbackSignatureValid: jest.fn(),
    };
  });

  describe('tagihan baru mengikuti saklar', () => {
    it('saklar tidak diisi → IDRX (produksi tidak berubah sampai dinyalakan dengan sengaja)', async () => {
      await gateway(undefined).mintRequest(input);

      expect(idrx.mintRequest).toHaveBeenCalledWith(input);
      expect(duitku.createInvoice).not.toHaveBeenCalled();
    });

    it('PAYMENT_PROVIDER=duitku → Duitku, nomor order berawalan DK, nominal tagihan utuh', async () => {
      const res = await gateway('duitku').mintRequest(input);

      expect(idrx.mintRequest).not.toHaveBeenCalled();
      const [arg] = duitku.createInvoice.mock.calls[0] as [
        { paymentAmount: number; merchantOrderId: string },
      ];
      expect(arg.paymentAmount).toBe(20_000);
      expect(isDuitkuOrderId(arg.merchantOrderId)).toBe(true);
      expect(res.data.merchantOrderId).toBe(arg.merchantOrderId);
      expect(res.data.paymentUrl).toBe('https://pay');
    });

    it('alur QRIS langsung di Duitku → ditolak, tidak menerbitkan halaman bayar diam-diam', async () => {
      await expect(
        gateway('duitku').mintRequest({
          ...input,
          paymentMethod: 'QRIS',
          channelId: 'x',
        }),
      ).rejects.toThrow(/halaman pembayaran/);
      expect(duitku.createInvoice).not.toHaveBeenCalled();
    });
  });

  describe('bukti mengikuti NOMOR ORDER, bukan saklar', () => {
    it('saklar sudah Duitku, order IDRX lama → tetap ditanyakan ke IDRX', async () => {
      await gateway('duitku').findMintByMerchantOrderId('20261009021827');

      expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledWith(
        '20261009021827',
      );
      expect(duitku.transactionStatus).not.toHaveBeenCalled();
    });

    it('saklar kembali IDRX, order Duitku → tetap ditanyakan ke Duitku', async () => {
      await gateway('idrx').findMintByMerchantOrderId(
        'DK1791979642000a1b2c3d4',
      );

      expect(duitku.transactionStatus).toHaveBeenCalledWith(
        'DK1791979642000a1b2c3d4',
      );
      expect(idrx.findMintByMerchantOrderId).not.toHaveBeenCalled();
    });
  });

  describe('status Duitku → catatan verifikasi', () => {
    const base = { merchantOrderId: 'DK1', amount: '20000', reference: 'R1' };

    it('"00" → PAID + MINTED, bertanda rel DUITKU, nominalnya ikut', () => {
      expect(duitkuStatusToRecord({ ...base, statusCode: '00' })).toMatchObject(
        {
          paymentStatus: 'PAID',
          userMintStatus: 'MINTED',
          toBeMinted: '20000',
          rail: 'DUITKU',
        },
      );
    });

    it('"01" → masih menunggu', () => {
      expect(duitkuStatusToRecord({ ...base, statusCode: '01' })).toMatchObject(
        {
          paymentStatus: 'WAITING_FOR_PAYMENT',
          userMintStatus: 'NOT_AVAILABLE',
        },
      );
    });

    it('"02" → kedaluwarsa/batal', () => {
      expect(
        duitkuStatusToRecord({ ...base, statusCode: '02' }).paymentStatus,
      ).toBe('EXPIRED');
    });

    it('kode yang tidak dikenal → MENUNGGU, bukan lunas dan bukan kedaluwarsa', () => {
      const rec = duitkuStatusToRecord({ ...base, statusCode: '99' });
      expect(rec.paymentStatus).toBe('WAITING_FOR_PAYMENT');
      expect(rec.userMintStatus).toBe('NOT_AVAILABLE');
    });
  });

  it('nomor order Duitku tidak bisa bertabrakan dengan IDRX maupun mock IDRX', () => {
    const id = newDuitkuOrderId(1_791_979_642_000);
    expect(id).toMatch(/^DK1791979642000[0-9a-f]{8}$/);
    expect(id.length).toBeLessThanOrEqual(50);
    expect(isDuitkuOrderId('20261009021827')).toBe(false);
    expect(isDuitkuOrderId('MOCK-1790558116318-19380')).toBe(false);
  });

  /**
   * Tsc tidak menangkap ini: PaymentsService meminta PaymentGateway lewat injeksi Nest. Kalau
   * modulnya lupa mendaftarkan PaymentGateway (atau DuitkuClient yang dibutuhkannya), server
   * GAGAL MENYALA saat deploy — seluruh api.hoshimarket.xyz mati.
   */
  it('PaymentsModule mendaftarkan semua yang dibutuhkan rel pembayaran', () => {
    const providers = Reflect.getMetadata(
      'providers',
      PaymentsModule,
    ) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        PaymentsService,
        PaymentGateway,
        DuitkuClient,
        IdrxClient,
      ]),
    );
    const deps = Reflect.getMetadata(
      'design:paramtypes',
      PaymentsService,
    ) as unknown[];
    expect(deps).toContain(PaymentGateway);
  });
});
