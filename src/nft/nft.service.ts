import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Nft } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UmiService } from '../solana/umi.service';

@Injectable()
export class NftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly umi: UmiService,
    private readonly config: ConfigService,
  ) {}

  /** Mint card jadi NFT (owner = wallet user, platform bayar) lalu catat ke DB. */
  async mintForUser(params: {
    userId: string;
    ownerAddress: string;
    cardId: string;
  }) {
    const card = await this.prisma.card.findUnique({
      where: { id: params.cardId },
    });
    if (!card) throw new NotFoundException('Card tidak ditemukan.');

    const uri =
      card.metadataUri ?? this.config.get<string>('DEFAULT_METADATA_URI');
    if (!uri) {
      throw new NotFoundException(
        'Card belum punya metadataUri & DEFAULT_METADATA_URI kosong.',
      );
    }

    const { assetAddress, signature } = await this.umi.mintCoreAsset({
      ownerAddress: params.ownerAddress,
      name: card.name,
      uri,
    });

    const nft = await this.prisma.nft.create({
      data: {
        assetAddress,
        ownerAddress: params.ownerAddress,
        mintTx: signature,
        metadataUri: uri,
        name: card.name,
        cardId: card.id,
        ownerId: params.userId,
      },
    });

    return this.withExplorer(nft);
  }

  async findForUser(userId: string) {
    const rows = await this.prisma.nft.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((n) => this.withExplorer(n));
  }

  async findOne(userId: string, id: string) {
    const nft = await this.prisma.nft.findUnique({ where: { id } });
    if (!nft || nft.ownerId !== userId) {
      throw new NotFoundException('NFT tidak ditemukan.');
    }
    return this.withExplorer(nft);
  }

  /** Tambahkan link explorer sesuai cluster aktif. */
  private withExplorer(nft: Nft) {
    const cluster = this.config.get<string>('SOLANA_CLUSTER') ?? 'devnet';
    return {
      ...nft,
      explorerNft: `https://core.metaplex.com/explorer/${nft.assetAddress}?env=${cluster}`,
      explorerAddress: `https://explorer.solana.com/address/${nft.assetAddress}?cluster=${cluster}`,
      explorerTx: nft.mintTx
        ? `https://explorer.solana.com/tx/${nft.mintTx}?cluster=${cluster}`
        : null,
    };
  }
}
