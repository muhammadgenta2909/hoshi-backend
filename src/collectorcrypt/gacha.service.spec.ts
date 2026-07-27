import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CcPackStatus } from '@prisma/client';
import type { CcPackPurchase } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcGachaClient } from './cc-gacha.client';
import type { CcMachineNormalized } from './cc-gacha.types';
import { toCcRarity } from './cc-gacha.types';
import { GachaService } from './gacha.service';
import { GeneratePackDto } from './dto/generate-pack.dto';
import { PurchasePackDto } from './dto/purchase-pack.dto';
import { TreasuryService } from './treasury.service';

// TreasuryService meng-import @solana/web3.js, yang menarik rantai ESM
// (rpc-websockets→uuid) yang bikin jest gagal parse — persis masalah yang sudah
// diselesaikan auth.service.spec.ts dengan cara yang sama. Di file ini TreasuryService
// hanya dipakai sebagai TOKEN DI dan selalu di-override dengan mock di bawah, jadi
// implementasi aslinya (satu-satunya pemegang private key) tidak pernah dieksekusi:
// tidak ada key yang dibaca, tidak ada byte transaksi yang benar-benar ditandatangani.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
}));

describe('GachaService', () => {
  let service: GachaService;
  let prisma: {
    ccPackPurchase: {
      create: jest.Mock;
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      aggregate: jest.Mock;
    };
  };
  let client: {
    machines: jest.Mock;
    generatePack: jest.Mock;
    submitTransaction: jest.Mock;
    openPack: jest.Mock;
    packStatus: jest.Mock;
    buyback: jest.Mock;
    recentWinners: jest.Mock;
  };
  let treasury: {
    publicKey: string;
    sign: jest.Mock;
    isConfigured: jest.Mock;
  };

  const now = new Date('2026-07-14T00:00:00.000Z');

  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };

  // The wallet an attacker would try to smuggle in through the request body.
  const ATTACKER_WALLET = 'AttackerWalletBase58';

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

  const MEMO = 'hoshi-slug-11111111-2222-3333-4444-555555555555';

  // A signed transaction is only accepted if the memo is actually inside its bytes —
  // CollectorCrypt writes the memo into a Memo instruction as UTF-8. SIGNED_TX therefore
  // embeds MEMO; FOREIGN_TX is a well-formed base64 blob that does not, standing in for
  // any unrelated transaction a user might sign and try to pass off as this pack's purchase.
  const SIGNED_TX = Buffer.from(`\x01sig...${MEMO}...rest`, 'utf8').toString(
    'base64',
  );
  const FOREIGN_TX = Buffer.from('\x01some other transaction', 'utf8').toString(
    'base64',
  );

  /* --- Fixture jalur TREASURY (Hoshi yang bayar & tanda tangan) --- */

  // Wallet yang MEMBAYAR pada jalur treasury. Bukan wallet user, dan tidak pernah
  // bisa disebut oleh request body.
  const TREASURY_WALLET = 'HoshiTreasuryBase58';

  // Transaksi UNSIGNED yang dikembalikan CollectorCrypt. Sama seperti jalur user-bayar,
  // memo-nya ada di dalam byte — kalau tidak, service menolak menandatanganinya.
  const CC_UNSIGNED_TX = Buffer.from(
    `\x01unsigned...${MEMO}...rest`,
    'utf8',
  ).toString('base64');

  // Apa pun yang keluar dari treasury.sign(). Isinya tidak penting bagi service;
  // yang penting BLOB INI yang diteruskan ke CC, bukan blob kiriman klien.
  const TREASURY_SIGNED_TX = 'signed-b64';

  const row: CcPackPurchase = {
    id: 'cc-1',
    memo: MEMO,
    userId: user.id,
    playerAddress: user.walletAddress,
    packType: 'pokemon_50',
    turbo: false,
    status: CcPackStatus.GENERATED,
    priceUsdc: 50_000_000,
    purchaseSignature: null,
    openSignature: null,
    rarity: null,
    nftAddress: null,
    nftName: null,
    nftImage: null,
    roll: null,
    points: null,
    buybackAmountUsdc: null,
    buybackSignature: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    openedAt: null,
  };

  beforeEach(async () => {
    prisma = {
      ccPackPurchase: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        // Default: this request wins the atomic GENERATED -> SUBMITTING claim.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Default: treasury belum belanja apa pun dalam 24 jam terakhir, jadi plafon
        // harian tidak pernah menghalangi tes yang sedang menguji hal lain.
        aggregate: jest.fn().mockResolvedValue({ _sum: { priceUsdc: null } }),
      },
    };
    client = {
      machines: jest.fn().mockResolvedValue([machine]),
      generatePack: jest.fn(),
      submitTransaction: jest.fn(),
      openPack: jest.fn(),
      packStatus: jest.fn(),
      buyback: jest.fn(),
      recentWinners: jest.fn(),
    };
    treasury = {
      publicKey: TREASURY_WALLET,
      sign: jest.fn().mockReturnValue(TREASURY_SIGNED_TX),
      isConfigured: jest.fn().mockReturnValue(true),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        GachaService,
        { provide: PrismaService, useValue: prisma },
        { provide: CcGachaClient, useValue: client },
        { provide: TreasuryService, useValue: treasury },
      ],
    }).compile();

    service = moduleRef.get(GachaService);
  });

  describe('generate', () => {
    it('sends the JWT wallet as playerAddress, never an address from the body', async () => {
      // The DTO has no playerAddress/alt* fields by design; a caller could still POST
      // them. Cast past the type to prove the service ignores them even if they arrive.
      const hostileDto = {
        packType: 'pokemon_50',
        playerAddress: ATTACKER_WALLET,
        altPlayerAddress: ATTACKER_WALLET,
        altFundsRecipient: ATTACKER_WALLET,
      } as unknown as GeneratePackDto;
      client.generatePack.mockResolvedValue({ memo: MEMO, transaction: 'b64' });
      prisma.ccPackPurchase.create.mockResolvedValue(row);

      await service.generate(hostileDto, user);

      expect(client.generatePack).toHaveBeenCalledWith({
        playerAddress: user.walletAddress,
        packType: 'pokemon_50',
        turbo: false,
      });
      const [sent] = client.generatePack.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(sent.playerAddress).not.toBe(ATTACKER_WALLET);
      expect(sent).not.toHaveProperty('altPlayerAddress');
      expect(sent).not.toHaveProperty('altFundsRecipient');
      // The ledger row must be attributed to the JWT wallet too — revenue share
      // depends on "who bought what" being unforgeable.
      expect(prisma.ccPackPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: user.id,
          playerAddress: user.walletAddress,
        }) as unknown,
      });
    });

    it('snapshots priceUsdc from machines() onto the row and the response', async () => {
      client.generatePack.mockResolvedValue({ memo: MEMO, transaction: 'b64' });
      prisma.ccPackPurchase.create.mockResolvedValue(row);

      const res = await service.generate({}, user);

      expect(client.machines).toHaveBeenCalled();
      expect(res.priceUsdc).toBe(50_000_000);
      expect(prisma.ccPackPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ priceUsdc: 50_000_000 }) as unknown,
      });
    });

    it('throws BadRequestException for an unknown packType and never calls generatePack', async () => {
      await expect(
        service.generate({ packType: 'not_a_machine' }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.create).not.toHaveBeenCalled();
    });

    it('write-ahead persists the GENERATED row with the returned memo', async () => {
      client.generatePack.mockResolvedValue({
        memo: MEMO,
        transaction: 'unsigned-b64',
      });
      prisma.ccPackPurchase.create.mockResolvedValue(row);

      const res = await service.generate({ packType: 'pokemon_50' }, user);

      expect(prisma.ccPackPurchase.create).toHaveBeenCalledWith({
        data: {
          memo: MEMO,
          userId: user.id,
          playerAddress: user.walletAddress,
          packType: 'pokemon_50',
          turbo: false,
          priceUsdc: 50_000_000,
          status: CcPackStatus.GENERATED,
        },
      });
      expect(res).toEqual({
        memo: MEMO,
        transaction: 'unsigned-b64',
        packType: 'pokemon_50',
        priceUsdc: 50_000_000,
      });
    });

    it('does not hand the transaction to the caller when the ledger write fails', async () => {
      // No row = a user who signs anyway pays with no trace we can bill or prove.
      client.generatePack.mockResolvedValue({
        memo: MEMO,
        transaction: 'unsigned-b64',
      });
      prisma.ccPackPurchase.create.mockRejectedValue(new Error('db down'));

      await expect(service.generate({}, user)).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('memo ownership', () => {
    const foreign: CcPackPurchase = { ...row, userId: 'someone-else' };

    it('submit() throws ForbiddenException when the memo belongs to another user', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(foreign);

      await expect(
        service.submit(MEMO, { signedTransaction: 'c2ln' }, user),
      ).rejects.toThrow(ForbiddenException);

      expect(client.submitTransaction).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.update).not.toHaveBeenCalled();
    });

    it('open() throws ForbiddenException when the memo belongs to another user', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...foreign,
        status: CcPackStatus.SUBMITTED,
      });

      await expect(service.open(MEMO, user)).rejects.toThrow(
        ForbiddenException,
      );

      // openPack is idempotent and returns the full prize — calling it for a
      // foreign memo would hand this user someone else's card.
      expect(client.openPack).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.update).not.toHaveBeenCalled();
    });

    it('packStatus() throws ForbiddenException when the memo belongs to another user', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(foreign);

      await expect(service.packStatus(MEMO, user)).rejects.toThrow(
        ForbiddenException,
      );

      expect(client.packStatus).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a memo that is not in our ledger', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(null);

      await expect(service.open(MEMO, user)).rejects.toThrow(NotFoundException);

      expect(client.openPack).not.toHaveBeenCalled();
    });
  });

  describe('open', () => {
    const opened: CcPackPurchase = {
      ...row,
      status: CcPackStatus.OPENED,
      purchaseSignature: 'BuySig',
      openSignature: 'OpenSig',
      rarity: 'Epic',
      nftAddress: 'NftAddrBase58',
      nftName: 'Charizard',
      roll: '9987',
      points: 420,
      openedAt: now,
    };

    it('returns the stored result for an already-OPENED row without calling CollectorCrypt', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(opened);

      const res = await service.open(MEMO, user);

      expect(client.openPack).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.update).not.toHaveBeenCalled();
      expect(res).toEqual(
        expect.objectContaining({
          memo: MEMO,
          status: CcPackStatus.OPENED,
          rarity: 'Epic',
          nftAddress: 'NftAddrBase58',
          roll: '9987',
        }),
      );
    });

    it('persists the VRF result verbatim (rarity, nftAddress, roll as string) and sets OPENED', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: 'BuySig',
      });
      client.openPack.mockResolvedValue({
        success: true,
        transactionSignature: 'OpenSig',
        nft_address: 'NftAddrBase58',
        nftWon: {
          content: {
            metadata: { name: 'Charizard', description: 'x', attributes: [] },
          },
        },
        points: 420,
        roll: 9987,
        rarity: 'Epic',
      });
      prisma.ccPackPurchase.update.mockResolvedValue(opened);

      const res = await service.open(MEMO, user);

      expect(client.openPack).toHaveBeenCalledWith({ memo: MEMO });
      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: {
          status: CcPackStatus.OPENED,
          rarity: 'Epic',
          nftAddress: 'NftAddrBase58',
          nftName: 'Charizard',
          // Mock nftWon di atas tidak membawa links/files → gambar tidak ada = null.
          nftImage: null,
          openSignature: 'OpenSig',
          roll: '9987',
          points: 420,
          openedAt: expect.any(Date) as unknown,
          error: null,
        },
      });
      // roll is stored as a string: the on-chain VRF value must survive verbatim.
      const [call] = prisma.ccPackPurchase.update.mock.calls as [
        [{ data: { roll: unknown } }],
      ];
      expect(typeof call[0].data.roll).toBe('string');
      expect(res.status).toBe(CcPackStatus.OPENED);
      expect(res.rarity).toBe('Epic');
    });

    // CASING WIRE: openPack CC bisa mengirim rarity HURUF-KECIL ('epic') — persis casing
    // /api/machines — sementara DB kita menyimpan bentuk KANONIK kapital. toCcRarity yang
    // menjembatani: 'epic' -> 'Epic'. Tanpa normalisasi ini DB kita jadi tak konsisten
    // dengan dirinya sendiri (sebagian baris 'Epic', sebagian 'epic') dan setiap GROUP BY
    // rarity pecah di batas casing. Ini kasus yang PALING mungkin terjadi: ground truth
    // menunjukkan endpoint mesin/stok CC memang huruf-kecil.
    it('normalises a lowercase openPack rarity ("epic") to canonical "Epic" before persisting', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: 'BuySig',
      });
      client.openPack.mockResolvedValue({
        success: true,
        transactionSignature: 'OpenSig',
        nft_address: 'NftAddrBase58',
        nftWon: {
          content: {
            metadata: { name: 'Charizard', description: 'x', attributes: [] },
          },
        },
        points: 420,
        roll: 9987,
        rarity: 'epic', // huruf-kecil, apa adanya dari wire CC
      });
      prisma.ccPackPurchase.update.mockResolvedValue(opened);

      const res = await service.open(MEMO, user);

      // Disimpan KAPITAL ('Epic'), bukan 'epic' mentah; dan error null karena rarity DIKENALI.
      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: expect.objectContaining({
          rarity: 'Epic',
          error: null,
        }) as unknown,
      });
      expect(res.rarity).toBe('Epic');
    });

    // GUARD: hanya pack yang SUDAH DIBAYAR (SUBMITTED) yang boleh dibuka. Membuka pack
    // GENERATED (transaksi dibuat, belum di-submit, belum ada uang bergerak) berarti
    // mengeluarkan kartu tanpa pembayaran terkonfirmasi — harus ditolak keras.
    it('refuses to open a pack that is not yet paid (GENERATED) and never calls CollectorCrypt', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.GENERATED,
      });

      await expect(service.open(MEMO, user)).rejects.toThrow(
        BadRequestException,
      );
      expect(client.openPack).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.update).not.toHaveBeenCalled();
    });
  });

  describe('submit', () => {
    it('stores the purchase signature and flips the row to SUBMITTED', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(row);
      client.submitTransaction.mockResolvedValue({
        success: true,
        signature: 'BuySig',
        confirmationStatus: 'confirmed',
      });
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: 'BuySig',
      });

      const res = await service.submit(
        MEMO,
        { signedTransaction: SIGNED_TX },
        user,
      );

      // The GENERATED -> SUBMITTING claim must be atomic and must be scoped to the
      // owner, so a concurrent request cannot also reach the non-idempotent submit.
      expect(prisma.ccPackPurchase.updateMany).toHaveBeenCalledWith({
        where: {
          memo: MEMO,
          userId: user.id,
          status: CcPackStatus.GENERATED,
        },
        data: { status: CcPackStatus.SUBMITTING },
      });
      expect(client.submitTransaction).toHaveBeenCalledWith({
        signedTransaction: SIGNED_TX,
      });
      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: {
          status: CcPackStatus.SUBMITTED,
          purchaseSignature: 'BuySig',
          error: null,
        },
      });
      expect(res.confirmationStatus).toBe('confirmed');
    });

    it('rejects a second submit instead of risking a double charge', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
      });
      prisma.ccPackPurchase.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submit(MEMO, { signedTransaction: SIGNED_TX }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    // The race the atomic claim exists for: two concurrent requests for one memo. The
    // loser's updateMany matches nothing, so only one reaches the non-idempotent submit.
    it('lets only one of two concurrent submits reach CollectorCrypt', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(row);
      prisma.ccPackPurchase.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submit(MEMO, { signedTransaction: SIGNED_TX }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    // A pack stuck at SUBMITTING has an UNKNOWN on-chain fate. Re-submitting it is the
    // one action that can charge the user twice, so it must be refused, not retried.
    it('refuses to re-submit a row whose outcome is unknown (SUBMITTING)', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTING,
      });
      prisma.ccPackPurchase.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.submit(MEMO, { signedTransaction: SIGNED_TX }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    // Without this, a user could sign any unrelated transaction and we would relay it,
    // then stamp its signature onto the row as proof the pack was paid for — poisoning
    // the ledger that our 50% revenue share is reconciled against.
    it('refuses a signed transaction that does not carry this pack memo', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(row);

      await expect(
        service.submit(MEMO, { signedTransaction: FOREIGN_TX }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.submitTransaction).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('CollectorCrypt failures', () => {
    // A failed submit call does NOT prove the transaction failed on-chain — our own 15s
    // timeout fires while CollectorCrypt is still waiting for Solana confirmation. The
    // row must stay at SUBMITTING ("unknown"), never be walked back to a retryable state.
    it('records the error but does NOT downgrade the status on a failed submit', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue(row);
      client.submitTransaction.mockRejectedValue(
        new ServiceUnavailableException('CollectorCrypt down'),
      );
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTING,
      });

      await expect(
        service.submit(MEMO, { signedTransaction: SIGNED_TX }, user),
      ).rejects.toThrow(ServiceUnavailableException);

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: { error: 'CollectorCrypt down' },
      });
    });

    // The row is SUBMITTED: the user's USDC is already gone. A failure of the OPEN call
    // is not a failure of the purchase. Writing FAILED here would make a paid pack read
    // as "cancelled" during commission reconciliation, and would re-open the submit path.
    it('records the error but does NOT downgrade a PAID row on a failed open', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
      });
      client.openPack.mockRejectedValue(new Error('machine off'));
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
      });

      await expect(service.open(MEMO, user)).rejects.toThrow('machine off');

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: { error: 'machine off' },
      });
    });

    // A turbo pack auto-sells its prize, so there may be no NFT to name. Blind-dereferencing
    // nftWon would throw AFTER the pack is irreversibly opened on-chain, stranding it.
    it('opens a pack whose payload carries no nftWon (turbo) without throwing', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        turbo: true,
        status: CcPackStatus.SUBMITTED,
      });
      client.openPack.mockResolvedValue({
        success: true,
        transactionSignature: 'OpenSig',
        nft_address: 'NftAddr',
        rarity: 'Rare',
        // no nftWon, no points, no roll
      });
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...row,
        status: CcPackStatus.OPENED,
        rarity: 'Rare',
        nftAddress: 'NftAddr',
      });

      const res = await service.open(MEMO, user);

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: expect.objectContaining({
          status: CcPackStatus.OPENED,
          nftName: null,
          roll: null,
          points: null,
        }) as unknown,
      });
      expect(res.rarity).toBe('Rare');
    });

    it('never swallows the original error when the FAILED flag itself cannot be written', async () => {
      prisma.ccPackPurchase.findUnique.mockResolvedValue({
        ...row,
        status: CcPackStatus.SUBMITTED,
      });
      client.openPack.mockRejectedValue(new Error('machine off'));
      prisma.ccPackPurchase.update.mockRejectedValue(new Error('db down'));

      await expect(service.open(MEMO, user)).rejects.toThrow('machine off');
    });
  });

  describe('buyback', () => {
    it('quotes only CollectorCrypt refundAmount, for an NFT this user actually won', async () => {
      const opened: CcPackPurchase = {
        ...row,
        status: CcPackStatus.OPENED,
        rarity: 'Rare',
        nftAddress: 'NftAddrBase58',
      };
      prisma.ccPackPurchase.findFirst.mockResolvedValue(opened);
      client.buyback.mockResolvedValue({
        success: true,
        serializedTransaction: 'unsigned-b64',
        refundAmount: 42_500_000,
        memo: 'buyback-memo',
      });
      prisma.ccPackPurchase.update.mockResolvedValue(opened);

      const res = await service.buyback({ nftAddress: 'NftAddrBase58' }, user);

      expect(client.buyback).toHaveBeenCalledWith({
        playerAddress: user.walletAddress,
        nftAddress: 'NftAddrBase58',
      });
      expect(res.refundAmountUsdc).toBe(42_500_000);
      expect(res.serializedTransaction).toBe('unsigned-b64');
    });

    it('throws ForbiddenException for an NFT that is not in this user ledger', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue(null);

      await expect(
        service.buyback({ nftAddress: 'NftAddrBase58' }, user),
      ).rejects.toThrow(ForbiddenException);

      expect(client.buyback).not.toHaveBeenCalled();
    });
  });

  /**
   * winners(): feed "Live Card Won". Membaca bentuk getRecentWinners MENTAH CC — bersarang
   * dalam (nft.content.metadata.name + links.image) dan tidak dijamin kontrak — lalu
   * memetakannya ke GachaWinner[] yang rata. Dua sifat yang diuji ketat: pemetaan yang
   * BENAR (nama/gambar/winner/tier), dan KETAHANAN — satu mesin yang gagal atau satu item
   * jelek tidak boleh menjatuhkan seluruh feed.
   */
  describe('winners', () => {
    // Bentuk SATU winner VERBATIM dari getRecentWinners (disederhanakan dari payload devnet).
    const NFT_ID = '8AskiNe41W1wo15SzTDUkfErV1v89c2yJ3Utzkg8MREt';
    const WINNER_WALLET = '4Th3Ej2oJrsj2g2Hi7JByC2R237YvHnNaZgMp4ztVtyT';
    const CARD_NAME = '2003 #7 Minun-Holo PSA 6 EX Drag';
    const CARD_IMAGE = 'https://arweave.net/q9PZ';

    const rawWinner = {
      winner: WINNER_WALLET,
      prize_tier: 4,
      nft: {
        id: NFT_ID,
        content: {
          links: { image: CARD_IMAGE },
          files: [
            {
              uri: 'https://arweave.net/file-uri',
              cdn_uri: 'https://cdn.helius-rpc.com/file-cdn',
              cc_cdn: 'https://dq63y5568o1bp.cloudfront.net/file-cc',
            },
          ],
          metadata: { name: CARD_NAME, attributes: [] },
        },
      },
    };

    // Amplop APA ADANYA: { success: true, data: [ ... ] }.
    const envelope = (data: unknown[]): unknown => ({ success: true, data });

    it('maps the raw CollectorCrypt winner shape to a clean GachaWinner', async () => {
      client.recentWinners.mockResolvedValue(envelope([rawWinner]));

      const res = await service.winners('pokemon_50');

      // packType diberikan → hanya mesin itu yang dipanggil, sekali.
      expect(client.recentWinners).toHaveBeenCalledTimes(1);
      expect(client.recentWinners).toHaveBeenCalledWith('pokemon_50');
      expect(res).toEqual([
        {
          nftAddress: NFT_ID,
          name: CARD_NAME,
          image: CARD_IMAGE,
          winner: WINNER_WALLET,
          tier: 4,
        },
      ]);
    });

    // Gambar diambil berurutan: links.image → files[0].cdn_uri → files[0].uri.
    it('falls back to files[0].cdn_uri, then files[0].uri, when links.image is absent', async () => {
      const noLink = {
        ...rawWinner,
        nft: {
          id: 'nft-no-link',
          content: { ...rawWinner.nft.content, links: {} },
        },
      };
      const noLinkNoCdn = {
        ...rawWinner,
        nft: {
          id: 'nft-uri-only',
          content: {
            ...rawWinner.nft.content,
            links: {},
            files: [{ uri: 'https://arweave.net/only-uri' }],
          },
        },
      };
      client.recentWinners.mockResolvedValue(envelope([noLink, noLinkNoCdn]));

      const res = await service.winners('pokemon_50');

      expect(res).toEqual([
        expect.objectContaining({
          nftAddress: 'nft-no-link',
          image: 'https://cdn.helius-rpc.com/file-cdn',
        }),
        expect.objectContaining({
          nftAddress: 'nft-uri-only',
          image: 'https://arweave.net/only-uri',
        }),
      ]);
    });

    // REGRESI: links.image = "" (string KOSONG) harus dianggap tidak ada, lalu jatuh ke
    // files[0].cdn_uri. Dengan `??` dulu, "" lolos dan winner valid malah dibuang.
    it('treats an empty-string links.image as absent and falls back to cdn_uri', async () => {
      const emptyLink = {
        ...rawWinner,
        nft: {
          id: 'nft-empty-link',
          content: { ...rawWinner.nft.content, links: { image: '' } },
        },
      };
      client.recentWinners.mockResolvedValue(envelope([emptyLink]));

      const res = await service.winners('pokemon_50');

      expect(res).toEqual([
        expect.objectContaining({
          nftAddress: 'nft-empty-link',
          image: 'https://cdn.helius-rpc.com/file-cdn',
        }),
      ]);
    });

    // Item jelek dibuang DIAM-DIAM (return null), bukan bikin throw — satu winner tanpa
    // nama atau tanpa gambar tidak boleh mematikan seluruh feed.
    it('skips winners missing a name or an image without throwing', async () => {
      const noName = {
        winner: 'w-no-name',
        prize_tier: 1,
        nft: {
          id: 'nft-no-name',
          content: { links: { image: 'https://img' } },
        },
      };
      const noImage = {
        winner: 'w-no-image',
        prize_tier: 2,
        nft: { id: 'nft-no-image', content: { metadata: { name: 'Anon' } } },
      };
      client.recentWinners.mockResolvedValue(
        envelope([noName, noImage, rawWinner]),
      );

      const res = await service.winners('pokemon_50');

      expect(res).toHaveLength(1);
      expect(res[0].nftAddress).toBe(NFT_ID);
    });

    // allSettled: satu packType yang REJECTED (mesin off/timeout) tidak menjatuhkan hasil —
    // mesin lain tetap menyumbang winner. Tanpa packType, winners() meng-agregasi 6 mesin.
    it('does not drop the feed when one packType rejects (aggregation path)', async () => {
      const other = {
        ...rawWinner,
        winner: 'otherWallet',
        nft: { ...rawWinner.nft, id: 'nft-other' },
      };
      client.recentWinners.mockImplementation((pack: string) =>
        pack === 'pokemon_250'
          ? Promise.reject(new Error('Machine is off'))
          : Promise.resolve(envelope([other])),
      );

      const res = await service.winners();

      // 6 mesin default dipanggil; 1 reject, 5 sukses (semua winner sama → dedupe jadi 1).
      expect(client.recentWinners).toHaveBeenCalledTimes(6);
      expect(res).toEqual([
        {
          nftAddress: 'nft-other',
          name: CARD_NAME,
          image: CARD_IMAGE,
          winner: 'otherWallet',
          tier: 4,
        },
      ]);
    });

    // Dedupe lintas mesin berdasar nftAddress: winner yang sama muncul di banyak mesin,
    // tapi hanya tampil sekali di feed.
    it('dedupes winners by nftAddress across machines', async () => {
      const distinct = {
        ...rawWinner,
        winner: 'walletB',
        nft: { ...rawWinner.nft, id: 'nft-distinct' },
      };
      // Tiap mesin mengembalikan DUA winner yang sama → 6 mesin, tetap 2 unik.
      client.recentWinners.mockResolvedValue(envelope([rawWinner, distinct]));

      const res = await service.winners();

      expect(res).toHaveLength(2);
      expect(res.map((w) => w.nftAddress).sort()).toEqual(
        [NFT_ID, 'nft-distinct'].sort(),
      );
    });

    // Payload yang bukan amplop winner (null / bentuk asing) → [] , TIDAK PERNAH throw.
    it('returns an empty array when the response is not a winners envelope', async () => {
      client.recentWinners.mockResolvedValue(null);

      await expect(service.winners('pokemon_50')).resolves.toEqual([]);
    });

    // prize_tier hilang → tier default 0 (tetap ditampilkan; tier bukan syarat tampil).
    it('defaults tier to 0 when prize_tier is absent', async () => {
      const noTier = {
        winner: WINNER_WALLET,
        nft: {
          id: 'nft-no-tier',
          content: {
            links: { image: CARD_IMAGE },
            metadata: { name: CARD_NAME },
          },
        },
      };
      client.recentWinners.mockResolvedValue(envelope([noTier]));

      const [winner] = await service.winners('pokemon_50');

      expect(winner.tier).toBe(0);
    });
  });

  /**
   * Jalur TREASURY: Hoshi yang membayar USDC dan Hoshi yang menandatangani, user cuma
   * menerima kartunya. Yang berubah bukan cuma "siapa yang bayar" — yang berubah adalah
   * SIAPA YANG RUGI kalau ada bug. Di jalur user-bayar, penjaga-penjaga di bawah
   * melindungi uang USER dan wallet user selalu jadi rem terakhir (ia bisa menolak
   * tanda tangan). Di sini rem itu TIDAK ADA: yang keluar adalah uang KAMI, dan
   * satu-satunya yang menahannya adalah kode ini.
   */
  describe('purchase', () => {
    const purchased: CcPackPurchase = {
      ...row,
      // Baris ledger jalur treasury: pembayarnya treasury, pemiliknya tetap user JWT.
      playerAddress: TREASURY_WALLET,
      status: CcPackStatus.OPENED,
      purchaseSignature: 'BuySig',
      openSignature: 'OpenSig',
      rarity: 'Epic',
      nftAddress: 'NftAddrBase58',
      nftName: 'Charizard',
      roll: '9987',
      points: 420,
      openedAt: now,
    };

    /** Satu pembelian treasury yang mulus. Tiap tes lalu merusak TEPAT SATU bagiannya. */
    const armHappyPurchase = (): void => {
      client.generatePack.mockResolvedValue({
        memo: MEMO,
        transaction: CC_UNSIGNED_TX,
      });
      prisma.ccPackPurchase.create.mockResolvedValue({
        ...row,
        playerAddress: TREASURY_WALLET,
      });
      client.submitTransaction.mockResolvedValue({
        success: true,
        signature: 'BuySig',
        confirmationStatus: 'confirmed',
      });
      client.openPack.mockResolvedValue({
        success: true,
        transactionSignature: 'OpenSig',
        nft_address: 'NftAddrBase58',
        nftWon: {
          content: {
            metadata: { name: 'Charizard', description: 'x', attributes: [] },
          },
        },
        points: 420,
        roll: 9987,
        rarity: 'Epic',
      });
      prisma.ccPackPurchase.update.mockResolvedValue(purchased);
    };

    /** Setiap `status` yang benar-benar ditulis ke ledger, dalam urutan penulisannya. */
    const statusesWritten = (): unknown[] =>
      (
        prisma.ccPackPurchase.update.mock.calls as [
          { data: { status?: unknown } },
        ][]
      )
        .map(([arg]) => arg.data.status)
        .filter((status) => status !== undefined);

    // FLOW "beli dulu, buka nanti": dengan deferOpen, purchase BERHENTI di SUBMITTED —
    // pack dibayar & dimiliki user, tapi VRF (openPack) TIDAK dijalankan. Kartunya belum
    // diundi sampai user menekan Open. Ledger tidak pernah menyentuh OPENED.
    it('with deferOpen pays + submits but does NOT open the pack (stops at SUBMITTED)', async () => {
      armHappyPurchase();
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...row,
        playerAddress: TREASURY_WALLET,
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: 'BuySig',
      });

      const res = await service.purchase({}, user, {
        viaRupiahPayment: true,
        deferOpen: true,
      });

      expect(client.submitTransaction).toHaveBeenCalledTimes(1);
      expect(client.openPack).not.toHaveBeenCalled();
      expect(res.status).toBe(CcPackStatus.SUBMITTED);
      expect(statusesWritten()).not.toContain(CcPackStatus.OPENED);
    });

    // INI TES YANG PALING PENTING DI FILE INI. Pembayar dan penerima kartu kini BEDA
    // wallet, dan itu persis bentuk yang biasanya dipakai mencuri: kalau body request
    // bisa menyentuh salah satunya, penyerang mengarahkan kartu ~$50 yang DIBAYAR
    // TREASURY ke wallet-nya sendiri (altPlayerAddress), atau menjadikan wallet KORBAN
    // sebagai pembayar (playerAddress). Keduanya harus mustahil dari body — titik.
    it('pays from the treasury and sends the card to the JWT wallet, and the body can override neither', async () => {
      const hostileDto = {
        packType: 'pokemon_50',
        playerAddress: ATTACKER_WALLET,
        altPlayerAddress: ATTACKER_WALLET,
        altFundsRecipient: ATTACKER_WALLET,
      } as unknown as PurchasePackDto;
      armHappyPurchase();

      await service.purchase(hostileDto, user);

      expect(client.generatePack).toHaveBeenCalledWith({
        playerAddress: TREASURY_WALLET,
        packType: 'pokemon_50',
        turbo: false,
        altPlayerAddress: user.walletAddress,
      });
      const [sent] = client.generatePack.mock.calls[0] as [
        Record<string, unknown>,
      ];
      expect(sent.playerAddress).toBe(TREASURY_WALLET);
      expect(sent.playerAddress).not.toBe(ATTACKER_WALLET);
      expect(sent.altPlayerAddress).toBe(user.walletAddress);
      expect(sent.altPlayerAddress).not.toBe(ATTACKER_WALLET);
      // Turbo-nya auto-sell mendarat di penerima kartu; membiarkan body mengarahkannya
      // sama saja membuka keran USDC treasury.
      expect(sent).not.toHaveProperty('altFundsRecipient');
      // Ledger: dibayar treasury, TAPI tetap milik user JWT — itu yang menghubungkan
      // pack ini ke orang yang membayar rupiahnya, dan ke bagi hasil 50% kita.
      expect(prisma.ccPackPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: user.id,
          playerAddress: TREASURY_WALLET,
        }) as unknown,
      });
    });

    it('signs the transaction CollectorCrypt returned and forwards exactly that blob', async () => {
      armHappyPurchase();

      await service.purchase({}, user);

      // Yang ditandatangani HARUS transaksi milik memo ini — bukan blob lain.
      expect(treasury.sign).toHaveBeenCalledTimes(1);
      expect(treasury.sign).toHaveBeenCalledWith(CC_UNSIGNED_TX);
      // Dan yang diteruskan ke CC HARUS hasil tanda tangan kita sendiri. User tidak
      // pernah menyetorkan blob apa pun di jalur ini.
      expect(client.submitTransaction).toHaveBeenCalledWith({
        signedTransaction: TREASURY_SIGNED_TX,
      });
    });

    // WRITE-AHEAD. Tanda tangan treasury = uang terikat. Kalau barisnya belum tertulis
    // saat itu terjadi, kita membelanjakan ~$50 tanpa catatan: tidak bisa ditagihkan ke
    // siapa pun, tidak bisa dibuktikan ke CollectorCrypt, dan tidak bisa direkonsiliasi.
    it('writes the ledger row BEFORE the treasury signs anything', async () => {
      armHappyPurchase();

      await service.purchase({}, user);

      const created =
        prisma.ccPackPurchase.create.mock.invocationCallOrder[0] ?? 0;
      const signed = treasury.sign.mock.invocationCallOrder[0] ?? 0;
      expect(created).toBeGreaterThan(0);
      expect(signed).toBeGreaterThan(0);
      expect(created).toBeLessThan(signed);
    });

    it('never signs when the ledger write fails', async () => {
      armHappyPurchase();
      prisma.ccPackPurchase.create.mockRejectedValue(new Error('db down'));

      await expect(service.purchase({}, user)).rejects.toThrow(
        InternalServerErrorException,
      );

      // Tidak ada baris → tidak boleh ada tanda tangan, dan karena itu tidak ada
      // satu pun rupiah/USDC yang bergerak. Pembelian batal itu murah; pack yang
      // dibayar tanpa jejak tidak.
      expect(treasury.sign).not.toHaveBeenCalled();
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    it('claims GENERATED -> SUBMITTING atomically before submitting', async () => {
      armHappyPurchase();

      await service.purchase({}, user);

      expect(prisma.ccPackPurchase.updateMany).toHaveBeenCalledWith({
        where: {
          memo: MEMO,
          userId: user.id,
          status: CcPackStatus.GENERATED,
        },
        data: { status: CcPackStatus.SUBMITTING },
      });
      const claimed =
        prisma.ccPackPurchase.updateMany.mock.invocationCallOrder[0] ?? 0;
      const submitted =
        client.submitTransaction.mock.invocationCallOrder[0] ?? 0;
      expect(claimed).toBeGreaterThan(0);
      expect(claimed).toBeLessThan(submitted);
    });

    // Balapan yang bikin klaim atomik itu ada. Di jalur user-bayar, yang tertagih 2×
    // adalah user. Di sini yang membayar 2× adalah TREASURY KITA — dan tidak ada lagi
    // wallet user yang bisa menolak tanda tangan kedua. Yang kalah harus berhenti
    // SEBELUM menandatangani, bukan cuma sebelum submit.
    it('a losing concurrent caller (count 0) neither signs nor submits', async () => {
      armHappyPurchase();
      prisma.ccPackPurchase.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.purchase({}, user)).rejects.toThrow(
        BadRequestException,
      );

      expect(treasury.sign).not.toHaveBeenCalled();
      expect(client.submitTransaction).not.toHaveBeenCalled();
    });

    // Timeout kita BUKAN bukti transaksinya tidak tayang on-chain. "Tidak diketahui"
    // bukan "gagal": menurunkan status di sini membuka lagi jalur beli ulang, dan
    // treasury membayar dua kali untuk satu pack yang sama.
    it('records the error but does NOT downgrade the status on a failed submit', async () => {
      armHappyPurchase();
      client.submitTransaction.mockRejectedValue(
        new ServiceUnavailableException('CollectorCrypt down'),
      );

      await expect(service.purchase({}, user)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: { error: 'CollectorCrypt down' },
      });
      // Barisnya berhenti di SUBMITTING (ditulis lewat updateMany). Tidak ada satu pun
      // status baru yang ditulis sesudahnya — FAILED paling berbahaya.
      expect(statusesWritten()).toEqual([]);
    });

    // Baris SUBMITTED = uang treasury SUDAH keluar. Gagalnya panggilan BUKA bukan
    // gagalnya pembelian: menulis FAILED membuat pack BERBAYAR terbaca "dibatalkan"
    // saat rekonsiliasi komisi — kita kehilangan klaim 50% atas pack yang kita bayar.
    it('does not write FAILED when openPack fails on an already-PAID row', async () => {
      armHappyPurchase();
      client.openPack.mockRejectedValue(new Error('machine off'));

      // Pesannya tidak boleh terdengar seperti kegagalan: uangnya sudah keluar dan
      // pack-nya milik user — ia cuma belum menerima kartunya.
      await expect(service.purchase({}, user)).rejects.toThrow(/SUDAH DIBAYAR/);

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: {
          status: CcPackStatus.SUBMITTED,
          purchaseSignature: 'BuySig',
          error: null,
        },
      });
      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: { error: 'machine off' },
      });
      // Satu-satunya status yang boleh tertulis adalah SUBMITTED ("sudah bayar,
      // belum terkirim"). openPack idempoten, jadi open(memo) nanti menyelesaikannya.
      expect(statusesWritten()).toEqual([CcPackStatus.SUBMITTED]);
      expect(statusesWritten()).not.toContain(CcPackStatus.FAILED);
    });

    // Respons non-terminal (WAITING_FOR_PAYMENT / nft_address belum terbit). Menulis
    // OPENED di sini = KORUPSI LEDGER: barisnya berbunyi "kartu sudah diberikan" padahal
    // nftAddress NULL, dan pack berbayar yang tak terkirim itu jadi tak terlihat oleh
    // query "cari pack belum terkirim" sekaligus mustahil di-buyback.
    it('keeps a non-terminal openPack response at SUBMITTED instead of writing OPENED', async () => {
      armHappyPurchase();
      client.openPack.mockResolvedValue({
        success: true,
        code: 'WAITING_FOR_PAYMENT',
        transactionSignature: '',
        nft_address: '',
        rarity: 'Common',
      });

      await expect(service.purchase({}, user)).rejects.toThrow(/SUDAH DIBAYAR/);

      expect(statusesWritten()).toEqual([CcPackStatus.SUBMITTED]);
      expect(statusesWritten()).not.toContain(CcPackStatus.OPENED);
    });

    // Bentuk respons CC cuma cerminan dokumentasi mereka, bukan kontrak yang dijamin.
    // Deref buta atas pack yang SUDAH terbuka on-chain (ireversibel) = pack itu gagal
    // tercatat lalu tersangkut selamanya, padahal treasury sudah membayarnya.
    it('persists OPENED without throwing when the payload carries no nftWon (turbo shape)', async () => {
      armHappyPurchase();
      client.openPack.mockResolvedValue({
        success: true,
        transactionSignature: 'OpenSig',
        nft_address: 'NftAddr',
        rarity: 'Rare',
        // tidak ada nftWon, points, roll
      });
      prisma.ccPackPurchase.update.mockResolvedValue({
        ...purchased,
        rarity: 'Rare',
        nftAddress: 'NftAddr',
        nftName: null,
        roll: null,
        points: null,
      });

      const res = await service.purchase({}, user);

      expect(prisma.ccPackPurchase.update).toHaveBeenCalledWith({
        where: { memo: MEMO },
        data: expect.objectContaining({
          status: CcPackStatus.OPENED,
          nftAddress: 'NftAddr',
          nftName: null,
          roll: null,
          points: null,
        }) as unknown,
      });
      expect(res.status).toBe(CcPackStatus.OPENED);
      expect(res.rarity).toBe('Rare');
    });

    it('throws BadRequestException for an unknown packType and never calls generatePack or signs', async () => {
      armHappyPurchase();

      await expect(
        service.purchase({ packType: 'not_a_machine' }, user),
      ).rejects.toThrow(BadRequestException);

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(treasury.sign).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.create).not.toHaveBeenCalled();
    });

    // Harga yang kita bayar ditentukan RESPONS MEREKA, dan tidak ada lagi popup wallet
    // yang menahannya. Meng-hardcode $50 berarti diam-diam salah bayar begitu harga
    // mesin berubah; membaca dari machines() berarti angka di ledger = angka yang dibayar.
    it('snapshots the price from machines() rather than hardcoding it', async () => {
      armHappyPurchase();
      client.machines.mockResolvedValue([
        { ...machine, priceUsdcBaseUnits: 60_000_000 },
      ]);

      await service.purchase({}, user);

      expect(client.machines).toHaveBeenCalled();
      expect(prisma.ccPackPurchase.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ priceUsdc: 60_000_000 }) as unknown,
      });
    });

    // Lubang uang terbesar di model treasury: turbo menjual-otomatis kartu menang jadi
    // USDC dan mengirimnya ke PENERIMA KARTU — yaitu wallet user. Satu tombol, dan USDC
    // TREASURY keluar sebagai USDC MILIK USER di wallet non-kustodian, ireversibel.
    it('refuses turbo on the treasury path — it would pipe treasury USDC into a user wallet', async () => {
      armHappyPurchase();

      await expect(service.purchase({ turbo: true }, user)).rejects.toThrow(
        BadRequestException,
      );

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(treasury.sign).not.toHaveBeenCalled();
    });

    it('refuses to spend when the treasury is not configured, before anything moves', async () => {
      armHappyPurchase();
      treasury.isConfigured.mockReturnValue(false);

      await expect(service.purchase({}, user)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(treasury.sign).not.toHaveBeenCalled();
      expect(prisma.ccPackPurchase.create).not.toHaveBeenCalled();
    });

    // Sampai gerbang pembayaran rupiah ada, plafon inilah satu-satunya batas nominal
    // antara sebuah JWT (yang gratis dan tak terbatas — /auth/nonce meng-upsert user
    // untuk alamat Solana APA PUN) dan isi treasury kita.
    it('refuses once the 24h treasury spend cap would be exceeded, before calling CollectorCrypt', async () => {
      armHappyPurchase();
      prisma.ccPackPurchase.aggregate.mockResolvedValue({
        _sum: { priceUsdc: 500_000_000 },
      });

      await expect(service.purchase({}, user)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(treasury.sign).not.toHaveBeenCalled();
    });

    // Satu respons /api/machines yang jahat atau salah (harga $50.000) tidak boleh bisa
    // berubah jadi tanda tangan treasury senilai $50.000.
    it('refuses to sign a machine price above the ceiling', async () => {
      armHappyPurchase();
      client.machines.mockResolvedValue([
        { ...machine, priceUsdcBaseUnits: 200_000_000 },
      ]);

      await expect(service.purchase({}, user)).rejects.toThrow(
        ServiceUnavailableException,
      );

      expect(client.generatePack).not.toHaveBeenCalled();
      expect(treasury.sign).not.toHaveBeenCalled();
    });
  });
});

// Unit murni untuk normaliser rarity kanonik. GROUND TRUTH: /api/machines & /api/stock
// mengirim key HURUF-KECIL, contoh openPack di dokumentasi KAPITAL, dan getRecentWinners
// malah mengirim prize_tier NUMERIK — CC terbukti tidak konsisten. toCcRarity menerima
// casing apa pun (case-INSENSITIVE) lalu mengembalikan bentuk kanonik kapital kita, atau
// null untuk apa pun yang tak dikenal: TIDAK PERNAH menebak, TIDAK PERNAH default ke 'Common'
// (itu perilaku normalizeRarity 5-tier Hoshi yang justru harus dihindari untuk rarity CC).
describe('toCcRarity', () => {
  it('folds any casing of a known CollectorCrypt tier to the canonical capitalised form', () => {
    expect(toCcRarity('epic')).toBe('Epic'); // wire huruf-kecil (/api/machines, /api/stock)
    expect(toCcRarity('EPIC')).toBe('Epic'); // huruf-besar
    expect(toCcRarity('Epic')).toBe('Epic'); // sudah kanonik (contoh docs openPack)
    expect(toCcRarity('  common  ')).toBe('Common'); // ber-spasi tetap dikenali
    expect(toCcRarity('rare')).toBe('Rare');
    // 'Uncommon' TIDAK punya padanan di 5-tier Hoshi — normalizeRarity akan menelannya jadi
    // 'Common'; toCcRarity WAJIB mempertahankannya utuh.
    expect(toCcRarity('uncommon')).toBe('Uncommon');
  });

  it('returns null for anything it does not recognise — never guesses, never defaults to Common', () => {
    expect(toCcRarity('legendary')).toBeNull(); // tier Hoshi, bukan salah satu dari 4 tier CC
    expect(toCcRarity('4')).toBeNull(); // prize_tier numerik getRecentWinners (sebagai string)
    expect(toCcRarity('')).toBeNull();
    expect(toCcRarity('garbage')).toBeNull();
  });
});
