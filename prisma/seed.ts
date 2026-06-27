import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.card.count();
  if (existing > 0) {
    console.log(`Seed dilewati — sudah ada ${existing} card.`);
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

  console.log('Seed selesai:', {
    cards: [charizard.id, blastoise.id],
    vaultItems: 2,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
