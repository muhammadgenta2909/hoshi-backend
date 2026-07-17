import { ConflictException, Injectable } from '@nestjs/common';
import { VaultStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NftService } from '../../nft/nft.service';
import { RARITY_VALUE, normalizeRarity } from '../../packs/packs.catalog';
import type {
  DeliveryRecipient,
  InventoryCard,
  InventoryDelivery,
  InventoryHold,
  InventoryProvider,
} from '../inventory.types';

/**
 * Provider inventory dari vault Hoshi sendiri. Membungkus mesin vault→mint yang
 * sudah ada: reserve = kunci atomik STORED→MINTING (sama seperti VaultService.claim),
 * deliver = mint NFT ke wallet user, release = kompensasi MINTING→STORED.
 */
@Injectable()
export class HoshiVaultProvider implements InventoryProvider {
  readonly source = 'hoshi-vault' as const;

  constructor(
    private readonly prisma: PrismaService,
    private readonly nft: NftService,
  ) {}

  async listAvailable(_packId: string): Promise<InventoryCard[]> {
    // Vault POC = satu pool bersama; scoping per-pack (mis. filter card.set)
    // ditambahkan nanti. `packId` tetap di signature demi keseragaman interface.
    const items = await this.prisma.vaultItem.findMany({
      where: { status: VaultStatus.STORED },
      include: { card: true },
      orderBy: { createdAt: 'asc' },
    });
    return items.map((it) => {
      const rarity = normalizeRarity(it.card.rarity);
      return {
        source: this.source,
        ref: it.id,
        name: it.card.name,
        rarity,
        imageUrl: it.card.imageUrl ?? undefined,
        valueIdr: RARITY_VALUE[rarity],
      };
    });
  }

  async reserve(card: InventoryCard): Promise<InventoryHold> {
    // Kunci ATOMIK: hanya request yang berhasil ubah STORED→MINTING yang menang.
    const locked = await this.prisma.vaultItem.updateMany({
      where: { id: card.ref, status: VaultStatus.STORED },
      data: { status: VaultStatus.MINTING },
    });
    if (locked.count !== 1) {
      throw new ConflictException(
        'Card is no longer available (taken by another draw).',
      );
    }
    return { source: this.source, holdId: card.ref, card };
  }

  async deliver(
    hold: InventoryHold,
    recipient: DeliveryRecipient,
  ): Promise<InventoryDelivery> {
    const item = await this.prisma.vaultItem.findUniqueOrThrow({
      where: { id: hold.holdId },
    });
    // Mint on-chain (mahal & ireversibel) — item sudah "dimenangkan" (MINTING).
    const nft = await this.nft.mintForUser({
      userId: recipient.userId,
      ownerAddress: recipient.ownerAddress,
      cardId: item.cardId,
    });
    await this.prisma.vaultItem.update({
      where: { id: hold.holdId },
      data: {
        status: VaultStatus.MINTED,
        ownerId: recipient.userId,
        nftId: nft.id,
      },
    });
    return {
      source: this.source,
      card: hold.card,
      assetAddress: nft.assetAddress,
      txSignature: nft.mintTx ?? undefined,
      nftId: nft.id,
    };
  }

  async release(hold: InventoryHold): Promise<void> {
    await this.prisma.vaultItem.updateMany({
      where: { id: hold.holdId, status: VaultStatus.MINTING },
      data: { status: VaultStatus.STORED, ownerId: null },
    });
  }
}
