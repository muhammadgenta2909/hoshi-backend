import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Nft } from '@prisma/client';
import { detectProductionSignal } from '../common/demo-mode';
import { PrismaService } from '../prisma/prisma.service';
import { UmiService } from '../solana/umi.service';

const BASE58 =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Alamat asset TIRUAN (mock) berbentuk base58 44-char — cukup mirip alamat Solana asli supaya
 *  link explorer well-formed, tapi jelas bukan on-chain. Dipakai jalur mock (staging/CC_MOCK). */
function mockAssetAddress(): string {
  let s = '';
  for (let i = 0; i < 44; i++) {
    s += BASE58[Math.floor(Math.random() * BASE58.length)];
  }
  return s;
}

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
  private readonly logger = new Logger(NftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly umi: UmiService,
    private readonly config: ConfigService,
  ) {}

  /** MOCK vs REAL mint. Di lingkungan NON-produksi, mensimulasi mint (nol on-chain, tak butuh
   *  PLATFORM_SECRET_KEY / SOL devnet) bila EITHER:
   *    • CC_MOCK=1 (staging — konsisten dgn settlement reseller/P2P yang juga di-mock), ATAU
   *    • PLATFORM_SECRET_KEY belum di-set (tanpa key mint on-chain memang mustahil → mending
   *      degrade ke mock daripada melempar "PLATFORM_SECRET_KEY not set" saat beli/terima-offer).
   *  Prod (detectProductionSignal ≠ null) TIDAK pernah mock (lagipula buy/acceptOffer sudah
   *  di-assertDemoOnly di hulu). */
  private mintMockEnabled(): boolean {
    if (detectProductionSignal() !== null) return false;
    return (
      this.config.get<string>('CC_MOCK') === '1' ||
      !this.config.get<string>('PLATFORM_SECRET_KEY')
    );
  }

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

    // MOCK (staging/CC_MOCK): jangan mint on-chain — accept-offer/buy demo harus jalan tanpa
    // PLATFORM_SECRET_KEY & SOL devnet. NFT jadi baris DB (owner = pembeli) → kartu tampil di
    // Vault & marketplace seperti biasa, cukup untuk demo. REAL (prod/devnet-armed): mint sungguhan.
    let assetAddress: string;
    let mintTx: string | null;
    if (this.mintMockEnabled()) {
      assetAddress = mockAssetAddress();
      mintTx = null;
      this.logger.log(
        `Mint MOCK (CC_MOCK): asset ${assetAddress} → ${params.ownerAddress} ` +
          `(nol on-chain, tanpa PLATFORM_SECRET_KEY).`,
      );
    } else {
      const minted = await this.umi.mintCoreAsset({
        ownerAddress: params.ownerAddress,
        name: card.name,
        uri,
      });
      assetAddress = minted.assetAddress;
      mintTx = minted.signature;
    }

    const nft = await this.prisma.nft.create({
      data: {
        assetAddress,
        ownerAddress: params.ownerAddress,
        mintTx,
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
