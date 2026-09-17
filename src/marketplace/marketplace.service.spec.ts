import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CcPackStatus,
  Grader,
  ListingSource,
  ListingStatus,
} from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { CcCardFactsService } from '../collectorcrypt/cc-card-facts.service';
import { NftService } from '../nft/nft.service';
import { PrismaService } from '../prisma/prisma.service';
import { EscrowService } from '../escrow/escrow.service';
import { MailService } from '../mail/mail.service';
import { MarketplaceService } from './marketplace.service';

// Prevent the Metaplex/Solana ESM chain from loading through NftService.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));

// MarketplaceService kini meng-import EscrowService, yang menarik rantai ESM Solana v1
// (umi-bundle-defaults → web3.js → rpc-websockets→uuid) yang bikin jest gagal parse. Sama
// seperti payments.service.spec, kita mock @solana/web3.js dengan kelas no-op. EscrowService
// sendiri selalu di-override dengan mock di test, jadi tak ada key dibaca / tx ditandatangani.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
}));

describe('MarketplaceService', () => {
  let service: MarketplaceService;
  let prisma: {
    card: { findUnique: jest.Mock; create: jest.Mock };
    listing: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
    nft: { updateMany: jest.Mock };
    offer: { updateMany: jest.Mock; create: jest.Mock; findUnique: jest.Mock };
    activity: { create: jest.Mock };
    ccPackPurchase: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let nft: { mintForUser: jest.Mock };
  let ccFacts: { ensureFacts: jest.Mock };
  let config: { get: jest.Mock };
  let escrow: {
    buildTransferToEscrowTx: jest.Mock;
    broadcastSignedToEscrow: jest.Mock;
    transferCoreAssetTo: jest.Mock;
    ownsAsset: jest.Mock;
    checkOwnsAsset: jest.Mock;
    ownsAssetWithRetry: jest.Mock;
    isConfigured: jest.Mock;
    noteSponsorshipConsumed: jest.Mock;
  };

  const now = new Date('2026-07-05T00:00:00.000Z');
  const user = {
    id: 'buyer-1',
    walletAddress: 'BuyerWalletBase58',
    displayName: null,
    role: 'USER',
  };

  const listing = {
    id: 'listing-1',
    name: 'Charizard VMAX',
    set: 'Classic',
    rarity: 'Legendary Rare',
    image: '/card4.png',
    priceIdrx: 24_250_000,
    expectedValueIdrx: 27_000_000,
    buybackIdrx: 18_000_000,
    grade: 'PSA 10',
    grader: Grader.PSA,
    gradeScore: 10,
    language: 'English',
    era: 'Classic',
    element: 'Fire',
    category: 'Character Illustration',
    views: 0,
    status: ListingStatus.ACTIVE,
    sellerId: 'seller-1',
    sellerAddress: 'x0f3a..91c2',
    buyerId: null,
    cardId: null,
    nftId: null,
    listedAt: now,
    soldAt: null,
    createdAt: now,
    updatedAt: now,
    nft: null,
  };

  beforeEach(async () => {
    prisma = {
      card: { findUnique: jest.fn(), create: jest.fn() },
      listing: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      nft: { updateMany: jest.fn() },
      // buy() closes any dangling offers and writes an audit row after settling.
      offer: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        // submitOffer / acceptOffer — dipakai grup gerbang P2P di bawah.
        create: jest.fn(),
        findUnique: jest.fn(),
      },
      activity: { create: jest.fn().mockResolvedValue({}) },
      ccPackPurchase: { findFirst: jest.fn() },
      // acceptOffer menandai ACCEPTED + menyapu offer saingan dalam SATU transaksi. Test
      // gerbang memastikan transaksi ini TIDAK PERNAH dijalankan saat gerbang menolak.
      $transaction: jest.fn().mockResolvedValue([]),
    };
    nft = { mintForUser: jest.fn() };

    // Grade kartu hasil pull dibaca dari katalog CC lewat service ini, bukan dari
    // payload klien. Default di test: CC mengenali kartunya sebagai CGC 9.5 —
    // sengaja BEDA dari "PSA 9" yang dikirim `fromPackDto`, supaya terlihat versi
    // siapa yang benar-benar tersimpan.
    ccFacts = {
      ensureFacts: jest.fn().mockResolvedValue({
        itemName: '2001 #16 Zubat CGC 9.5 Neo Destiny',
        gradeCompany: 'CGC',
        gradeScore: 9.5,
        gradeLabel: 'MINT+ 9.5',
        gradeCert: '1234567',
        set: 'Neo Destiny',
        category: 'Pokemon',
        language: 'English',
        year: 2001,
        vault: 'OmniVault',
        serial: '16/105',
      }),
    };

    // Default: mock/unarmed → p2pRealArmed()=false → listing langsung ACTIVE (perilaku lama).
    // Test escrow di bawah meng-override HOSHI_P2P_ENABLED='true' untuk menyalakan jalur real.
    config = { get: jest.fn().mockReturnValue(undefined) };
    escrow = {
      buildTransferToEscrowTx: jest.fn(),
      broadcastSignedToEscrow: jest.fn(),
      transferCoreAssetTo: jest.fn(),
      ownsAsset: jest.fn(),
      // Default SENGAJA `null` = "tidak terbaca": jawaban itu tidak pernah mengizinkan fakta
      // escrow dihapus, jadi test yang memajang ulang baris ber-escrowedAt HARUS menyatakan
      // sendiri apa yang dikatakan rantai. Default `false` akan menyembunyikan justru regresi
      // yang gerbang ini ada untuk mencegahnya.
      checkOwnsAsset: jest.fn().mockResolvedValue(null),
      ownsAssetWithRetry: jest.fn(),
      isConfigured: jest.fn().mockReturnValue(true),
      // C — pembukuan sponsor gas. Best-effort di submitEscrow (dibungkus try/catch di service).
      noteSponsorshipConsumed: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        { provide: PrismaService, useValue: prisma },
        { provide: NftService, useValue: nft },
        { provide: CcCardFactsService, useValue: ccFacts },
        { provide: ConfigService, useValue: config },
        { provide: EscrowService, useValue: escrow },
        {
          provide: MailService,
          useValue: { sendEmail: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = moduleRef.get(MarketplaceService);
  });

  /** Nyalakan jalur P2P real (armed): CC_MOCK unset + HOSHI_P2P_ENABLED='true'. */
  function armP2p() {
    config.get.mockImplementation((k: string) =>
      k === 'HOSHI_P2P_ENABLED' ? 'true' : undefined,
    );
  }

  describe('buy', () => {
    it('locks ACTIVE listing, creates a card snapshot, mints NFT, then links nftId', async () => {
      prisma.listing.findUnique.mockResolvedValue(listing);
      prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.listing.findUniqueOrThrow.mockResolvedValue({
        ...listing,
        status: ListingStatus.SOLD,
        buyerId: user.id,
      });
      prisma.card.create.mockResolvedValue({ id: 'card-snapshot-1' });
      prisma.listing.update
        .mockResolvedValueOnce({ ...listing, cardId: 'card-snapshot-1' })
        .mockResolvedValueOnce({
          ...listing,
          status: ListingStatus.SOLD,
          buyerId: user.id,
          cardId: 'card-snapshot-1',
          nftId: 'nft-1',
          nft: { id: 'nft-1', assetAddress: 'AssetAddr', mintTx: 'SigTx' },
        });
      nft.mintForUser.mockResolvedValue({
        id: 'nft-1',
        assetAddress: 'AssetAddr',
        mintTx: 'SigTx',
      });

      const res = await service.buy('listing-1', user);

      expect(prisma.listing.updateMany).toHaveBeenCalledWith({
        where: { id: 'listing-1', status: ListingStatus.ACTIVE },
        data: {
          status: ListingStatus.SOLD,
          buyerId: user.id,
          soldAt: expect.any(Date),
        },
      });
      expect(prisma.card.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          name: 'Charizard VMAX',
          imageUrl: '/card4.png',
          set: 'Classic',
          rarity: 'Legendary Rare',
        }),
      });
      expect(nft.mintForUser).toHaveBeenCalledWith({
        userId: user.id,
        ownerAddress: user.walletAddress,
        cardId: 'card-snapshot-1',
      });
      expect(prisma.listing.update).toHaveBeenLastCalledWith({
        where: { id: 'listing-1' },
        data: { cardId: 'card-snapshot-1', nftId: 'nft-1' },
        include: { nft: true },
      });
      expect(res.nft?.assetAddress).toBe('AssetAddr');
    });

    it('rolls a fresh listing back to its seed state when mint fails', async () => {
      // Fresh listing: buyerId/nftId/soldAt are null, so the compensation
      // restores exactly that (previous "owner" is nobody).
      const listedWithCard = { ...listing, cardId: 'card-1' };
      prisma.listing.findUnique.mockResolvedValue(listedWithCard);
      prisma.listing.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.listing.findUniqueOrThrow.mockResolvedValue({
        ...listedWithCard,
        status: ListingStatus.SOLD,
        buyerId: user.id,
      });
      nft.mintForUser.mockRejectedValue(new Error('RPC timeout'));

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        'RPC timeout',
      );

      expect(prisma.listing.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'listing-1',
          status: ListingStatus.SOLD,
          buyerId: user.id,
          nftId: null,
        },
        data: {
          status: ListingStatus.ACTIVE,
          buyerId: null,
          soldAt: null,
        },
      });
      expect(prisma.listing.update).not.toHaveBeenCalled();
    });

    it('restores the previous owner + nftId when a re-listed card fails to mint', async () => {
      // A re-listed card carries the previous owner in buyerId and their NFT in
      // nftId. Compensation must restore THAT state, not reset to seed/null.
      const relisted = {
        ...listing,
        status: ListingStatus.ACTIVE,
        sellerId: 'owner-9',
        buyerId: 'owner-9',
        soldAt: now,
        nftId: 'nft-old',
        cardId: 'card-1',
      };
      prisma.listing.findUnique.mockResolvedValue(relisted);
      prisma.listing.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      prisma.listing.findUniqueOrThrow.mockResolvedValue({
        ...relisted,
        status: ListingStatus.SOLD,
        buyerId: user.id,
      });
      nft.mintForUser.mockRejectedValue(new Error('RPC timeout'));

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        'RPC timeout',
      );

      expect(prisma.listing.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'listing-1',
          status: ListingStatus.SOLD,
          buyerId: user.id,
          nftId: 'nft-old',
        },
        data: {
          status: ListingStatus.ACTIVE,
          buyerId: 'owner-9',
          soldAt: now,
        },
      });
      expect(prisma.listing.update).not.toHaveBeenCalled();
    });

    it('does not mint when another buyer already won the atomic update', async () => {
      prisma.listing.findUnique.mockResolvedValue(listing);
      prisma.listing.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        BadRequestException,
      );

      expect(nft.mintForUser).not.toHaveBeenCalled();
    });

    it('rejects self-buy before reserving the listing', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...listing,
        sellerId: user.id,
      });

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        BadRequestException,
      );

      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      expect(nft.mintForUser).not.toHaveBeenCalled();
    });
  });

  describe('relist', () => {
    const owned = {
      ...listing,
      status: ListingStatus.SOLD,
      sellerId: 'seller-1',
      buyerId: user.id,
      soldAt: now,
      nftId: 'nft-1',
      cardId: 'card-1',
    };

    it('flips SOLD/CANCELLED back to ACTIVE via the atomic updateMany', async () => {
      prisma.listing.findUnique.mockResolvedValue(owned);
      prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.listing.findUniqueOrThrow.mockResolvedValue({
        ...owned,
        status: ListingStatus.ACTIVE,
        sellerId: user.id,
        priceIdrx: 30_000_000,
        expectedValueIdrx: 33_000_000,
        buybackIdrx: 20_000_000,
        nft: null,
      });

      await service.relist(
        'listing-1',
        { price: 30_000_000, expectedValue: 33_000_000, buyback: 20_000_000 },
        user,
      );

      expect(prisma.listing.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'listing-1',
          buyerId: user.id,
          // FAKTA escrow yang keputusannya bersandar padanya ikut dipagar di WHERE: kalau
          // submitEscrow men-stamp escrowedAt di antara baca & tulis, klaim ini GAGAL.
          escrowedAt: null,
          status: {
            in: [
              ListingStatus.SOLD,
              ListingStatus.CANCELLED,
              ListingStatus.PENDING_ESCROW,
            ],
          },
        },
        data: {
          status: ListingStatus.ACTIVE,
          sellerId: user.id,
          sellerAddress: 'Buyer..se58',
          priceIdrx: 30_000_000,
          expectedValueIdrx: 33_000_000,
          buybackIdrx: 20_000_000,
          listedAt: expect.any(Date),
          escrowedAt: null,
        },
      });
    });

    it('throws when the caller is not the owner (buyerId mismatch)', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...owned,
        buyerId: 'someone-else',
      });

      await expect(
        service.relist('listing-1', { price: 30_000_000 }, user),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    });

    it('throws when the listing is already ACTIVE', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...owned,
        status: ListingStatus.ACTIVE,
      });

      await expect(
        service.relist('listing-1', { price: 30_000_000 }, user),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    });

    it('throws when the atomic updateMany matches nothing (count 0)', async () => {
      prisma.listing.findUnique.mockResolvedValue(owned);
      prisma.listing.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        service.relist('listing-1', { price: 30_000_000 }, user),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.listing.findUniqueOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('create (from pack)', () => {
    const puller = {
      id: 'puller-1',
      walletAddress: 'PullerWalletBase58',
      displayName: null,
      role: 'USER',
    };
    const fromPackDto = {
      name: 'Zubat',
      set: 'Neo Destiny',
      rarity: 'Rare',
      image: 'https://cc/zubat.png',
      price: 2_000_000,
      expectedValue: 2_200_000,
      grade: 'PSA 9',
      grader: Grader.PSA,
      gradeScore: 9,
      language: 'English',
      era: 'Classic',
      element: 'Poison',
      category: 'Full Art',
      fromPackMemo: 'hoshi-slug-abc',
    };

    it('verifies pull ownership, then links the listing to the real NFT (source CC + ccNftAddress)', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
      });
      prisma.listing.findUnique.mockResolvedValue(null); // not listed yet
      prisma.listing.create.mockResolvedValue({
        ...listing,
        source: ListingSource.COLLECTORCRYPT,
        ccNftAddress: 'CCAsset123',
        sellerId: puller.id,
      });

      await service.create(fromPackDto, puller);

      expect(prisma.ccPackPurchase.findFirst).toHaveBeenCalledWith({
        where: {
          memo: 'hoshi-slug-abc',
          userId: puller.id,
          status: CcPackStatus.OPENED,
        },
      });
      expect(prisma.listing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            source: ListingSource.COLLECTORCRYPT,
            ccNftAddress: 'CCAsset123',
            contractAddress: 'CCAsset123',
            sellerId: puller.id,
          }),
        }),
      );
    });

    it('takes the grade from the CC catalog and IGNORES what the client sent', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
        rarity: 'Rare',
        nftName: '2001 #16 Zubat CGC 9.5 Neo D',
      });
      prisma.listing.findUnique.mockResolvedValue(null);
      prisma.listing.create.mockResolvedValue(listing);

      // Klien mengirim "PSA 9" — persis bentuk data yang dulu bisa dikarang oleh
      // default form. Yang tersimpan harus jawaban CC, bukan itu.
      await service.create(fromPackDto, puller);

      expect(prisma.listing.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            grade: 'CGC 9.5',
            grader: Grader.CGC,
            gradeScore: 9.5,
            certificate: '1234567',
            name: '2001 #16 Zubat CGC 9.5 Neo Destiny',
            // CC tidak punya konsep "element" — kosong, bukan "Poison" kiriman klien.
            element: '',
            era: 'Classic',
            vaultLocation: 'CollectorCrypt OmniVault',
          }),
        }),
      );
    });

    it('refuses to list when CC cannot tell us the grade (no invented default)', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
      });
      prisma.listing.findUnique.mockResolvedValue(null);
      ccFacts.ensureFacts.mockResolvedValue(null);

      await expect(service.create(fromPackDto, puller)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('refuses a grader outside PSA/CGC/BGS instead of rounding it to the nearest one', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
      });
      prisma.listing.findUnique.mockResolvedValue(null);
      ccFacts.ensureFacts.mockResolvedValue({
        itemName: 'Zubat',
        gradeCompany: 'SGC',
        gradeScore: 9,
        gradeLabel: 'MINT 9',
        gradeCert: null,
        set: null,
        category: null,
        language: null,
        year: null,
        vault: null,
        serial: null,
      });

      await expect(service.create(fromPackDto, puller)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('rejects when the pull is not the caller’s / not OPENED', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue(null);

      await expect(service.create(fromPackDto, puller)).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('rejects when the pulled card is already actively listed', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
      });
      prisma.listing.findUnique.mockResolvedValue({
        ...listing,
        status: ListingStatus.ACTIVE,
        ccNftAddress: 'CCAsset123',
      });

      await expect(service.create(fromPackDto, puller)).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });

    it('re-lists a previously cancelled pull instead of hitting the unique index', async () => {
      prisma.ccPackPurchase.findFirst.mockResolvedValue({
        nftAddress: 'CCAsset123',
        status: CcPackStatus.OPENED,
      });
      prisma.listing.findUnique.mockResolvedValue({
        ...listing,
        status: ListingStatus.CANCELLED,
        sellerId: puller.id,
        ccNftAddress: 'CCAsset123',
      });
      prisma.listing.update.mockResolvedValue({
        ...listing,
        status: ListingStatus.ACTIVE,
        sellerId: puller.id,
      });

      await service.create(fromPackDto, puller);

      expect(prisma.listing.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ListingStatus.ACTIVE,
            priceIdrx: 2_000_000,
          }),
        }),
      );
      expect(prisma.listing.create).not.toHaveBeenCalled();
    });
  });

  describe('buy — CollectorCrypt source guard', () => {
    it('blocks buying a SYNCED catalog CC card (no seller)', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...listing,
        source: ListingSource.COLLECTORCRYPT,
        sellerId: null,
      });

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        BadRequestException,
      );
      // Blocked BEFORE reserving the listing.
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    });

    it('allows buying a user-listed pulled CC card (seller set) — reaches reservation', async () => {
      prisma.listing.findUnique.mockResolvedValue({
        ...listing,
        source: ListingSource.COLLECTORCRYPT,
        sellerId: 'seller-9',
      });
      // Lose the atomic race so we stop early — the point is we got PAST the guard.
      prisma.listing.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(service.buy('listing-1', user)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.listing.updateMany).toHaveBeenCalled();
    });
  });

  describe('listPurchases', () => {
    it('queries by buyerId only, without a status filter', async () => {
      prisma.listing.findMany.mockResolvedValue([]);

      await service.listPurchases('buyer-1');

      expect(prisma.listing.findMany).toHaveBeenCalledWith({
        where: { buyerId: 'buyer-1' },
        include: { nft: true },
        orderBy: { soldAt: 'desc' },
      });
    });
  });

  // ── F3: escrow-saat-listing (real P2P armed) ──────────────────────────────
  describe('escrow-at-listing (F3, real P2P armed)', () => {
    const seller = {
      id: 'seller-1',
      walletAddress: 'SellerWalletBase58',
      displayName: null,
      role: 'USER',
    };
    const fromPackDto = {
      name: 'Zubat',
      set: 'Neo Destiny',
      rarity: 'Rare',
      image: 'https://cc/zubat.png',
      price: 2_000_000,
      expectedValue: 2_200_000,
      grade: 'PSA 9',
      grader: Grader.PSA,
      gradeScore: 9,
      language: 'English',
      era: 'Classic',
      element: 'Poison',
      category: 'Full Art',
      fromPackMemo: 'hoshi-slug-abc',
    };
    const pendingListing = {
      ...listing,
      status: ListingStatus.PENDING_ESCROW,
      sellerId: seller.id,
      ccNftAddress: 'CCAsset123',
    };

    describe('create/relist gating', () => {
      it('fresh pull listing is created PENDING_ESCROW when armed (no "listed" activity yet)', async () => {
        armP2p();
        prisma.ccPackPurchase.findFirst.mockResolvedValue({
          nftAddress: 'CCAsset123',
          status: CcPackStatus.OPENED,
        });
        prisma.listing.findUnique.mockResolvedValue(null);
        prisma.listing.create.mockResolvedValue({
          ...pendingListing,
          nft: null,
        });

        await service.create(fromPackDto, seller);

        expect(prisma.listing.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: ListingStatus.PENDING_ESCROW,
              ccNftAddress: 'CCAsset123',
            }),
          }),
        );
        // Umumkan "listed" hanya setelah kartu di escrow (submitEscrow), bukan sekarang.
        expect(prisma.activity.create).not.toHaveBeenCalled();
      });

      it('mock/unarmed keeps the classic ACTIVE path (no PENDING_ESCROW)', async () => {
        // config default → p2pRealArmed()=false
        prisma.ccPackPurchase.findFirst.mockResolvedValue({
          nftAddress: 'CCAsset123',
          status: CcPackStatus.OPENED,
        });
        prisma.listing.findUnique.mockResolvedValue(null);
        prisma.listing.create.mockResolvedValue({ ...listing, nft: null });

        await service.create(fromPackDto, seller);

        expect(prisma.listing.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: ListingStatus.ACTIVE }),
          }),
        );
        expect(prisma.activity.create).toHaveBeenCalled();
      });

      it('relist of an owned card goes PENDING_ESCROW when armed', async () => {
        armP2p();
        const owned = {
          ...listing,
          status: ListingStatus.SOLD,
          sellerId: 'prev-seller',
          buyerId: user.id,
          ccNftAddress: 'CCAsset123',
        };
        prisma.listing.findUnique.mockResolvedValue(owned);
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...owned,
          status: ListingStatus.PENDING_ESCROW,
          sellerId: user.id,
          nft: null,
        });

        await service.relist('listing-1', { price: 30_000_000 }, user);

        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: ListingStatus.PENDING_ESCROW,
            }),
          }),
        );
        expect(prisma.activity.create).not.toHaveBeenCalled();
      });
    });

    /**
     * ╔════════════════════════════════════════════════════════════════════════════════════════╗
     * ║ B — POPULASI BUNTU TIDAK BOLEH LAHIR LAGI SESUDAH ARMING.                              ║
     * ╚════════════════════════════════════════════════════════════════════════════════════════╝
     *
     * `POST /marketplace` TANPA fromPackMemo membuat listing USER ber-ccNftAddress NULL. Saat
     * ARMED, baris seperti itu tidak bisa dititipkan, tidak bisa diserahkan, tidak tampil di feed
     * publik, dan tidak bisa dipulihkan dengan relist — satu-satunya yang pernah terjadi padanya
     * adalah pemiliknya disuruh membatalkannya. Membersihkannya SEBELUM arming (langkah runbook)
     * tidak ada gunanya kalau aplikasinya mengisinya kembali SESUDAH arming.
     */
    describe('create — listing user tanpa aset on-chain saat ARMED', () => {
      const typedCardDto = {
        name: 'Charizard (ketik manual)',
        image: '/card1.png',
        price: 2_000_000,
        expectedValue: 2_200_000,
        grade: 'PSA 10',
        grader: Grader.PSA,
        gradeScore: 10,
      };

      it('ARMED: DITOLAK di titik lahirnya, dengan sebab yang benar & nol baris dibuat', async () => {
        armP2p();

        await expect(service.create(typedCardDto, seller)).rejects.toMatchObject(
          {
            response: {
              code: 'P2P_LISTING_NOT_ESCROWED',
              stage: 'NO_EFFECT',
              // Pesannya harus menyuruh penjual melakukan sesuatu yang BISA berhasil.
              message: expect.stringContaining('Vault') as unknown,
            },
          },
        );
        expect(prisma.listing.create).not.toHaveBeenCalled();
        expect(prisma.activity.create).not.toHaveBeenCalled();
      });

      it('UNARMED/MOCK: listing ketikan biasa TETAP SAH — staging & demo tak berubah', async () => {
        // config default → mode OFF (dan MOCK berperilaku sama di gerbang ini).
        prisma.listing.create.mockResolvedValue({ ...listing, nft: null });

        await service.create(typedCardDto, seller);

        expect(prisma.listing.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              status: ListingStatus.ACTIVE,
              ccNftAddress: undefined,
            }),
          }),
        );
      });

      it('ARMED: kartu hasil pull (punya aset on-chain) TIDAK ikut tertolak', async () => {
        armP2p();
        prisma.ccPackPurchase.findFirst.mockResolvedValue({
          nftAddress: 'CCAsset123',
          status: CcPackStatus.OPENED,
        });
        prisma.listing.findUnique.mockResolvedValue(null);
        prisma.listing.create.mockResolvedValue({
          ...pendingListing,
          nft: null,
        });

        await expect(
          service.create(fromPackDto, seller),
        ).resolves.toBeDefined();
        expect(prisma.listing.create).toHaveBeenCalled();
      });
    });

    /**
     * ╔════════════════════════════════════════════════════════════════════════════════════════╗
     * ║ F1 — MEMAJANG ULANG TIDAK BOLEH MENGHAPUS SATU-SATUNYA PETUNJUK KARTU YANG TERTINGGAL. ║
     * ╚════════════════════════════════════════════════════════════════════════════════════════╝
     *
     * Baris CANCELLED ber-`escrowedAt` adalah baris yang `cancel` SENGAJA tinggalkan ketika
     * pengembalian kartu dari escrow GAGAL — isi daftar `stranded` operator. Memajangnya ulang
     * dulu menulis `escrowedAt: null`, dan sesudah itu kartu yang on-chain masih dipegang escrow
     * tidak muncul di satu pun dari tiga daftar operator.
     */
    describe('relist — fakta escrow hanya boleh dihapus dengan BUKTI', () => {
      const strandedRow = {
        ...listing,
        id: 'listing-stranded',
        sellerId: 'seller-1',
        buyerId: null,
        ccNftAddress: 'CCAsset123',
        escrowedAt: now, // cancel GAGAL mengembalikan kartunya
        status: ListingStatus.CANCELLED,
      };
      const strandedSeller = { ...user, id: 'seller-1' };

      it('escrow MASIH memegang kartunya → DITOLAK, dan barisnya tetap utuh (tetap "stranded")', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue(strandedRow);
        escrow.checkOwnsAsset.mockResolvedValue(true);

        await expect(
          service.relist('listing-stranded', { price: 1 }, strandedSeller),
        ).rejects.toMatchObject({
          response: {
            code: 'P2P_LISTING_ESCROW_HELD',
            stage: 'NO_EFFECT',
            listingId: 'listing-stranded',
          },
        });

        // TIDAK ADA tulisan sama sekali: `escrowedAt` tetap ter-set, jadi baris ini tetap
        // terlihat operator di daftar `stranded` dan tetap bisa dipulihkan admin.
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('rantai TIDAK TERBACA → DITOLAK juga (fail-closed), bukan diasumsikan sudah kembali', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue(strandedRow);
        escrow.checkOwnsAsset.mockResolvedValue(null); // RPC gagal / aset tak terindeks

        await expect(
          service.relist('listing-stranded', { price: 1 }, strandedSeller),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_ESCROW_HELD', stage: 'NO_EFFECT' },
        });
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('escrow TERBUKTI tidak memegangnya → relist berjalan & fakta escrow dibersihkan', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue(strandedRow);
        escrow.checkOwnsAsset.mockResolvedValue(false); // kartunya memang sudah kembali
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...strandedRow,
          status: ListingStatus.PENDING_ESCROW,
          escrowedAt: null,
          nft: null,
        });

        await service.relist('listing-stranded', { price: 1 }, strandedSeller);

        expect(escrow.checkOwnsAsset).toHaveBeenCalledWith('CCAsset123');
        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            // Klaim atomiknya ikut memagari fakta yang barusan dibuktikan.
            where: expect.objectContaining({ escrowedAt: now }),
            data: expect.objectContaining({ escrowedAt: null }),
          }),
        );
      });

      it('listing tanpa fakta escrow: NOL panggilan RPC (jalur normal tidak ikut membayar)', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...strandedRow,
          escrowedAt: null,
        });
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...strandedRow,
          escrowedAt: null,
          status: ListingStatus.PENDING_ESCROW,
          nft: null,
        });

        await service.relist('listing-stranded', { price: 1 }, strandedSeller);

        expect(escrow.checkOwnsAsset).not.toHaveBeenCalled();
      });

      it('jalur create(fromPackMemo) yang menemukan baris lama digerbang SAMA', async () => {
        // Kalau hanya `relist()` yang digerbang, "jual lagi kartu hasil pull saya" tetap
        // menghapus petunjuknya lewat pintu sebelah.
        armP2p();
        prisma.ccPackPurchase.findFirst.mockResolvedValue({
          nftAddress: 'CCAsset123',
          status: CcPackStatus.OPENED,
        });
        prisma.listing.findUnique.mockResolvedValue(strandedRow);
        escrow.checkOwnsAsset.mockResolvedValue(true);

        await expect(
          service.create(fromPackDto, { ...seller, id: 'seller-1' }),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_ESCROW_HELD' },
        });
        expect(prisma.listing.update).not.toHaveBeenCalled();
        // Digerbang SEBELUM menyentuh katalog CC: penolakannya tidak boleh bergantung pada
        // ketersediaan pihak ketiga.
        expect(ccFacts.ensureFacts).not.toHaveBeenCalled();
      });
    });

    describe('prepareEscrow', () => {
      it('builds the transfer-to-escrow tx for the owner of a PENDING_ESCROW listing', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        escrow.buildTransferToEscrowTx.mockResolvedValue('BASE64_UNSIGNED');

        const res = await service.prepareEscrow('listing-1', seller);

        expect(res).toEqual({ serializedTransaction: 'BASE64_UNSIGNED' });
        // C — listingId + sellerId WAJIB ikut: ledger sponsor gas memakainya untuk plafon
        // per-penjual / 24 jam. Tanpa keduanya, fee yang ditanggung escrow tak bisa diplafon.
        expect(escrow.buildTransferToEscrowTx).toHaveBeenCalledWith({
          assetAddress: 'CCAsset123',
          ownerWallet: seller.walletAddress,
          listingId: 'listing-1',
          sellerId: seller.id,
        });
      });

      it('rejects a non-owner', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        await expect(service.prepareEscrow('listing-1', user)).rejects.toThrow(
          ForbiddenException,
        );
        expect(escrow.buildTransferToEscrowTx).not.toHaveBeenCalled();
      });

      it('rejects a listing that is not PENDING_ESCROW', async () => {
        prisma.listing.findUnique.mockResolvedValue({
          ...pendingListing,
          status: ListingStatus.ACTIVE,
        });
        await expect(
          service.prepareEscrow('listing-1', seller),
        ).rejects.toThrow(BadRequestException);
        expect(escrow.buildTransferToEscrowTx).not.toHaveBeenCalled();
      });
    });

    describe('submitEscrow', () => {
      it('broadcasts, VERIFIES escrow ownership, then activates + marks escrowedAt + records LISTED_CARD', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        escrow.ownsAsset.mockResolvedValue(false);
        escrow.broadcastSignedToEscrow.mockResolvedValue('sig-1');
        escrow.ownsAssetWithRetry.mockResolvedValue(true); // escrow really got the card
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...pendingListing,
          status: ListingStatus.ACTIVE,
          nft: null,
        });

        await service.submitEscrow(
          'listing-1',
          { signedTransaction: 'SIGNED64' },
          seller,
        );

        expect(escrow.broadcastSignedToEscrow).toHaveBeenCalledWith('SIGNED64');
        expect(escrow.ownsAssetWithRetry).toHaveBeenCalledWith('CCAsset123');
        expect(prisma.listing.updateMany).toHaveBeenCalledWith({
          where: {
            id: 'listing-1',
            sellerId: seller.id,
            status: ListingStatus.PENDING_ESCROW,
          },
          data: {
            status: ListingStatus.ACTIVE,
            listedAt: expect.any(Date),
            escrowedAt: expect.any(Date),
          },
        });
        expect(prisma.activity.create).toHaveBeenCalled();
      });

      it('REFUSES to activate if escrow did not actually receive the card after broadcast (arbitrary tx)', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        escrow.ownsAsset.mockResolvedValue(false);
        escrow.broadcastSignedToEscrow.mockResolvedValue('sig-bogus');
        escrow.ownsAssetWithRetry.mockResolvedValue(false); // card never landed in escrow

        await expect(
          service.submitEscrow(
            'listing-1',
            { signedTransaction: 'SOME_OTHER_TX' },
            seller,
          ),
        ).rejects.toThrow(UnprocessableEntityException);
        // Never flips to ACTIVE — listing stays PENDING_ESCROW, buyer can't pay for a non-escrowed card.
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('is idempotent: if escrow already owns the card, skip broadcast but still activate', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        escrow.ownsAsset.mockResolvedValue(true);
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...pendingListing,
          status: ListingStatus.ACTIVE,
          nft: null,
        });

        await service.submitEscrow(
          'listing-1',
          { signedTransaction: 'SIGNED64' },
          seller,
        );

        expect(escrow.broadcastSignedToEscrow).not.toHaveBeenCalled();
        expect(prisma.listing.updateMany).toHaveBeenCalled();
      });

      it('throws ConflictException when the listing is no longer PENDING_ESCROW at activation (e.g. cancelled)', async () => {
        prisma.listing.findUnique.mockResolvedValue(pendingListing);
        escrow.ownsAsset.mockResolvedValue(false);
        escrow.broadcastSignedToEscrow.mockResolvedValue('sig-1');
        escrow.ownsAssetWithRetry.mockResolvedValue(true); // ownership verified; race is on the DB flip
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 0 });

        await expect(
          service.submitEscrow(
            'listing-1',
            { signedTransaction: 'SIGNED64' },
            seller,
          ),
        ).rejects.toThrow(ConflictException);
        expect(prisma.activity.create).not.toHaveBeenCalled();
      });
    });

    describe('cancel — escrow return', () => {
      // Card genuinely deposited in escrow (submitEscrow set escrowedAt).
      const escrowed = {
        ...listing,
        status: ListingStatus.ACTIVE,
        sellerId: seller.id,
        ccNftAddress: 'CCAsset123',
        escrowedAt: now,
      };
      // Never escrowed (mock/unarmed ACTIVE, or PENDING_ESCROW unsigned): escrowedAt null.
      const notEscrowed = {
        ...listing,
        status: ListingStatus.ACTIVE,
        sellerId: seller.id,
        ccNftAddress: 'CCAsset123',
        escrowedAt: null,
      };

      it('returns the card DIRECTLY (no ownsAsset gate) when escrowedAt is set, then clears the marker', async () => {
        prisma.listing.findUnique.mockResolvedValue(escrowed);
        prisma.listing.updateMany.mockResolvedValue({ count: 1 }); // CANCELLED flip + escrowedAt clear
        escrow.transferCoreAssetTo.mockResolvedValue('sig-return');
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...escrowed,
          status: ListingStatus.CANCELLED,
          escrowedAt: null,
          nft: null,
        });

        await service.cancel('listing-1', seller);

        // Called directly — no ownsAsset short-circuit that could swallow a transient RPC read.
        expect(escrow.ownsAsset).not.toHaveBeenCalled();
        expect(escrow.transferCoreAssetTo).toHaveBeenCalledWith({
          assetAddress: 'CCAsset123',
          newOwner: seller.walletAddress,
        });
        // Marker cleared after successful return.
        expect(prisma.listing.updateMany).toHaveBeenCalledWith({
          where: { id: 'listing-1' },
          data: { escrowedAt: null },
        });
      });

      it('does NOT touch escrow when escrowedAt is null (card never deposited — mock/unarmed or unsigned)', async () => {
        prisma.listing.findUnique.mockResolvedValue(notEscrowed);
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...notEscrowed,
          status: ListingStatus.CANCELLED,
          nft: null,
        });

        await service.cancel('listing-1', seller);

        expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
      });

      it('self-race fallback: PENDING_ESCROW with escrowedAt still null but escrow already holds the card → returns it', async () => {
        // submitEscrow in-flight deposited the card but hadn't persisted escrowedAt when cancel won.
        prisma.listing.findUnique.mockResolvedValue({
          ...notEscrowed,
          status: ListingStatus.PENDING_ESCROW,
          escrowedAt: null,
        });
        prisma.listing.updateMany.mockResolvedValue({ count: 1 });
        escrow.ownsAsset.mockResolvedValue(true); // deposit already landed
        escrow.transferCoreAssetTo.mockResolvedValue('sig-return');
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...notEscrowed,
          status: ListingStatus.CANCELLED,
          nft: null,
        });

        await service.cancel('listing-1', seller);

        expect(escrow.ownsAsset).toHaveBeenCalledWith('CCAsset123');
        expect(escrow.transferCoreAssetTo).toHaveBeenCalled();
      });

      it('self-race: fakta "escrow memegangnya" DICATAT dulu, supaya pengembalian yang gagal tetap terlihat', async () => {
        // Tanpa pencatatan ini, kartu yang gagal dikembalikan di jalur self-race tertinggal di
        // baris CANCELLED ber-escrowedAt NULL — tidak muncul di `held`, `stranded`, MAUPUN
        // `unescrowedActive`. Fakta yang sudah kita ketahui tidak boleh mati bersama request.
        prisma.listing.findUnique.mockResolvedValue({
          ...notEscrowed,
          status: ListingStatus.PENDING_ESCROW,
          escrowedAt: null,
        });
        prisma.listing.updateMany.mockResolvedValue({ count: 1 });
        escrow.ownsAsset.mockResolvedValue(true);
        escrow.transferCoreAssetTo.mockRejectedValue(new Error('rpc down'));
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...notEscrowed,
          status: ListingStatus.CANCELLED,
          nft: null,
        });

        await service.cancel('listing-1', seller);

        // Dicatat berpagar (tidak menimpa stempel asli submitEscrow)...
        expect(prisma.listing.updateMany).toHaveBeenCalledWith({
          where: { id: 'listing-1', escrowedAt: null },
          data: { escrowedAt: expect.any(Date) as unknown },
        });
        // ...dan TIDAK dibersihkan lagi, karena pengembaliannya gagal: baris ini WAJIB tetap
        // membawa faktanya supaya muncul di daftar `stranded`.
        expect(prisma.listing.updateMany).not.toHaveBeenCalledWith({
          where: { id: 'listing-1' },
          data: { escrowedAt: null },
        });
      });

      it('returns the card even if P2P was DISARMED after escrow (gate is escrowedAt, not the live flag)', async () => {
        // config default → p2pRealArmed()=false, but escrowedAt proves the card is in escrow.
        prisma.listing.findUnique.mockResolvedValue(escrowed);
        prisma.listing.updateMany.mockResolvedValue({ count: 1 });
        escrow.transferCoreAssetTo.mockResolvedValue('sig-return');
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...escrowed,
          status: ListingStatus.CANCELLED,
          nft: null,
        });

        await service.cancel('listing-1', seller);

        expect(escrow.transferCoreAssetTo).toHaveBeenCalled();
      });

      it('still CANCELS even if the escrow return fails (logged for manual return, no refund)', async () => {
        prisma.listing.findUnique.mockResolvedValue(escrowed);
        prisma.listing.updateMany.mockResolvedValue({ count: 1 });
        escrow.transferCoreAssetTo.mockRejectedValue(new Error('rpc down'));
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...escrowed,
          status: ListingStatus.CANCELLED,
          nft: null,
        });

        await expect(
          service.cancel('listing-1', seller),
        ).resolves.toBeDefined();
      });
    });

    describe('escrow-backed listings block the demo instant-sale paths', () => {
      const escrowedActive = {
        ...listing,
        status: ListingStatus.ACTIVE,
        sellerId: 'seller-9',
        ccNftAddress: 'CCAsset123',
        escrowedAt: now,
      };

      it('buy() refuses an escrow-backed listing (must settle via Rupiah rail)', async () => {
        prisma.listing.findUnique.mockResolvedValue(escrowedActive);

        await expect(service.buy('listing-1', user)).rejects.toThrow(
          BadRequestException,
        );
        // Never reserves / mints.
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
        expect(nft.mintForUser).not.toHaveBeenCalled();
      });
    });

    /**
     * F4 — PEMULIHAN YANG DIDOKUMENTASIKAN HARUS BENAR-BENAR BERJALAN.
     *
     * Setiap pesan `P2P_LISTING_NOT_ESCROWED` menyuruh penjual "memajang ulang". Sebelum
     * pass ini `relist()` menuntut `buyerId === user.id`, dan `create()` TIDAK PERNAH
     * mengisi `buyerId` — jadi untuk listing yang dibuat-dan-belum-pernah-terjual (yaitu
     * SELURUH populasi yang pesan itu tuju) jawabannya selalu 400 "Only the owner can list
     * this card." Jalan yang benar-benar bekerja adalah dua langkah di endpoint LAIN
     * (cancel → POST /marketplace dengan fromPackMemo), yang juga menjalankan ulang
     * `ccListingAttrs()` dan bisa gagal 422 karena CC lambat.
     */
    describe('relist — pemulihan satu-aksi untuk listing yang BELUM PERNAH TERJUAL', () => {
      it('penjual pemilik listing ACTIVE tanpa escrow: relist → PENDING_ESCROW, TANPA menyentuh CC', async () => {
        armP2p();
        const unsold = {
          ...listing,
          id: 'listing-unsold',
          sellerId: 'seller-1',
          buyerId: null, // create() tidak pernah mengisinya
          ccNftAddress: 'CCAsset123',
          escrowedAt: null,
          status: ListingStatus.ACTIVE,
        };
        prisma.listing.findUnique.mockResolvedValue(unsold);
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...unsold,
          status: ListingStatus.PENDING_ESCROW,
          nft: null,
        });

        await service.relist(
          'listing-unsold',
          { price: 30_000_000 },
          { ...user, id: 'seller-1' },
        );

        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'listing-unsold',
              buyerId: null,
              sellerId: 'seller-1',
              status: ListingStatus.ACTIVE,
              escrowedAt: null,
            }),
            data: expect.objectContaining({
              status: ListingStatus.PENDING_ESCROW,
              escrowedAt: null,
            }),
          }),
        );
        // Pemulihan tidak boleh bisa gagal karena CollectorCrypt lambat / grade tak didukung.
        expect(ccFacts.ensureFacts).not.toHaveBeenCalled();
      });

      it('BUKAN pemiliknya tetap ditolak (pelonggaran kepemilikan hanya untuk baris belum-terjual)', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...listing,
          sellerId: 'seller-1',
          buyerId: null,
          status: ListingStatus.CANCELLED,
        });

        await expect(
          service.relist(
            'listing-1',
            { price: 1 },
            { ...user, id: 'someone-else' },
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('baris yang PERNAH TERJUAL tetap milik PEMBELI — penjual lama tak bisa merebutnya', async () => {
        prisma.listing.findUnique.mockResolvedValue({
          ...listing,
          sellerId: 'seller-1',
          buyerId: 'buyer-1',
          status: ListingStatus.SOLD,
        });

        await expect(
          service.relist(
            'listing-1',
            { price: 1 },
            { ...user, id: 'seller-1' },
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('listing ACTIVE yang SEHAT (ber-escrow) tetap ditolak — ubah harga lewat PATCH', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...listing,
          sellerId: 'seller-1',
          buyerId: null,
          ccNftAddress: 'CCAsset123',
          escrowedAt: now,
          status: ListingStatus.ACTIVE,
        });

        await expect(
          service.relist(
            'listing-1',
            { price: 1 },
            { ...user, id: 'seller-1' },
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('listing user TANPA aset on-chain: relist menjawab SEBAB yang benar, bukan "already active"', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...listing,
          sellerId: 'seller-1',
          buyerId: null,
          ccNftAddress: null,
          escrowedAt: null,
          status: ListingStatus.ACTIVE,
        });

        await expect(
          service.relist(
            'listing-1',
            { price: 1 },
            { ...user, id: 'seller-1' },
          ),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED', stage: 'NO_EFFECT' },
        });
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      });

      it('UNARMED: relist listing ACTIVE tetap ditolak seperti dulu', async () => {
        prisma.listing.findUnique.mockResolvedValue({
          ...listing,
          sellerId: 'seller-1',
          buyerId: null,
          status: ListingStatus.ACTIVE,
        });

        await expect(
          service.relist(
            'listing-1',
            { price: 1 },
            { ...user, id: 'seller-1' },
          ),
        ).rejects.toThrow(BadRequestException);
      });
    });

    describe('relist tolerates PENDING_ESCROW (recovery from a rejected escrow signature)', () => {
      it('re-emits a stuck PENDING_ESCROW bought card and resets escrowedAt', async () => {
        armP2p();
        const stuck = {
          ...listing,
          status: ListingStatus.PENDING_ESCROW,
          sellerId: user.id,
          buyerId: user.id,
          ccNftAddress: 'CCAsset123',
          escrowedAt: null,
        };
        prisma.listing.findUnique.mockResolvedValue(stuck);
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue({
          ...stuck,
          nft: null,
        });

        await service.relist('listing-1', { price: 30_000_000 }, user);

        expect(prisma.listing.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: expect.objectContaining({
                in: expect.arrayContaining([ListingStatus.PENDING_ESCROW]),
              }),
            }),
            data: expect.objectContaining({
              status: ListingStatus.PENDING_ESCROW,
              escrowedAt: null,
            }),
          }),
        );
      });
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ A + B — SURFACE PEMBELI TIDAK BOLEH PERNAH MENAWARKAN APA YANG TAK BISA DISERAHKAN.      ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Dua kebocoran yang berbeda, satu gerbang:
   *   A — P2P MATI: setiap Rupiah yang mendarat untuk listing user PASTI berakhir refund manual.
   *   B — P2P NYALA tapi listing lahir SEBELUM arming: escrow tak pernah memegang kartunya.
   *
   * Semua pemeriksaan bersandar pada FAKTA escrowedAt, bukan pada flag saat itu.
   */
  describe('gerbang P2P pada surface marketplace (A + B)', () => {
    const userCard = {
      ...listing,
      id: 'listing-user',
      sellerId: 'seller-1',
      ccNftAddress: 'CCAsset123',
      escrowedAt: null as Date | null,
      source: ListingSource.COLLECTORCRYPT,
    };

    /**
     * POPULASI YANG DULU LOLOS DARI SEMUA PAGAR: listing USER tanpa aset on-chain.
     *
     * Ia dibuat oleh `POST /marketplace` TANPA fromPackMemo — jalur yang butuh nol
     * prasyarat selain login. Semua fixture listing-user di file ini punya `ccNftAddress`,
     * dan ITULAH sebabnya tidak ada satu pun test yang menangkap lubangnya: setiap pagar
     * menuliskan `ccNftAddress != null` sebagai SYARAT sebelum memeriksa escrow, jadi baris
     * ini melewati semuanya — tidak ditolak, tampil di feed, tidak ditandai ke pemiliknya,
     * tidak dihitung di radius ledakan — lalu diklaim SOLD dan ditolak tanpa rollback.
     */
    const userCardNoAsset = {
      ...userCard,
      id: 'listing-user-noasset',
      ccNftAddress: null as string | null,
      source: ListingSource.HOSHI,
    };

    describe('feed publik (list)', () => {
      it('ARMED: listing user TANPA escrow DIKECUALIKAN dari feed', async () => {
        armP2p();
        prisma.listing.findMany.mockResolvedValue([]);

        await service.list({});

        // Predikatnya harus persis negasi "escrow-backed" untuk listing USER:
        // punya penjual DAN (tanpa aset on-chain ATAU tanpa escrow). `OR` itu bagian dari
        // pagarnya: versi lama menuntut `ccNftAddress: { not: null }`, sehingga listing user
        // TANPA aset on-chain tetap tampil di feed publik walau ia tak pernah bisa disettle.
        expect(prisma.listing.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: ListingStatus.ACTIVE,
              NOT: {
                sellerId: { not: null },
                OR: [{ ccNftAddress: null }, { escrowedAt: null }],
              },
            }),
          }),
        );
      });

      it('UNARMED: feed TIDAK difilter (perilaku lama; tak ada escrow yang diwajibkan)', async () => {
        prisma.listing.findMany.mockResolvedValue([]);

        await service.list({});

        const arg = prisma.listing.findMany.mock.calls[0][0];
        expect(arg.where.NOT).toBeUndefined();
      });

      it('ARMED: DTO menandai listing tanpa escrow needsEscrowDeposit=true (pemilik disuruh relist)', async () => {
        armP2p();
        prisma.listing.findMany.mockResolvedValue([userCard]);

        const [dto] = await service.listMine('seller-1');

        expect(dto.escrowed).toBe(false);
        expect(dto.needsEscrowDeposit).toBe(true);
      });

      it('ARMED: listing user TANPA aset on-chain JUGA ditandai needsEscrowDeposit', async () => {
        // Dulu false: serializer menuntut `ccNftAddress != null` sebelum menandai, jadi
        // pemilik baris ini tidak pernah diberi tahu bahwa kartunya tak bisa dibeli.
        armP2p();
        prisma.listing.findMany.mockResolvedValue([userCardNoAsset]);

        const [dto] = await service.listMine('seller-1');

        expect(dto.escrowed).toBe(false);
        expect(dto.needsEscrowDeposit).toBe(true);
        // UI membedakan dua sub-kasus dari field ini: null ⇒ tidak bisa dipulihkan
        // dengan relist, satu-satunya jalan adalah membatalkan listing-nya.
        expect(dto.ccNftAddress).toBeNull();
      });

      it('ARMED: listing yang BER-escrow tidak ditandai', async () => {
        armP2p();
        prisma.listing.findMany.mockResolvedValue([
          { ...userCard, escrowedAt: new Date('2026-07-01T00:00:00.000Z') },
        ]);

        const [dto] = await service.listMine('seller-1');

        expect(dto.escrowed).toBe(true);
        expect(dto.needsEscrowDeposit).toBe(false);
      });

      it('UNARMED: TIDAK pernah menandai needsEscrowDeposit (mock/unarmed memang tanpa escrow)', async () => {
        prisma.listing.findMany.mockResolvedValue([userCard]);

        const [dto] = await service.listMine('seller-1');

        expect(dto.needsEscrowDeposit).toBe(false);
      });

      it('map DTO memakai lambda, BUKAN .map(toListingDto) — index tidak boleh jadi opts', async () => {
        // Regresi khusus: `rows.map(toListingDto)` mengoper (nilai, INDEX, array). Index numerik
        // sebagai `opts` akan mematikan penandaan needsEscrowDeposit pada SEMUA baris tanpa satu
        // pun error TypeScript. Dua baris sudah cukup untuk menangkapnya.
        armP2p();
        prisma.listing.findMany.mockResolvedValue([
          { ...userCard, id: 'a' },
          { ...userCard, id: 'b' },
        ]);

        const dtos = await service.listMine('seller-1');

        expect(dtos.map((d) => d.needsEscrowDeposit)).toEqual([true, true]);
      });
    });

    describe('submitOffer', () => {
      it('P2P MATI → P2P_DISABLED, NOL offer dibuat', async () => {
        prisma.listing.findUnique.mockResolvedValue(userCard);

        await expect(
          service.submitOffer('listing-user', user, 1_000),
        ).rejects.toMatchObject({
          response: { code: 'P2P_DISABLED', stage: 'NO_EFFECT' },
        });
        expect(prisma.offer.create).not.toHaveBeenCalled();
      });

      it('ARMED tanpa escrow → P2P_LISTING_NOT_ESCROWED, NOL offer dibuat', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue(userCard);

        await expect(
          service.submitOffer('listing-user', user, 1_000),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED' },
        });
        expect(prisma.offer.create).not.toHaveBeenCalled();
      });

      it('ARMED + listing user TANPA aset on-chain → DITOLAK juga, NOL offer dibuat', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue(userCardNoAsset);

        await expect(
          service.submitOffer('listing-user-noasset', user, 1_000),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED', stage: 'NO_EFFECT' },
        });
        expect(prisma.offer.create).not.toHaveBeenCalled();
      });

      it('ARMED + ber-escrow → offer dibuat seperti biasa', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...userCard,
          escrowedAt: new Date('2026-07-01T00:00:00.000Z'),
        });
        prisma.offer.create.mockResolvedValue({
          id: 'offer-1',
          listingId: 'listing-user',
          buyerId: user.id,
          user: 'Buyer',
          amount: 1_000,
          status: 'PENDING',
          createdAt: now,
          listing: { ...userCard, seller: null },
          buyer: null,
        });

        await service.submitOffer('listing-user', user, 1_000);

        expect(prisma.offer.create).toHaveBeenCalled();
      });
    });

    describe('acceptOffer', () => {
      const offerRow = {
        id: 'offer-1',
        listingId: 'listing-user',
        buyerId: 'buyer-1',
        user: 'Buyer',
        amount: 1_000,
        status: 'PENDING',
        createdAt: now,
        listing: {
          ...userCard,
          seller: null,
        },
        buyer: null,
      };
      const seller = {
        id: 'seller-1',
        walletAddress: 'SellerWallet',
        displayName: null,
        role: 'USER',
      };

      it('P2P MATI → ditolak SEBELUM offer ditandai ACCEPTED (penjual tahu lebih dulu)', async () => {
        // Accept tidak menyentuh uang, tapi ia SATU-SATUNYA hal yang membuka tombol "lanjut
        // bayar" dan ia menutup semua offer saingan. Menerimanya untuk kartu yang tak bisa
        // diserahkan = penjual diberi tahu "terjual", penawar lain ditolak, pemenang berjalan
        // lurus ke halaman bayar yang akan menolaknya.
        prisma.offer.findUnique.mockResolvedValue(offerRow);
        prisma.listing.findUnique.mockResolvedValue(userCard);

        await expect(
          service.acceptOffer('offer-1', seller),
        ).rejects.toMatchObject({ response: { code: 'P2P_DISABLED' } });

        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('ARMED tanpa escrow → P2P_LISTING_NOT_ESCROWED, offer TIDAK jadi ACCEPTED', async () => {
        armP2p();
        prisma.offer.findUnique.mockResolvedValue(offerRow);
        prisma.listing.findUnique.mockResolvedValue(userCard);

        await expect(
          service.acceptOffer('offer-1', seller),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED' },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('ARMED + listing user TANPA aset on-chain → offer TIDAK jadi ACCEPTED', async () => {
        armP2p();
        prisma.offer.findUnique.mockResolvedValue({
          ...offerRow,
          listing: { ...userCardNoAsset, seller: null },
        });
        prisma.listing.findUnique.mockResolvedValue(userCardNoAsset);

        await expect(
          service.acceptOffer('offer-1', seller),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED' },
        });
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });
    });

    describe('buy (jalur demo instant-mint)', () => {
      it('ARMED + listing user TANPA escrow → ditolak (cegah mint aset KEDUA utk satu kartu)', async () => {
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...userCard,
          seller: null,
        });

        await expect(service.buy('listing-user', user)).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED' },
        });
        expect(nft.mintForUser).not.toHaveBeenCalled();
      });

      it('ARMED + listing user TANPA aset on-chain → ditolak (buy tak pernah mengkredit penjual)', async () => {
        // `buy()` menandai SOLD + me-mint NFT baru ke pembeli TANPA membayar penjual
        // sepeser pun. Saat settlement real berlaku, itu merampas kartu penjual — tak
        // peduli barisnya punya aset on-chain atau tidak.
        armP2p();
        prisma.listing.findUnique.mockResolvedValue({
          ...userCardNoAsset,
          seller: null,
        });

        await expect(
          service.buy('listing-user-noasset', user),
        ).rejects.toMatchObject({
          response: { code: 'P2P_LISTING_NOT_ESCROWED' },
        });
        expect(prisma.listing.updateMany).not.toHaveBeenCalled();
        expect(nft.mintForUser).not.toHaveBeenCalled();
      });

      it('UNARMED → TIDAK ikut tergerbang (demo devnet memang jalurnya)', async () => {
        // buy() bukan jalur penerbit tagihan, jadi "fitur P2P mati" bukan alasan menolaknya —
        // itu justru keadaan normal demo yang jalur ini ada untuk melayaninya.
        prisma.listing.findUnique.mockResolvedValue({
          ...userCard,
          seller: null,
        });
        prisma.listing.updateMany.mockResolvedValueOnce({ count: 1 });
        prisma.listing.findUniqueOrThrow.mockResolvedValue(userCard);
        prisma.card.create.mockResolvedValue({ id: 'card-1' });
        nft.mintForUser.mockResolvedValue({ id: 'nft-1' });
        prisma.listing.update.mockResolvedValue({ ...userCard, nft: null });

        await service.buy('listing-user', user);

        expect(nft.mintForUser).toHaveBeenCalled();
      });
    });
  });
});
