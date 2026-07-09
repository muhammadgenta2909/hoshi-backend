import { Grader, PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function seedCards() {
  const existing = await prisma.card.count();
  if (existing > 0) {
    console.log(`Seed card dilewati — sudah ada ${existing} card.`);
    return;
  }

  const metadataUri =
    process.env.DEFAULT_METADATA_URI ??
    'https://gateway.irys.xyz/6UNWfKd2igXWUGF7XY39Mwa7baeVwFHVdorDCaH1bjN2';

  const charizard = await prisma.card.create({
    data: {
      name: 'Hoshi Card #001 — Charizard',
      description: 'POC card NFT untuk validasi vault Hoshi',
      imageUrl: 'https://placehold.co/400x560/png?text=Charizard',
      set: 'Base',
      rarity: 'Holo Rare',
      attributes: [
        { trait_type: 'Set', value: 'Base' },
        { trait_type: 'Rarity', value: 'Holo Rare' },
      ],
      metadataUri,
    },
  });

  const blastoise = await prisma.card.create({
    data: {
      name: 'Hoshi Card #002 — Blastoise',
      description: 'POC card NFT untuk validasi vault Hoshi',
      imageUrl: 'https://placehold.co/400x560/png?text=Blastoise',
      set: 'Base',
      rarity: 'Holo Rare',
      attributes: [
        { trait_type: 'Set', value: 'Base' },
        { trait_type: 'Rarity', value: 'Holo Rare' },
      ],
      metadataUri,
    },
  });

  // Taruh beberapa item di vault (STORED → siap diklaim user).
  await prisma.vaultItem.create({
    data: { cardId: charizard.id, serialNumber: 'CHAR-0001' },
  });
  await prisma.vaultItem.create({
    data: { cardId: blastoise.id, serialNumber: 'BLAS-0001' },
  });

  console.log('Seed card selesai:', {
    cards: [charizard.id, blastoise.id],
    vaultItems: 2,
  });
}

// Dynamic card image — uses placehold.co with card name & element-based color.
const ELEMENT_BG: Record<string, string> = {
  Fire: '4a0e0e', Water: '0e2a4a', Grass: '0e3a0e', Psychic: '2e0e3a',
  Lightning: '3a2e0e', Rock: '2a1a0e',
};
const DEFAULT_BG = '1a1a2e';
function cardImg(name: string, element: string): string {
  const bg = ELEMENT_BG[element] ?? DEFAULT_BG;
  return `https://placehold.co/400x560/${bg}/ffd700?text=${encodeURIComponent(name.replace(/\s/g, '+'))}`;
}

const VAULT_LOCATIONS = ['Jakarta Vault A', 'Jakarta Vault B', 'Jakarta Vault C'];
const OFFER_USERS = ['sora_cards', 'akira_collects', 'reno.sol', 'kyx_vault'];
const OFFER_AGES = ['2m ago', '17m ago', '1h ago', '3h ago'];

function certificate(i: number) {
  return `${8841 + i * 17} ${2207 + i * 31}`;
}

function cardNumber(i: number) {
  return `${24 + i * 7}/190`;
}

function variant(category: string) {
  if (category === 'Rainbow') return 'Rainbow Foil';
  if (category === 'Full Art') return 'Full Art';
  if (category === 'PROMO CARD') return 'Promo';
  return 'Holo';
}

function priceHistory(price: number, i: number) {
  const tilt = (i % 4) + 1;
  return [
    Math.round(price * (0.9 + tilt * 0.005)),
    Math.round(price * (0.92 + tilt * 0.006)),
    Math.round(price * (0.94 + tilt * 0.006)),
    Math.round(price * (0.965 + tilt * 0.004)),
    Math.round(price * (0.985 + tilt * 0.003)),
    price,
  ];
}

function offers(price: number, i: number) {
  return [0, 1, 2].map((n) => ({
    user: OFFER_USERS[(i + n) % OFFER_USERS.length],
    ago: OFFER_AGES[n],
    amount: Math.round((price * (0.96 + n * 0.04)) / 1000) * 1000,
    changePct: Math.round((1.5 + n * 1.2 + (i % 3) * 0.4) * 10) / 10,
  }));
}

// Fixture marketplace awal. Setelah seed, frontend membaca data ini lewat
// GET /marketplace dan GET /marketplace/:id, bukan dari mock lokal.
const SEED_LISTINGS = [
  { name: 'Charizard VMAX', set: 'Classic', rarity: 'Legendary Rare', image: cardImg('Charizard VMAX', 'Fire'), price: 24_250_000, expectedValue: 27_000_000, buyback: 18_000_000, seller: 'x0f3a..91c2', listedAt: '2026-06-30T21:10:00Z', grade: 'PSA 10', grader: Grader.PSA, gradeScore: 10, language: 'English', era: 'Classic', element: 'Fire', category: 'Character Illustration', views: 1_920 },
  { name: 'Blastoise GX', set: 'Classic', rarity: 'Rare', image: cardImg('Blastoise GX', 'Water'), price: 12_100_000, expectedValue: 11_000_000, buyback: 0, seller: 'x7b21..44de', listedAt: '2026-06-27T14:03:00Z', grade: 'PSA 9', grader: Grader.PSA, gradeScore: 9, language: 'English', era: 'Classic', element: 'Water', category: 'Full Art', views: 860 },
  { name: 'Venusaur EX', set: 'Jungle', rarity: 'Epic', image: cardImg('Venusaur EX', 'Grass'), price: 14_000_000, expectedValue: 15_500_000, buyback: 0, seller: 'x91cc..02af', listedAt: '2026-06-29T18:41:00Z', grade: 'CGC 9.5', grader: Grader.CGC, gradeScore: 9.5, language: 'Japan', era: 'Sword & Shield', element: 'Grass', category: 'Secret Rare', views: 1_240 },
  { name: 'Mewtwo VSTAR', set: 'Promo', rarity: 'Legendary', image: cardImg('Mewtwo VSTAR', 'Psychic'), price: 31_500_000, expectedValue: 30_000_000, buyback: 22_000_000, seller: 'x0aa1..7f30', listedAt: '2026-06-30T07:55:00Z', grade: 'PSA 10', grader: Grader.PSA, gradeScore: 10, language: 'English', era: 'Scarlet & Violet', element: 'Psychic', category: 'Rainbow', views: 2_010 },
  { name: 'Pikachu Illustrator', set: 'Rare', rarity: 'Legendary Rare', image: cardImg('Pikachu Illustrator', 'Lightning'), price: 88_000_000, expectedValue: 92_000_000, buyback: 66_000_000, seller: 'x5d09..a1b8', listedAt: '2026-06-30T21:10:00Z', grade: 'BGS 9.5', grader: Grader.BGS, gradeScore: 9.5, language: 'Japan', era: 'Vintage', element: 'Lightning', category: 'Special Illustration', views: 3_400 },
  { name: 'Rayquaza VMAX', set: 'Evolving', rarity: 'Epic', image: cardImg('Rayquaza VMAX', 'Water'), price: 27_400_000, expectedValue: 26_000_000, buyback: 0, seller: 'x22f7..9c14', listedAt: '2026-06-26T11:20:00Z', grade: 'PSA 10', grader: Grader.PSA, gradeScore: 10, language: 'Japan', era: 'Sword & Shield', element: 'Water', category: 'Full Art', views: 1_780 },
  { name: 'Gengar ex', set: 'Jungle', rarity: 'Common', image: cardImg('Gengar ex', 'Psychic'), price: 9_800_000, expectedValue: 10_500_000, buyback: 0, seller: 'x8e42..30bd', listedAt: '2026-06-25T16:47:00Z', grade: 'CGC 8.5', grader: Grader.CGC, gradeScore: 8.5, language: 'English', era: 'Sun & Moon', element: 'Psychic', category: 'Character Illustration', views: 540 },
  { name: 'Snorlax', set: 'Evolving', rarity: 'Rare', image: cardImg('Snorlax', 'Rock'), price: 13_000_000, expectedValue: 12_400_000, buyback: 0, seller: 'x1c60..55ea', listedAt: '2026-06-24T08:30:00Z', grade: 'PSA 9', grader: Grader.PSA, gradeScore: 9, language: 'English', era: 'XY', element: 'Rock', category: 'Full Art', views: 720 },
  { name: 'Mew ex', set: 'Promo', rarity: 'Legendary', image: cardImg('Mew ex', 'Psychic'), price: 21_500_000, expectedValue: 24_800_000, buyback: 15_000_000, seller: 'x3ab9..7712', listedAt: '2026-06-29T12:00:00Z', grade: 'PSA 10', grader: Grader.PSA, gradeScore: 10, language: 'Japan', era: 'Scarlet & Violet', element: 'Psychic', category: 'Special Illustration', views: 2_650 },
  { name: 'Umbreon VMAX', set: 'Evolving', rarity: 'Legendary Rare', image: cardImg('Umbreon VMAX', 'Psychic'), price: 45_800_000, expectedValue: 52_000_000, buyback: 34_000_000, seller: 'x0d51..8ac3', listedAt: '2026-06-28T19:25:00Z', grade: 'BGS 9.5', grader: Grader.BGS, gradeScore: 9.5, language: 'Japan', era: 'Sword & Shield', element: 'Psychic', category: 'Rainbow', views: 4_100 },
  { name: 'Lugia V', set: 'Rare', rarity: 'Epic', image: cardImg('Lugia V', 'Water'), price: 10_900_000, expectedValue: 11_200_000, buyback: 0, seller: 'x64f2..11bd', listedAt: '2026-06-27T09:15:00Z', grade: 'CGC 9', grader: Grader.CGC, gradeScore: 9, language: 'English', era: 'Sun & Moon', element: 'Water', category: 'Full Art', views: 990 },
  { name: 'Giratina V', set: 'Promo', rarity: 'Legendary', image: cardImg('Giratina V', 'Psychic'), price: 18_300_000, expectedValue: 17_500_000, buyback: 0, seller: 'x9c07..4fe1', listedAt: '2026-06-26T20:40:00Z', grade: 'PSA 9.5', grader: Grader.PSA, gradeScore: 9.5, language: 'English', era: 'Black & White', element: 'Psychic', category: 'Character Illustration', views: 1_330 },
];

async function seedListings() {
  const existing = await prisma.listing.count();
  if (existing > 0) {
    console.log(`Seed listing dilewati — sudah ada ${existing} listing.`);
    return;
  }

  for (const [i, l] of SEED_LISTINGS.entries()) {
    await prisma.listing.create({
      data: {
        name: l.name,
        set: l.set,
        rarity: l.rarity,
        image: l.image,
        imageBack: '/card-back.svg',
        priceIdrx: l.price,
        expectedValueIdrx: l.expectedValue,
        buybackIdrx: l.buyback,
        grade: l.grade,
        grader: l.grader,
        gradeScore: l.gradeScore,
        language: l.language,
        era: l.era,
        element: l.element,
        category: l.category,
        views: l.views,
        certificate: certificate(i),
        vaultLocation: VAULT_LOCATIONS[i % VAULT_LOCATIONS.length],
        cardNumber: cardNumber(i),
        variant: variant(l.category),
        priceHistory: priceHistory(l.price, i),
        offers: offers(l.price, i),
        sellerAddress: l.seller,
        listedAt: new Date(l.listedAt),
      },
    });
  }

  console.log(`Seed listing selesai: ${SEED_LISTINGS.length} listing.`);
}

async function main() {
  await seedCards();
  await seedListings();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
