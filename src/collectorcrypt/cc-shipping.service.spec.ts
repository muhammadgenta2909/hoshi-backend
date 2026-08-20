import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RedemptionStatus } from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcShippingClient } from './cc-shipping.client';
import { CcShippingService, ShippingPostFundError } from './cc-shipping.service';
import {
  TreasuryFundIndeterminateError,
  TreasuryService,
} from './treasury.service';

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
  };
  let treasury: { fundUsdc: jest.Mock };

  const now = new Date('2026-08-20T00:00:00.000Z');

  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };

  const PRIVY = 'privy-identity-token';
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

  /* ─────────────────────── fundAndPrepare — matrix urutan keamanan uang ─────────────────────── */

  describe('fundAndPrepare', () => {
    // Langkah 3 (CC prepare) GAGAL = masih PRA-danai. Tidak boleh ada klaim FUNDING, tidak boleh
    // ada fund, refundSafe TETAP true (Rupiah aman di-refund).
    it('prepare throws (pre-fund): never funds, never claims FUNDING, refundSafe stays true', async () => {
      armFundHappy();
      client.prepare.mockRejectedValue(new ServiceUnavailableException('CC down'));

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
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
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
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
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
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
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
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
        .fundAndPrepare(REDEMPTION_ID, user, PRIVY)
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
        .fundAndPrepare(REDEMPTION_ID, user, PRIVY)
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

      const res = await service.fundAndPrepare(REDEMPTION_ID, user, PRIVY);

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

    it('refuses a redemption in the wrong status (not READY_TO_FUND) before touching CC or funds', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        status: RedemptionStatus.AWAITING_PAYMENT,
      });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
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

    it('rejects when the row is not FUNDED and never calls CC burn', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        status: RedemptionStatus.READY_TO_FUND,
      });

      await expect(
        service.submitBurn(REDEMPTION_ID, user, PRIVY, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
      expect(prisma.cardRedemption.updateMany).not.toHaveBeenCalled();
    });

    it('happy path: claims FUNDED->BURN_SUBMITTED, calls CC burn, stores signature + refundSafe=false', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockResolvedValue({ signature: 'BURNSIG', success: true });

      const res = await service.submitBurn(REDEMPTION_ID, user, PRIVY, SIGNED);

      expect(prisma.cardRedemption.updateMany).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID, status: RedemptionStatus.FUNDED },
        data: { status: RedemptionStatus.BURN_SUBMITTED },
      });
      expect(client.burn).toHaveBeenCalledWith(PRIVY, 'ship-1', {
        transactions: SIGNED,
      });
      expect(prisma.cardRedemption.update).toHaveBeenCalledWith({
        where: { id: REDEMPTION_ID },
        data: { burnSignature: 'BURNSIG', refundSafe: false },
      });
      expect(res).toEqual({
        status: RedemptionStatus.BURN_SUBMITTED,
        burnSignature: 'BURNSIG',
      });
    });

    // client.burn throw = INDETERMINATE PASCA-danai: status SUDAH BURN_SUBMITTED (dari klaim),
    // refundSafe=false, ShippingPostFundError; TIDAK di-walk-back, TIDAK refund.
    it('CC burn throws: stays BURN_SUBMITTED, refundSafe=false, ShippingPostFundError, no walk-back', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      client.burn.mockRejectedValue(new Error('cc 500'));

      const err = await service
        .submitBurn(REDEMPTION_ID, user, PRIVY, SIGNED)
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
        service.submitBurn(REDEMPTION_ID, user, PRIVY, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
    });

    it('a concurrent submit that loses the atomic claim (count 0) never calls CC burn', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue(fundedRow);
      prisma.cardRedemption.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submitBurn(REDEMPTION_ID, user, PRIVY, SIGNED),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(client.burn).not.toHaveBeenCalled();
    });

    it('rejects empty signedTransactions before any lookup', async () => {
      await expect(
        service.submitBurn(REDEMPTION_ID, user, PRIVY, []),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
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

      const res = await service.refreshStatus(REDEMPTION_ID, user, PRIVY);

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

      await service.refreshStatus(REDEMPTION_ID, user, PRIVY);

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

      await service.refreshStatus(REDEMPTION_ID, user, PRIVY);

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

      await service.refreshStatus(REDEMPTION_ID, user, PRIVY);

      const call = prisma.cardRedemption.updateMany.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).not.toHaveProperty('status');
    });

    it('returns the row unchanged and does not poll CC when there is no shipment yet', async () => {
      const noShipment = { ...baseRow, outboundShipmentId: null };
      prisma.cardRedemption.findUnique.mockResolvedValue(noShipment);

      const res = await service.refreshStatus(REDEMPTION_ID, user, PRIVY);

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
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('throws Forbidden when the redemption belongs to another user', async () => {
      prisma.cardRedemption.findUnique.mockResolvedValue({
        ...baseRow,
        userId: 'someone-else',
      });

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(client.prepare).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });
  });

  describe('assertEnabled (feature gate)', () => {
    it('refuses every real path when HOSHI_CC_SHIPPING_ENABLED is off, before any lookup', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = 'false';

      await expect(
        service.fundAndPrepare(REDEMPTION_ID, user, PRIVY),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(prisma.cardRedemption.findUnique).not.toHaveBeenCalled();
      expect(treasury.fundUsdc).not.toHaveBeenCalled();
    });

    it('also gates submitBurn and refreshStatus when off', async () => {
      configFlags.HOSHI_CC_SHIPPING_ENABLED = undefined;

      await expect(
        service.submitBurn(REDEMPTION_ID, user, PRIVY, ['x']),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        service.refreshStatus(REDEMPTION_ID, user, PRIVY),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
