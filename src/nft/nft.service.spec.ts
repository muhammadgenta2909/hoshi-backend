import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NftService } from './nft.service';
import { PrismaService } from '../prisma/prisma.service';
import { UmiService } from '../solana/umi.service';

// Cegah rantai metaplex/solana (ESM) ke-load. UmiService di-mock penuh via DI di bawah.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));

describe('NftService', () => {
  let service: NftService;
  let prisma: {
    card: { findUnique: jest.Mock };
    nft: { create: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock };
  };
  let umi: { mintCoreAsset: jest.Mock };
  let config: { get: jest.Mock };

  beforeEach(async () => {
    prisma = {
      card: { findUnique: jest.fn() },
      nft: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
    };
    umi = { mintCoreAsset: jest.fn() };
    config = { get: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NftService,
        { provide: PrismaService, useValue: prisma },
        { provide: UmiService, useValue: umi },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(NftService);
  });

  const params = { userId: 'u1', ownerAddress: 'OwnerWallet', cardId: 'c1' };

  it('mint: pakai metadataUri card → UmiService (mock) → catat NFT + link explorer', async () => {
    prisma.card.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'Charizard',
      metadataUri: 'https://meta/charizard.json',
    });
    umi.mintCoreAsset.mockResolvedValue({
      assetAddress: 'AssetAddr',
      signature: 'SigTx',
    });
    prisma.nft.create.mockResolvedValue({
      id: 'nft1',
      assetAddress: 'AssetAddr',
      mintTx: 'SigTx',
      name: 'Charizard',
    });
    config.get.mockReturnValue('devnet'); // SOLANA_CLUSTER

    const res = await service.mintForUser(params);

    // UmiService dipanggil dengan owner = wallet user, name & uri dari card.
    expect(umi.mintCoreAsset).toHaveBeenCalledWith({
      ownerAddress: 'OwnerWallet',
      name: 'Charizard',
      uri: 'https://meta/charizard.json',
    });
    // NFT dicatat dgn snapshot owner + hasil mint.
    expect(prisma.nft.create).toHaveBeenCalledWith({
      data: {
        assetAddress: 'AssetAddr',
        ownerAddress: 'OwnerWallet',
        mintTx: 'SigTx',
        metadataUri: 'https://meta/charizard.json',
        name: 'Charizard',
        cardId: 'c1',
        ownerId: 'u1',
      },
    });
    expect(res.assetAddress).toBe('AssetAddr');
    expect(res.explorerAddress).toContain('AssetAddr');
    expect(String(res.explorerTx)).toContain('SigTx');
  });

  it('fallback ke DEFAULT_METADATA_URI saat card.metadataUri kosong', async () => {
    prisma.card.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'Blastoise',
      metadataUri: null,
    });
    config.get.mockImplementation((k: string) =>
      k === 'DEFAULT_METADATA_URI' ? 'https://meta/default.json' : 'devnet',
    );
    umi.mintCoreAsset.mockResolvedValue({ assetAddress: 'A', signature: 'S' });
    prisma.nft.create.mockResolvedValue({
      id: 'n',
      assetAddress: 'A',
      mintTx: 'S',
    });

    await service.mintForUser(params);

    expect(umi.mintCoreAsset).toHaveBeenCalledWith(
      expect.objectContaining({ uri: 'https://meta/default.json' }),
    );
  });

  it('card tidak ada → NotFound, UmiService tidak dipanggil', async () => {
    prisma.card.findUnique.mockResolvedValue(null);

    await expect(service.mintForUser(params)).rejects.toThrow(
      NotFoundException,
    );
    expect(umi.mintCoreAsset).not.toHaveBeenCalled();
  });

  it('tanpa metadataUri & tanpa DEFAULT_METADATA_URI → NotFound (tak mint)', async () => {
    prisma.card.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'X',
      metadataUri: null,
    });
    config.get.mockReturnValue(undefined);

    await expect(service.mintForUser(params)).rejects.toThrow(
      NotFoundException,
    );
    expect(umi.mintCoreAsset).not.toHaveBeenCalled();
  });
});
