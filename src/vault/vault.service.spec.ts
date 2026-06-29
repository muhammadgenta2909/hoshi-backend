import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { VaultStatus } from '@prisma/client';
import { VaultService } from './vault.service';
import { PrismaService } from '../prisma/prisma.service';
import { NftService } from '../nft/nft.service';

// Cegah rantai metaplex/solana (ESM) ke-load lewat NftService→UmiService di jest.
// NftService di-mock penuh via DI di bawah, jadi isi UmiService asli tak diperlukan.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));

describe('VaultService', () => {
  let service: VaultService;
  let prisma: {
    card: { findUnique: jest.Mock };
    vaultItem: {
      create: jest.Mock;
      findMany: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      updateMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let nft: { mintForUser: jest.Mock };

  beforeEach(async () => {
    prisma = {
      card: { findUnique: jest.fn() },
      vaultItem: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
    };
    nft = { mintForUser: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        VaultService,
        { provide: PrismaService, useValue: prisma },
        { provide: NftService, useValue: nft },
      ],
    }).compile();

    service = moduleRef.get(VaultService);
  });

  const claimParams = {
    userId: 'user-1',
    ownerAddress: 'WalletUserBase58',
    vaultItemId: 'vault-1',
  };

  describe('claim (alur inti Hoshi)', () => {
    it('sukses: STORED→MINTING (atomik) → mint → MINTED + tertaut NFT', async () => {
      prisma.vaultItem.updateMany.mockResolvedValueOnce({ count: 1 });
      prisma.vaultItem.findUniqueOrThrow.mockResolvedValue({
        id: 'vault-1',
        cardId: 'card-1',
      });
      nft.mintForUser.mockResolvedValue({ id: 'nft-1', assetAddress: 'AsetX' });
      prisma.vaultItem.update.mockResolvedValue({
        id: 'vault-1',
        status: VaultStatus.MINTED,
        nftId: 'nft-1',
        card: { id: 'card-1' },
      });

      const res = await service.claim(claimParams);

      // 1) Klaim ATOMIK: hanya yang berhasil ubah STORED→MINTING yang lanjut.
      expect(prisma.vaultItem.updateMany).toHaveBeenCalledWith({
        where: { id: 'vault-1', status: VaultStatus.STORED },
        data: { status: VaultStatus.MINTING, ownerId: 'user-1' },
      });
      // 2) Mint dipanggil dengan card milik item.
      expect(nft.mintForUser).toHaveBeenCalledWith({
        userId: 'user-1',
        ownerAddress: 'WalletUserBase58',
        cardId: 'card-1',
      });
      // 3) Finalisasi: status MINTED + NFT terlampir.
      expect(res.status).toBe(VaultStatus.MINTED);
      expect(res.nft).toEqual({ id: 'nft-1', assetAddress: 'AsetX' });
    });

    it('item tidak tersedia (count=0, item ada) → BadRequest, mint TIDAK jalan', async () => {
      prisma.vaultItem.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.vaultItem.findUnique.mockResolvedValue({ id: 'vault-1' });

      await expect(service.claim(claimParams)).rejects.toThrow(
        BadRequestException,
      );
      expect(nft.mintForUser).not.toHaveBeenCalled();
    });

    it('item tidak ditemukan (count=0, item null) → NotFound', async () => {
      prisma.vaultItem.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.vaultItem.findUnique.mockResolvedValue(null);

      await expect(service.claim(claimParams)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('kompensasi: mint gagal → rollback MINTING→STORED + rethrow (anti item ke-lock)', async () => {
      prisma.vaultItem.updateMany
        .mockResolvedValueOnce({ count: 1 }) // klaim awal
        .mockResolvedValueOnce({ count: 1 }); // rollback
      prisma.vaultItem.findUniqueOrThrow.mockResolvedValue({
        id: 'vault-1',
        cardId: 'card-1',
      });
      nft.mintForUser.mockRejectedValue(new Error('RPC timeout'));

      await expect(service.claim(claimParams)).rejects.toThrow('RPC timeout');

      // Rollback: kembalikan ke STORED + lepas owner agar bisa diklaim ulang.
      expect(prisma.vaultItem.updateMany).toHaveBeenLastCalledWith({
        where: { id: 'vault-1', status: VaultStatus.MINTING },
        data: { status: VaultStatus.STORED, ownerId: null },
      });
      expect(prisma.vaultItem.update).not.toHaveBeenCalled();
    });
  });

  describe('store', () => {
    it('card ada → buat vault item (STORED) include card', async () => {
      prisma.card.findUnique.mockResolvedValue({ id: 'card-1' });
      prisma.vaultItem.create.mockResolvedValue({ id: 'vault-1' });

      await service.store({ cardId: 'card-1', serialNumber: 'SN-1' });

      expect(prisma.vaultItem.create).toHaveBeenCalledWith({
        data: { cardId: 'card-1', serialNumber: 'SN-1' },
        include: { card: true },
      });
    });

    it('card tidak ada → NotFound, tidak membuat item', async () => {
      prisma.card.findUnique.mockResolvedValue(null);

      await expect(
        service.store({ cardId: 'nope', serialNumber: 'SN' }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.vaultItem.create).not.toHaveBeenCalled();
    });
  });
});
