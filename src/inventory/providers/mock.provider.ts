import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RARITY_VALUE } from '../../packs/packs.catalog';
import type { CardRarity } from '../inventory.types';
import type {
  DeliveryRecipient,
  InventoryCard,
  InventoryDelivery,
  InventoryHold,
  InventoryProvider,
} from '../inventory.types';

// Pool sintetis in-memory — supply tak terbatas. Berguna untuk dev frontend &
// unit test tanpa DB / tanpa on-chain: menjalankan seluruh alur draw & seam
// reserve→deliver tanpa efek samping nyata.
const POOL: { name: string; rarity: CardRarity }[] = [
  { name: 'Pikachu (Mock)', rarity: 'Common' },
  { name: 'Bulbasaur (Mock)', rarity: 'Common' },
  { name: 'Snorlax (Mock)', rarity: 'Rare' },
  { name: 'Blastoise GX (Mock)', rarity: 'Rare' },
  { name: 'Venusaur EX (Mock)', rarity: 'Epic' },
  { name: 'Mewtwo VSTAR (Mock)', rarity: 'Legendary' },
  { name: 'Charizard VMAX (Mock)', rarity: 'Legendary' },
  { name: 'Pikachu Illustrator (Mock)', rarity: 'Legendary Rare' },
];

/**
 * Provider mock: supply tak terbatas, tanpa DB & tanpa chain. Setiap reserve
 * membuat holdId unik sehingga delivery selalu berbeda; deliver mengembalikan
 * asset sintetis. Dipakai untuk pengembangan lokal & test.
 */
@Injectable()
export class MockInventoryProvider implements InventoryProvider {
  readonly source = 'mock' as const;

  listAvailable(_packId: string): Promise<InventoryCard[]> {
    return Promise.resolve(
      POOL.map((c, i) => ({
        source: this.source,
        ref: `mock-${i}`,
        name: c.name,
        rarity: c.rarity,
        valueIdr: RARITY_VALUE[c.rarity],
      })),
    );
  }

  reserve(card: InventoryCard): Promise<InventoryHold> {
    // Supply tak terbatas → tiap draw dapat holdId unik (tak ada bentrok).
    return Promise.resolve({
      source: this.source,
      holdId: `${card.ref}:${randomUUID()}`,
      card,
    });
  }

  deliver(
    hold: InventoryHold,
    _recipient: DeliveryRecipient,
  ): Promise<InventoryDelivery> {
    return Promise.resolve({
      source: this.source,
      card: hold.card,
      assetAddress: `MOCK_${hold.holdId}`,
      txSignature: `mocktx_${hold.holdId}`,
    });
  }

  release(_hold: InventoryHold): Promise<void> {
    return Promise.resolve();
  }
}
