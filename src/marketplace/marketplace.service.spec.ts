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
import { CcCardFactsService } from '../collectorcrypt/cc-card-facts.service';
import { NftService } from '../nft/nft.service';
import { PrismaService } from '../prisma/prisma.service';
import { MarketplaceService } from './marketplace.service';

// Prevent the Metaplex/Solana ESM chain from loading through NftService.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));

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
    offer: { updateMany: jest.Mock };
    activity: { create: jest.Mock };
    ccPackPurchase: { findFirst: jest.Mock };
  };
  let nft: { mintForUser: jest.Mock };
  let ccFacts: { ensureFacts: jest.Mock };

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
      offer: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      activity: { create: jest.fn().mockResolvedValue({}) },
      ccPackPurchase: { findFirst: jest.fn() },
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

    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        { provide: PrismaService, useValue: prisma },
        { provide: NftService, useValue: nft },
        { provide: CcCardFactsService, useValue: ccFacts },
      ],
    }).compile();

    service = moduleRef.get(MarketplaceService);
  });

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
          status: {
            in: [ListingStatus.SOLD, ListingStatus.CANCELLED],
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
});
