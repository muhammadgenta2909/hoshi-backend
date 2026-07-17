import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { InventoryService } from '../inventory/inventory.service';
import type {
  CardRarity,
  InventoryCard,
  InventoryHold,
  InventorySource,
} from '../inventory/inventory.types';
import {
  BUYBACK_RATE,
  PACKS,
  PackDefinition,
  buybackQuoteIdr,
  expectedValueIdr,
  findPack,
} from './packs.catalog';

/** Fisher-Yates pakai crypto RNG — urutan acak kandidat tanpa bias. */
function shuffled<T>(input: T[]): T[] {
  const a = [...input];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function groupByRarity(
  cards: InventoryCard[],
): Map<CardRarity, InventoryCard[]> {
  const map = new Map<CardRarity, InventoryCard[]>();
  for (const c of cards) {
    const arr = map.get(c.rarity) ?? [];
    arr.push(c);
    map.set(c.rarity, arr);
  }
  return map;
}

@Injectable()
export class PacksService {
  private readonly logger = new Logger(PacksService.name);

  constructor(private readonly inventory: InventoryService) {}

  /** Katalog pack + expected value & rasio buyback (untuk halaman Open Packs). */
  list() {
    return PACKS.map((p) => this.decorate(p));
  }

  getOne(id: string) {
    const pack = findPack(id);
    if (!pack) throw new NotFoundException('Pack not found.');
    return this.decorate(pack);
  }

  private decorate(pack: PackDefinition) {
    return {
      ...pack,
      expectedValueIdr: expectedValueIdr(pack),
      buybackRate: BUYBACK_RATE,
    };
  }

  /**
   * Inti gacha: undi rarity berbobot → reserve satu kartu dari provider aktif →
   * deliver (mint/transfer) ke wallet user. Pola 2-fase + kompensasi seperti
   * VaultService.claim, tapi agnostik-sumber lewat InventoryService.
   */
  async open(params: {
    userId: string;
    ownerAddress: string;
    packId: string;
    source?: InventorySource;
  }) {
    const pack = findPack(params.packId);
    if (!pack) throw new NotFoundException('Pack not found.');

    // TODO(pembayaran): tagih pack.priceIdr dalam IDRX (escrow/settlement) SEBELUM
    // menarik kartu. POC mengasumsikan pembayaran sudah beres.

    const provider = this.inventory.resolve(params.source);
    const available = await provider.listAvailable(pack.id);
    if (available.length === 0) {
      throw new ConflictException('Stok kartu untuk pack ini sedang kosong.');
    }

    // Undi HANYA di antara rarity yang ada stoknya (bobot dinormalisasi ulang),
    // supaya tidak pernah mengundi tier kosong.
    const byRarity = groupByRarity(available);
    const rarity = this.drawRarity(pack, byRarity);

    // Reserve 2-fase: coba kunci kandidat satu per satu (yg lain bisa keburu diambil).
    let hold: InventoryHold | null = null;
    for (const card of shuffled(byRarity.get(rarity) ?? [])) {
      try {
        hold = await provider.reserve(card);
        break;
      } catch (err) {
        this.logger.warn(
          `reserve gagal utk ${card.ref}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (!hold) {
      throw new ConflictException(
        'Gagal mengunci kartu (semua kandidat keburu diambil). Coba lagi.',
      );
    }

    try {
      const delivery = await provider.deliver(hold, {
        userId: params.userId,
        ownerAddress: params.ownerAddress,
      });
      return {
        packId: pack.id,
        source: provider.source,
        rarity: hold.card.rarity,
        card: hold.card,
        delivery,
        buybackQuoteIdr: buybackQuoteIdr(hold.card.valueIdr),
      };
    } catch (err) {
      // Kompensasi best-effort: lepas hold agar kartu bisa dimenangkan lagi.
      await provider.release(hold).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Undian rarity berbobot memakai crypto RNG, dibatasi ke rarity yang tersedia.
   * Provably-fair (commit-reveal seed / VRF on-chain) adalah upgrade yang tinggal
   * disisipkan di sini tanpa mengubah pemanggil.
   */
  private drawRarity(
    pack: PackDefinition,
    byRarity: Map<CardRarity, InventoryCard[]>,
  ): CardRarity {
    const eligible = pack.dropRates.filter(
      (d) => (byRarity.get(d.rarity)?.length ?? 0) > 0,
    );
    // Bobot integer (skala ×100 untuk menjaga 2 desimal, mis. 1.8% → 180).
    const weights = eligible.map((d) => Math.round(d.pct * 100));
    const total = weights.reduce((s, w) => s + w, 0);

    if (total <= 0) {
      // Pool tak beririsan dgn drop-table → ambil rarity apa pun yang ada.
      const [first] = byRarity.keys();
      return first;
    }

    let roll = randomInt(0, total);
    for (let i = 0; i < eligible.length; i++) {
      roll -= weights[i];
      if (roll < 0) return eligible[i].rarity;
    }
    return eligible[eligible.length - 1].rarity;
  }
}
