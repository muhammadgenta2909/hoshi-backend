import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { VaultStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NftService } from '../nft/nft.service';
import { CreateVaultItemDto } from './dto/create-vault-item.dto';

@Injectable()
export class VaultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly nft: NftService,
  ) {}

  /** Admin menaruh kartu fisik ke vault (status STORED). */
  async store(dto: CreateVaultItemDto) {
    const card = await this.prisma.card.findUnique({
      where: { id: dto.cardId },
    });
    if (!card) throw new NotFoundException('Card tidak ditemukan.');
    return this.prisma.vaultItem.create({
      data: { cardId: dto.cardId, serialNumber: dto.serialNumber },
      include: { card: true },
    });
  }

  /** Item yang masih bisa diklaim. */
  findAvailable() {
    return this.prisma.vaultItem.findMany({
      where: { status: VaultStatus.STORED },
      include: { card: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Vault item milik user (sudah diklaim). */
  findForUser(userId: string) {
    return this.prisma.vaultItem.findMany({
      where: { ownerId: userId },
      include: { card: true, nft: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string) {
    const item = await this.prisma.vaultItem.findUnique({
      where: { id },
      include: { card: true, nft: true },
    });
    if (!item) throw new NotFoundException('Vault item tidak ditemukan.');
    return item;
  }

  /**
   * Inti alur Hoshi: user klaim item vault → platform mint NFT ke wallet user
   * → item jadi MINTED & ditautkan ke NFT.
   */
  async claim(params: {
    userId: string;
    ownerAddress: string;
    vaultItemId: string;
  }) {
    // 1) Klaim ATOMIK: hanya request yang berhasil mengubah STORED→MINTING yang lanjut.
    //    Cegah double-claim/double-mint walau ada 2 request bersamaan / double-click.
    const claimed = await this.prisma.vaultItem.updateMany({
      where: { id: params.vaultItemId, status: VaultStatus.STORED },
      data: { status: VaultStatus.MINTING, ownerId: params.userId },
    });
    if (claimed.count !== 1) {
      const exists = await this.prisma.vaultItem.findUnique({
        where: { id: params.vaultItemId },
      });
      if (!exists) throw new NotFoundException('Vault item tidak ditemukan.');
      throw new BadRequestException('Item ini sudah diklaim / tidak tersedia.');
    }

    try {
      // 2) Mint on-chain (mahal & ireversibel) — item sudah "dimenangkan" (MINTING).
      const item = await this.prisma.vaultItem.findUniqueOrThrow({
        where: { id: params.vaultItemId },
      });
      const nft = await this.nft.mintForUser({
        userId: params.userId,
        ownerAddress: params.ownerAddress,
        cardId: item.cardId,
      });

      // 3) Finalisasi: tautkan NFT & tandai MINTED.
      const updated = await this.prisma.vaultItem.update({
        where: { id: params.vaultItemId },
        data: { status: VaultStatus.MINTED, nftId: nft.id },
        include: { card: true },
      });
      return { ...updated, nft };
    } catch (err) {
      // Kompensasi (best-effort): kembalikan ke STORED agar bisa diklaim ulang.
      await this.prisma.vaultItem.updateMany({
        where: { id: params.vaultItemId, status: VaultStatus.MINTING },
        data: { status: VaultStatus.STORED, ownerId: null },
      });
      throw err;
    }
  }
}
