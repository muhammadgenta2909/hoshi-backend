import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Grader, ListingStatus } from '@prisma/client';
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
  };
  let nft: { mintForUser: jest.Mock };

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
    };
    nft = { mintForUser: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        MarketplaceService,
        { provide: PrismaService, useValue: prisma },
        { provide: NftService, useValue: nft },
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
