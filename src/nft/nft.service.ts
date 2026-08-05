import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Nft } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UmiService } from '../solana/umi.service';

// Metadata JSON default (sama dengan yang didokumentasikan di .env.example) — dipakai HANYA sebagai
// jaring terakhir bila kartu tak punya metadataUri DAN env DEFAULT_METADATA_URI tak di-set, supaya
// mint demo (beli/terima-offer) tidak gagal. Gambar kartu di UI Hoshi tetap dari data listing/card,
// bukan dari URI ini; URI ini hanya penting untuk explorer eksternal. Set DEFAULT_METADATA_URI di
// env untuk menimpanya.
const FALLBACK_METADATA_URI =
  'https://gateway.irys.xyz/6UNWfKd2igXWUGF7XY39Mwa7baeVwFHVdorDCaH1bjN2';

/** Bangun metadata JSON (standar Metaplex) dari kartu itu sendiri sebagai data: URI — supaya NFT
 *  hasil mint menampilkan gambar & trait kartu ASLI tanpa perlu hosting eksternal. Kecil (embed URL
 *  gambar, bukan byte-nya). Di-render core.metaplex.com (explorer yang di-link app). */
function buildCardMetadataUri(card: {
  name: string;
  description: string | null;
  imageUrl: string | null;
  set: string | null;
  rarity: string | null;
}): string {
  const attributes = [
    card.set ? { trait_type: 'Set', value: card.set } : null,
    card.rarity ? { trait_type: 'Rarity', value: card.rarity } : null,
  ].filter((a): a is { trait_type: string; value: string } => a !== null);
  const meta = {
    name: card.name,
    ...(card.description ? { description: card.description } : {}),
    ...(card.imageUrl ? { image: card.imageUrl } : {}),
    ...(attributes.length ? { attributes } : {}),
  };
  return (
    'data:application/json;base64,' +
    Buffer.from(JSON.stringify(meta)).toString('base64')
  );
}

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
    if (!card) throw new NotFoundException('Card not found.');

    // Selalu ada URI valid → mint demo tak pernah gagal karena metadata. Prioritas:
    //   1. metadataUri eksplisit kartu (kalau ada)
    //   2. metadata dibangun DARI kartu itu sendiri (data: URI: nama+gambar+set/rarity) → NFT hasil
    //      mint menampilkan ART KARTU ASLI di core.metaplex.com (yang di-link app), tanpa hosting.
    //   3. env DEFAULT_METADATA_URI, lalu 4. fallback hardcoded (kartu tanpa gambar).
    const uri =
      card.metadataUri ||
      (card.imageUrl ? buildCardMetadataUri(card) : null) ||
      this.config.get<string>('DEFAULT_METADATA_URI') ||
      FALLBACK_METADATA_URI;

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
      throw new NotFoundException('NFT not found.');
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
