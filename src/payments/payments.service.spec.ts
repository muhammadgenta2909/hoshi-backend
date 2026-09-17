import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CcPackStatus, PaymentStatus } from '@prisma/client';
import type { PaymentOrder } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { GachaService, type CcPackDto } from '../collectorcrypt/gacha.service';
import {
  ResellerPostBuyError,
  ResellerSettlementService,
} from '../collectorcrypt/reseller-settlement.service';
import {
  EscrowService,
  EscrowTransferIndeterminateError,
} from '../escrow/escrow.service';
import { BalanceService } from '../balance/balance.service';
import { CcShippingService } from '../collectorcrypt/cc-shipping.service';
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
      findFirst: jest.Mock;
      findMany: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
    };
    user: { findUnique: jest.Mock };
    ccPackPurchase: { aggregate: jest.Mock };
    listing: { findUnique: jest.Mock; updateMany: jest.Mock };
    offer: { updateMany: jest.Mock };
    activity: { create: jest.Mock };
    $transaction: jest.Mock;
  };
  let idrx: {
    mintRequest: jest.Mock;
    rates: jest.Mock;
    findMintByMerchantOrderId: jest.Mock;
  };
  let gacha: {
    machines: jest.Mock;
    purchase: jest.Mock;
    treasuryBalances: jest.Mock;
  };
  let config: { get: jest.Mock };
  let configValues: Record<string, string | number | undefined>;
  let resellerSettlement: { settle: jest.Mock };
  let escrow: { transferCoreAssetTo: jest.Mock };
  let balance: { credit: jest.Mock };
  let ccShipping: {
    assertEnabled: jest.Mock;
    estimateForRedemption: jest.Mock;
  };

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
    listingId: null,
    offerId: null,
    redemptionId: null,
    error: null,
    refundSafe: true,
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
    // Fakta katalog CC (nullable) — tidak diuji di sini, cukup penuhi kontrak DTO.
    ccItemName: null,
    ccGradeCompany: null,
    ccGradeScore: null,
    ccGradeLabel: null,
    ccGradeCert: null,
    ccSet: null,
    ccVault: null,
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
        // Default: belum ada order PENDING untuk (user, listing) → createListingOrder bikin baru.
        findFirst: jest.fn().mockResolvedValue(null),
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
      // Jalur reseller CC. Default: findUnique kosong (test isi per kasus); updateMany menang
      // klaim ACTIVE→SOLD. $transaction jalankan callback dengan prisma mock sebagai tx client.
      listing: {
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      // Gerbang offer di settlement P2P: klaim ACCEPTED→PAID. Default MENANG (count 1); test
      // "offer basi" menimpanya dengan count 0.
      offer: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      // Feed aktivitas (SALE_CARD) — ditulis mis. saat settle inventaris Hoshi.
      activity: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
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
      // Default: saldo tak diketahui (null) → preflight dilewati, andalkan plafon config.
      // Test yang menguji preflight menimpanya dengan saldo eksplisit.
      treasuryBalances: jest.fn().mockResolvedValue(null),
    };
    config = { get: jest.fn((key: string) => configValues[key]) };
    // Default: settlement reseller real sukses (beli + transfer). Tes armed menimpanya.
    resellerSettlement = {
      settle: jest.fn().mockResolvedValue({
        buySignature: 'BUYSIG',
        transferSignature: 'XFERSIG',
        priceUsdc: 250,
      }),
    };
    escrow = { transferCoreAssetTo: jest.fn().mockResolvedValue('P2PXFERSIG') };
    balance = { credit: jest.fn().mockResolvedValue({ credited: true }) };
    ccShipping = {
      assertEnabled: jest.fn(),
      estimateForRedemption: jest
        .fn()
        .mockResolvedValue({ usd: 25, usdcBaseUnits: 25_000_000 }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: IdrxClient, useValue: idrx },
        { provide: GachaService, useValue: gacha },
        { provide: ConfigService, useValue: config },
        { provide: ResellerSettlementService, useValue: resellerSettlement },
        { provide: EscrowService, useValue: escrow },
        { provide: BalanceService, useValue: balance },
        { provide: CcShippingService, useValue: ccShipping },
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

    // PREFLIGHT SALDO ON-CHAIN. Plafon config bisa saja lebih besar dari saldo NYATA treasury
    // (default $100/pack, $500/hari vs float bisa cuma ~$49). Tanpa preflight, order $50 lolos
    // plafon, user bayar rupiah, lalu fulfillment gagal karena USDC kurang → REFUND_DUE. Preflight
    // menolak SEBELUM user ditagih.
    describe('preflight saldo treasury', () => {
      it('menolak (ServiceUnavailable) saat USDC treasury di bawah harga pack — sebelum menagih user', async () => {
        // Pack $50 = 50_000_000 base unit; treasury cuma $49.
        gacha.treasuryBalances.mockResolvedValue({
          usdcBaseUnits: 49_000_000,
          solLamports: 100_000_000,
        });

        await expect(service.createPackOrder({}, user)).rejects.toThrow(
          ServiceUnavailableException,
        );
        expect(idrx.mintRequest).not.toHaveBeenCalled();
        expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
      });

      it('menolak (ServiceUnavailable) saat SOL treasury di bawah minimum gas — sebelum menagih user', async () => {
        // USDC cukup, tapi SOL 0,005 (< 0,01 minimum gas).
        gacha.treasuryBalances.mockResolvedValue({
          usdcBaseUnits: 60_000_000,
          solLamports: 5_000_000,
        });

        await expect(service.createPackOrder({}, user)).rejects.toThrow(
          ServiceUnavailableException,
        );
        expect(idrx.mintRequest).not.toHaveBeenCalled();
        expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
      });

      it('meloloskan order saat USDC dan SOL treasury cukup', async () => {
        gacha.treasuryBalances.mockResolvedValue({
          usdcBaseUnits: 60_000_000, // > $50 pack
          solLamports: 100_000_000, // 0,1 SOL > minimum gas
        });

        await service.createPackOrder({}, user);
        expect(idrx.mintRequest).toHaveBeenCalled();
        expect(prisma.paymentOrder.create).toHaveBeenCalled();
      });

      it('saldo null (RPC/treasury tak dikonfigurasi) → preflight dilewati, order tetap terbit', async () => {
        gacha.treasuryBalances.mockResolvedValue(null);

        await service.createPackOrder({}, user);
        expect(idrx.mintRequest).toHaveBeenCalled();
      });
    });
  });

  /**
   * GERBANG ANTI-RAMPOK. Callback IDRX tidak ditandatangani dan tidak pernah diulang: body-nya
   * PEMICU, bukan BUKTI. Setiap keputusan uang diambil dari History API, dan tepat satu pemenang
   * klaim atomik yang boleh membeli pack.
   */
  /**
   * JALUR RESELLER CC (createListingOrder + fulfilListing). Pembeli bayar HARGA KITA via IDRX;
   * treasury (nanti) menebus kartu di CollectorCrypt. Uji: (1) plafon per-pack $100 gacha TIDAK
   * mengunci kartu CC mahal, (2) diskriminator katalog, (3) plafon per-kartu tetap membatasi,
   * (4) gerbang settlement TIDAK belanja saat mati, (5) MOCK settle = listing SOLD tanpa on-chain.
   */
  describe('createListingOrder / fulfilListing (jalur reseller CC)', () => {
    // Kartu katalog CC yang sah: source COLLECTORCRYPT, TANPA penjual user, ACTIVE, punya alamat
    // on-chain + harga dolar. $250 — SENGAJA di atas plafon pack $100 gacha.
    const catalogListing = {
      id: 'listing-cc-1',
      name: 'Charizard PSA 10',
      source: 'COLLECTORCRYPT',
      sellerId: null as string | null,
      ccNftAddress: 'CcNftAddrBase58',
      ccPriceUsd: 250,
      priceIdrx: 5_000_000, // harga kita (rupiah); biaya CC 250×16.000 = 4.000.000 → margin +
      status: 'ACTIVE',
    };

    const resellerOrder: PaymentOrder = {
      ...baseOrder,
      packType: 'MARKETPLACE',
      listingId: catalogListing.id,
      priceUsdc: 250_000_000,
    };

    it('kartu katalog CC $250 TIDAK ditolak plafon pack $100 — order MARKETPLACE terbit', async () => {
      prisma.listing.findUnique.mockResolvedValue(catalogListing);

      await service.createListingOrder(catalogListing.id, user);

      // Tidak dilempar plafon per-pack: mintRequest terbit & order MARKETPLACE tercatat dengan
      // priceUsdc 250_000_000 (jauh di atas plafon pack $100 = 100_000_000).
      expect(idrx.mintRequest).toHaveBeenCalledTimes(1);
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            packType: 'MARKETPLACE',
            listingId: catalogListing.id,
            priceUsdc: 250_000_000,
          }) as unknown,
        }),
      );
    });

    it('MENERIMA user listing (sellerId terisi, penjual lain) → order MARKETPLACE, priceUsdc 0', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...catalogListing,
        sellerId: 'user-2', // penjual lain, bukan pembeli user-1
      });

      await service.createListingOrder(catalogListing.id, user);

      expect(idrx.mintRequest).toHaveBeenCalledTimes(1);
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            packType: 'MARKETPLACE',
            listingId: catalogListing.id,
            priceUsdc: 0, // user listing: tak ada leg USDC
          }) as unknown,
        }),
      );
    });

    it('IDEMPOTEN: spam beli → order PENDING yang sama dikembalikan, tak bikin order/mint baru', async () => {
      prisma.listing.findUnique.mockResolvedValue(catalogListing);
      prisma.paymentOrder.findFirst.mockResolvedValue({
        ...baseOrder,
        listingId: catalogListing.id,
        status: PaymentStatus.PENDING,
      });

      await service.createListingOrder(catalogListing.id, user);

      // Order lama dipakai ulang: tidak ada mint IDRX baru, tidak ada baris order baru.
      expect(idrx.mintRequest).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    it('menolak beli listing SENDIRI (sellerId === pembeli) tanpa mintRequest', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...catalogListing,
        sellerId: user.id,
      });

      await expect(
        service.createListingOrder(catalogListing.id, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(idrx.mintRequest).not.toHaveBeenCalled();
    });

    it('plafon per-kartu TETAP membatasi: kartu di atas HOSHI_CC_MAX_CARD_PRICE_USDC ditolak', async () => {
      // $6.000 → 6.000.000.000 base unit > default 5.000.000.000. Margin tetap lolos (priceIdrx tinggi).
      prisma.listing.findUnique.mockResolvedValue({
        ...catalogListing,
        ccPriceUsd: 6000,
        priceIdrx: 120_000_000, // >= 6000×16.000 = 96.000.000
      });

      await expect(
        service.createListingOrder(catalogListing.id, user),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(idrx.mintRequest).not.toHaveBeenCalled();
    });

    it('gerbang settlement MATI (CC_MOCK off, RESELL off) → REFUND_DUE, NOL belanja, listing tak di-SOLD', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // NOL on-chain: gacha.purchase tak pernah dipanggil; listing TIDAK ditandai SOLD.
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      const written = allStatusesWritten();
      expect(written).toContain(PaymentStatus.REFUND_DUE);
      expect(written).not.toContain(PaymentStatus.FULFILLED);
      expect(written).not.toContain(PaymentStatus.FAILED);
    });

    it('MOCK settle: listing ACTIVE→SOLD + order FULFILLED, NOL belanja (gacha.purchase tak dipanggil)', async () => {
      // ccMockEnabled = CC_MOCK==='1' && detectProductionSignal()===null. Bersihkan 3 sinyal
      // produksi (env) agar deterministik, restore setelahnya.
      const saved = {
        SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
        SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
        COLLECTORCRYPT_GACHA_BASE_URL: process.env.COLLECTORCRYPT_GACHA_BASE_URL,
      };
      delete process.env.SOLANA_CLUSTER;
      delete process.env.SOLANA_RPC_URL;
      delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
      configValues.CC_MOCK = '1';
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);

      try {
        const outcome = await service.handleCallback({
          merchantOrderId: MERCHANT_ORDER_ID,
        });

        expect(outcome).toBe('FULFILLED');
        // MOCK = nol on-chain: TIDAK ada pembelian gacha/treasury.
        expect(gacha.purchase).not.toHaveBeenCalled();
        // Listing diklaim ACTIVE→SOLD ke pembeli, order jadi FULFILLED (satu transaksi).
        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: catalogListing.id, status: 'ACTIVE' },
            data: expect.objectContaining({
              status: 'SOLD',
              buyerId: user.id,
            }) as unknown,
          }),
        );
        expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { merchantOrderId: MERCHANT_ORDER_ID },
            data: expect.objectContaining({
              status: PaymentStatus.FULFILLED,
            }) as unknown,
          }),
        );
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it('ARMED real: settle sukses → klaim listing SOLD lalu order FULFILLED (txHash=buySignature)', async () => {
      configValues.HOSHI_CC_RESELL_ENABLED = 'true'; // armed; CC_MOCK unset → mock=false
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED');
      // Klaim listing ACTIVE→SOLD DULU (gerbang konkurensi) baru belanja.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: catalogListing.id, status: 'ACTIVE' },
          data: expect.objectContaining({ status: 'SOLD', buyerId: user.id }) as unknown,
        }),
      );
      // Settle dipanggil dgn plafon = priceUsdc snapshot order.
      expect(resellerSettlement.settle).toHaveBeenCalledWith({
        nftAddress: catalogListing.ccNftAddress,
        buyerWallet: user.walletAddress,
        maxPriceUsdcBaseUnits: resellerOrder.priceUsdc,
      });
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantOrderId: MERCHANT_ORDER_ID },
          data: expect.objectContaining({
            status: PaymentStatus.FULFILLED,
            txHash: 'BUYSIG',
          }) as unknown,
        }),
      );
    });

    it('ARMED real: transfer gagal SESUDAH beli → REFUND_DUE "KIRIM ULANG", listing TIDAK dibalikin', async () => {
      configValues.HOSHI_CC_RESELL_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);
      resellerSettlement.settle.mockRejectedValue(
        new ResellerPostBuyError('rpc down', 'BUYSIG', catalogListing.ccNftAddress),
      );

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // Pesan REFUND_DUE menyuruh KIRIM ULANG (bukan refund) + membawa signature beli.
      const refundCall = (
        prisma.paymentOrder.updateMany.mock.calls as [
          { data?: { status?: unknown; error?: unknown } },
        ][]
      ).find(([arg]) => arg?.data?.status === PaymentStatus.REFUND_DUE);
      expect(String(refundCall?.[0]?.data?.error)).toContain('KIRIM ULANG');
      expect(String(refundCall?.[0]?.data?.error)).toContain('BUYSIG');
      // Listing TIDAK dibalikin ke ACTIVE (pembeli sudah memilikinya secara ekonomi).
      expect(prisma.listing.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }) as unknown,
        }),
      );
    });

    it('ARMED real: settle gagal SEBELUM beli → listing dibalikin ACTIVE + REFUND_DUE', async () => {
      configValues.HOSHI_CC_RESELL_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);
      resellerSettlement.settle.mockRejectedValue(new Error('CC down'));

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // Belum ada belanja → listing dikembalikan ke ACTIVE agar bisa dijual lagi.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: catalogListing.id,
            status: 'SOLD',
            buyerId: user.id,
          }) as unknown,
          data: expect.objectContaining({
            status: 'ACTIVE',
            buyerId: null,
          }) as unknown,
        }),
      );
    });

    it('ARMED real: settle SUKSES tapi tulis FULFILLED gagal → tetap FULFILLED, TIDAK refund/rollback', async () => {
      configValues.HOSHI_CC_RESELL_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);
      // settle sukses (default), tapi tulis FULFILLED (paymentOrder.update) MELEDAK — kartu sudah
      // di pembeli, jadi ini TIDAK boleh berubah jadi refund/rollback (double loss).
      prisma.paymentOrder.update.mockImplementation(
        (args: { data?: { status?: unknown } }) =>
          args?.data?.status === PaymentStatus.FULFILLED
            ? Promise.reject(new Error('db down'))
            : Promise.resolve(fulfilledOrder),
      );

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED'); // kartu sudah terkirim → tetap terpenuhi
      expect(resellerSettlement.settle).toHaveBeenCalledTimes(1);
      // TIDAK ada REFUND_DUE dan TIDAK ada rollback listing ke ACTIVE.
      const wroteRefund = (
        prisma.paymentOrder.updateMany.mock.calls as [{ data?: { status?: unknown } }][]
      ).some(([a]) => a?.data?.status === PaymentStatus.REFUND_DUE);
      expect(wroteRefund).toBe(false);
      expect(prisma.listing.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }) as unknown,
        }),
      );
    });

    it('ARMED real: kalah klaim konkurensi (listing sudah SOLD) → REFUND_DUE, settle TAK dipanggil (nol belanja)', async () => {
      configValues.HOSHI_CC_RESELL_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(resellerOrder);
      prisma.listing.findUnique.mockResolvedValue(catalogListing);
      prisma.listing.updateMany.mockResolvedValue({ count: 0 }); // klaim ACTIVE→SOLD kalah

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(resellerSettlement.settle).not.toHaveBeenCalled(); // NOL belanja treasury
    });

    it('INVENTARIS HOSHI (source=HOSHI, tanpa penjual): klaim SOLD + FULFILLED, NOL kredit penjual, NOL beli-CC/pack', async () => {
      const hoshiListing = {
        ...catalogListing,
        id: 'listing-hoshi-1',
        name: 'Pikachu Hoshi',
        source: 'HOSHI',
        sellerId: null,
        sellable: true, // stok Hoshi genuine (bukan seed) → boleh dibeli
        ccNftAddress: null,
        ccPriceUsd: null,
        image: null,
        category: null,
        set: null,
        priceIdrx: 3_000_000,
        status: 'ACTIVE',
      };
      const hoshiOrder: PaymentOrder = {
        ...baseOrder,
        packType: 'MARKETPLACE',
        listingId: hoshiListing.id,
        priceUsdc: 0,
      };
      prisma.paymentOrder.findUnique.mockResolvedValue(hoshiOrder);
      prisma.listing.findUnique.mockResolvedValue(hoshiListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED');
      // Hoshi = penjual + platform → simpan 100%: NOL beli-CC, NOL beli pack, NOL kredit penjual.
      expect(resellerSettlement.settle).not.toHaveBeenCalled();
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
      // Klaim listing ACTIVE→SOLD ke pembeli + order FULFILLED + baris feed SALE_CARD.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: hoshiListing.id, status: 'ACTIVE' },
          data: expect.objectContaining({
            status: 'SOLD',
            buyerId: user.id,
          }) as unknown,
        }),
      );
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantOrderId: MERCHANT_ORDER_ID },
          data: expect.objectContaining({
            status: PaymentStatus.FULFILLED,
          }) as unknown,
        }),
      );
      expect(prisma.activity.create).toHaveBeenCalled();
    });
  });

  /**
   * JALUR P2P (Flow B): jual-beli antar USER. Pembeli bayar Rupiah → escrow kirim kartu penjual
   * ke pembeli + penjual dikredit saldo (priceIdrx − komisi). Hoshi TIDAK beli apa pun.
   */
  describe('fulfilUserListing (jalur P2P antar user)', () => {
    const userListing = {
      id: 'listing-user-1',
      name: 'Pikachu PSA 9',
      source: 'HOSHI',
      sellerId: 'seller-9',
      ccNftAddress: 'UserNftAddrBase58',
      ccPriceUsd: null as number | null,
      priceIdrx: 1_000_000, // Rp 1.000.000
      status: 'ACTIVE',
    };
    const userOrder: PaymentOrder = {
      ...baseOrder,
      packType: 'MARKETPLACE',
      listingId: userListing.id,
      priceUsdc: 0,
      // priceIdr = baseOrder (805.600) = yang PEMBELI benar-benar bayar (cocok dgn record IDRX).
      // SENGAJA beda dari listing.priceIdrx (1.000.000) untuk MEMBUKTIKAN payout dihitung dari yang
      // dibayar (order), BUKAN dari listing.priceIdrx live yang bisa penjual ubah setelah order.
    };
    // Payout di-backout dari order.priceIdr: base = floor(805.600 × 10000/10070) = 799.999;
    // komisi 5% = 39.999; payout = 760.000. (Kalau salah pakai listing.priceIdrx → jadi 950.000.)
    const PAYOUT = 760_000;

    it('MOCK: klaim SOLD + kredit saldo penjual (DB) TANPA on-chain (escrow tak dipanggil)', async () => {
      const saved = {
        SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
        SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
        COLLECTORCRYPT_GACHA_BASE_URL: process.env.COLLECTORCRYPT_GACHA_BASE_URL,
      };
      delete process.env.SOLANA_CLUSTER;
      delete process.env.SOLANA_RPC_URL;
      delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
      configValues.CC_MOCK = '1';
      prisma.paymentOrder.findUnique.mockResolvedValue(userOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);

      try {
        const outcome = await service.handleCallback({
          merchantOrderId: MERCHANT_ORDER_ID,
        });

        expect(outcome).toBe('FULFILLED');
        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: userListing.id, status: 'ACTIVE' },
            data: expect.objectContaining({ status: 'SOLD', buyerId: user.id }) as unknown,
          }),
        );
        // Penjual dikredit payout (idempoten per merchantOrderId), DALAM transaksi atomik (arg tx).
        expect(balance.credit).toHaveBeenCalledWith(
          expect.objectContaining({
            userId: 'seller-9',
            amountIdrx: PAYOUT,
            reason: 'P2P_SALE',
            refId: MERCHANT_ORDER_ID,
          }),
          expect.anything(),
        );
        // MOCK = nol on-chain: escrow TIDAK dipanggil.
        expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });

    it('gerbang MATI (CC_MOCK off, HOSHI_P2P_ENABLED off) → REFUND_DUE, nol kredit & transfer', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(userOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(balance.credit).not.toHaveBeenCalled();
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
    });

    it('ARMED real: escrow transfer kartu ke pembeli + kredit penjual → FULFILLED', async () => {
      configValues.HOSHI_P2P_ENABLED = 'true'; // armed; CC_MOCK unset → mock=false
      prisma.paymentOrder.findUnique.mockResolvedValue(userOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED');
      expect(escrow.transferCoreAssetTo).toHaveBeenCalledWith({
        assetAddress: userListing.ccNftAddress,
        newOwner: user.walletAddress,
      });
      expect(balance.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-9', amountIdrx: PAYOUT }),
      );
    });

    it('ARMED real: transfer INDETERMINATE → REFUND_DUE "cek on-chain", listing TIDAK dibalikin, tak dikredit', async () => {
      configValues.HOSHI_P2P_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(userOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);
      escrow.transferCoreAssetTo.mockRejectedValue(
        new EscrowTransferIndeterminateError(
          'confirm timeout',
          userListing.ccNftAddress,
          user.walletAddress,
        ),
      );

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // Kartu mungkin sudah pindah → JANGAN kredit, JANGAN balikin listing ke ACTIVE.
      expect(balance.credit).not.toHaveBeenCalled();
      expect(prisma.listing.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }) as unknown,
        }),
      );
    });

    it('ARMED real: kalah klaim konkurensi → REFUND_DUE, escrow & kredit tak dipanggil', async () => {
      configValues.HOSHI_P2P_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(userOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);
      prisma.listing.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
    });

    // GERBANG OFFER: order bayar-offer (offerId != null) hanya settle bila offer MASIH ACCEPTED.
    const offerOrder: PaymentOrder = { ...userOrder, offerId: 'offer-77' };

    it('ARMED real, order bayar-offer & offer masih ACCEPTED → klaim ACCEPTED→PAID lalu settle FULFILLED', async () => {
      configValues.HOSHI_P2P_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(offerOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED');
      // Offer di-klaim atomik ACCEPTED→PAID (tepat satu pemenang) SEBELUM kartu pindah.
      expect(prisma.offer.updateMany).toHaveBeenCalledWith({
        where: { id: 'offer-77', status: 'ACCEPTED' },
        data: { status: 'PAID' },
      });
      expect(escrow.transferCoreAssetTo).toHaveBeenCalled();
      expect(balance.credit).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'seller-9', amountIdrx: PAYOUT }),
      );
    });

    it('ARMED real, offer SUDAH di-supersede (klaim count 0) → REFUND_DUE, kartu TAK pindah, penjual TAK dikredit', async () => {
      configValues.HOSHI_P2P_ENABLED = 'true';
      prisma.paymentOrder.findUnique.mockResolvedValue(offerOrder);
      prisma.listing.findUnique.mockResolvedValue(userListing);
      // Offer ini bukan lagi yang diterima penjual (accept offer lain / ditolak) → klaim gagal.
      prisma.offer.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      // Gerbang menolak SEBELUM klaim listing → tak ada SOLD, tak ada transfer, tak ada kredit.
      expect(prisma.listing.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SOLD' }) as unknown,
        }),
      );
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
    });
  });

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
      // Pack dibuka di tempat (auto-reveal) → TANPA deferOpen.
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
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B2 — INVOICE YANG KALAH BALAPAN DENGAN SAPUAN KEDALUWARSA TIDAK BOLEH LENYAP DIAM-DIAM.    ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * BUGNYA. Tick reconciler dan callback pembayaran memverifikasi BERSAMAAN di batas kedaluwarsa:
   * pembacaan server-ke-server milik reconciler menjawab EXPIRED, milik callback menjawab
   * PAID+MINTED. Kalau transaksi kedaluwarsa commit duluan, order jadi EXPIRED dan redemption-nya
   * dilepas ke REQUESTED — lalu callback yang membawa bukti PEMBAYARAN NYATA berhenti di penjaga
   * terminal verifyAndFulfil. Ia TIDAK PERNAH mencapai klaim atomik, TIDAK PERNAH mencapai
   * fulfilShipping, TIDAK PERNAH mencapai failToRefund. Hasil akhirnya: Rupiah duduk di treasury,
   * nol baris REFUND_DUE, nol log ERROR, dan user melihat "Menunggu pembayaran ongkir" lagi lalu
   * MEMBAYAR UNTUK KEDUA KALINYA.
   *
   * Komentar di recordUnfulfilled dulu MENJANJIKAN sebaliknya ("fulfilShipping mendapat count!==1
   * → failToRefund → REFUND_DUE"). Janji itu tidak pernah bisa ditepati.
   */
  describe('B2 — order EXPIRED yang ternyata BENAR-BENAR dibayar jadi UTANG TERCATAT', () => {
    const expiredShippingOrder: PaymentOrder = {
      ...baseOrder,
      packType: 'SHIPPING',
      redemptionId: 'red-1',
      status: PaymentStatus.EXPIRED,
      idrxPaymentStatus: 'EXPIRED',
      idrxUserMintStatus: 'NOT_AVAILABLE',
    };

    it('EXPIRED lalu verifikasi menjawab PAID → REFUND_DUE berpredikat [EXPIRED], TANPA mengirim barangnya', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      // Pembayarannya NYATA: mendarat di treasury kita, nominal penuh.
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
        where: {
          merchantOrderId: MERCHANT_ORDER_ID,
          // PREDIKATNYA [EXPIRED]: ia tidak bisa menimpa klaim / baris terminal milik siapa pun.
          status: { in: [PaymentStatus.EXPIRED] },
        },
        data: expect.objectContaining({
          status: PaymentStatus.REFUND_DUE,
          // PRA-belanja: klaim atomiknya tidak pernah diambil, jadi Rupiah-nya AMAN di-refund.
          refundSafe: true,
          idrxPaymentStatus: 'PAID',
          idrxUserMintStatus: 'MINTED',
        }) as unknown,
      });

      // ATURAN YANG TIDAK BOLEH DILANGGAR: jalur ini MENCATAT UTANG, ia TIDAK PERNAH MENGIRIM
      // BARANGNYA. Nol klaim atomik, nol belanja treasury, nol baris redemption yang maju.
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(resellerSettlement.settle).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
      const written = allStatusesWritten();
      expect(written).toContain(PaymentStatus.REFUND_DUE);
      expect(written).not.toContain(PaymentStatus.FULFILLING);
      expect(written).not.toContain(PaymentStatus.FULFILLED);
    });

    it('log-nya terbit di level ERROR dan MENYEBUT ONGKIR KIRIM FISIK, bukan pack', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });

      try {
        await service.handleCallback({ merchantOrderId: MERCHANT_ORDER_ID });
      } finally {
        spy.mockRestore();
      }

      const debt = errors.find((m) => m.includes('REFUND_DUE'));
      expect(debt).toBeDefined();
      // Dulu satu-satunya jejaknya adalah logger.log (INFO) yang bicara soal PACK.
      expect(debt).toContain('ONGKIR KIRIM FISIK');
      expect(debt).not.toContain('[PACK]');
      expect(debt).toContain(MERCHANT_ORDER_ID);
      expect(debt).toContain(String(PRICE_IDR));
      expect(debt).toContain('BALAPAN KEDALUWARSA');
    });

    it('order pack yang EXPIRED-tapi-dibayar juga jadi utang — dan log-nya menyebut PACK', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue({
        ...baseOrder,
        status: PaymentStatus.EXPIRED,
      });
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });

      let outcome: string;
      try {
        outcome = await service.handleCallback({
          merchantOrderId: MERCHANT_ORDER_ID,
        });
      } finally {
        spy.mockRestore();
      }

      expect(outcome).toBe('REFUND_DUE');
      expect(errors.find((m) => m.includes('REFUND_DUE'))).toContain('[PACK]');
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    it('EXPIRED yang JUJUR (memang tak pernah dibayar) tetap EXPIRED — nol tulisan, nol utang', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        paymentStatus: 'EXPIRED',
        userMintStatus: 'NOT_AVAILABLE',
      });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('ALREADY_CLAIMED');
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.update).not.toHaveBeenCalled();
      expect(allStatusesWritten()).toEqual([]);
    });

    it('callback DIULANG tidak membuat utang kedua: baris sudah REFUND_DUE → berhenti di penjaga terminal', async () => {
      // Callback pertama menang dan menulis REFUND_DUE. Callback kedua membaca baris yang SUDAH
      // REFUND_DUE — dan penjaga terminal verifyAndFulfil menghentikannya sebelum apa pun.
      prisma.paymentOrder.findUnique
        .mockResolvedValueOnce(expiredShippingOrder)
        .mockResolvedValue({
          ...expiredShippingOrder,
          status: PaymentStatus.REFUND_DUE,
          refundSafe: true,
        });
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);

      const first = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });
      const second = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });
      const third = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(first).toBe('REFUND_DUE');
      expect(second).toBe('ALREADY_CLAIMED');
      expect(third).toBe('ALREADY_CLAIMED');
      // SATU utang, bukan tiga: hanya satu tulisan yang pernah terjadi.
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledTimes(1);
      // Dan IDRX hanya ditanya sekali — callback berikutnya berhenti sebelum verifikasi.
      expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(1);
    });

    it('dua verifikasi BERSAMAAN atas baris EXPIRED yang sama: tepat SATU yang menang tulisannya', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
      // Postgres menyerialkan keduanya: pemenang count 1, pecundang count 0 (no-op, bukan error).
      prisma.paymentOrder.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const [a, b] = await Promise.all([
        service.verifyAndFulfil(MERCHANT_ORDER_ID),
        service.verifyAndFulfil(MERCHANT_ORDER_ID),
      ]);

      expect(a).toBe('REFUND_DUE');
      expect(b).toBe('REFUND_DUE');
      // Dua percobaan tulisan, tapi hanya satu BARIS yang berubah — dan barisnya cuma satu.
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledTimes(2);
      for (const [arg] of prisma.paymentOrder.updateMany.mock.calls as [
        { where: { status: { in: PaymentStatus[] } } },
      ][]) {
        expect(arg.where.status.in).toEqual([PaymentStatus.EXPIRED]);
      }
    });

    it('IDRX tak bisa dihubungi saat mengecek baris EXPIRED → TIDAK menulis apa pun, TAPI berteriak di ERROR', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      idrx.findMintByMerchantOrderId.mockRejectedValue(new Error('IDRX down'));
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });

      let outcome: string;
      try {
        outcome = await service.handleCallback({
          merchantOrderId: MERCHANT_ORDER_ID,
        });
      } finally {
        spy.mockRestore();
      }

      expect(outcome).toBe('VERIFY_FAILED');
      expect(allStatusesWritten()).toEqual([]);
      const shout = errors.find((m) => m.includes(MERCHANT_ORDER_ID));
      expect(shout).toContain('ONGKIR KIRIM FISIK');
      expect(shout).toContain('utangnya BELUM tercatat');
    });

    it('PAID tapi mint-nya gagal di sisi IDRX → tetap utang, dengan peringatan anti refund DOBEL', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredShippingOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        userMintStatus: 'REFUND',
      });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      const [[arg]] = prisma.paymentOrder.updateMany.mock.calls as [
        { data: { error: string } },
      ][];
      expect(arg.data.error).toContain('userMintStatus=REFUND');
      expect(arg.data.error).toContain('jangan refund dobel');
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B1 — INTERLEAVING KEDUA: KLAIM ATOMIK KALAH KE TULISAN KEDALUWARSA YANG BARU SAJA COMMIT.  ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `settleExpiredButPaid` (blok di atas) hanya menangkap balapan yang callback-nya MEMBACA
   * SESUDAH commit kedaluwarsa. Interleaving yang SATUNYA dulu lolos utuh:
   *
   *   1. callback membaca order — masih PENDING;
   *   2. IDRX menjawab PAID+MINTED dan pin-nya LOLOS;
   *   3. tick reconciler yang bersamaan commit kedaluwarsa duluan → baris jadi EXPIRED;
   *   4. klaim `status IN (PENDING,PAID) → FULFILLING` cocok NOL baris → dulu: `logger.log(...)`
   *      di level INFO, NOL tulisan, NOL utang, NOL ERROR — dan untuk ONGKIR, redemption-nya sudah
   *      terlanjur dilepas ke REQUESTED sehingga user diundang MEMBAYAR UNTUK KEDUA KALINYA.
   *
   * Rail-nya SATU untuk semua: pack, kartu marketplace, top-up, dan ongkir sama-sama lewat klaim
   * atomik itu. Karena itu setiap rail diuji: utang tercatat, dan NOL barang berangkat.
   */
  describe('B1 — klaim KALAH ke tulisan kedaluwarsa: utang tercatat, barang TIDAK dikirim', () => {
    /** Berapa kali status REFUND_DUE benar-benar dicoba ditulis ke ledger order. */
    const debtWrites = (): { where: unknown; data: Record<string, unknown> }[] =>
      (
        prisma.paymentOrder.updateMany.mock.calls as [
          { where: unknown; data: Record<string, unknown> },
        ][]
      )
        .map(([arg]) => arg)
        .filter((arg) => arg.data.status === PaymentStatus.REFUND_DUE);

    /**
     * Susun interleaving-nya: pembacaan PERTAMA menjawab `PENDING` (barisnya masih hidup), klaim
     * atomik KALAH, lalu pembacaan ULANG menjawab status terminal `now`. Persis yang dihasilkan
     * serialisasi baris Postgres saat tulisan kedaluwarsa commit di antara keduanya.
     */
    const raceLostTo = (order: PaymentOrder, now: PaymentStatus): void => {
      prisma.paymentOrder.findUnique
        .mockResolvedValueOnce({ ...order, status: PaymentStatus.PENDING })
        .mockResolvedValue({ ...order, status: now });
      prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });
    };

    it('ONGKIR: kalah klaim + baris kini EXPIRED → REFUND_DUE berpredikat [EXPIRED, FAILED], NOL barang', async () => {
      raceLostTo(
        { ...baseOrder, packType: 'SHIPPING', redemptionId: 'red-1' },
        PaymentStatus.EXPIRED,
      );

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(debtWrites()).toHaveLength(1);
      expect(debtWrites()[0].where).toEqual({
        merchantOrderId: MERCHANT_ORDER_ID,
        // PREDIKAT TERMINAL-TANPA-PENYERAHAN. Ia TIDAK BISA menimpa klaim pemenang yang sah
        // (FULFILLING), baris yang sudah diserahkan (FULFILLED), maupun utang yang sudah ada
        // (REFUND_DUE) — jadi utang kedua mustahil dan barang terkirim tak pernah dideklarasikan utang.
        status: { in: [PaymentStatus.EXPIRED, PaymentStatus.FAILED] },
      });
      expect(debtWrites()[0].data).toMatchObject({
        status: PaymentStatus.REFUND_DUE,
        // PRA-belanja: klaimnya tidak pernah diambil → Rupiah-nya AMAN di-refund.
        refundSafe: true,
        idrxPaymentStatus: 'PAID',
        idrxUserMintStatus: 'MINTED',
      });

      // ATURAN YANG TIDAK BOLEH DILANGGAR: mencatat utang ≠ mengirim ulang barangnya.
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(resellerSettlement.settle).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
      const written = allStatusesWritten();
      expect(written).toContain(PaymentStatus.REFUND_DUE);
      expect(written).not.toContain(PaymentStatus.FULFILLED);
      expect(written).not.toContain(PaymentStatus.FAILED);
    });

    /**
     * CABANG INI DIPAKAI SEMUA RAIL. Kalau ia hanya benar untuk ongkir, sebuah pack Rp 800.000 /
     * kartu marketplace / top-up tetap menguap diam-diam.
     */
    it.each([
      ['PACK', { ...baseOrder }],
      ['KARTU MARKETPLACE', { ...baseOrder, listingId: 'listing-1' }],
      ['TOP-UP SALDO', { ...baseOrder, packType: 'TOPUP', priceUsdc: 0 }],
      [
        'ONGKIR KIRIM FISIK',
        { ...baseOrder, packType: 'SHIPPING', redemptionId: 'red-1' },
      ],
    ])(
      'rail %s: utang TERCATAT dan NOL penyerahan (purchase/settle/credit tak pernah dipanggil)',
      async (subject, order) => {
        raceLostTo(order as PaymentOrder, PaymentStatus.EXPIRED);
        const errors: string[] = [];
        const spy = jest
          .spyOn(Logger.prototype, 'error')
          .mockImplementation((msg: unknown) => {
            errors.push(String(msg));
          });

        let outcome: string;
        try {
          outcome = await service.handleCallback({
            merchantOrderId: MERCHANT_ORDER_ID,
          });
        } finally {
          spy.mockRestore();
        }

        expect(outcome).toBe('REFUND_DUE');
        expect(debtWrites()).toHaveLength(1);

        // NOL barang, di ketiga mesin penyerahan sekaligus.
        expect(gacha.purchase).not.toHaveBeenCalled();
        expect(resellerSettlement.settle).not.toHaveBeenCalled();
        expect(balance.credit).not.toHaveBeenCalled();
        expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();

        // Dulu satu-satunya jejaknya adalah logger.log (INFO) yang SELALU bicara soal "pack".
        // Sekarang: ERROR, menyebut RAIL-nya, merchantOrderId, dan nominal rupiahnya.
        const debt = errors.find((m) => m.includes('REFUND_DUE'));
        expect(debt).toBeDefined();
        expect(debt).toContain(`REFUND_DUE[${subject}]`);
        expect(debt).toContain(MERCHANT_ORDER_ID);
        expect(debt).toContain(String(PRICE_IDR));
        expect(debt).toContain('BALAPAN KEDALUWARSA');
      },
    );

    it('FAILED juga terminal-tanpa-penyerahan → utang tercatat', async () => {
      raceLostTo({ ...baseOrder }, PaymentStatus.FAILED);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('REFUND_DUE');
      expect(debtWrites()).toHaveLength(1);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    /**
     * BATAS YANG MENJAGA ATURAN AMBIGUITAS. Kalah klaim ke pemenang yang SAH bukan utang: barangnya
     * sedang/sudah berangkat (FULFILLING/FULFILLED), utangnya sudah ada (REFUND_DUE), atau ordernya
     * masih hidup dan masih dimiliki reconciler (PENDING/PAID — klaim yang dilepas untuk diulang).
     * Mendeklarasikan utang di salah satu dari itu = refund atas barang terkirim, atau utang DOBEL.
     */
    it.each([
      PaymentStatus.FULFILLING,
      PaymentStatus.FULFILLED,
      PaymentStatus.REFUND_DUE,
      PaymentStatus.PAID,
      PaymentStatus.PENDING,
    ])(
      'pemenang klaim yang SAH (baris kini %s): short-circuit ALREADY_CLAIMED — NOL utang, NOL barang',
      async (now) => {
        raceLostTo({ ...baseOrder }, now);

        const outcome = await service.handleCallback({
          merchantOrderId: MERCHANT_ORDER_ID,
        });

        expect(outcome).toBe('ALREADY_CLAIMED');
        expect(debtWrites()).toEqual([]);
        expect(allStatusesWritten()).not.toContain(PaymentStatus.REFUND_DUE);
        expect(gacha.purchase).not.toHaveBeenCalled();
        expect(resellerSettlement.settle).not.toHaveBeenCalled();
        expect(balance.credit).not.toHaveBeenCalled();
      },
    );

    it('baca-ulang GAGAL (DB blip) → VERIFY_FAILED, NOL tulisan — reconciler yang memutuskan nanti', async () => {
      prisma.paymentOrder.findUnique
        .mockResolvedValueOnce({ ...baseOrder, status: PaymentStatus.PENDING })
        .mockRejectedValue(new Error('DB blip'));
      prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('VERIFY_FAILED');
      // Satu-satunya tulisan yang pernah DICOBA adalah klaim atomiknya sendiri — dan ia kalah
      // (count 0), jadi NOL baris berubah. Tidak ada utang yang dideklarasikan atas keraguan.
      expect(debtWrites()).toEqual([]);
      expect(allStatusesWritten()).not.toContain(PaymentStatus.REFUND_DUE);
      expect(allStatusesWritten()).not.toContain(PaymentStatus.FULFILLED);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    /**
     * KEDUA INTERLEAVING, SATU UTANG MASING-MASING. Ini yang dituntut laporan: bukan cuma
     * "yang baru diperbaiki", tapi kedua arah balapan menghasilkan TEPAT satu baris utang.
     */
    it('KEDUA interleaving mencatat TEPAT SATU utang — tidak nol, tidak dua', async () => {
      // (a) baca SESUDAH commit kedaluwarsa → settleExpiredButPaid.
      prisma.paymentOrder.findUnique.mockResolvedValue({
        ...baseOrder,
        status: PaymentStatus.EXPIRED,
      });
      expect(
        await service.verifyAndFulfil(MERCHANT_ORDER_ID),
      ).toBe('REFUND_DUE');
      expect(debtWrites()).toHaveLength(1);
      expect(debtWrites()[0].where).toEqual({
        merchantOrderId: MERCHANT_ORDER_ID,
        status: { in: [PaymentStatus.EXPIRED] },
      });

      // (b) baca SEBELUM commit kedaluwarsa, lalu klaim kalah → settleLostClaim.
      prisma.paymentOrder.updateMany.mockClear();
      raceLostTo({ ...baseOrder }, PaymentStatus.EXPIRED);
      expect(
        await service.verifyAndFulfil(MERCHANT_ORDER_ID),
      ).toBe('REFUND_DUE');
      expect(debtWrites()).toHaveLength(1);
      expect(debtWrites()[0].where).toEqual({
        merchantOrderId: MERCHANT_ORDER_ID,
        status: { in: [PaymentStatus.EXPIRED, PaymentStatus.FAILED] },
      });

      // Dan tak satu pun dari keduanya mengirim barang.
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(resellerSettlement.settle).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('callback DIULANG sesudah utangnya tercatat: NOL utang kedua, NOL verifikasi kedua', async () => {
      // Callback #1 kalah klaim dan mencatat utang; sesudah itu barisnya REFUND_DUE, dan penjaga
      // terminal di puncak verifyAndFulfil menghentikan callback #2 dan #3 sebelum apa pun.
      prisma.paymentOrder.findUnique
        .mockResolvedValueOnce({ ...baseOrder, status: PaymentStatus.PENDING })
        .mockResolvedValueOnce({ ...baseOrder, status: PaymentStatus.EXPIRED })
        .mockResolvedValue({ ...baseOrder, status: PaymentStatus.REFUND_DUE });
      // Klaim atomiknya KALAH (count 0); tulisan utang yang menyusul MENANG (count 1).
      prisma.paymentOrder.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValue({ count: 1 });

      const first = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });
      const second = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });
      const third = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect([first, second, third]).toEqual([
        'REFUND_DUE',
        'ALREADY_CLAIMED',
        'ALREADY_CLAIMED',
      ]);
      expect(debtWrites()).toHaveLength(1);
      // IDRX hanya ditanya sekali: callback berikutnya berhenti di penjaga terminal.
      expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(1);
    });

    it('dua verifikasi BERSAMAAN yang sama-sama kalah klaim: dua percobaan, SATU baris berubah', async () => {
      // KEDUA pemanggil membaca barisnya SEBELUM commit kedaluwarsa (dua pembacaan teratas =
      // PENDING), lalu KEDUANYA membacanya ulang SESUDAH commit itu (EXPIRED) — persis
      // interleaving yang diuji, bukan campuran dengan jalur settleExpiredButPaid.
      let reads = 0;
      prisma.paymentOrder.findUnique.mockImplementation(() => {
        reads += 1;
        return Promise.resolve({
          ...baseOrder,
          status: reads <= 2 ? PaymentStatus.PENDING : PaymentStatus.EXPIRED,
        });
      });
      // Tulisan utangnya diserialkan Postgres: pemenang count 1, pecundang count 0 (no-op).
      prisma.paymentOrder.updateMany
        .mockResolvedValueOnce({ count: 0 }) // klaim A kalah
        .mockResolvedValueOnce({ count: 0 }) // klaim B kalah
        .mockResolvedValueOnce({ count: 1 }) // utang A menang
        .mockResolvedValueOnce({ count: 0 }); // utang B no-op

      const [a, b] = await Promise.all([
        service.verifyAndFulfil(MERCHANT_ORDER_ID),
        service.verifyAndFulfil(MERCHANT_ORDER_ID),
      ]);

      expect([a, b]).toEqual(['REFUND_DUE', 'REFUND_DUE']);
      // Dua percobaan tulisan, tapi predikatnya identik dan hanya SATU baris yang bisa berubah.
      expect(debtWrites()).toHaveLength(2);
      for (const w of debtWrites()) {
        expect(w.where).toEqual({
          merchantOrderId: MERCHANT_ORDER_ID,
          status: { in: [PaymentStatus.EXPIRED, PaymentStatus.FAILED] },
        });
      }
    });

    it('order EXPIRED yang MEMANG tak pernah dibayar: NOL utang hantu, NOL tulisan', async () => {
      raceLostTo({ ...baseOrder }, PaymentStatus.EXPIRED);
      // IDRX sendiri yang bilang belum dibayar → jalur ini tak pernah sampai ke klaim atomik.
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        paymentStatus: 'UNPAID',
        userMintStatus: 'NOT_AVAILABLE',
      });

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('AWAITING_PAYMENT');
      expect(debtWrites()).toEqual([]);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B1 — SABUK-DAN-BRETEL: ORPHAN TIDAK BOLEH BERGANTUNG PADA ADANYA CALLBACK.                 ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Kedua jalur utang balapan di atas dipicu oleh SEBUAH CALLBACK. Callback IDRX dikirim sekali
   * dan tidak pernah diulang — kalau ia hilang (deploy/OOM/502), dulu tidak ada apa pun yang
   * memindai EXPIRED. Sapuan ini menutup celah itu, DIBATASI dua arah, dan IDEMPOTEN.
   */
  describe('B1 — sapuan EXPIRED di reconciler', () => {
    const expiredOrder: PaymentOrder = {
      ...baseOrder,
      status: PaymentStatus.EXPIRED,
      idrxPaymentStatus: 'EXPIRED',
      idrxUserMintStatus: 'NOT_AVAILABLE',
    };

    /** Query ke-3 = sapuan EXPIRED (1: PENDING/PAID, 2: FULFILLING macet). */
    const expiredQuery = (): {
      where: Record<string, unknown>;
      take: number;
      orderBy: unknown;
    } =>
      (
        prisma.paymentOrder.findMany.mock.calls as [
          { where: Record<string, unknown>; take: number; orderBy: unknown },
        ][]
      )[2][0];

    it('memindai baris EXPIRED yang BARU saja kedaluwarsa, dengan batch TERPISAH dan berbatas waktu', async () => {
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await service.reconcile();

      expect(prisma.paymentOrder.findMany).toHaveBeenCalledTimes(3);
      const q = expiredQuery();
      expect(q.where.status).toBe(PaymentStatus.EXPIRED);
      // DIBATASI: hanya baris yang updatedAt-nya di dalam jendela — bukan seluruh sejarah.
      const gte = (q.where.updatedAt as { gte: Date }).gte;
      expect(gte).toBeInstanceOf(Date);
      // Jendelanya SATU JAM (± slop jam dinding antara service dan assertion ini), bukan tak
      // berhingga: baris yang sudah lama EXPIRED berhenti dipoll selamanya.
      const windowMs = Date.now() - gte.getTime();
      expect(windowMs).toBeGreaterThan(59 * 60 * 1000);
      expect(windowMs).toBeLessThan(61 * 60 * 1000);
      // Batch TERPISAH & lebih kecil: tidak boleh menyandera jatah order yang masih bisa MAJU.
      expect(q.take).toBe(25);
      expect(q.take).toBeLessThan(50);
    });

    it('menemukan order EXPIRED yang ternyata DIBAYAR → utang tercatat, NOL barang dikirim', async () => {
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expiredOrder]);
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);

      const summary = await service.reconcile();

      expect(summary.scanned).toBe(1);
      expect(summary.refundDue).toBe(1);
      expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
        where: {
          merchantOrderId: MERCHANT_ORDER_ID,
          status: { in: [PaymentStatus.EXPIRED] },
        },
        data: expect.objectContaining({
          status: PaymentStatus.REFUND_DUE,
        }) as unknown,
      });
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(resellerSettlement.settle).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('IDEMPOTEN: sapuan berikutnya tak melihat baris yang sudah jadi REFUND_DUE → NOL utang kedua', async () => {
      // Putaran 1: baris masih EXPIRED → utang tercatat.
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expiredOrder]);
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      await service.reconcile();
      const afterFirst = prisma.paymentOrder.updateMany.mock.calls.length;
      expect(afterFirst).toBe(1);

      // Putaran 2: filter `status = EXPIRED` sudah tidak memungutnya (baris kini REFUND_DUE).
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      const summary = await service.reconcile();

      expect(summary.refundDue).toBe(0);
      expect(prisma.paymentOrder.updateMany.mock.calls.length).toBe(afterFirst);
    });

    it('kedaluwarsa yang JUJUR tetap bersih: dihitung `expired` (bukan "masih menunggu"), NOL tulisan', async () => {
      prisma.paymentOrder.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([expiredOrder]);
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        paymentStatus: 'EXPIRED',
        userMintStatus: 'NOT_AVAILABLE',
      });

      const summary = await service.reconcile();

      expect(summary).toMatchObject({
        scanned: 1,
        expired: 1,
        refundDue: 0,
        stillPending: 0,
      });
      expect(allStatusesWritten()).toEqual([]);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B1 — JALUR KEDALUWARSA TIDAK BOLEH MENDEKLARASIKAN UTANG REFUND-SAFE TANPA PIN.            ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `refundSafe = true` BUKAN bendera teknis: operator memutuskan mengirim uang sungguhan dengan
   * MEMBACA KOLOM ITU. Menulisnya berarti kita mengklaim DUA hal sekaligus terbukti — (a) uang user
   * ada pada kita, dan (b) barangnya belum diserahkan. `paymentStatus === 'PAID'` sendirian hanya
   * menyentuh setengah dari (a): catatan IDRX yang sama bisa mencetak ke wallet ORANG LAIN,
   * bernominal jauh di bawah tagihan, atau ber-requestType 'usdt'. Itulah gunanya pin.
   *
   * Jalur normal (order masih PENDING) memakai pin sebagai penentu dan FAIL-CLOSED ketika field pin
   * WAJIB-nya absen. Jalur kedaluwarsa dulu melewatinya sama sekali — dan sejak sapuan EXPIRED ada,
   * SETIAP baris EXPIRED lewat sana, tiap tick, selama sejam. Blok ini mengunci PARITASNYA:
   * untuk catatan IDRX yang SAMA, kedua jalur harus sampai pada kesimpulan yang SAMA.
   */
  describe('B1 — pin WAJIB juga di jalur EXPIRED (paritas dengan jalur normal)', () => {
    const expiredOrder: PaymentOrder = {
      ...baseOrder,
      status: PaymentStatus.EXPIRED,
      idrxPaymentStatus: 'EXPIRED',
      idrxUserMintStatus: 'NOT_AVAILABLE',
    };

    type Write = { where: unknown; data: Record<string, unknown> };
    const writes = (): Write[] =>
      (prisma.paymentOrder.updateMany.mock.calls as [Write][]).map(
        ([arg]) => arg,
      );
    const debtWrites = (): Write[] =>
      writes().filter((w) => w.data.status === PaymentStatus.REFUND_DUE);

    /**
     * Jalankan SATU catatan IDRX lewat KEDUA jalur: order PENDING (jalur normal) dan order
     * EXPIRED (jalur sapuan). Keduanya memakai record yang identik, jadi setiap perbedaan hasil
     * adalah perbedaan KEBIJAKAN — persis yang tidak boleh ada.
     */
    const runBothPaths = async (record: IdrxTransactionRecord) => {
      prisma.paymentOrder.findUnique.mockResolvedValue(baseOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(record);
      const normalOutcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      const normalWrites = writes();
      const normalDebts = debtWrites();
      prisma.paymentOrder.updateMany.mockClear();
      prisma.paymentOrder.update.mockClear();

      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      const expiryOutcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      return {
        normalOutcome,
        normalWrites,
        normalDebts,
        expiryOutcome,
        expiryWrites: writes(),
        expiryDebts: debtWrites(),
      };
    };

    it('destinationWalletAddress = wallet ASING → KEDUANYA utang, dan error-nya MENYEBUT wallet itu', async () => {
      const r = await runBothPaths({
        ...paidMintedRecord,
        destinationWalletAddress: ATTACKER_ADDRESS,
      });

      expect(r.normalOutcome).toBe('REFUND_DUE');
      expect(r.expiryOutcome).toBe('REFUND_DUE');
      expect(r.normalDebts).toHaveLength(1);
      expect(r.expiryDebts).toHaveLength(1);
      // ╔══════════════════════════════════════════════════════════════════════════════════════╗
      // ║ B2 — KEBIJAKAN: PIN TERBUKTI MENYIMPANG ⇒ refundSafe = FALSE, DI KEDUA JALUR.        ║
      // ╚══════════════════════════════════════════════════════════════════════════════════════╝
      // `refundSafe=true` adalah klaim bahwa uang user TERBUKTI kami pegang DAN TERBUKTI belum
      // diserahkan. Pin yang menyimpang membuktikan KEBALIKAN dari paruh pertama: Rupiah-nya
      // me-mint ke wallet lain. Operator yang patuh pada aturan "baca refundSafe" akan mengirim
      // Rupiah sungguhan untuk uang yang tidak pernah kami terima — rugi dibayar DUA KALI.
      // DULU: kedua jalur menulis true dan mengandalkan teks `error` — mitigasi yang justru
      // dinyatakan tidak bekerja oleh aturan operator itu sendiri.
      expect(r.normalDebts[0].data.refundSafe).toBe(false);
      expect(r.expiryDebts[0].data.refundSafe).toBe(false);
      // DULU: jalur EXPIRED menulis refundSafe=true dengan error yang TIDAK PERNAH menyebut wallet.
      expect(String(r.normalDebts[0].data.error)).toContain(ATTACKER_ADDRESS);
      expect(String(r.expiryDebts[0].data.error)).toContain(ATTACKER_ADDRESS);
      // Penyimpangan ditaruh DI DEPAN supaya selamat dari pemotongan ERROR_MAX (500 char) —
      // di KEDUA jalur, karena keduanya kini menulis lewat helper yang sama.
      expect(String(r.normalDebts[0].data.error).slice(0, 14)).toBe(
        'PIN MENYIMPANG',
      );
      expect(String(r.expiryDebts[0].data.error).slice(0, 14)).toBe(
        'PIN MENYIMPANG',
      );
      // Dan teks itu HARUS mengatakan terang-terangan apa yang tidak terbukti, plus ke mana
      // operator memverifikasinya sebelum satu Rupiah pun bergerak.
      for (const debt of [r.normalDebts[0], r.expiryDebts[0]]) {
        const text = String(debt.data.error);
        expect(text).toContain('TIDAK TERBUKTI KAMI TERIMA');
        expect(text).toContain('refundSafe=false');
        expect(text).toContain('dashboard IDRX');
        // Utangnya TETAP tercatat: yang berubah izin transfernya, bukan keberadaan utangnya.
        expect(debt.data.status).toBe(PaymentStatus.REFUND_DUE);
      }
      // Predikatnya tetap sesuai status barisnya masing-masing — tidak ada yang menimpa klaim lain.
      expect(r.expiryDebts[0].where).toEqual({
        merchantOrderId: MERCHANT_ORDER_ID,
        status: { in: [PaymentStatus.EXPIRED] },
      });
      // Dan TIDAK ADA barang yang berangkat dari mana pun.
      expect(gacha.purchase).not.toHaveBeenCalled();
      expect(balance.credit).not.toHaveBeenCalled();
    });

    it('destinationWalletAddress ABSEN → KEDUANYA PIN_UNVERIFIABLE dan TIDAK menulis apa pun', async () => {
      // Bukan kasus eksotis: idrx.types.ts menandai field ini OPSIONAL karena dokumentasi History
      // meng-elide-nya. Kalau History produksi memang tidak mengirimnya, versi lama menjadikan
      // SETIAP order EXPIRED sebagai utang refund-SAFE tanpa satu pun bukti uangnya sampai.
      const record = { ...paidMintedRecord };
      delete record.destinationWalletAddress;

      const r = await runBothPaths(record);

      expect(r.normalOutcome).toBe('PIN_UNVERIFIABLE');
      expect(r.expiryOutcome).toBe('PIN_UNVERIFIABLE');
      expect(r.normalWrites).toEqual([]);
      expect(r.expiryWrites).toEqual([]);
      expect(allStatusesWritten()).toEqual([]);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    it('nominal yang di-mint JAUH di bawah tagihan → KEDUANYA utang, error menyebut nominalnya', async () => {
      const r = await runBothPaths({ ...paidMintedRecord, toBeMinted: 1_000 });

      expect(r.normalOutcome).toBe('REFUND_DUE');
      expect(r.expiryOutcome).toBe('REFUND_DUE');
      expect(String(r.normalDebts[0].data.error)).toContain('1000');
      expect(String(r.expiryDebts[0].data.error)).toContain('1000');
      expect(String(r.expiryDebts[0].data.error)).toContain(String(PRICE_IDR));
      // B2 — penyimpangan TERBUKTI: uangnya tidak terbukti kami terima sepenuhnya.
      expect(r.normalDebts[0].data.refundSafe).toBe(false);
      expect(r.expiryDebts[0].data.refundSafe).toBe(false);
    });

    it("requestType 'usdt' → KEDUANYA utang, error menyebut requestType-nya", async () => {
      const r = await runBothPaths({
        ...paidMintedRecord,
        requestType: 'usdt',
      });

      expect(r.normalOutcome).toBe('REFUND_DUE');
      expect(r.expiryOutcome).toBe('REFUND_DUE');
      expect(String(r.normalDebts[0].data.error)).toContain('usdt');
      expect(String(r.expiryDebts[0].data.error)).toContain('usdt');
      // B2 — penyimpangan TERBUKTI di kedua jalur → keduanya refundSafe=false.
      expect(r.normalDebts[0].data.refundSafe).toBe(false);
      expect(r.expiryDebts[0].data.refundSafe).toBe(false);
    });

    it('pin LOLOS → utangnya TETAP tercatat seperti semula (refundSafe=true, predikat [EXPIRED], tanpa prefiks penyimpangan)', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);

      expect(outcome).toBe('REFUND_DUE');
      const debts = debtWrites();
      expect(debts).toHaveLength(1);
      expect(debts[0].where).toEqual({
        merchantOrderId: MERCHANT_ORDER_ID,
        status: { in: [PaymentStatus.EXPIRED] },
      });
      expect(debts[0].data.refundSafe).toBe(true);
      expect(String(debts[0].data.error)).not.toContain('PIN MENYIMPANG');
      expect(String(debts[0].data.error)).toContain('BALAPAN KEDALUWARSA');
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    it('HONEST EXPIRY tidak ikut berubah: IDRX bilang bukan PAID → NOL tulisan, NOL utang', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        paymentStatus: 'EXPIRED',
        userMintStatus: 'NOT_AVAILABLE',
      });

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);

      expect(outcome).toBe('ALREADY_CLAIMED');
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
    });

    /**
     * `settleLostClaim` (jalur utang KEDUA, ditambahkan pass lalu) DIPERIKSA DI SINI: ia hanya
     * bisa dicapai SESUDAH pin lolos, karena pin duduk di antara verifikasi IDRX dan klaim atomik
     * yang kekalahannya memanggilnya. Tes ini mengunci fakta itu dari luar: dengan pin yang TIDAK
     * BISA diputuskan, klaim atomiknya bahkan TIDAK PERNAH DICOBA — jadi tidak ada jalan menuju
     * settleLostClaim, dan lubang B1 tidak punya kembaran di sana.
     */
    it('settleLostClaim tak terjangkau tanpa pin: klaim atomik tidak pernah dicoba saat pin tak terputuskan', async () => {
      const record = { ...paidMintedRecord };
      delete record.destinationWalletAddress;
      prisma.paymentOrder.findUnique.mockResolvedValue(baseOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(record);

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);

      expect(outcome).toBe('PIN_UNVERIFIABLE');
      // NOL updateMany sama sekali → klaim PENDING|PAID → FULFILLING tidak pernah dijalankan,
      // jadi `claimed.count !== 1` (satu-satunya pintu ke settleLostClaim) tak pernah dievaluasi.
      expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
      expect(allStatusesWritten()).toEqual([]);
    });

    it('settleLostClaim yang pin-nya LOLOS tetap mencatat utang refund-safe saat klaim kalah ke EXPIRED', async () => {
      prisma.paymentOrder.findUnique
        .mockResolvedValueOnce(baseOrder)
        .mockResolvedValue({ ...baseOrder, status: PaymentStatus.EXPIRED });
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
      // Klaim atomik KALAH (count 0) — baris sudah keburu ditulis EXPIRED oleh tick reconciler.
      prisma.paymentOrder.updateMany.mockResolvedValue({ count: 0 });

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);

      expect(outcome).toBe('REFUND_DUE');
      const debts = debtWrites();
      expect(debts).toHaveLength(1);
      // B2 — JANGAN OVER-TIGHTEN: pin LOLOS membuktikan uangnya mendarat di treasury kita, dan
      // status terminal-tanpa-penyerahan membuktikan barangnya belum berangkat. Keduanya terbukti
      // → refundSafe=true memang benar di sini, dan HARUS tetap true.
      expect(debts[0].data.refundSafe).toBe(true);
      expect(String(debts[0].data.error)).toContain('pin-nya lolos');
      expect(String(debts[0].data.error)).not.toContain('PIN MENYIMPANG');
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    /**
     * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
     * ║ GERBANG MINT — pin LOLOS tidak cukup untuk refundSafe=true.                              ║
     * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
     * Pin membaca destinationWalletAddress / toBeMinted / requestType: ia membuktikan TUJUAN
     * mint-nya, BUKAN bahwa mint-nya TERJADI. `userMintStatus='REFUND'` berarti IDRX SUDAH
     * mengembalikan uangnya ke user; `FAILED`/`REJECTED` berarti token-nya tidak pernah sampai ke
     * treasury kami. DULU cabang pin-lolos di jalur EXPIRED menulis refundSafe=true untuk
     * SEMUA nilai itu, dengan peringatannya diparkir di teks `error` — tempat yang justru
     * dilarang dijadikan patokan oleh aturan operator. Akibatnya: operator bayar user DUA kali.
     *
     * Skenario yang bisa jalan sendiri tanpa manusia: invoice kedaluwarsa → user bayar telat di
     * halaman IDRX → IDRX menangkap pembayarannya (PAID) tapi mint ke treasury ditolak/di-refund
     * → sapuan EXPIRED bertanya dalam 2 menit → pin lolos (tujuannya memang treasury) → baris
     * ditulis REFUND_DUE. Sapuan itu otomatis, jadi ia bisa memproduksi utang salah-aman massal.
     */
    it.each(['FAILED', 'REJECTED', 'REFUND', 'PENDING', 'PROCESSING'])(
      'userMintStatus=%s → utang TETAP dicatat tapi refundSafe=FALSE (gerbang mint)',
      async (mintStatus) => {
        prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          userMintStatus: mintStatus,
        });

        const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
        const debts = debtWrites();

        // Utangnya WAJIB tetap tercatat: user sudah bayar. Menghilangkannya = uang hilang tanpa
        // jejak, yang justru kegagalan yang sapuan EXPIRED ini dibangun untuk mencegah.
        expect(outcome).toBe('REFUND_DUE');
        expect(debts).toHaveLength(1);
        // Tapi TIDAK boleh ditandai aman: uangnya tidak terbukti kami terima.
        expect(debts[0].data.refundSafe).toBe(false);
        // Dan tidak ada barang yang diserahkan dari jalur ini.
        expect(gacha.purchase).not.toHaveBeenCalled();
      },
    );

    it('userMintStatus=MINTED + pin lolos → refundSafe=true (gerbangnya TIDAK boleh kebablasan)', async () => {
      // Sisi lain dari gerbang: aturan yang berhenti mencatat utang asli, atau menandai SEMUA
      // utang perlu-diperiksa, merugikan sama persis — cuma dalam bentuk kerja manual tak berujung.
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      const debts = debtWrites();

      expect(outcome).toBe('REFUND_DUE');
      expect(debts).toHaveLength(1);
      expect(debts[0].data.refundSafe).toBe(true);
      expect(gacha.purchase).not.toHaveBeenCalled();
    });

    it('gerbangnya ada di TITIK TULIS, bukan di satu pemanggil — pin menyimpang + mint gagal tetap false', async () => {
      // Dua sebab menumpuk. Apa pun urutan pengecekannya, hasilnya harus tetap yang paling
      // hati-hati; ini yang membuktikan gerbangnya bukan `if` yang bisa dilewati cabang lain.
      prisma.paymentOrder.findUnique.mockResolvedValue(expiredOrder);
      idrx.findMintByMerchantOrderId.mockResolvedValue({
        ...paidMintedRecord,
        destinationWalletAddress: ATTACKER_ADDRESS,
        userMintStatus: 'REFUND',
      });

      const outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      const debts = debtWrites();

      expect(outcome).toBe('REFUND_DUE');
      expect(debts).toHaveLength(1);
      expect(debts[0].data.refundSafe).toBe(false);
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ B2 — SAPUAN EXPIRED HARUS KONVERGEN, DAN ERROR HARUS TETAP BERARTI "ADA UANG BUTUH MANUSIA" ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Baris yang jujur-kedaluwarsa TIDAK PERNAH ditulis (itu memang benar), jadi `updatedAt`-nya tak
   * bergerak dan ia tetap lolos filter `updatedAt >= now - 1 jam` selama SATU JAM penuh. Pada
   * interval 120 detik itu 30 tick: 25 baris × 30 = 750 panggilan History per jam yang semuanya
   * menjawab hal yang sama — dan rate limit IDRX tidak dimodelkan di jalur ini sama sekali.
   */
  describe('B2 — konvergensi sapuan EXPIRED & kebisingan log', () => {
    const T0 = Date.parse('2026-07-14T00:05:00.000Z');
    const sweptRow: PaymentOrder = {
      ...baseOrder,
      status: PaymentStatus.EXPIRED,
      idrxPaymentStatus: 'EXPIRED',
      idrxUserMintStatus: 'NOT_AVAILABLE',
      // Baru semenit lalu jadi EXPIRED → 59 menit sisa jendela sapuan.
      updatedAt: new Date(T0 - 60_000),
    };

    /** Fake DB yang MENGHORMATI predikatnya — sapuan hanya menerima baris yang tak dikecualikan. */
    const honourNotIn = (row: PaymentOrder): void => {
      prisma.paymentOrder.findMany.mockImplementation(
        (args: {
          where?: {
            status?: unknown;
            merchantOrderId?: { notIn?: string[] };
          };
        }) => {
          const where = args?.where ?? {};
          if (where.status !== PaymentStatus.EXPIRED) return Promise.resolve([]);
          const notIn = where.merchantOrderId?.notIn ?? [];
          return Promise.resolve(
            notIn.includes(row.merchantOrderId) ? [] : [row],
          );
        },
      );
    };

    /** Argumen query sapuan (query ke-3 tiap putaran) pada putaran ke-`tick` (0-based). */
    const sweepQuery = (
      tick: number,
    ): { where: Record<string, unknown>; take: number } =>
      (
        prisma.paymentOrder.findMany.mock.calls as [
          { where: Record<string, unknown>; take: number },
        ][]
      )[tick * 3 + 2][0];

    it('vonis TERMINAL IDRX (EXPIRED) → SATU panggilan History untuk 30 tick, bukan 30', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'EXPIRED',
          userMintStatus: 'NOT_AVAILABLE',
        });

        // Satu jam penuh pada interval default 120 detik.
        for (let tick = 0; tick < 30; tick += 1) {
          clock.mockReturnValue(T0 + tick * 120_000);
          await service.reconcile();
        }

        // DULU: 30. Vonis 'EXPIRED' milik IDRX TERMINAL — ia tak akan pernah berbalik jadi PAID.
        expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(1);
        // Dan pengecualiannya terjadi DI DALAM query: baris yang sudah dijawab tidak ikut memakan
        // jatah `take` 25, jadi ia tidak bisa menyandera baris EXPIRED yang lebih baru.
        const q = sweepQuery(1);
        expect(
          (q.where.merchantOrderId as { notIn: string[] }).notIn,
        ).toContain(MERCHANT_ORDER_ID);
        expect(q.take).toBe(25);
        // NOL tulisan sepanjang sejam itu: kedaluwarsa yang jujur bukan utang.
        expect(allStatusesWritten()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });

    it('WAITING_FOR_PAYMENT TIDAK dihentikan — cuma dijeda: ia masih bisa berbalik jadi PAID', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'WAITING_FOR_PAYMENT',
          userMintStatus: 'NOT_AVAILABLE',
        });

        for (let tick = 0; tick < 30; tick += 1) {
          clock.mockReturnValue(T0 + tick * 120_000);
          await service.reconcile();
        }

        // Jauh di bawah 30 TAPI JELAS LEBIH DARI SATU: menghentikannya = melewatkan pembayaran
        // terlambat, yang justru SATU-SATUNYA alasan jendela sejam ini ada.
        const calls = idrx.findMintByMerchantOrderId.mock.calls.length;
        expect(calls).toBeGreaterThan(1);
        expect(calls).toBeLessThan(30);

        const notInAt = (tick: number): string[] =>
          (
            sweepQuery(tick).where.merchantOrderId as
              | { notIn: string[] }
              | undefined
          )?.notIn ?? [];

        // JEDA TETAP BERLAKU DI BADAN JENDELA: baris ini jadi EXPIRED semenit sebelum T0, jadi
        // tepi jendelanya ada di menit ke-59. Tick ke-1 (menit ke-2) masih jauh dari tepi →
        // pertanyaan di menit ke-0 masih menjedanya.
        expect(notInAt(1)).toContain(MERCHANT_ORDER_ID);

        // …TAPI DI MARGIN TERAKHIR JENDELA (10 menit terakhir, yakni sejak menit ke-49) jedanya
        // DILEPAS TOTAL: tick ke-25 (menit ke-50) dan ke-26 (menit ke-52) TIDAK BOLEH memuat
        // baris ini di `notIn`. Itulah mekanisme yang menjamin SELALU ada pertanyaan terakhir
        // sebelum jendelanya tertutup — lihat tes "pembayaran di 10 menit TERAKHIR" di bawah.
        expect(notInAt(25)).not.toContain(MERCHANT_ORDER_ID);
        expect(notInAt(26)).not.toContain(MERCHANT_ORDER_ID);
      } finally {
        clock.mockRestore();
      }
    });

    /**
     * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
     * ║ B1 — PEMBAYARAN YANG MENDARAT DI CELAH TERAKHIR JENDELA TETAP JADI UTANG TERCATAT.       ║
     * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
     *
     * Jendela sapuan tertutup KERAS di `updatedAt >= now - 1 jam`: sesudah itu baris ini tidak
     * pernah ditanya lagi, selamanya. Jeda datar 10 menit yang tidak sadar tepi jendela membuat
     * pertanyaan TERAKHIR selalu jatuh sampai ~10 menit sebelum tepi — dan SETIAP pembayaran yang
     * mendarat di celah itu hilang tanpa satu baris pun jejak. Itu persis skenario "callback IDRX
     * hilang" yang menjadi ALASAN sapuan ini ada, dan `recordUnfulfilled` sudah terlanjur melepas
     * redemption-nya AWAITING_PAYMENT → REQUESTED sehingga layar user mengundang PEMBAYARAN KEDUA.
     *
     * Fake DB di sini menghormati KEDUA predikat (`notIn` DAN jendela `updatedAt.gte`), jadi tes
     * ini tidak bisa lulus karena baris "kebetulan masih terlihat" sesudah jendelanya tutup.
     * Fase tick-nya SENGAJA tidak selaras (offset 30 detik terhadap T0) supaya tidak ada tick yang
     * kebetulan mendarat tepat di batas jeda.
     */
    it('B1 — pembayaran di 10 menit TERAKHIR jendela tetap tertangkap (jeda tidak boleh menutup tepi)', async () => {
      const EXPIRED_AT = Date.parse('2026-07-14T02:00:00.000Z');
      const WINDOW_MS = 60 * 60 * 1000;
      const TICK_MS = 120_000;
      /** Fase SENGAJA tidak selaras: tick jatuh di 0.5, 2.5, 4.5, … menit sesudah kedaluwarsa. */
      const PHASE_MS = 30_000;
      /** User membayar di halaman IDRX pada menit ke-52 — di dalam celah 10 menit terakhir. */
      const PAID_AT = EXPIRED_AT + 52 * 60_000;

      const row: PaymentOrder = {
        ...baseOrder,
        status: PaymentStatus.EXPIRED,
        idrxPaymentStatus: 'EXPIRED',
        idrxUserMintStatus: 'NOT_AVAILABLE',
        updatedAt: new Date(EXPIRED_AT),
      };

      // Fake DB yang menghormati `notIn` DAN batas jendela — tanpa yang kedua, tes ini bohong.
      prisma.paymentOrder.findMany.mockImplementation(
        (args: {
          where?: {
            status?: unknown;
            updatedAt?: { gte?: Date };
            merchantOrderId?: { notIn?: string[] };
          };
        }) => {
          const where = args?.where ?? {};
          if (where.status !== PaymentStatus.EXPIRED) return Promise.resolve([]);
          const gte = where.updatedAt?.gte;
          if (gte && row.updatedAt.getTime() < gte.getTime()) {
            return Promise.resolve([]);
          }
          const notIn = where.merchantOrderId?.notIn ?? [];
          return Promise.resolve(
            notIn.includes(row.merchantOrderId) ? [] : [row],
          );
        },
      );
      prisma.paymentOrder.findUnique.mockResolvedValue(row);

      const clock = jest.spyOn(Date, 'now').mockReturnValue(EXPIRED_AT);
      try {
        // Reconciler berjalan tiap 120 detik dari kedaluwarsa sampai LEWAT tepi jendela.
        for (
          let t = EXPIRED_AT + PHASE_MS;
          t <= EXPIRED_AT + WINDOW_MS + 5 * TICK_MS;
          t += TICK_MS
        ) {
          clock.mockReturnValue(t);
          idrx.findMintByMerchantOrderId.mockResolvedValue(
            t >= PAID_AT
              ? paidMintedRecord
              : {
                  ...paidMintedRecord,
                  paymentStatus: 'WAITING_FOR_PAYMENT',
                  userMintStatus: 'NOT_AVAILABLE',
                },
          );
          await service.reconcile();
        }

        // DULU (jeda datar 10 menit): pertanyaan terakhir di menit ke-50,5 → uangnya mendarat di
        // menit ke-52 dan TIDAK PERNAH ditanyakan lagi. NOL tulisan, NOL utang, NOL ERROR —
        // `debts` kosong. Sekarang utangnya TERCATAT, dan karena fake DB ini menghormati batas
        // jendela, satu-satunya cara ia bisa tercatat adalah ditanya SEBELUM jendelanya tertutup.
        //
        // (Di produksi tulisan ini terjadi SEKALI: tulisannya memindahkan baris ke REFUND_DUE dan
        // filter `status = EXPIRED` sapuan tidak melihatnya lagi. Fake `updateMany` di sini tidak
        // memindahkan apa pun, jadi tick-tick sisa menulis lagi — yang diuji di sini BUKAN
        // idempotensi (ada tesnya sendiri), melainkan "utangnya tercatat sama sekali".)
        const debts = (
          prisma.paymentOrder.updateMany.mock.calls as [
            { data: Record<string, unknown> },
          ][]
        )
          .map(([arg]) => arg)
          .filter((w) => w.data.status === PaymentStatus.REFUND_DUE);
        expect(debts.length).toBeGreaterThanOrEqual(1);
        // Pin-nya lolos (record treasury yang sah) → utang ini memang refund-safe.
        expect(debts[0].data.refundSafe).toBe(true);
        expect(String(debts[0].data.error)).toContain('BALAPAN KEDALUWARSA');
      } finally {
        clock.mockRestore();
      }
    });

    it('B1 — konvergensi TERMINAL tidak ikut longgar: vonis EXPIRED tetap SATU panggilan walau jendelanya mau habis', async () => {
      const EXPIRED_AT = Date.parse('2026-07-14T03:00:00.000Z');
      const row: PaymentOrder = {
        ...sweptRow,
        updatedAt: new Date(EXPIRED_AT),
      };
      const clock = jest.spyOn(Date, 'now').mockReturnValue(EXPIRED_AT);
      try {
        honourNotIn(row);
        prisma.paymentOrder.findUnique.mockResolvedValue(row);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'EXPIRED',
          userMintStatus: 'NOT_AVAILABLE',
        });

        // Satu jam penuh, fase tidak selaras — termasuk seluruh margin 10 menit terakhir.
        for (let tick = 0; tick < 30; tick += 1) {
          clock.mockReturnValue(EXPIRED_AT + 30_000 + tick * 120_000);
          await service.reconcile();
        }

        // Margin terakhir HANYA melonggarkan cabang NON-terminal. 'EXPIRED' adalah vonis terminal
        // IDRX — ia tidak akan pernah berbalik jadi PAID, jadi propertinya harus tetap 1, bukan 30.
        expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(1);
        expect(allStatusesWritten()).toEqual([]);
      } finally {
        clock.mockRestore();
      }
    });

    it('baris yang sudah dijeda LALU jadi DIBAYAR tetap ditangkap setelah jedanya habis', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'WAITING_FOR_PAYMENT',
          userMintStatus: 'NOT_AVAILABLE',
        });
        await service.reconcile();
        expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();

        // User membayar di halaman IDRX SESUDAH order kita kedaluwarsa.
        idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
        clock.mockReturnValue(T0 + 11 * 60_000);
        const summary = await service.reconcile();

        expect(summary.refundDue).toBe(1);
        expect(prisma.paymentOrder.updateMany).toHaveBeenCalledWith({
          where: {
            merchantOrderId: MERCHANT_ORDER_ID,
            status: { in: [PaymentStatus.EXPIRED] },
          },
          data: expect.objectContaining({
            status: PaymentStatus.REFUND_DUE,
            refundSafe: true,
          }) as unknown,
        });
      } finally {
        clock.mockRestore();
      }
    });

    it('"tidak ada catatan di IDRX" turun ke WARN — ERROR disimpan untuk uang yang butuh manusia', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
      idrx.findMintByMerchantOrderId.mockResolvedValue(null);
      const errors: string[] = [];
      const warns: string[] = [];
      const errSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((msg: unknown) => {
          warns.push(String(msg));
        });

      let outcome: string;
      try {
        outcome = await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      } finally {
        errSpy.mockRestore();
        warnSpy.mockRestore();
      }

      expect(outcome).toBe('VERIFY_FAILED');
      expect(allStatusesWritten()).toEqual([]);
      // DULU: baris ERROR, sekali per tick, menenggelamkan utang SUNGGUHAN yang juga ERROR.
      expect(errors.filter((m) => m.includes(MERCHANT_ORDER_ID))).toEqual([]);
      const note = warns.find((m) => m.includes(MERCHANT_ORDER_ID));
      expect(note).toBeDefined();
      expect(note).toContain('memang tidak');
      expect(note).toContain('NOL utang');
    });

    it('utang SUNGGUHAN tetap ERROR (yang ini memang butuh manusia)', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
      idrx.findMintByMerchantOrderId.mockResolvedValue(paidMintedRecord);
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });

      try {
        await service.verifyAndFulfil(MERCHANT_ORDER_ID);
      } finally {
        spy.mockRestore();
      }

      expect(errors.find((m) => m.includes('REFUND_DUE'))).toContain(
        MERCHANT_ORDER_ID,
      );
    });

    it('pin tak terputuskan di sapuan tetap ERROR, dan barisnya dijeda (bukan diteriaki tiap tick)', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      const errors: string[] = [];
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((msg: unknown) => {
          errors.push(String(msg));
        });
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        const record = { ...paidMintedRecord };
        delete record.destinationWalletAddress;
        idrx.findMintByMerchantOrderId.mockResolvedValue(record);

        for (let tick = 0; tick < 5; tick += 1) {
          clock.mockReturnValue(T0 + tick * 120_000);
          await service.reconcile();
        }

        // Satu teriakan, bukan lima — dan tetap NOL tulisan (fail-closed).
        expect(
          errors.filter((m) => m.includes('fail-closed')),
        ).toHaveLength(1);
        expect(allStatusesWritten()).toEqual([]);
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
    });

    it('peta jeda hanya MENJADWALKAN pertanyaan: NOL tulisan ke DB, jadi `updatedAt` tak pernah berbohong', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'EXPIRED',
          userMintStatus: 'NOT_AVAILABLE',
        });

        for (let tick = 0; tick < 10; tick += 1) {
          clock.mockReturnValue(T0 + tick * 120_000);
          await service.reconcile();
        }

        // Tidak ada kolom yang ditulis, jadi `updatedAt` (= detik baris ini JADI EXPIRED, dan
        // satu-satunya sumber jendela sejam) tetap apa adanya — mekanisme konvergensi ini secara
        // struktural TIDAK BISA berbohong tentang keadaan order.
        expect(prisma.paymentOrder.update).not.toHaveBeenCalled();
        expect(prisma.paymentOrder.updateMany).not.toHaveBeenCalled();
        // Jendela sejamnya juga tidak berubah.
        const gte = (sweepQuery(9).where.updatedAt as { gte: Date }).gte;
        expect(T0 + 9 * 120_000 - gte.getTime()).toBe(60 * 60 * 1000);
      } finally {
        clock.mockRestore();
      }
    });

    it('RESTART: peta hilang → baris ditanya SEKALI lagi, lalu konvergen lagi (tidak pernah melewatkan utang)', async () => {
      const clock = jest.spyOn(Date, 'now').mockReturnValue(T0);
      try {
        honourNotIn(sweptRow);
        prisma.paymentOrder.findUnique.mockResolvedValue(sweptRow);
        idrx.findMintByMerchantOrderId.mockResolvedValue({
          ...paidMintedRecord,
          paymentStatus: 'EXPIRED',
          userMintStatus: 'NOT_AVAILABLE',
        });
        await service.reconcile();
        await service.reconcile();
        expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(1);

        // Proses restart: instans baru, peta kosong.
        const fresh = await Test.createTestingModule({
          providers: [
            PaymentsService,
            { provide: PrismaService, useValue: prisma },
            { provide: IdrxClient, useValue: idrx },
            { provide: GachaService, useValue: gacha },
            { provide: ConfigService, useValue: config },
            {
              provide: ResellerSettlementService,
              useValue: resellerSettlement,
            },
            { provide: EscrowService, useValue: escrow },
            { provide: BalanceService, useValue: balance },
            { provide: CcShippingService, useValue: ccShipping },
          ],
        }).compile();
        const revived = fresh.get(PaymentsService);

        await revived.reconcile();
        await revived.reconcile();

        // Tepat SATU pertanyaan ekstra — bukan kembali ke 30/jam, dan bukan utang yang terlewat.
        expect(idrx.findMintByMerchantOrderId).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
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

  /**
   * TOP-UP SALDO. Jalur PALING AMAN: fulfilment-nya HANYA mengkredit saldo in-app, TIDAK PERNAH
   * membelanjakan treasury. Tes di sini mengunci dua jaminan uang:
   *   1. sebuah order TOPUP TIDAK PERNAH memanggil gacha.purchase (tak beli pack ~$50), dan
   *   2. kegagalan credit → LEPAS klaim untuk diulang (bukan REFUND_DUE, bukan dobel-kredit).
   */
  describe('top-up saldo (createTopupOrder / fulfilTopup)', () => {
    // Order top-up: packType sentinel 'TOPUP', TANPA listingId, priceUsdc 0. priceIdr = PRICE_IDR
    // supaya record IDRX default (toBeMinted PRICE_IDR ke treasury) lolos pin nominal & tujuan.
    const topupOrder: PaymentOrder = {
      ...baseOrder,
      packType: 'TOPUP',
      listingId: null,
      priceUsdc: 0,
    };

    it('membuat order TOPUP: packType="TOPUP", priceUsdc 0, listingId null, mint ke treasury sebesar amount', async () => {
      await service.createTopupOrder(100_000, user);

      expect(idrx.mintRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          toBeMinted: '100000',
          destinationWalletAddress: TREASURY_ADDRESS,
        }),
      );
      expect(prisma.paymentOrder.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            packType: 'TOPUP',
            priceIdr: 100_000,
            priceUsdc: 0,
            status: PaymentStatus.PENDING,
          }) as unknown,
        }),
      );
      // listingId TIDAK di-set (undefined) — top-up bukan pembelian listing.
      const [createArg] = prisma.paymentOrder.create.mock.calls[0] as [
        { data: { listingId?: unknown } },
      ];
      expect(createArg.data.listingId).toBeUndefined();
    });

    it('menolak (BadRequest) nominal di bawah minimum mint IDRX 20.000 — tanpa mint & tanpa create', async () => {
      await expect(service.createTopupOrder(10_000, user)).rejects.toThrow(
        BadRequestException,
      );
      expect(idrx.mintRequest).not.toHaveBeenCalled();
      expect(prisma.paymentOrder.create).not.toHaveBeenCalled();
    });

    it('fulfil TOPUP: KREDIT saldo (idempoten per merchantOrderId) + FULFILLED — gacha.purchase TAK PERNAH dipanggil', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(topupOrder);

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      expect(outcome).toBe('FULFILLED');
      // Jaminan #1: NOL belanja treasury — top-up tak pernah beli pack.
      expect(gacha.purchase).not.toHaveBeenCalled();
      // Saldo dikredit sebesar priceIdr, reason TOPUP, refId=merchantOrderId (gerbang idempotensi).
      expect(balance.credit).toHaveBeenCalledWith({
        userId: user.id,
        amountIdrx: topupOrder.priceIdr,
        reason: 'TOPUP',
        refId: MERCHANT_ORDER_ID,
      });
      expect(prisma.paymentOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { merchantOrderId: MERCHANT_ORDER_ID },
          data: expect.objectContaining({
            status: PaymentStatus.FULFILLED,
          }) as unknown,
        }),
      );
    });

    it('credit gagal → LEPAS klaim ke PAID untuk diulang (VERIFY_FAILED), BUKAN REFUND_DUE, tanpa belanja', async () => {
      prisma.paymentOrder.findUnique.mockResolvedValue(topupOrder);
      balance.credit.mockRejectedValue(new Error('db down'));

      const outcome = await service.handleCallback({
        merchantOrderId: MERCHANT_ORDER_ID,
      });

      // Aman diulang (credit idempoten + nol treasury) → klaim dilepas, bukan utang.
      expect(outcome).toBe('VERIFY_FAILED');
      expect(gacha.purchase).not.toHaveBeenCalled();
      const statuses = allStatusesWritten();
      // Klaim melepas FULFILLING→PAID; TIDAK boleh menulis REFUND_DUE maupun FULFILLED.
      expect(statuses).toContain(PaymentStatus.PAID);
      expect(statuses).not.toContain(PaymentStatus.REFUND_DUE);
      expect(statuses).not.toContain(PaymentStatus.FULFILLED);
    });
  });
});
