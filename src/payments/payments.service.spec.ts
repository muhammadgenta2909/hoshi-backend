import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CcPackStatus, PaymentStatus } from '@prisma/client';
import type { PaymentOrder } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { GachaService, type CcPackDto } from '../collectorcrypt/gacha.service';
import type { CcMachineNormalized } from '../collectorcrypt/cc-gacha.types';
import { PrismaService } from '../prisma/prisma.service';
import { IdrxClient } from './idrx.client';
import { PaymentsService } from './payments.service';
import type {
  IdrxMintRequestResponse,
  IdrxRatesResponse,
  IdrxTransactionRecord,
} from './idrx.types';

// PaymentsService meng-import PublicKey dari @solana/web3.js (untuk memvalidasi alamat
// treasury) DAN — lewat GachaService → TreasuryService — menarik rantai ESM v1
// (rpc-websockets→uuid) yang bikin jest gagal parse. Sama seperti gacha.service.spec.ts,
// kita mock @solana/web3.js. GachaService & TreasuryService hanya dipakai sebagai TOKEN DI
// dan selalu di-override dengan mock, jadi tak ada key yang dibaca / tx yang ditandatangani.
// PublicKey di sini cukup kelas no-op: satu-satunya pemakaiannya di service adalah
// `new PublicKey(addr)` untuk MENOLAK alamat yang tidak sah — dan setiap tes memasok alamat sah.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
}));

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: {
    paymentOrder: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    ccPackPurchase: { aggregate: jest.Mock };
  };
  let idrx: {
    mintRequest: jest.Mock;
    rates: jest.Mock;
    findMintByMerchantOrderId: jest.Mock;
  };
  let gacha: { machines: jest.Mock; purchase: jest.Mock };
  let config: { get: jest.Mock };
  let configValues: Record<string, string | number | undefined>;

  const now = new Date('2026-07-14T00:00:00.000Z');

  // Alamat treasury: TUJUAN rupiah user & satu-satunya destinationWalletAddress yang sah.
  const TREASURY_ADDRESS = 'HoshiTreasuryBase58Addr';
  // Wallet yang akan dicoba diselipkan penyerang lewat body callback — tidak boleh pernah dipakai.
  const ATTACKER_ADDRESS = 'AttackerWalletBase58';

  const MERCHANT_ORDER_ID = 'MOID-abc-123';
  const MEMO = 'hoshi-slug-11111111-2222-3333-4444-555555555555';

  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };

  // Baris User seperti dikembalikan Prisma saat fulfilment. Penerima kartu diturunkan DARI SINI,
  // tidak pernah dari body callback (yang tidak membawa JWT).
  const userRow = {
    id: user.id,
    walletAddress: user.walletAddress,
    displayName: null,
    role: 'USER',
  };

  // Mesin SETELAH dinormalkan klien (CcMachineNormalized): `price` dolar sudah diganti
  // priceUsdcDollars (display) + priceUsdcBaseUnits (satu-satunya nilai uang). Key rarity
  // HURUF-KECIL sesuai wire CC, dan ev FLOAT dolar penuh (display-only).
  const machine: CcMachineNormalized = {
    code: 'pokemon_50',
    name: 'Pokemon $50',
    shortName: 'PKMN 50',
    image: '',
    thumbnailUrl: '/pokemon_50.png',
    videoSrc: '',
    videoHevc: '',
    public: true,
    owner: null,
    contains: 1,
    instantBuyback: 85,
    freeSpins: true,
    turboMode: true,
    pointsMultiplier: 1,
    lowThreshold: 20,
    targetEv: 55,
    ev: 64.78889966676375,
    odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
    tierRanges: {},
    stock: { common: 28, uncommon: 10, rare: 133, epic: 490 },
    priceUsdcDollars: 50, // nilai mentah CC dalam dolar penuh
    priceUsdcBaseUnits: 50_000_000, // $50 = 50_000_000 — satu-satunya nilai jalur uang
  };

  // Harga rupiah default yang dihasilkan pipeline: buyAmount 800.000 + fee QRIS 0,7% (margin 0)
  // = 805.600. Dipakai sebagai priceIdr baris order dan sebagai nominal yang dicocokkan verifier.
  const PRICE_IDR = 805_600;

  const baseOrder: PaymentOrder = {
    id: 'order-1',
    merchantOrderId: MERCHANT_ORDER_ID,
    idrxRequestId: 'idrx-id-1',
    reference: 'REF-1',
    userId: user.id,
    packType: 'pokemon_50',
    priceIdr: PRICE_IDR,
    priceUsdc: 50_000_000,
    paymentMethod: 'QRIS',
    qrContent: 'qr-string',
    virtualAccountNo: null,
    paymentUrl: null,
    expiresAt: new Date('2026-07-14T00:30:00.000Z'),
    status: PaymentStatus.PENDING,
    idrxPaymentStatus: null,
    idrxUserMintStatus: null,
    txHash: null,
    packMemo: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    paidAt: null,
    fulfilledAt: null,
  };

  const fulfilledOrder: PaymentOrder = {
    ...baseOrder,
    status: PaymentStatus.FULFILLED,
    packMemo: MEMO,
    paidAt: now,
    fulfilledAt: now,
  };

  // SATU-SATUNYA bukti sah bahwa pembayaran benar-benar lunas: catatan History API IDRX,
  // BUKAN body callback. PAID + MINTED, mint ke treasury kita, nominal >= tagihan, requestType idrx.
  const paidMintedRecord: IdrxTransactionRecord = {
    id: 'rec-1',
    merchantOrderId: MERCHANT_ORDER_ID,
    paymentStatus: 'PAID',
    userMintStatus: 'MINTED',
    destinationWalletAddress: TREASURY_ADDRESS,
    requestType: 'idrx',
    toBeMinted: PRICE_IDR,
    txHash: 'SolanaTxHash',
  };

  const pack: CcPackDto = {
    memo: MEMO,
    packType: 'pokemon_50',
    status: CcPackStatus.OPENED,
    turbo: false,
    playerAddress: TREASURY_ADDRESS,
    priceUsdc: 50_000_000,
    purchaseSignature: 'BuySig',
    openSignature: 'OpenSig',
    rarity: 'Epic',
    nftAddress: 'NftAddrBase58',
    nftName: 'Charizard',
    nftImage: 'https://cdn.example.com/charizard.png',
    roll: '9987',
    points: 420,
    buybackAmountUsdc: null,
    error: null,
    createdAt: now,
    openedAt: now,
  };

  const ratesResponse = (buyAmount: number): IdrxRatesResponse => ({
    statusCode: 200,
    message: 'ok',
    data: {
      price: 1,
      buyAmount,
      chainId: '101',
      quote: { expectedResult: { min: buyAmount, max: buyAmount } },
    },
  });

  const mintResponse = (merchantOrderId: string): IdrxMintRequestResponse => ({
    statusCode: 200,
    message: 'ok',
    data: {
      id: 'idrx-id-1',
      merchantOrderId,
      merchantCode: 'MC',
      reference: 'REF-1',
      qrContent: 'qr-string',
      amount: PRICE_IDR,
      statusCode: 200,
      statusMessage: 'created',
    },
  });

  /**
   * Setiap `status` yang benar-benar ditulis ke ledger order — lewat update MAUPUN updateMany.
   * Refund pasca-klaim ditulis via updateMany berpredikat status, sedangkan FULFILLED via update;
   * helper ini menyapu keduanya supaya "status apa yang pernah tertulis" tidak bisa lolos deteksi.
   */
  const allStatusesWritten = (): unknown[] =>
    [
      ...(prisma.paymentOrder.update.mock.calls as [
        { data: { status?: unknown } },
      ][]),
      ...(prisma.paymentOrder.updateMany.mock.calls as [
        { data: { status?: unknown } },
      ][]),
    ]
      .map(([arg]) => arg.data.status)
      .filter((status) => status !== undefined);

  beforeEach(async () => {
    configValues = {
      HOSHI_TREASURY_ADDRESS: TREASURY_ADDRESS,
      IDRX_NETWORK_CHAIN_ID: '101',
      HOSHI_PAYMENT_RETURN_URL: 'https://hoshi.example/return',
      IDRX_QRIS_CHANNEL_ID: 'QRIS-CH',
      // margin, slippage, kuota order, cap harian, expiry → dibiarkan default lewat intConfig.
    };

    prisma = {
      paymentOrder: {
        create: jest.fn().mockResolvedValue(baseOrder),
        findUnique: jest.fn().mockResolvedValue(baseOrder),
        findMany: jest.fn().mockResolvedValue([]),
        // Default: request ini MEMENANGKAN klaim atomik PENDING/PAID → FULFILLING.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(fulfilledOrder),
        // Default: user belum punya order menganggur → kuota tidak menghalangi.
        count: jest.fn().mockResolvedValue(0),
        // Default: belum ada obligasi order → plafon treasury tidak menghalangi.
        aggregate: jest.fn().mockResolvedValue({ _sum: { priceUsdc: null } }),
      },
      user: { findUnique: jest.fn().mockResolvedValue(userRow) },
      ccPackPurchase: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { priceUsdc: null } }),
      },
    };
    idrx = {
      mintRequest: jest.fn().mockResolvedValue(mintResponse(MERCHANT_ORDER_ID)),
      rates: jest.fn().mockResolvedValue(ratesResponse(800_000)),
      // Default verifier: pembayaran TERBUKTI lunas & tercetak ke treasury.
      findMintByMerchantOrderId: jest.fn().mockResolvedValue(paidMintedRecord),
    };
    gacha = {
      machines: jest.fn().mockResolvedValue([machine]),
      purchase: jest.fn().mockResolvedValue(pack),
    };
    config = { get: jest.fn((key: string) => configValues[key]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdrxClient, useValue: idrx },
        { provide: GachaService, useValue: gacha },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(PaymentsService);
  });

  /**
   * PENETAPAN HARGA & SNAPSHOT. Nominal tidak pernah datang dari klien: ia di-snapshot dari
   * harga mesin CC + kurs IDRX, dibulatkan KE ATAS, dan integer (rupiah pecahan tidak ada).
   */
  describe('createPackOrder (harga & snapshot)', () => {
    it('menyusun harga rupiah dari rates() + margin + fee QRIS sebagai INTEGER', async () => {
      // margin 5% (500 bps). buyAmount 800.000 → +5% = 840.000 → +0,7% QRIS = 845.880.
      configValues.HOSHI_PACK_MARGIN_BPS = 500;
      idrx.rates.mockResolvedValue(ratesResponse(800_000));

      await service.createPackOrder({}, user);

      expect(idrx.mintRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toBeMinted: '845880',
          destinationWalletAddress: TREASURY_ADDRESS,
        }),
      );
      const [sent] = idrx.mintRequest.mock.calls[0] as [{ toBeMinted: string }];
      // String rupiah penuh, tak ada titik desimal → dijamin integer.
      expect(sent.toBeMinted).toBe('845880');
      expect(Number.isInteger(Number(sent.toBeMinted))).toBe(true);
    });

    it('membulatkan harga KE ATAS (tak pernah rugi karena pembulatan ke bawah), tetap integer', async () => {
      // buyAmount 799.999, margin 0, fee QRIS 0,7% → 799.999 × 1,007 = 805.598,99... → 805.599.
      configValues.HOSHI_PACK_MARGIN_BPS = 0;
      idrx.rates.mockResolvedValue(ratesResponse(799_999));

      await service.createPackOrder({}, user);

      const [sent] = idrx.mintRequest.mock.calls[0] as [{ toBeMinted: string }];
      expect(sent.toBeMinted).toBe('805599');
    });

    it('menolak (BadRequest) harga di bawah minimum mint IDRX 20.000 dan tidak memanggil mintRequest', async () => {
      // buyAmount 10.000 → 10.070 rupiah, di bawah batas 20.000 IDRX.
      idrx.rates.mockResolvedValue(ratesResponse(10_000));

      await expect(service.createPackOrder({}, user)).rejects.toThrow(
        BadRequestException,
      );
      expect(idrx.mintRequest).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    it('menolak (BadRequest) packType yang tak dikenal dan tidak pernah memanggil mintRequest', async () => {
      await expect(
        service.createPackOrder({ packType: 'not_a_machine' }, user),
      ).rejects.toThrow(BadRequestException);

      expect(idrx.mintRequest).not.toHaveBeenCalled();
      expect(idrx.rates).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    it('mempersist baris order dengan KEDUA snapshot harga: priceIdr (rupiah) dan priceUsdc (base unit)', async () => {
      const dto = await service.createPackOrder({}, user);

      // Snapshot harga mesin CC diambil dari machines(), bukan di-hardcode / dari klien.
      expect(gacha.machines).toHaveBeenCalled();
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchantOrderId: MERCHANT_ORDER_ID,
          userId: user.id,
          packType: 'pokemon_50',
          priceIdr: PRICE_IDR, // rupiah penuh, integer
          priceUsdc: 50_000_000, // USDC base unit — SATUAN BERBEDA, jangan dibandingkan
          status: PaymentStatus.PENDING,
        }) as unknown,
      });
      expect(dto.priceIdr).toBe(PRICE_IDR);
      expect(dto.priceUsdc).toBe(50_000_000);
      expect(Number.isInteger(dto.priceIdr)).toBe(true);
    });

    // Plafon treasury menghitung obligasi ORDER (PENDING/PAID/FULFILLING/FULFILLED), bukan cuma
    // pack yang sudah tuntas. Tanpa ini, order yang sudah menagih user menyumbang 0 ke plafon,
    // sebar order barengan lolos semua, lalu jadi REFUND_DUE sesudah dibayar. Order in-flight yang
    // sudah menyentuh plafon HARUS menolak order baru — sebelum user ditagih.
    it('menghitung order in-flight ke plafon treasury dan menolak sebelum menagih user', async () => {
      const cap = 500_000_000; // 10 pack pokemon_50
      configValues.GACHA_TREASURY_DAILY_CAP_USDC = String(cap);
      // Obligasi order yang masih hidup sudah menyentuh plafon; +1 pack akan melewatinya.
      prisma.paymentOrder.aggregate.mockResolvedValue({
        _sum: { priceUsdc: cap },
      });

      await expect(service.createPackOrder({}, user)).rejects.toThrow(
        ServiceUnavailableException,
      );
      // Tidak menagih user dan tidak menerbitkan mint saat plafon penuh.
      expect(idrx.mintRequest).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    // REGRESI BUG UANG (faktor 1e6). quoteRupiah HARUS menyerahkan "50" — harga $50 PENUH —
    // ke rates(), BUKAN "0.00005" (yang lahir kalau $50 disalahartikan sebagai USDC base unit
    // lalu dibagi 1e6). rates() di suite ini mengabaikan argumennya, jadi tanpa assert eksplisit
    // ini bug yang menagih user Indonesia ~Rp 0,04 untuk pack $50 sepenuhnya TAK TERLIHAT.
    it('menyerahkan usdtAmount "50" (bukan "0.00005") ke rates() untuk pokemon_50', async () => {
      await service.createPackOrder({}, user);

      // machine.priceUsdcBaseUnits = 50_000_000 → usdcBaseUnitsToDecimalString → "50".
      expect(idrx.rates).toHaveBeenCalledWith('50');
    });
  });

  /**
   * GERBANG ANTI-RAMPOK. Callback IDRX tidak ditandatangani dan tidak pernah diulang: body-nya
   * PEMICU, bukan BUKTI. Setiap keputusan uang diambil dari History API, dan tepat satu pemenang
   * klaim atomik yang boleh membeli pack.
   */
  describe('handleCallback / verifyAndFulfil (gerbang pembayaran)', () => {
    // Callback PALSU: penyerang tahu merchantOrderId (kita sendiri yang menyerahkannya ke frontend)
    // dan mengarang body "PAID/MINTED". Keputusan HARUS datang dari History API — yang di sini
    // menjawab WAITING_FOR_PAYMENT — sehingga TIDAK ADA pack yang dibeli.
    it('callback PALSU (body mengklaim PAID) tidak membeli pack — verifier menjawab belum dibayar', async () => {
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        paymentStatus: 'WAITING_FOR_PAYMENT',
        userMintStatus: 'NOT_AVAILABLE',
      });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
        // Semua field di bawah ini DIKARANG penyerang dan HARUS diabaikan.
        paymentStatus: 'PAID',
        userMintStatus: 'MINTED',
        destinationWalletAddress: ATTACKER_ADDRESS,
        txHash: 'fake',
      });

      // Bukti diambil dari server-to-server, bukan dari body.
      expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledWith(
        MERCHANT_ORDER_ID,
      );
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(outcome).toBe('AWAITING_PAYMENT');
    });

    // Callback yang DIULANG untuk order yang sudah tertebus. History API akan menjawab PAID+MINTED
    // SELAMANYA, jadi yang menahan pack kedua BUKAN verifikasi melainkan klaim atomik: updateMany
    // berpredikat status mengembalikan count 0 → berhenti tenang, tidak melempar, tidak membeli lagi.
    it('callback DIULANG (klaim atomik count 0) tidak membeli pack kedua', async () => {
      // Barisnya masih terlihat PAID saat dibaca (pihak lain baru saja membaliknya),
      // tetapi klaim atomik kalah.
      prisma.paymentOrder.findUnique.mockResolvedValue({
        ...baseOrder,
        status: PaymentStatus.PAID,
      });
      prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(outcome).toBe('ALREADY_CLAIMED');
    });

    // Order yang SUDAH FULFILLED berhenti lebih awal — tak perlu memanggil verifier maupun purchase.
    it('order yang sudah FULFILLED tidak diverifikasi ulang dan tidak membeli pack', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(fulfilledOrder);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(idrx.findMintByMerchantOrderId).not.toHaveBeenCalled();
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(outcome).toBe('ALREADY_CLAIMED');
    });

    // Dua callback BERSAMAAN untuk satu order (callback + reconciler balapan adalah kasus NORMAL).
    // Klaim atomik memberi count 1 ke tepat satu pemanggil; yang kalah dapat count 0.
    it('dua callback bersamaan: hanya pemenang klaim yang mencapai purchase()', async () => {
      prisma.paymentOrder.updateMany
        .mockResolvedValueOnce({ count: 1 }) // pemenang
        .mockResolvedValueOnce({ count: 0 }); // yang kalah

      const outcomes = await Promise.all([
        service.handleCallback({ merchantOrderId: MERCHANT_ORDER_ID }),
        service.handleCallback({ merchantOrderId: MERCHANT_ORDER_ID }),
      ]);

      // Treasury membeli TEPAT satu pack untuk satu pembayaran, apa pun urutan balapannya.
      expect(gacha.purchase).toHaveBeenCalledTimes(1);
      expect([...outcomes].sort()).toEqual(['ALREADY_CLAIMED', 'FULFILLED']);
    });

    // Jalur bahagia: PAID + MINTED → tepat satu purchase(), order jadi FULFILLED + packMemo terisi.
    it('PAID + MINTED → tepat satu purchase(); order FULFILLED dengan packMemo terpasang', async () => {
      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(gacha.purchase).toHaveBeenCalledTimes(1);
      // packType dari BARIS ORDER (bukan klien); penerima kartu dari BARIS USER (bukan body callback).
      // viaRupiahPayment: true — menandai jalur berbayar agar bypass pagar demo-only di produksi.
      expect(gacha.purchase).toHaveBeenCalledWith(
        { packType: 'pokemon_50' },
        expect.objectContaining({
          id: user.id,
          walletAddress: user.walletAddress,
        }) as unknown,
        { viaRupiahPayment: true },
      );
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
        where: { merchantOrderId: MERCHANT_ORDER_ID },
        data: expect.objectContaining({
          status: PaymentStatus.FULFILLED,
          packMemo: MEMO,
        }) as unknown,
      });
      expect(outcome).toBe('FULFILLED');
    });

    // purchase() adalah mesin ROLL-FORWARD: sesudah submit, sebuah exception TIDAK berarti "tidak
    // ada uang yang bergerak" — USDC treasury mungkin sudah keluar. User pun SUDAH bayar rupiah.
    // Maka kegagalan di sini = UTANG (REFUND_DUE), tidak boleh FAILED, tidak boleh dilepas ke PENDING
    // (melepas klaim = reconciler membeli pack kedua untuk pembayaran yang sama).
    it('purchase() melempar SESUDAH terverifikasi & terklaim → order REFUND_DUE, TIDAK PERNAH FAILED', async () => {
      gacha.purchase.mockRejectedValue(new Error('CollectorCrypt down'));

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // Tulisan REFUND_DUE via updateMany berpredikat FULFILLING (klaim pasca-belanja milik
      // pemanggil ini) — jangan pernah menimpa baris terminal / klaim racer lain.
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
        where: {
          merchantOrderId: MERCHANT_ORDER_ID,
          status: { in: [PaymentStatus.FULFILLING] },
        },
        data: expect.objectContaining({
          status: PaymentStatus.REFUND_DUE,
        }) as unknown,
      });
      // Utang, bukan kegagalan: FAILED/FULFILLED TIDAK BOLEH pernah tertulis untuk order ini
      // (di mana pun — lewat update maupun updateMany). Klaim juga TIDAK dilepas balik ke PENDING/
      // PAID (itu akan membuat reconciler membeli pack kedua atas pembayaran yang sama).
      const written = allStatusesWritten();
      expect(written).toContain(PaymentStatus.REFUND_DUE);
      expect(written).not.toContain(PaymentStatus.FAILED);
      expect(written).not.toContain(PaymentStatus.FULFILLED);
    });
  });

  /**
   * REKONSILER — sumber kebenaran yang sesungguhnya. Callback IDRX dikirim SEKALI dan tak pernah
   * diulang; kalau backend blip saat itu, hanya polling ini yang menyelamatkan user yang sudah bayar.
   */
  describe('reconcile', () => {
    it('mengambil order PENDING yang basi dan menebusnya (menyelamatkan callback yang hilang)', async () => {
      // reconcile memindai dua kelompok terpisah: (1) order yang bisa maju (PENDING/PAID),
      // (2) FULFILLING yang macet — query berbeda supaya yang macet tak menyandera batch.
      // Order PENDING ini muncul di query pertama; query kedua (FULFILLING) kosong.
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([baseOrder])
        .mockResolvedValueOnce([]);
      // verifyAndFulfil di dalam reconcile membaca ulang barisnya lewat findUnique.
      prisma.paymentOrder.findUnique.mockResolvedValue(baseOrder);

      const summary = await service.reconcile();

      expect(prisma.paymentOrder.findMany).toHaveBeenCalled();
      // Tanpa callback apa pun, poll ini yang memicu pembelian pack yang dibayar user.
      expect(gacha.purchase).toHaveBeenCalledTimes(1);
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith({
        where: { merchantOrderId: MERCHANT_ORDER_ID },
        data: expect.objectContaining({
          status: PaymentStatus.FULFILLED,
          packMemo: MEMO,
        }) as unknown,
      });
      expect(summary.scanned).toBe(1);
      expect(summary.fulfilled).toBe(1);
    });
  });
});
