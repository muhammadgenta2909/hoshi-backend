import type { CardRarity } from '../inventory/inventory.types';

// ─────────────────────────────────────────────────────────────────────────────
// Katalog pack — SUMBER KEBENARAN sisi server untuk harga & drop-rate. Odds dan
// harga TIDAK BOLEH dipercaya dari client; frontend hanya menampilkannya.
// Mirror dari lib/packs.ts di frontend (id, harga, drop rates).
// ─────────────────────────────────────────────────────────────────────────────

export interface PackDropRate {
  rarity: CardRarity;
  /** Persen peluang (0–100). Boleh desimal (mis. 1.8). */
  pct: number;
}

export interface PackDefinition {
  id: string;
  name: string;
  group: 'Normal Hoshi Pack' | 'Special Hoshi Pack';
  /** Harga pack dalam IDRX. */
  priceIdr: number;
  dropRates: PackDropRate[];
}

/**
 * Nilai wajar per rarity (IDRX) — PLACEHOLDER POC. Di produksi angka ini datang
 * dari price feed provider (mis. nilai pasar CollectorCrypt), bukan hardcode.
 * Dipakai untuk expected value, kuotasi buyback, dan valuasi kartu vault/mock.
 */
export const RARITY_VALUE: Record<CardRarity, number> = {
  Common: 12_000,
  Rare: 45_000,
  Epic: 180_000,
  Legendary: 900_000,
  'Legendary Rare': 6_000_000,
};

/** Rasio buyback (sejalan dgn instant-buyback CollectorCrypt ~85% nilai). */
export const BUYBACK_RATE = 0.85;

const rates = (
  common: number,
  rare: number,
  epic: number,
  legendary: number,
  legendaryRare: number,
): PackDropRate[] => [
  { rarity: 'Common', pct: common },
  { rarity: 'Rare', pct: rare },
  { rarity: 'Epic', pct: epic },
  { rarity: 'Legendary', pct: legendary },
  { rarity: 'Legendary Rare', pct: legendaryRare },
];

export const PACKS: PackDefinition[] = [
  { id: 'n', name: 'Hoshi Pack N', group: 'Normal Hoshi Pack', priceIdr: 10_000, dropRates: rates(70, 22, 6, 1.8, 0.2) },
  { id: 'uc', name: 'Hoshi Pack UC', group: 'Normal Hoshi Pack', priceIdr: 15_000, dropRates: rates(62, 26, 9, 2.7, 0.3) },
  { id: 'r', name: 'Hoshi Pack R', group: 'Special Hoshi Pack', priceIdr: 50_000, dropRates: rates(55, 27, 13, 4.6, 0.4) },
  { id: 'sr', name: 'Hoshi Pack SR', group: 'Special Hoshi Pack', priceIdr: 75_000, dropRates: rates(50, 25, 15, 4.5, 0.5) },
];

export function findPack(id: string): PackDefinition | undefined {
  return PACKS.find((p) => p.id === id);
}

/**
 * Normalisasi rarity bebas-teks (mis. Card.rarity = 'Holo Rare') ke union
 * CardRarity. Longgar & tahan-banting: default 'Common'.
 */
export function normalizeRarity(raw?: string | null): CardRarity {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('legendary') && s.includes('rare')) return 'Legendary Rare';
  if (s.includes('legendary')) return 'Legendary';
  if (s.includes('epic')) return 'Epic';
  if (s.includes('rare')) return 'Rare';
  return 'Common';
}

/** Expected value pack (IDRX) = Σ (pct/100 × nilai rarity). */
export function expectedValueIdr(pack: PackDefinition): number {
  return Math.round(
    pack.dropRates.reduce(
      (sum, d) => sum + (d.pct / 100) * RARITY_VALUE[d.rarity],
      0,
    ),
  );
}

/** Kuotasi buyback untuk kartu bernilai `valueIdr`. */
export function buybackQuoteIdr(valueIdr: number): number {
  return Math.round(valueIdr * BUYBACK_RATE);
}
