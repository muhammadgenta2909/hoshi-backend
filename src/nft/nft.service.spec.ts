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

  it('tanpa metadataUri & tanpa DEFAULT_METADATA_URI → pakai FALLBACK_METADATA_URI (tetap mint)', async () => {
    prisma.card.findUnique.mockResolvedValue({
      id: 'c1',
      name: 'X',
      metadataUri: null,
    });
    // PLATFORM_SECRET_KEY di-set (truthy) → jalur REAL (bukan mock); DEFAULT_METADATA_URI kosong
    // → jatuh ke FALLBACK. (Tanpa key, mint akan MOCK — diuji terpisah.)
    config.get.mockImplementation((k: string) =>
      k === 'PLATFORM_SECRET_KEY' ? '[1,2,3]' : undefined,
    );
    umi.mintCoreAsset.mockResolvedValue({ assetAddress: 'A', signature: 'S' });
    prisma.nft.create.mockResolvedValue({ id: 'n', assetAddress: 'A', mintTx: 'S' });

    await service.mintForUser(params);

    // Jaring terakhir: mint TETAP jalan dengan URI fallback (gateway.irys.xyz/…), tak melempar —
    // supaya beli/terima-offer demo tidak gagal hanya karena env metadata belum di-set.
    expect(umi.mintCoreAsset).toHaveBeenCalledWith(
      expect.objectContaining({ uri: expect.stringContaining('gateway.irys.xyz') }),
    );
  });

  it('CC_MOCK=1 (non-prod) → mint DISIMULASI: UmiService TAK dipanggil, NFT dicatat dgn alamat mock & mintTx null', async () => {
    // detectProductionSignal() harus null → bersihkan sinyal prod dari env, pulihkan sesudahnya.
    const saved = {
      SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
      SOLANA_RPC_URL: process.env.SOLANA_RPC_URL,
      COLLECTORCRYPT_GACHA_BASE_URL: process.env.COLLECTORCRYPT_GACHA_BASE_URL,
    };
    delete process.env.SOLANA_CLUSTER;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
    try {
      prisma.card.findUnique.mockResolvedValue({
        id: 'c1',
        name: 'Pikachu',
        metadataUri: 'https://meta/pikachu.json',
      });
      config.get.mockImplementation((k: string) => (k === 'CC_MOCK' ? '1' : undefined));
      prisma.nft.create.mockImplementation((args: { data: { assetAddress: string } }) =>
        Promise.resolve({ id: 'nMock', ...args.data }),
      );

      const res = await service.mintForUser(params);

      // JAMINAN: nol on-chain — UmiService.mintCoreAsset TIDAK dipanggil (tanpa PLATFORM_SECRET_KEY pun jalan).
      expect(umi.mintCoreAsset).not.toHaveBeenCalled();
      const [createArg] = prisma.nft.create.mock.calls[0] as [
        { data: { assetAddress: string; mintTx: string | null; ownerId: string } },
      ];
      // Alamat mock base58 44-char (bukan hasil umi), mintTx null (tak ada tx on-chain).
      expect(createArg.data.assetAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(createArg.data.mintTx).toBeNull();
      expect(createArg.data.ownerId).toBe('u1');
      expect(res.assetAddress).toBe(createArg.data.assetAddress);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
