import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedemptionStatus } from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcShippingClient } from './cc-shipping.client';
import {
  CcShippingService,
  ShippingBurnRetryableError,
  ShippingPostFundError,
} from './cc-shipping.service';
import {
  TreasuryFundIndeterminateError,
  TreasuryService,
} from './treasury.service';
import { burnTxSetIdentity } from './cc-shipping.txset';

// CcShippingService meng-import treasury.service.ts, yang di module-scope menjalankan
// `new PublicKey(...)` dan menarik @solana/web3.js (rantai ESM rpc-websockets→uuid yang bikin
// jest gagal parse). Sama seperti reseller-settlement.service.spec.ts, kita mock @solana/web3.js:
// TreasuryService di sini hanya dipakai sebagai TOKEN DI (selalu di-override mock di bawah), jadi
// implementasi aslinya (satu-satunya pemegang private key) tidak pernah dieksekusi.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
  clusterApiUrl: () => 'http://localhost:8899',
}));

describe('CcShippingService', () => {
  let service: CcShippingService;
  let configFlags: Record<string, string | undefined>;
  let prisma: {
    cardRedemption: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    paymentOrder: { findUnique: jest.Mock; findFirst: jest.Mock };
    user: { findUnique: jest.Mock };
  };
  let client: {
    createShippingAddress: jest.Mock;
    estimate: jest.Mock;
    prepare: jest.Mock;
    burn: jest.Mock;
    getShipment: jest.Mock;
    siwsNonce: jest.Mock;
    siwsVerify: jest.Mock;
    siwsRefresh: jest.Mock;
  };
  let treasury: { fundUsdc: jest.Mock };

  const now = new Date('2026-08-20T00:00:00.000Z');

  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };

  // Access token sesi wallet sign-in CC (cca_) — satu-satunya kredensial yang bisa menuntaskan
  // redemption Solana; TIDAK ada jalur "Privy identity token" di kontrak CC.
  const CC_TOKEN = 'cca_session-token';
  const REDEMPTION_ID = 'red-1';

  // Baris redemption di titik READY_TO_FUND (Rupiah sudah PAID+MINTED, PRA-danai, refundSafe=true).
  // ccShippingAddressId sudah terisi supaya ensureCcShippingAddress short-circuit (jalur alamat CC
  // diuji terpisah — di sini fokusnya URUTAN keamanan uang).
  const baseRow: CardRedemption = {
    id: REDEMPTION_ID,
    userId: user.id,
    nftAddress: 'NftAddrBase58',
    cardName: 'Charizard',
    cardImage: null,
    cardSet: null,
    source: 'PACK',
    // Jalur CC Vault: listingId NULL. Sebuah baris DOMESTIK (listingId non-null) tidak bisa
    // masuk ke jalur ini sama sekali — ownedRedemption menolaknya (assertCcRail).
    listingId: null,
    shippingAddressId: null,
    recipientName: 'Budi',
    country: 'ID',
    street: 'Jl. Merdeka 1',
    apt: null,
    city: 'Jakarta',
    state: null,
    zip: '12345',
    phoneCountryCode: null,
    phoneNumber: null,
    status: RedemptionStatus.READY_TO_FUND,
    note: null,
    createdAt: now,
    updatedAt: now,
    processedAt: null,
    ccShippingAddressId: 'cc-addr-1',
    outboundShipmentId: null,
    totalCostUsdc: null,
    paymentOrderId: 'order-1',
    fundingSignature: null,
    burnSignature: null,
    // B2: baris LAMA belum punya identitas set transaksi -> pemeriksaan batch-basi DILEWATI,
    // perilakunya persis seperti sebelum fitur itu ada. Test khusus B2 mengisinya sendiri.
    burnTxSetHash: null,
    trackingIds: [],
    trackingUrls: [],
    refundSafe: true,
  };

  // Respons /redeem/prepare yang mulus. totalCost 25 USD → 25_000_000 USDC base unit.
  const preparedOk = {
    outboundShipmentId: 'ship-1',
    transactions: ['UNSIGNED_BURN_TX'],
    delistTransactions: ['DELIST_TX'],
    totalCost: 25,
  };

  // User membayar Rupiah senilai 25_000_000 base unit (snapshot order). Plafon slippage +10%
  // → ceiling 27_500_000. Ongkir CC 25_000_000 di bawah ceiling → lolos.
  const PAID_USDC = 25_000_000;
  const FUNDED_COST_USDC = 25_000_000;

  const armFundHappy = (): void => {
    prisma.cardRedemption.findUnique.mockResolvedValue(baseRow);
    client.prepare.mockResolvedValue(preparedOk);
  };

  // Semua argumen `update` yang benar-benar ditulis, untuk memeriksa flag refundSafe / status.
  const updateArgs = (): Array<{ data: Record<string, unknown> }> =>
    prisma.cardRedemption.update.mock.calls.map(
      (c) => c[0] as { data: Record<string, unknown> },
    );
  const refundSafeSetFalse = (): boolean =>
    updateArgs().some((a) => a.data.refundSafe === false);

  beforeEach(async () => {
    configFlags = { HOSHI_CC_SHIPPING_ENABLED: 'true' };
    prisma = {
      cardRedemption: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
        // Default: request ini memenangkan klaim atomik READY_TO_FUND -> FUNDING.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentOrder: {
        findUnique: jest.fn().mockResolvedValue({ priceUsdc: PAID_USDC }),
        findFirst: jest.fn().mockResolvedValue({ priceUsdc: PAID_USDC }),
      },
      user: { findUnique: jest.fn().mockResolvedValue({ email: 'u@example.com' }) },
    };
    client = {
      createShippingAddress: jest.fn().mockResolvedValue({ id: 'cc-addr-created' }),
      estimate: jest.fn(),
      prepare: jest.fn(),
      burn: jest.fn(),
      getShipment: jest.fn(),
      siwsNonce: jest
        .fn()
        .mockResolvedValue({ nonce: 'NONCE', expiresAt: 123, message: 'SIWS MSG' }),
      siwsVerify: jest.fn().mockResolvedValue({
        accessToken: 'cca_x',
        refreshToken: 'ccr_x',
        expiresAt: 456,
      }),
      siwsRefresh: jest.fn().mockResolvedValue({
        accessToken: 'cca_y',
        refreshToken: 'ccr_y',
        expiresAt: 789,
      }),
    };
    treasury = { fundUsdc: jest.fn().mockResolvedValue({ signature: 'FUNDSIG' }) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CcShippingService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (k: string) => configFlags[k] } },
        { provide: CcShippingClient, useValue: client },
        { provide: TreasuryService, useValue: treasury },
      ],
    }).compile();

    service = moduleRef.get(CcShippingService);
  });

  /* ───────────── estimateForRedemption — bentuk request/response REAL (pra-bayar) ─────────────
     Kontrak CC: /redeem/estimate HANYA menerima nftAddresses, shippingAddressId, deliveryCompany,
     payCustomsDuties (objek alamat → 400), dan angka otoritatifnya `total` — BUKAN `totalCost`
     (field itu milik /redeem/prepare). */

  describe('estimateForRedemption', () => {
    /** Respons /redeem/estimate seperti di dokumen (angka USD dolar penuh). */
    const estimateOk = {
      price: 5.99,
      insurancePrice: 0,
      feesPrice: 0,
      shippingPrice: 5.99,
      total: 25,
      numberOfCards: 1,
      customsDutiesEstimate: 0,
      breakdown: { region: 'RestOfWorld', declaredValue: 80, lines: [] },
    };

    it('sends ONLY the allowed fields (shippingAddressId, not an address object) and reads `total`', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(baseRow);
      client.estimate.mockResolvedValue(estimateOk);

      const res = await service.estimateForRedemption(
        REDEMPTION_ID,
        user,
        CC_TOKEN,
      );

      expect(client.estimate).toHaveBeenCalledWith(CC_TOKEN, {
        nftAddresses: [baseRow.nftAddress],
        shippingAddressId: 'cc-addr-1',
        deliveryCompany: 'ups',
      });
      // 25 USD → 25_000_000 base unit USDC.
      expect(res).toEqual({ usd: 25, usdcBaseUnits: 25_000_000 });
    });

    // Jaring pengaman regresi: kalau ada yang mengembalikan pembacaan ke `totalCost`, angka estimate
    // jadi undefined → jalur uang WAJIB menolak, bukan menerima NaN.
    it('refuses a response that carries only the OLD totalCost field (no `total`)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(baseRow);
      client.estimate.mockResolvedValue({ totalCost: 25 });

      await expect(
        service.estimateForRedemption(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('creates the CC address first when the row has none, WITHOUT sending email', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        ccShippingAddressId: null,
        state: 'Jakarta',
      });
      client.estimate.mockResolvedValue(estimateOk);

      await service.estimateForRedemption(REDEMPTION_ID, user, CC_TOKEN);

      const addr = client.createShippingAddress.mock.calls[0][1] as Record<
        string,
        unknown
      >;
      // WHITELIST KETAT: field di luar daftar CC (dulu kita mengirim `email`) dijawab 400.
      expect(addr).toEqual({
        streetAddress: 'Jl. Merdeka 1',
        city: 'Jakarta',
        state: 'Jakarta',
        country: 'ID',
        fullName: 'Budi',
        apartment: undefined,
        zip: '12345',
        phoneNumber: undefined,
        isDefault: true,
      });
      expect(Object.keys(addr)).not.toContain('email');
      // Estimate lalu memakai id alamat yang baru dibuat.
      expect(client.estimate).toHaveBeenCalledWith(
        CC_TOKEN,
        expect.objectContaining({
          shippingAddressId: 'cc-addr-created',
        }) as unknown,
      );
    });

    // CC MEWAJIBKAN `state` ("even where the concept does not apply") sementara kolom kita nullable:
    // tolak lebih awal dengan pesan jelas, jangan menunggu 400 "Invalid request." yang anonim.
    it('refuses before touching CC when the address snapshot has no state', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        ccShippingAddressId: null,
        state: null,
      });

      await expect(
        service.estimateForRedemption(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.createShippingAddress).not.toHaveBeenCalled();
      expect(client.estimate).not.toHaveBeenCalled();
    });
  });

  /* ─────────────────────── fundAndPrepare — matrix urutan keamanan uang ─────────────────────── */

  describe('fundAndPrepare', () => {
    // Langkah 3 (CC prepare) GAGAL = masih PRA-danai. Tidak boleh ada klaim FUNDING, tidak boleh
    // ada fund, refundSafe TETAP true (Rupiah aman di-refund).
    it('prepare throws (pre-fund): never funds, never claims FUNDING, refundSafe stays true', async () => {
      armFundHappy();
      client.prepare.mockRejectedValue(new ServiceUnavailableException('CC down'));

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      // Klaim atomik READY_TO_FUND->FUNDING belum pernah dijalankan.
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(refundSafeSetFalse()).toBe(false);
    });

    // Langkah 4 (slippage) MELEBIHI plafon = masih PRA-danai → tolak keras, nol belanja.
    it('slippage over the ceiling: BadRequest, pre-fund, no fund call, no FUNDING claim', async () => {
      armFundHappy();
      // 30 USD → 30_000_000 > ceiling 27_500_000 (dibayar 25_000_000 + 10%).
      client.prepare.mockResolvedValue({ ...preparedOk, totalCost: 30 });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(refundSafeSetFalse()).toBe(false);
    });

    // Sesi kedua tiba saat status SUDAH FUNDING → cek status menolaknya sebelum menyentuh CC/dana.
    it('second concurrent call finds status already FUNDING and is rejected before any work', async () => {
      armFundHappy();
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        status: RedemptionStatus.FUNDING,
      });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    // Balapan sebenarnya: findUnique masih READY_TO_FUND, tapi klaim atomik kalah (count 0).
    // Yang kalah harus BERHENTI sebelum fund — dua sesi tak boleh double-fund.
    it('atomic claim loser (count 0) does not fund', async () => {
      armFundHappy();
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      expect(refundSafeSetFalse()).toBe(false);
    });

    // fundUsdc gagal PRA-broadcast (mis. simulasi ditolak) = belum ada USDC keluar → LEPAS klaim
    // balik ke READY_TO_FUND, refundSafe TETAP true, dan rethrow error ASLINYA (bukan PostFund).
    it('fundUsdc throws a normal (pre-broadcast) error: releases claim, refundSafe stays true, rethrows', async () => {
      armFundHappy();
      treasury.fundUsdc.mockRejectedValue(
        new ServiceUnavailableException('sim failed pre-broadcast'),
      );

      const err = await service
        .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect(err).not.toBeInstanceOf(ShippingPostFundError);
      // Klaim dilepas: FUNDING -> READY_TO_FUND.
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDING },
        data: { status: RedemptionStatus.READY_TO_FUND },
      });
      // Tidak pernah ditandai PASCA-danai.
      expect(refundSafeSetFalse()).toBe(false);
    });

    // fundUsdc INDETERMINATE = USDC MUNGKIN sudah pindah → status TETAP FUNDING, refundSafe=false,
    // ShippingPostFundError, dan klaim TIDAK dilepas (JANGAN auto-refund Rupiah).
    it('fundUsdc throws TreasuryFundIndeterminateError: stays FUNDING, refundSafe=false, ShippingPostFundError, no refund', async () => {
      armFundHappy();
      treasury.fundUsdc.mockRejectedValue(
        new TreasuryFundIndeterminateError(
          'confirm timeout',
          'FUNDSIG_IND',
          user.walletAddress,
        ),
      );

      const err = await service
        .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingPostFundError);
      expect((err as ShippingPostFundError).redemptionId).toBe(REDEMPTION_ID);
      // markPostFund: status TETAP FUNDING + refundSafe=false + fundingSignature disimpan.
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: expect.objectContaining({
          status: RedemptionStatus.FUNDING,
          refundSafe: false,
          fundingSignature: 'FUNDSIG_IND',
        }) as unknown,
      });
      // Klaim TIDAK dilepas balik ke READY_TO_FUND (itu jalur pra-danai).
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDING },
        data: { status: RedemptionStatus.READY_TO_FUND },
      });
    });

    // Happy: FUNDED + fundingSignature + refundSafe=false, mendanai nominal OTORITATIF CC, dan
    // mengembalikan tx UNSIGNED untuk ditandatangani frontend.
    it('happy path: FUNDED + refundSafe=false and returns the unsigned burn transactions', async () => {
      armFundHappy();

      const res = await service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN);

      expect(treasury.fundUsdc).toHaveBeenCalledWith({
        toWallet: user.walletAddress,
        amountBaseUnits: FUNDED_COST_USDC,
      });
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: {
          status: RedemptionStatus.FUNDED,
          fundingSignature: 'FUNDSIG',
          refundSafe: false,
        },
      });
      expect(res).toEqual({
        transactions: ['UNSIGNED_BURN_TX'],
        delistTransactions: ['DELIST_TX'],
        outboundShipmentId: 'ship-1',
        totalCostUsdc: FUNDED_COST_USDC,
      });
    });

    // B4 — ANGKA YANG DIDANAI TIDAK BOLEH BISA DITIMPA SESI YANG KALAH KLAIM.
    // Dulu {outboundShipmentId,totalCostUsdc,burnTxSetHash} ditulis lewat update() TANPA predikat
    // SEBELUM klaim. Dua tab di READY_TO_FUND: A prepare->tulis->klaim->danai->FUNDED; B (round-trip
    // CC lebih lambat) menulis totalCostUsdc MILIKNYA sesudah A mendanai, baru kalah klaim. Kolom
    // itu adalah basis plafon assertCostWithinFunded SEKALIGUS suku penjumlahan plafon treasury 24
    // jam — nilai yang tercemar diam-diam mendistorsi cap harian.
    it('B4: the session that LOSES the atomic claim writes nothing at all (no totalCostUsdc overwrite)', async () => {
      armFundHappy();
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });
      // Sesi yang kalah memakai harga CC yang BERBEDA — persis nilai yang dulu bisa menimpa.
      client.prepare.mockResolvedValue({ ...preparedOk, totalCost: 26 });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      // SATU-SATUNYA tulisan yang pernah dicoba adalah klaim berpredikatnya sendiri, dan ia kalah.
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledTimes(1);
      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(call.where).toEqual({
        id: REDEMPTION_ID,
        status: RedemptionStatus.READY_TO_FUND,
      });
      expect(call.data.totalCostUsdc).toBe(26_000_000);
    });

    it('B4: a rejected cost guard persists NOTHING (shipment id / cost / identity all unwritten)', async () => {
      armFundHappy();
      // 30 USD > plafon 27,5 → ditolak SEBELUM klaim.
      client.prepare.mockResolvedValue({ ...preparedOk, totalCost: 30 });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(refundSafeSetFalse()).toBe(false);
    });

    it('refuses a redemption in the wrong status (not READY_TO_FUND) before touching CC or funds', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        status: RedemptionStatus.AWAITING_PAYMENT,
      });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });
  });

  /* ─────────────────────────────────── submitBurn ─────────────────────────────────── */

  describe('submitBurn', () => {
    const fundedRow: CardRedemption = {
      ...baseRow,
      status: RedemptionStatus.FUNDED,
      outboundShipmentId: 'ship-1',
      refundSafe: false,
    };
    const SIGNED = ['SIGNED_BURN_TX'];
    const SIGNED_DELIST = ['SIGNED_DELIST_TX'];
    /** Respons burn REAL: HTTP 200 + ARRAY TELANJANG, `error: null` = leg itu mendarat. */
    const burnOk = [
      { error: null, transactionId: 'TX1', transactionUrl: 'https://x/TX1' },
    ];

    it('rejects when the row is not FUNDED and never calls CC burn', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        status: RedemptionStatus.READY_TO_FUND,
      });

      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    });

    it('happy path: claims FUNDED->BURN_SUBMITTED, posts BOTH arrays, stores the landed transactionId', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue(burnOk);

      const res = await service.submitBurn(
        REDEMPTION_ID,
        user,
        CC_TOKEN,
        SIGNED,
        SIGNED_DELIST,
      );

      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDED },
        data: { status: RedemptionStatus.BURN_SUBMITTED },
      });
      // KONTRAK: dua array TERPISAH — digabung = 403 "not the complete set this server issued".
      expect(client.burn).toHaveBeenCalledWith(CC_TOKEN, 'ship-1', {
        transactions: SIGNED,
        delistTransactions: SIGNED_DELIST,
      });
      // burnSignature = transactionId leg yang mendarat (respons burn tidak punya `signature`).
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: { burnSignature: 'TX1', refundSafe: false },
      });
      expect(res).toEqual({
        status: RedemptionStatus.BURN_SUBMITTED,
        burnSignature: 'TX1',
      });
    });

    it('sends an EMPTY delist array when prepare returned none (never merged into transactions)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue(burnOk);

      await service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED);

      expect(client.burn).toHaveBeenCalledWith(CC_TOKEN, 'ship-1', {
        transactions: SIGNED,
        delistTransactions: [],
      });
    });

    // INTI KONTRAK BARU: HTTP 200 BUKAN bukti sukses. Satu elemen dengan `error` non-null = leg itu
    // tidak mendarat → kegagalan PASCA-danai (USDC sudah di wallet user): refundSafe=false, status
    // TETAP BURN_SUBMITTED, ShippingPostFundError, dan JANGAN refund.
    it('200 with a non-null error on ANY element is a post-fund failure (no refund, no walk-back)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue([
        { error: 'Transaction simulation failed', transactionId: null },
        { error: null, transactionId: 'TX2' },
      ]);

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED, SIGNED_DELIST)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingPostFundError);
      expect((err as ShippingPostFundError).redemptionId).toBe(REDEMPTION_ID);
      expect((err as Error).message).toContain('Transaction simulation failed');
      expect(refundSafeSetFalse()).toBe(true);
      // Status TIDAK ditulis ulang (klaim FUNDED->BURN_SUBMITTED tetap berlaku, tak ada walk-back).
      expect(
        updateArgs()
          .map((a) => a.data.status)
          .filter((s) => s !== undefined),
      ).toEqual([]);
      // burnSignature TIDAK pernah disimpan untuk burn yang gagal.
      expect(
        updateArgs().some((a) => a.data.burnSignature !== undefined),
      ).toBe(false);
    });

    // "Duplicate transaction result" = leg yang SUDAH tercatat (body identik dikirim ulang).
    // Dokumen CC eksplisit: JANGAN dibaca sebagai kegagalan.
    it('treats "Duplicate transaction result" as SUCCESS (safe re-post), not a failure', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue([
        { error: 'Duplicate transaction result', transactionId: 'TX1' },
        { error: null, transactionId: 'TX3' },
      ]);

      const res = await service.submitBurn(
        REDEMPTION_ID,
        user,
        CC_TOKEN,
        SIGNED,
        SIGNED_DELIST,
      );

      expect(res.status).toBe(RedemptionStatus.BURN_SUBMITTED);
      expect(res.burnSignature).toBe('TX1');
    });

    // Bentuk respons yang tidak dikenal itu AMBIGU, dan jalur ini sudah PASCA-danai → wajib
    // memicu penyelesaian manual, bukan diam-diam dianggap sukses.
    it('treats an EMPTY array or a non-array 200 body as a post-fund failure', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);

      client.burn.mockResolvedValue([]);
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      client.burn.mockResolvedValue({ signature: 'not-an-array' });
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);
      expect(refundSafeSetFalse()).toBe(true);
    });

    // client.burn throw = INDETERMINATE PASCA-danai: status SUDAH BURN_SUBMITTED (dari klaim),
    // refundSafe=false, ShippingPostFundError; TIDAK di-walk-back, TIDAK refund.
    it('CC burn throws: stays BURN_SUBMITTED, refundSafe=false, ShippingPostFundError, no walk-back', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(new Error('cc 500'));

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingPostFundError);
      expect((err as ShippingPostFundError).redemptionId).toBe(REDEMPTION_ID);
      // Klaim FUNDED->BURN_SUBMITTED tetap berlaku (tidak dibatalkan).
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDED },
        data: { status: RedemptionStatus.BURN_SUBMITTED },
      });
      // Update kegagalan hanya menulis refundSafe=false + note; TIDAK menyentuh status.
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: expect.objectContaining({ refundSafe: false }) as unknown,
      });
      const statusesWritten = updateArgs()
        .map((a) => a.data.status)
        .filter((s) => s !== undefined);
      expect(statusesWritten).toEqual([]);
    });

    it('double-submit on a BURN_SUBMITTED row is rejected (burn is not idempotent)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...fundedRow,
        status: RedemptionStatus.BURN_SUBMITTED,
      });

      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
    });

    it('a concurrent submit that loses the atomic claim (count 0) never calls CC burn', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
    });

    // B4 — tulisan SUKSES pasca-CC dulu SATU-SATUNYA tulisan di jalur pasca-danai yang tidak
    // dibungkus try/catch. Blip DB di sana melempar SETELAH burn-nya berhasil: user melihat layar
    // terminal "butuh manusia" untuk pengiriman yang sebenarnya sukses, dan signature-nya hilang.
    it('B4: a DB blip on the post-burn SUCCESS write still reports success (and never loses the signature)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue([
        { error: null, transactionId: 'SIG_BURN', transactionUrl: 'https://x' },
      ]);
      prisma.cardRedemption.update.mockRejectedValue(new Error('db blip'));

      const res = await service.submitBurn(
        REDEMPTION_ID,
        user,
        CC_TOKEN,
        SIGNED,
      );

      expect(res).toEqual({
        status: RedemptionStatus.BURN_SUBMITTED,
        burnSignature: 'SIG_BURN',
      });
      // Klaim atomiknya sendiri tetap yang memindahkan status; tulisan yang gagal cuma jejak.
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDED },
        data: { status: RedemptionStatus.BURN_SUBMITTED },
      });
    });

    it('rejects empty signedTransactions before any lookup', async () => {
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, []),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
    });

    /* ── FIX B: hanya `error === null` (plus literal duplikat) yang berarti leg MENDARAT ──
       Dokumen: "a 200 with a non-null error on any element means that leg did not land." Kunci
       `error` yang HILANG dan string KOSONG itu AMBIGU — dan ini keputusan PASCA-danai, jadi
       ambiguitas WAJIB dibaca sebagai kegagalan, bukan diam-diam dianggap mendarat. */
    it('treats an EMPTY-STRING error and a MISSING error key as FAILED legs (fail-closed)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);

      // '' (string kosong) — dulu dihitung "mendarat".
      client.burn.mockResolvedValue([{ error: '', transactionId: 'TX1' }]);
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // kunci `error` HILANG sama sekali — dulu dihitung "mendarat".
      client.burn.mockResolvedValue([{ transactionId: 'TX1' }]);
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // `error: undefined` eksplisit — sama saja: bukan null, jadi GAGAL.
      client.burn.mockResolvedValue([
        { error: undefined, transactionId: 'TX1' },
      ]);
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // Tidak satu pun dari ketiganya boleh menyimpan burnSignature "sukses".
      expect(updateArgs().some((a) => a.data.burnSignature !== undefined)).toBe(
        false,
      );
      expect(refundSafeSetFalse()).toBe(true);
    });

    /* ── FIX A: DUA kegagalan yang DOKUMEN CC jamin "nothing was burned" ──────────────────
       403 "Transaction was not issued by this server" (batch 15 menit kedaluwarsa) dan 409 yang
       membawa `delistErrors`. Keduanya: klaim DILEPAS balik ke FUNDED (bisa diulang lewat
       re-prepare), refundSafe TETAP false, dan errornya BUKAN ShippingPostFundError. */

    /** Pesan error PERSIS seperti yang dibentuk CcShippingClient.toHttpException. */
    const ccBurnError = (status: number, remote: string): Error =>
      status === 409
        ? new ConflictException(
            `CollectorCrypt Shipping POST /blockchain/ship-1/burn gagal (HTTP 409): ${remote}`,
          )
        : // Klien memetakan 403 CC ke UnauthorizedException (HTTP 401!) — itulah kenapa
          // pencocokan dilakukan atas TEKS pesan, bukan kelas/status exception-nya.
          new UnauthorizedException(
            `CollectorCrypt Shipping POST /blockchain/ship-1/burn gagal (HTTP ${status}): ${remote}`,
          );

    /** Panggilan updateMany yang MELEPAS klaim (BURN_SUBMITTED -> FUNDED). */
    const releaseCalls = (): Array<{
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }> =>
      (
        prisma.cardRedemption.updateMany.mock.calls as Array<
          [{ where: Record<string, unknown>; data: Record<string, unknown> }]
        >
      )
        .map((c) => c[0])
        .filter((a) => a.data.status === RedemptionStatus.FUNDED);

    /**
     * Error yang dilempar KLIEN ASLI (CcShippingClient) untuk sebuah status + body MENTAH.
     *
     * Kenapa harus lewat klien asli: cabang 409 "nothing burned" memutuskan lewat SINYAL
     * TERSTRUKTUR yang DILAMPIRKAN klien ke exception, bukan lewat prosa. Test yang menyuapkan
     * JSON mentah sebagai pesan (pola lama) cuma menguji ASUMSINYA sendiri dan akan tetap hijau
     * walau seam client->service putus. Di sini fetch dipalsukan, klien ASLI dipanggil, lalu
     * exception yang BENAR-BENAR ia lempar dioper ke mock burn milik service.
     */
    const realClientBurnError = async (
      status: number,
      rawBody: string,
    ): Promise<unknown> => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          CcShippingClient,
          {
            provide: ConfigService,
            useValue: {
              get: (k: string) =>
                k === 'COLLECTORCRYPT_SHIPPING_BASE_URL'
                  ? 'https://dev-api.collectorcrypt.com'
                  : k === 'COLLECTORCRYPT_SHIPPING_USER_AGENT'
                    ? 'hoshi-test-ua'
                    : undefined,
            },
          },
        ],
      }).compile();
      const realClient = moduleRef.get(CcShippingClient);

      const savedFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status,
        text: () => Promise.resolve(rawBody),
      });

      let thrown: unknown;
      try {
        await realClient.burn(CC_TOKEN, 'ship-1', {
          transactions: SIGNED,
          delistTransactions: SIGNED_DELIST,
        });
      } catch (e: unknown) {
        thrown = e;
      } finally {
        global.fetch = savedFetch;
      }
      if (thrown === undefined) {
        throw new Error(
          `KLIEN ASLI tidak melempar untuk HTTP ${status} — fixture test salah.`,
        );
      }
      return thrown;
    };

    it('403 "Transaction was not issued by this server": releases the claim back to FUNDED and is RETRYABLE (not post-fund)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(
        ccBurnError(403, 'Transaction was not issued by this server'),
      );

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED, SIGNED_DELIST)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingBurnRetryableError);
      expect(err).not.toBeInstanceOf(ShippingPostFundError);
      expect((err as ShippingBurnRetryableError).redemptionId).toBe(
        REDEMPTION_ID,
      );
      // Klaim dilepas BERPAGAR status, refundSafe TETAP false, catatan jelas.
      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0]).toEqual({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.BURN_SUBMITTED },
        data: {
          status: RedemptionStatus.FUNDED,
          refundSafe: false,
          note: expect.stringContaining(
            'Transaction was not issued by this server',
          ) as unknown,
        },
      });
      // Tidak ada tulisan PASCA-danai lain (markBurnPostFundFailure TIDAK dipakai di jalur ini).
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
    });

    /* Ketiga test 409 di bawah menembak lewat KLIEN ASLI (realClientBurnError), bukan pesan
       karangan — karena persis di seam itulah bug-nya dulu bersembunyi: nama kunci
       `delistErrors` TIDAK selamat di pesan bentukan klien. */

    it('409 Nest-shaped with delistErrors (real client): releases the claim back to FUNDED and is RETRYABLE', async () => {
      // Bentuk Nest ASLI: `delistErrors` adalah kunci SAUDARA dari `message` — klien memilih
      // `message` untuk prosa, jadi nama kuncinya TIDAK PERNAH muncul di err.message.
      const ccError = await realClientBurnError(
        409,
        JSON.stringify({
          statusCode: 409,
          message: 'De-list failed',
          error: 'Conflict',
          delistErrors: [
            { nftAddress: 'NftAddrBase58', error: 'listing not found' },
          ],
        }),
      );

      // Bukti bahwa pencocokan prosa yang lama TIDAK MUNGKIN kena di body realistis ini.
      expect((ccError as Error).message).not.toContain('delistErrors');
      expect((ccError as Error).message).toContain('(HTTP 409)');

      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(ccError);

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED, SIGNED_DELIST)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingBurnRetryableError);
      expect(err).not.toBeInstanceOf(ShippingPostFundError);
      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0]).toEqual({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.BURN_SUBMITTED },
        data: {
          status: RedemptionStatus.FUNDED,
          refundSafe: false,
          note: expect.stringContaining('delistErrors') as unknown,
        },
      });
      // Jalur ini BUKAN pasca-danai: tidak ada tulisan markBurnPostFundFailure.
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
    });

    it('409 where delistErrors sits PAST the 300-char message truncation (real client): still releases to FUNDED', async () => {
      // Tanpa message/error/details, klien jatuh ke teks MENTAH yang dipotong 300 char —
      // dan `delistErrors` ada jauh di belakang titik potong itu.
      const padding = 'x'.repeat(400);
      const rawBody = JSON.stringify({
        statusCode: 409,
        reason: padding,
        delistErrors: [
          { nftAddress: 'NftAddrBase58', error: 'listing not found' },
        ],
      });
      const ccError = await realClientBurnError(409, rawBody);

      // Kuncinya memang ada di body mentah, tapi HILANG dari pesan karena pemotongan.
      expect(rawBody).toContain('delistErrors');
      expect((ccError as Error).message).not.toContain('delistErrors');

      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(ccError);

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED, SIGNED_DELIST)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingBurnRetryableError);
      expect(err).not.toBeInstanceOf(ShippingPostFundError);
      expect(releaseCalls()).toHaveLength(1);
      expect(releaseCalls()[0].data).toEqual({
        status: RedemptionStatus.FUNDED,
        refundSafe: false,
        note: expect.stringContaining('delistErrors') as unknown,
      });
    });

    it('409 WITHOUT a delistErrors key (real client) stays INDETERMINATE — no release, no refund', async () => {
      const ccError = await realClientBurnError(
        409,
        JSON.stringify({
          statusCode: 409,
          message: 'shipment ship-1 is awaiting card payment confirmation',
          error: 'Conflict',
        }),
      );

      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(ccError);

      await expect(
        service.submitBurn(
          REDEMPTION_ID,
          user,
          CC_TOKEN,
          SIGNED,
          SIGNED_DELIST,
        ),
      ).rejects.toBeInstanceOf(ShippingPostFundError);
      expect(releaseCalls()).toHaveLength(0);
    });

    it('FAIL-CLOSED: a 409 whose delistErrors is only PROSE (non-JSON body) or is EMPTY stays INDETERMINATE', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);

      // (i) Body BUKAN JSON tapi kebetulan menyebut kata "delistErrors" — tidak terverifikasi.
      client.burn.mockRejectedValue(
        await realClientBurnError(
          409,
          'Conflict: delistErrors encountered while de-listing',
        ),
      );
      await expect(
        service.submitBurn(
          REDEMPTION_ID,
          user,
          CC_TOKEN,
          SIGNED,
          SIGNED_DELIST,
        ),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // (ii) Kunci ADA tapi KOSONG — tidak membuktikan leg de-list gagal.
      client.burn.mockRejectedValue(
        await realClientBurnError(
          409,
          JSON.stringify({ statusCode: 409, delistErrors: [] }),
        ),
      );
      await expect(
        service.submitBurn(
          REDEMPTION_ID,
          user,
          CC_TOKEN,
          SIGNED,
          SIGNED_DELIST,
        ),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // (iii) Kunci ADA tapi null.
      client.burn.mockRejectedValue(
        await realClientBurnError(
          409,
          JSON.stringify({ statusCode: 409, delistErrors: null }),
        ),
      );
      await expect(
        service.submitBurn(
          REDEMPTION_ID,
          user,
          CC_TOKEN,
          SIGNED,
          SIGNED_DELIST,
        ),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // Tidak satu pun melepas klaim balik ke FUNDED.
      expect(releaseCalls()).toHaveLength(0);
    });

    it('an UNRELATED 403, a 409 without delistErrors, and a network failure ALL stay indeterminate (no release)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);

      // 403 lain — bukan salah satu dari dua pesan terdokumentasi.
      client.burn.mockRejectedValue(
        ccBurnError(
          403,
          'The transactions submitted are not the complete set this server issued',
        ),
      );
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // 409 yang BUKAN delistErrors.
      client.burn.mockRejectedValue(
        ccBurnError(
          409,
          'shipment ship-1 is awaiting card payment confirmation',
        ),
      );
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // Jaringan/timeout — tak ada bukti apa pun.
      client.burn.mockRejectedValue(
        new ServiceUnavailableException(
          'CollectorCrypt Shipping POST /blockchain/ship-1/burn tidak dapat dihubungi (timeout 20000ms).',
        ),
      );
      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED),
      ).rejects.toBeInstanceOf(ShippingPostFundError);

      // TIDAK pernah dilepas balik ke FUNDED: status tetap BURN_SUBMITTED, refundSafe=false.
      expect(releaseCalls()).toEqual([]);
      expect(refundSafeSetFalse()).toBe(true);
      expect(
        updateArgs()
          .map((a) => a.data.status)
          .filter((s) => s !== undefined),
      ).toEqual([]);
    });
  });

  /* ═════════════════ B2 — TOLAK BATCH BASI SEBELUM klaim & sebelum CC ═════════════════
     Balapan yang dicegah: dua modal (dua tab / HP + desktop) sama-sama memanggil /re-prepare, CC
     mengembalikan outboundShipmentId yang SAMA dengan transaksi BARU, lalu user menyetujui prompt
     wallet yang LEBIH TUA duluan. CC menjawab 403 "not the complete set this server issued" — 403
     yang TIDAK punya jaminan "nothing was burned", jadi barisnya nyangkut di BURN_SUBMITTED.
     Dicegah lokal: baris TIDAK PERNAH keluar dari FUNDED, klaim tidak terpakai, CC tak dipanggil. */

  describe('submitBurn — stale transaction set (B2)', () => {
    // Fixture wire-format Solana NYATA (dihasilkan @solana/web3.js): pasangan unsigned/signed dari
    // transaksi yang SAMA, plus transaksi LAIN sebagai "batch yang lebih baru".
    const OLD_UNSIGNED =
      'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAA' +
      'ED8u5lPq4RYmFW4/MVn92fSnD1X6WLiRStYiyN5HrS2nkOSc5CZUj5tO6HNMGoDIWfVTEZhsKU8DMNhYMtW7l8NQAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQ' +
      'wCAAAAAQAAAAAAAAA=';
    const OLD_SIGNED =
      'ATI/rw6zzk7JGxD/3exHVlpPgk9xgX99VT5d06n++AKBEHhKJFn42vhJRJzUH/w4QdhnW4pGhbd0asPbpBXyqgoBAA' +
      'ED8u5lPq4RYmFW4/MVn92fSnD1X6WLiRStYiyN5HrS2nkOSc5CZUj5tO6HNMGoDIWfVTEZhsKU8DMNhYMtW7l8NQAA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAgIAAQ' +
      'wCAAAAAQAAAAAAAAA=';
    const NEW_SIGNED =
      'AX1aJe516eWNs740MgWfiGSEvDvZwQuJeIdAe5UKw04qmwnajRo/Gda7Cwwj/gIXtP7pfHLL7oA276cseNsrXwOAAQ' +
      'ABA/LuZT6uEWJhVuPzFZ/dn0pw9V+li4kUrWIsjeR60tp5DknOQmVI+bTuhzTBqAyFn1UxGYbClPAzDYWDLVu5fDUA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAA' +
      'EMAgAAAAEAAAAAAAAAAA==';
    const NEW_UNSIGNED =
      'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQ' +
      'ABA/LuZT6uEWJhVuPzFZ/dn0pw9V+li4kUrWIsjeR60tp5DknOQmVI+bTuhzTBqAyFn1UxGYbClPAzDYWDLVu5fDUA' +
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQICAA' +
      'EMAgAAAAEAAAAAAAAAAA==';

    /** Identitas set yang TERSIMPAN = set "baru" (hasil re-prepare terakhir). */
    const currentHash = burnTxSetIdentity({
      outboundShipmentId: 'ship-1',
      transactions: [NEW_UNSIGNED],
      delistTransactions: [],
    });

    const fundedRow = (burnTxSetHash: string | null): CardRedemption => ({
      ...baseRow,
      status: RedemptionStatus.FUNDED,
      outboundShipmentId: 'ship-1',
      refundSafe: false,
      burnTxSetHash,
    });

    it('rejects the OLDER batch BEFORE the atomic claim: no CC call, status untouched, retryable code', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow(currentHash));

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, [OLD_SIGNED])
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingBurnRetryableError);
      const body = (err as ShippingBurnRetryableError).getResponse() as Record<
        string,
        unknown
      >;
      expect((err as ShippingBurnRetryableError).getStatus()).toBe(409);
      expect(body.code).toBe('SHIPPING_BURN_STALE_SESSION');
      // Barisnya TERBUKTI masih FUNDED → boleh tanda tangan lagi.
      expect(body.stage).toBe('FUNDED');
      expect(body.retryable).toBe(true);
      expect(body.redemptionId).toBe(REDEMPTION_ID);

      // Inti B2: CC TIDAK PERNAH dipanggil, klaim TIDAK diambil, refundSafe TIDAK disentuh.
      expect(client.burn).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
    });

    it('accepts the CURRENT batch (signed copy of the stored set) and proceeds to claim + CC', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow(currentHash));
      client.burn.mockResolvedValue([{ error: null, transactionId: 'TX1' }]);

      const res = await service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, [
        NEW_SIGNED,
      ]);

      expect(res.status).toBe(RedemptionStatus.BURN_SUBMITTED);
      expect(client.burn).toHaveBeenCalledWith(CC_TOKEN, 'ship-1', {
        transactions: [NEW_SIGNED],
        delistTransactions: [],
      });
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDED },
        data: { status: RedemptionStatus.BURN_SUBMITTED },
      });
    });

    it('a LEGACY row (no stored identity) is unaffected — the check is skipped entirely', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow(null));
      client.burn.mockResolvedValue([{ error: null, transactionId: 'TX1' }]);

      // Set yang TIDAK cocok dengan apa pun — tanpa identitas tersimpan, tetap diteruskan ke CC,
      // persis perilaku sebelum B2 ada (CC yang menilai).
      const res = await service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, [
        OLD_SIGNED,
      ]);

      expect(res.status).toBe(RedemptionStatus.BURN_SUBMITTED);
      expect(client.burn).toHaveBeenCalled();
    });

    it('degrades to today’s behaviour when the submitted set cannot be canonicalised (never a false "stale")', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow(currentHash));
      client.burn.mockResolvedValue([{ error: null, transactionId: 'TX1' }]);

      // Blob sintetis (mis. server mock CC) → tidak bisa dikanonikalisasi → pemeriksaan DILEWATI.
      const res = await service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, [
        'NOT_A_SOLANA_TX',
      ]);

      expect(res.status).toBe(RedemptionStatus.BURN_SUBMITTED);
      expect(client.burn).toHaveBeenCalled();
    });

    it('the delist group counts too: same burn legs but a stale delist leg is still rejected pre-claim', async () => {
      const hashWithDelist = burnTxSetIdentity({
        outboundShipmentId: 'ship-1',
        transactions: [NEW_UNSIGNED],
        delistTransactions: [NEW_UNSIGNED],
      });
      prisma.cardRedemption.findUnique.mockResolvedValue(
        fundedRow(hashWithDelist),
      );

      await expect(
        service.submitBurn(
          REDEMPTION_ID,
          user,
          CC_TOKEN,
          [NEW_SIGNED],
          [OLD_SIGNED],
        ),
      ).rejects.toBeInstanceOf(ShippingBurnRetryableError);
      expect(client.burn).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    });

    it('fundAndPrepare and reprepareBurn both persist the identity of the set they just issued', async () => {
      // fundAndPrepare
      prisma.cardRedemption.findUnique.mockResolvedValue(baseRow);
      client.prepare.mockResolvedValue({
        outboundShipmentId: 'ship-1',
        transactions: [OLD_UNSIGNED],
        delistTransactions: [],
        totalCost: 25,
      });
      await service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN);
      const oldHash = burnTxSetIdentity({
        outboundShipmentId: 'ship-1',
        transactions: [OLD_UNSIGNED],
        delistTransactions: [],
      });
      // B4: identitasnya ditulis DI DALAM klaim atomik READY_TO_FUND -> FUNDING, bukan lewat
      // update() tanpa predikat sebelum klaim. Lihat test B4 khusus di bawah untuk alasannya.
      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.READY_TO_FUND },
        data: {
          status: RedemptionStatus.FUNDING,
          outboundShipmentId: 'ship-1',
          totalCostUsdc: 25_000_000,
          burnTxSetHash: oldHash,
        },
      });

      // reprepareBurn: set BARU menggantikan yang lama → yang lama otomatis jadi basi.
      jest.clearAllMocks();
      prisma.cardRedemption.update.mockResolvedValue(undefined);
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow(oldHash));
      client.prepare.mockResolvedValue({
        outboundShipmentId: 'ship-1',
        transactions: [NEW_UNSIGNED],
        delistTransactions: [],
        totalCost: 25,
      });
      await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: { burnTxSetHash: currentHash },
      });
      expect(currentHash).not.toBe(oldHash);
    });
  });

  /* ═════════════ B1 — KONTRAK ERROR: status + code + stage per cabang ═════════════
     Yang diuji: setiap cabang kegagalan membawa `code` STABIL, dan `stage`/`retryable` TIDAK
     PERNAH melebih-lebihkan keamanan — "FUNDED" (silakan tanda tangan lagi) hanya terbit di tempat
     yang benar-benar membuktikan barisnya duduk di FUNDED. */

  describe('shipping error contract (B1)', () => {
    const fundedRow: CardRedemption = {
      ...baseRow,
      status: RedemptionStatus.FUNDED,
      outboundShipmentId: 'ship-1',
      refundSafe: false,
    };
    const SIGNED = ['SIGNED_BURN_TX'];

    const contract = (
      err: unknown,
    ): { status: number; body: Record<string, unknown> } => {
      expect(err).toBeInstanceOf(HttpException);
      const e = err as HttpException;
      return {
        status: e.getStatus(),
        body: e.getResponse() as Record<string, unknown>,
      };
    };

    it('RETRYABLE branch: 409 + SHIPPING_BURN_RETRYABLE + stage FUNDED, only after the release is CONFIRMED', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(
        new Error(
          'CollectorCrypt Shipping POST /blockchain/ship-1/burn gagal (HTTP 403): ' +
            'Transaction was not issued by this server',
        ),
      );
      // updateMany: klaim FUNDED->BURN_SUBMITTED (count 1), lalu pelepasan balik (count 1).
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 1 });

      const { status, body } = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(409);
      expect(body.code).toBe('SHIPPING_BURN_RETRYABLE');
      expect(body.stage).toBe('FUNDED');
      expect(body.retryable).toBe(true);
      expect(body.redemptionId).toBe(REDEMPTION_ID);
    });

    it('a "nothing was burned" failure whose RELEASE FAILS is NOT reported as retryable', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(
        new Error(
          'CollectorCrypt Shipping POST /blockchain/ship-1/burn gagal (HTTP 403): ' +
            'Transaction was not issued by this server',
        ),
      );
      // Klaim menang (count 1), tapi pelepasan balik ke FUNDED GAGAL (count 0).
      prisma.cardRedemption.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingPostFundError);
      const { status, body } = contract(err);
      expect(status).toBe(422);
      expect(body.code).toBe('SHIPPING_BURN_RELEASE_FAILED');
      // Barisnya TIDAK terbukti kembali ke FUNDED → tidak boleh mengaku retryable.
      expect(body.stage).toBe('UNKNOWN');
      expect(body.retryable).toBe(false);
      expect(body.redemptionId).toBe(REDEMPTION_ID);
    });

    it('POST-FUND INDETERMINATE branch: 422 (NOT 500, NOT 409) + code + redemptionId + retryable=false', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(new Error('network down'));

      const err = await service
        .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ShippingPostFundError);
      const { status, body } = contract(err);
      expect(status).toBe(422);
      expect(status).not.toBe(500);
      expect(body.code).toBe('SHIPPING_POST_FUND_INDETERMINATE');
      expect(body.stage).toBe('POST_FUND');
      expect(body.retryable).toBe(false);
      expect(body.redemptionId).toBe(REDEMPTION_ID);
    });

    it('POST-FUND LEG FAILURE branch: 422 + SHIPPING_BURN_LEG_FAILED (200 with a failed leg)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue([
        { error: 'leg did not land', transactionId: null },
      ]);

      const { status, body } = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(422);
      expect(body.code).toBe('SHIPPING_BURN_LEG_FAILED');
      expect(body.stage).toBe('POST_FUND');
      expect(body.retryable).toBe(false);
    });

    it('fundUsdc INDETERMINATE also lands on the 422 post-fund contract', async () => {
      armFundHappy();
      treasury.fundUsdc.mockRejectedValue(
        new TreasuryFundIndeterminateError('confirm timeout', 'SIG', user.walletAddress),
      );

      const { status, body } = contract(
        await service
          .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(422);
      expect(body.code).toBe('SHIPPING_POST_FUND_INDETERMINATE');
      expect(body.stage).toBe('POST_FUND');
      expect(body.retryable).toBe(false);
    });

    it('PRE-FUND branch: slippage over the ceiling is 400 + stage PRE_FUND (refund is genuinely safe)', async () => {
      armFundHappy();
      prisma.paymentOrder.findUnique.mockResolvedValue({ priceUsdc: 1_000_000 });

      const { status, body } = contract(
        await service
          .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(400);
      expect(body.code).toBe('SHIPPING_COST_EXCEEDS_PAID');
      expect(body.stage).toBe('PRE_FUND');
      expect(body.retryable).toBe(true);
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('PRE-FUND branch: a treasury failure BEFORE broadcast keeps its status but gains a code, and never escapes as a bare 500', async () => {
      armFundHappy();
      // Error TELANJANG (bukan HttpException) — dulu ini keluar sebagai 500 tanpa kode.
      treasury.fundUsdc.mockRejectedValue(new Error('rpc exploded'));

      const { status, body } = contract(
        await service
          .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(503);
      expect(body.code).toBe('SHIPPING_FUND_FAILED_PRE_BROADCAST');
      expect(body.stage).toBe('PRE_FUND');
      // Detail internal tidak bocor ke user.
      expect(String(body.message)).not.toContain('rpc exploded');
      // Klaim dilepas balik → refundSafe tidak pernah diset false.
      expect(refundSafeSetFalse()).toBe(false);
    });

    it('a concurrent claim loss NEVER claims safety: stage UNKNOWN, retryable=false', async () => {
      // fundAndPrepare kalah klaim.
      armFundHappy();
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });
      const fund = contract(
        await service
          .fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );
      expect(fund.body.code).toBe('SHIPPING_FUNDING_IN_PROGRESS');
      expect(fund.body.stage).toBe('UNKNOWN');
      expect(fund.body.retryable).toBe(false);

      // submitBurn kalah klaim.
      jest.clearAllMocks();
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });
      const burn = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );
      expect(burn.body.code).toBe('SHIPPING_BURN_ALREADY_SUBMITTED');
      expect(burn.body.stage).toBe('UNKNOWN');
      expect(burn.body.retryable).toBe(false);
      expect(client.burn).not.toHaveBeenCalled();
    });

    it('NO_EFFECT branches keep their original HTTP status and class, and add a code', async () => {
      // 404 / 403 kepemilikan.
      prisma.cardRedemption.findUnique.mockResolvedValue(null);
      const notFound = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );
      expect(notFound.status).toBe(404);
      expect(notFound.body.code).toBe('REDEMPTION_NOT_FOUND');
      expect(notFound.body.stage).toBe('NO_EFFECT');

      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...fundedRow,
        userId: 'someone-else',
      });
      const forbidden = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );
      expect(forbidden.status).toBe(403);
      expect(forbidden.body.code).toBe('REDEMPTION_NOT_YOURS');

      // 400 input kosong.
      const empty = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, [])
          .catch((e: unknown) => e),
      );
      expect(empty.status).toBe(400);
      expect(empty.body.code).toBe('SHIPPING_NO_SIGNED_TRANSACTIONS');

      // 503 gerbang fitur.
      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'false';
      const off = contract(
        await service
          .submitBurn(REDEMPTION_ID, user, CC_TOKEN, SIGNED)
          .catch((e: unknown) => e),
      );
      expect(off.status).toBe(503);
      expect(off.body.code).toBe('SHIPPING_DISABLED');
      expect(off.body.stage).toBe('NO_EFFECT');
    });

    // B3 — ongkir CC yang melewati plafon TIDAK BOLEH mengaku retryable. `stage: FUNDED` berarti
    // "minta transaksi baru lalu tanda tangan lagi", dan UI merender tombol yang memanggil
    // re-prepare — yang menjalankan ULANG guard yang sama terhadap totalCostUsdc yang sama dan
    // gagal identik: LOOP TAK BERUJUNG, dan dulu tiap putaran menerbitkan batch CC baru yang
    // menggantikan set yang sudah ditandatangani user. Vonis jujurnya: butuh manusia.
    it('a cost over the funded ceiling is NOT retryable: stage POST_FUND, retryable=false, no refund implied', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...fundedRow,
        totalCostUsdc: FUNDED_COST_USDC,
      });
      // Ongkir baru jauh di atas plafon.
      client.prepare.mockResolvedValue({
        outboundShipmentId: 'ship-1',
        transactions: ['FRESH'],
        delistTransactions: [],
        totalCost: 100,
      });

      const { status, body } = contract(
        await service
          .reprepareBurn(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );

      expect(status).toBe(400);
      expect(body.code).toBe('SHIPPING_COST_EXCEEDS_FUNDED');
      expect(body.stage).toBe('POST_FUND');
      // retryable DITURUNKAN dari stage — tidak bisa diset manual, jadi ini yang menutup loopnya.
      expect(body.retryable).toBe(false);
      // Dan TIDAK menyiratkan refund: di FUNDED USDC sudah pindah ke wallet user.
      expect(body.stage).not.toBe('PRE_FUND');
      expect(body.message).toContain('BUKAN kasus refund');
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('never emits stage PRE_FUND from a POST-fund path (no "your money is refundable" on a funded row)', async () => {
      // Baris FUNDED yang belum sempat menyimpan totalCostUsdc jatuh ke guard berbasis order
      // Rupiah — plafon yang sama, TAPI stage-nya tidak boleh ikut jadi PRE_FUND.
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...fundedRow,
        totalCostUsdc: null,
      });
      prisma.paymentOrder.findUnique.mockResolvedValue({ priceUsdc: 1_000_000 });
      client.prepare.mockResolvedValue({
        outboundShipmentId: 'ship-1',
        transactions: ['FRESH'],
        delistTransactions: [],
        totalCost: 25,
      });

      const { body } = contract(
        await service
          .reprepareBurn(REDEMPTION_ID, user, CC_TOKEN)
          .catch((e: unknown) => e),
      );

      expect(body.code).toBe('SHIPPING_COST_EXCEEDS_PAID');
      // B3: bukan PRE_FUND (uangnya sudah pindah) DAN bukan FUNDED (tanda tangan ulang tidak
      // menurunkan harga CC) — vonisnya "butuh manusia".
      expect(body.stage).toBe('POST_FUND');
      expect(body.stage).not.toBe('PRE_FUND');
      expect(body.retryable).toBe(false);
    });
  });

  /* ───────────── reprepareBurn — pemulihan PASCA-danai TANPA memindahkan uang ─────────────
     Dokumen CC: "Calling prepare again with identical input returns the same shipment with fresh
     transactions. That is the correct recovery when a blockhash expires." Pagar kerasnya: HANYA
     status FUNDED, TIDAK PERNAH fundUsdc, dan guard biaya dijalankan ulang terhadap yang SUDAH
     didanai dengan plafon slippage yang SAMA. */

  describe('reprepareBurn', () => {
    const fundedRow: CardRedemption = {
      ...baseRow,
      status: RedemptionStatus.FUNDED,
      outboundShipmentId: 'ship-1',
      totalCostUsdc: FUNDED_COST_USDC,
      fundingSignature: 'FUNDSIG',
      refundSafe: false,
    };

    /** prepare ULANG: shipment SAMA, transaksi BARU, biaya sama. */
    const freshPrepare = {
      outboundShipmentId: 'ship-1',
      transactions: ['FRESH_BURN_TX'],
      delistTransactions: ['FRESH_DELIST_TX'],
      totalCost: 25,
    };

    it('re-issues transactions for a FUNDED row and NEVER calls fundUsdc', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.prepare.mockResolvedValue(freshPrepare);

      const res = await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);

      // PAGAR UTAMA: uang sudah pindah — jalur ini tidak boleh menyentuh treasury sama sekali.
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      // Input IDENTIK dengan fundAndPrepare = syarat CC mengembalikan shipment yang SAMA.
      expect(client.prepare).toHaveBeenCalledWith(CC_TOKEN, {
        nftAddresses: [baseRow.nftAddress],
        shippingAddressId: 'cc-addr-1',
        coin: 'USDC',
        deliveryCompany: 'ups',
        email: 'u@example.com',
      });
      expect(res).toEqual({
        transactions: ['FRESH_BURN_TX'],
        delistTransactions: ['FRESH_DELIST_TX'],
        outboundShipmentId: 'ship-1',
        fundedUsdc: FUNDED_COST_USDC,
        totalCostUsdc: FUNDED_COST_USDC,
      });
      // TIDAK ada klaim status, TIDAK ada perubahan refundSafe, TIDAK menimpa totalCostUsdc.
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      // B2: satu-satunya tulisan adalah identitas set transaksi BARU (menggantikan yang lama, jadi
      // set yang lebih tua otomatis jadi basi). freshPrepare bukan transaksi Solana asli → null.
      expect(prisma.cardRedemption.update).toHaveBeenCalledTimes(1);
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: { burnTxSetHash: null },
      });
    });

    it('refuses ANY status other than FUNDED, before touching CC or the treasury', async () => {
      for (const status of [
        RedemptionStatus.REQUESTED,
        RedemptionStatus.AWAITING_PAYMENT,
        RedemptionStatus.READY_TO_FUND,
        RedemptionStatus.FUNDING,
        RedemptionStatus.BURN_SUBMITTED,
        RedemptionStatus.IN_TRANSIT,
        RedemptionStatus.DELIVERED,
        RedemptionStatus.RECLAIM_DUE,
      ]) {
        prisma.cardRedemption.findUnique.mockResolvedValue({
          ...fundedRow,
          status,
        });
        await expect(
          service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a new cost ABOVE the same slippage ceiling and leaves the row FUNDED', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      // Sudah didanai 25_000_000 -> plafon +10% = 27_500_000. CC minta 30 USD = 30_000_000.
      client.prepare.mockResolvedValue({ ...freshPrepare, totalCost: 30 });

      await expect(
        service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      // STATUS/UANG baris DIBIARKAN apa adanya: tidak ada klaim, tidak ada refundSafe, tidak ada
      // totalCostUsdc yang tertimpa.
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      // B3 — TAPI identitas set transaksinya TETAP dipersist: begitu prepare kembali, CC SUDAH
      // menggantikan setnya. Membiarkan burnTxSetHash lama berarti set yang sudah basi di CC lolos
      // pemeriksaan LOKAL, lalu mengambil klaim FUNDED->BURN_SUBMITTED dan dijawab 403 oleh CC.
      expect(prisma.cardRedemption.update).toHaveBeenCalledTimes(1);
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: { burnTxSetHash: null },
      });
    });

    // B3 — PRA-CEK sebelum prepare. Dokumen CC: prepare ulang MENGGANTIKAN set transaksi yang
    // berlaku. Percobaan yang sudah pasti ditolak guard biaya karena itu tidak boleh sampai
    // memanggil prepare — kalau tidak, ia membatalkan batch yang mungkin baru saja ditandatangani
    // user di tab lain. /redeem/estimate aman untuk ini: ia tidak membuat shipment/transaksi.
    it('rejects an over-ceiling cost from /redeem/estimate BEFORE prepare is ever called', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      // estimate SUDAH di atas plafon (30 USD > 27,5) → tolak sebelum prepare.
      client.estimate.mockResolvedValue({ total: 30 });
      client.prepare.mockResolvedValue(freshPrepare);

      const err = await service
        .reprepareBurn(REDEMPTION_ID, user, CC_TOKEN)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      const body = (err as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;

      expect(body.code).toBe('SHIPPING_COST_EXCEEDS_FUNDED');
      expect(body.retryable).toBe(false);
      // INTI-nya: batch hidup milik user TIDAK pernah digantikan.
      expect(client.prepare).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('a FAILING /redeem/estimate never blocks the flow — the authoritative guard still runs', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.estimate.mockRejectedValue(new Error('CC estimate down'));
      client.prepare.mockResolvedValue(freshPrepare);

      // Pra-cek DILEWATI (best-effort), prepare tetap jalan, guard otoritatif tetap meloloskannya.
      const res = await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);
      expect(res.totalCostUsdc).toBe(FUNDED_COST_USDC);
      expect(client.prepare).toHaveBeenCalledTimes(1);

      // Dan saat harga OTORITATIF-nya yang melanggar, ia tetap ditolak walau pra-ceknya mati.
      jest.clearAllMocks();
      prisma.cardRedemption.update.mockResolvedValue(undefined);
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.estimate.mockRejectedValue(new Error('CC estimate down'));
      client.prepare.mockResolvedValue({ ...freshPrepare, totalCost: 30 });
      await expect(
        service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('accepts a cost INSIDE the ceiling without funding the difference', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      // 27 USD = 27_000_000 <= plafon 27_500_000.
      client.prepare.mockResolvedValue({ ...freshPrepare, totalCost: 27 });

      const res = await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      expect(res.fundedUsdc).toBe(FUNDED_COST_USDC);
      expect(res.totalCostUsdc).toBe(27_000_000);
    });

    it('is idempotent-safe: repeated calls never fund twice and never claim a status', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.prepare.mockResolvedValue(freshPrepare);

      await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);
      await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);
      await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);

      expect(treasury.fundUsdc).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(client.prepare).toHaveBeenCalledTimes(3);
    });

    it('persists a DIFFERENT outboundShipmentId if CC returns one (and nothing else)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.prepare.mockResolvedValue({
        ...freshPrepare,
        outboundShipmentId: 'ship-2',
      });

      await service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN);

      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        // "dan tidak ada yang lain": tidak ada status, tidak ada refundSafe, tidak ada
        // totalCostUsdc. burnTxSetHash ikut ditulis karena identitas set-nya memang berubah.
        data: { outboundShipmentId: 'ship-2', burnTxSetHash: null },
      });
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('refuses when the feature gate is off, and when the row belongs to someone else', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'false';
      await expect(
        service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'true';
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...fundedRow,
        userId: 'someone-else',
      });
      await expect(
        service.reprepareBurn(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });
  });

  /* ─────────────────────────────────── refreshStatus ─────────────────────────────────── */

  describe('refreshStatus', () => {
    const inFlightRow: CardRedemption = {
      ...baseRow,
      status: RedemptionStatus.BURN_SUBMITTED,
      outboundShipmentId: 'ship-1',
    };

    it('maps CC "Shipped" → IN_TRANSIT, persists tracking, and only touches in-flight rows', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce(inFlightRow)
        .mockResolvedValueOnce({
          ...inFlightRow,
          status: RedemptionStatus.IN_TRANSIT,
          trackingIds: ['T1'],
          trackingUrls: ['U1'],
        });
      client.getShipment.mockResolvedValue({
        status: 'Shipped',
        trackingIds: ['T1'],
        trackingUrls: ['U1'],
      });

      const res = await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: {
          id: REDEMPTION_ID,
          status: {
            in: [RedemptionStatus.BURN_SUBMITTED, RedemptionStatus.IN_TRANSIT],
          },
        },
        data: {
          trackingIds: ['T1'],
          trackingUrls: ['U1'],
          status: RedemptionStatus.IN_TRANSIT,
        },
      });
      expect(res.status).toBe(RedemptionStatus.IN_TRANSIT);
    });

    it('maps CC "Delivered" → DELIVERED', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce({ ...inFlightRow, status: RedemptionStatus.IN_TRANSIT })
        .mockResolvedValueOnce({ ...inFlightRow, status: RedemptionStatus.DELIVERED });
      client.getShipment.mockResolvedValue({ status: 'Delivered' });

      await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe(RedemptionStatus.DELIVERED);
    });

    // A CC status that maps to a NON-advancing state ("Processing" → BURN_SUBMITTED) must not write
    // a status at all — and the where-clause (only BURN_SUBMITTED/IN_TRANSIT) is what stops a flaky
    // CC from ever regressing a DELIVERED row.
    it('never regresses: a non-advancing CC status writes tracking only, no status downgrade', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce(inFlightRow)
        .mockResolvedValueOnce(inFlightRow);
      client.getShipment.mockResolvedValue({
        status: 'Processing',
        trackingIds: ['T1'],
      });

      await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        where: { status: { in: RedemptionStatus[] } };
        data: Record<string, unknown>;
      };
      // Tidak ada status yang ditulis (advanceTo undefined).
      expect(call.data).not.toHaveProperty('status');
      // Where-clause mengecualikan DELIVERED → status maju tak bisa dimundurkan.
      expect(call.where.status.in).toEqual([
        RedemptionStatus.BURN_SUBMITTED,
        RedemptionStatus.IN_TRANSIT,
      ]);
    });

    it('an unknown CC status is ignored (tracking still written, no status change)', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce(inFlightRow)
        .mockResolvedValueOnce(inFlightRow);
      client.getShipment.mockResolvedValue({ status: 'SomethingNew', trackingIds: [] });

      await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).not.toHaveProperty('status');
    });

    // Kontrak CC: GET /outbound-shipment/:id menjawab id TAK DIKENAL dengan 200 + body kosong
    // (bukan 404) → klien memetakannya ke null. Itu BUKAN alasan menulis apa pun.
    it('writes nothing when CC reports the shipment as not-found (empty 200 → null)', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(inFlightRow);
      client.getShipment.mockResolvedValue(null);

      const res = await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.update).not.toHaveBeenCalled();
      expect(res).toBe(inFlightRow);
    });

    it('maps CC "Cancelled" → SHIP_FAILED_POST_BURN', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce(inFlightRow)
        .mockResolvedValueOnce({
          ...inFlightRow,
          status: RedemptionStatus.SHIP_FAILED_POST_BURN,
        });
      client.getShipment.mockResolvedValue({ status: 'Cancelled' });

      await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe(RedemptionStatus.SHIP_FAILED_POST_BURN);
    });

    // "Pending" = diterima, belum bergerak → tracking ditulis, status TIDAK maju.
    it('maps CC "Pending" to a non-advancing state (tracking only)', async () => {
      prisma.cardRedemption.findUnique
        .mockResolvedValueOnce(inFlightRow)
        .mockResolvedValueOnce(inFlightRow);
      client.getShipment.mockResolvedValue({
        status: 'Pending',
        trackingIds: [],
        // Dokumen: SEMUA field biaya + numberOfCards berupa STRING — kita tidak boleh tersandung.
        numberOfCards: '1',
        totalCost: '5.99',
        shippingCost: '5.99',
      });

      await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).not.toHaveProperty('status');
    });

    it('returns the row unchanged and does not poll CC when there is no shipment yet', async () => {
      const noShipment = { ...baseRow, outboundShipmentId: null };
      prisma.cardRedemption.findUnique.mockResolvedValue(noShipment);

      const res = await service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN);

      expect(client.getShipment).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
      expect(res).toBe(noShipment);
    });
  });

  /* ─────────────────────────────── ownership + feature gate ─────────────────────────────── */

  describe('ownership', () => {
    it('throws NotFound for a redemption id that is not in the ledger', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(null);

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the redemption belongs to another user', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        userId: 'someone-else',
      });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });
  });

  describe('assertEnabled (feature gate)', () => {
    it('refuses every real path when HOSHI_CC_SHIPPING_ENABLED is off, before any lookup', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'false';

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('also gates submitBurn and refreshStatus when off', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = undefined;

      await expect(
        service.submitBurn(REDEMPTION_ID, user, CC_TOKEN, ['x']),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.refreshStatus(REDEMPTION_ID, user, CC_TOKEN),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  /* ─────────────────────────────── SIWS (Track B) ─────────────────────────────── */

  describe('SIWS', () => {
    const WALLET = user.walletAddress;

    beforeEach(() => {
      configFlags.COLLECTORCRYPT_PARTNER_APP_ID = 'hoshi-partner';
      configFlags.COLLECTORCRYPT_SIWS_DOMAIN = 'hoshimarket.xyz';
      configFlags.COLLECTORCRYPT_SIWS_URI = 'https://hoshimarket.xyz';
    });

    it('siwsNonce injects partnerAppId/domain/uri from config and relays the wallet', async () => {
      const res = await service.siwsNonce(WALLET);

      expect(client.siwsNonce).toHaveBeenCalledWith({
        wallet: WALLET,
        partnerAppId: 'hoshi-partner',
        domain: 'hoshimarket.xyz',
        uri: 'https://hoshimarket.xyz',
      });
      expect(res).toEqual({ nonce: 'NONCE', expiresAt: 123, message: 'SIWS MSG' });
    });

    it('siwsNonce returns 503 "SIWS not configured" and never calls CC when config is missing', async () => {
      configFlags.COLLECTORCRYPT_SIWS_DOMAIN = undefined;

      await expect(service.siwsNonce(WALLET)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(client.siwsNonce).not.toHaveBeenCalled();
    });

    // Kontrak CC: `domain` = hostname TELANJANG (tanpa skema/port/path) dan harus ada di allowlist
    // mereka. Config salah bentuk → gagal di sini, bukan sebagai 400 anonim dari CC.
    it('siwsNonce refuses a domain that carries a scheme/port and never calls CC', async () => {
      configFlags.COLLECTORCRYPT_SIWS_DOMAIN = 'https://hoshimarket.xyz';

      await expect(service.siwsNonce(WALLET)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(client.siwsNonce).not.toHaveBeenCalled();
    });

    it('siwsVerify relays message + signature as-is (no config needed)', async () => {
      const res = await service.siwsVerify('MSG', 'SIG');

      expect(client.siwsVerify).toHaveBeenCalledWith({
        message: 'MSG',
        signature: 'SIG',
      });
      expect(res.accessToken).toBe('cca_x');
    });

    it('siwsRefresh relays the refreshToken as-is', async () => {
      const res = await service.siwsRefresh('ccr_old');

      expect(client.siwsRefresh).toHaveBeenCalledWith({
        refreshToken: 'ccr_old',
      });
      expect(res.refreshToken).toBe('ccr_y');
    });

    it('all SIWS methods are gated by HOSHI_CC_SHIPPING_ENABLED (503 when off, no CC call)', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'false';

      await expect(service.siwsNonce(WALLET)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(service.siwsVerify('m', 's')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(service.siwsRefresh('r')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(client.siwsNonce).not.toHaveBeenCalled();
      expect(client.siwsVerify).not.toHaveBeenCalled();
      expect(client.siwsRefresh).not.toHaveBeenCalled();
    });
  });
});
