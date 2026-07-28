import type { CcMachineNormalized, CcRarity } from './cc-gacha.types';

/**
 * Data PALSU untuk CC_MOCK (staging/devnet). BUKAN untuk produksi.
 *
 * Saat CC_MOCK=1 (dan deployment tidak terlihat produksi), GachaService memakai katalog
 * mesin + kartu palsu ini sebagai ganti panggilan ke dev-gacha CollectorCrypt. Efeknya:
 * order → bayar (mock IDRX) → fulfil membuka "pack" jadi kartu palsu → animasi reveal —
 * tanpa API key CC, tanpa treasury ber-USDC, tanpa transaksi on-chain sama sekali.
 */
export const CC_MOCK_MACHINES: CcMachineNormalized[] = [
  {
    code: 'pokemon_50',
    name: 'Pokémon $50 (Demo)',
    shortName: 'PKMN 50',
    image: '',
    thumbnailUrl: '/pokemon_50.png',
    videoSrc: '',
    videoHevc: '',
    public: true,
    owner: null,
    contains: 1,
    instantBuyback: 85,
    freeSpins: true,
    turboMode: false,
    pointsMultiplier: 1,
    lowThreshold: 20,
    targetEv: 55,
    ev: 55,
    odds: { common: 0.8, uncommon: 0.15, rare: 0.04, epic: 0.01 },
    tierRanges: {},
    stock: { common: 999, uncommon: 999, rare: 999, epic: 999 },
    priceUsdcDollars: 50,
    priceUsdcBaseUnits: 50_000_000,
  },
];

export interface MockCard {
  rarity: CcRarity;
  nftName: string;
  nftImage: string;
  roll: string;
  points: number;
}

/** Official artwork PokeAPI — URL publik yang stabil, jadi animasinya nampilin kartu beneran. */
const art = (id: number): string =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${id}.png`;

const POOL: ReadonlyArray<{
  rarity: CcRarity;
  name: string;
  id: number;
  weight: number;
}> = [
  { rarity: 'Common', name: 'Pidgey', id: 16, weight: 40 },
  { rarity: 'Common', name: 'Rattata', id: 19, weight: 40 },
  { rarity: 'Uncommon', name: 'Pikachu', id: 25, weight: 15 },
  { rarity: 'Uncommon', name: 'Eevee', id: 133, weight: 15 },
  { rarity: 'Rare', name: 'Snorlax', id: 143, weight: 4 },
  { rarity: 'Rare', name: 'Gengar', id: 94, weight: 4 },
  { rarity: 'Epic', name: 'Charizard', id: 6, weight: 1 },
  { rarity: 'Epic', name: 'Mewtwo', id: 150, weight: 1 },
];

/** Undian kartu palsu berbobot (mirip odds mesin). Math.random cukup — ini demo. */
export function pickMockCard(): MockCard {
  const total = POOL.reduce((sum, c) => sum + c.weight, 0);
  let r = Math.random() * total;
  let chosen = POOL[POOL.length - 1];
  for (const c of POOL) {
    r -= c.weight;
    if (r <= 0) {
      chosen = c;
      break;
    }
  }
  return {
    rarity: chosen.rarity,
    nftName: `${chosen.name} (Demo)`,
    nftImage: art(chosen.id),
    roll: String(Math.floor(Math.random() * 10_000)),
    points: Math.floor(Math.random() * 500) + 50,
  };
}
