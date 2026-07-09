import { Listing, Nft, Offer, Prisma } from '@prisma/client';

/**
 * Bentuk yang dikirim ke frontend, cocok 1:1 dengan tipe `Listing` di
 * `lib/market.ts`. Field detail tambahan dibaca dari row listing, bukan dibuat
 * runtime dari daftar mock.
 */
type ListingNft = Pick<Nft, 'id' | 'assetAddress' | 'mintTx'>;
type OfferRecord = Pick<Offer, 'id' | 'user' | 'amount' | 'status' | 'createdAt'>;
type ListingRow = Listing & { nft?: ListingNft | null; offerRecords?: OfferRecord[] };

type DetailOffer = {
  id: string;
  user: string;
  ago: string;
  amount: number;
  status: string;
};

function toNftDto(nft: ListingNft) {
  return {
    id: nft.id,
    assetAddress: nft.assetAddress,
    mintTx: nft.mintTx,
  };
}

function readPriceHistory(
  value: Prisma.JsonValue | null | undefined,
  fallback: number[],
): number[] {
  const raw = Array.isArray(value) ? value : [];
  const fromJson = raw
    .map((v) => (typeof v === 'number' ? v : Number(v)))
    .filter((v) => Number.isFinite(v));
  const source = fromJson.length > 0 ? fromJson : fallback;
  if (source.length >= 2) return source;
  const only = source[0] ?? 0;
  return [only, only];
}

function ago(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function readOffers(records: OfferRecord[]): DetailOffer[] {
  return records.map((o) => ({
    id: o.id,
    user: o.user,
    ago: ago(o.createdAt),
    amount: o.amount,
    status: o.status,
  }));
}

function changePct(history: number[]): number {
  const first = history[0] ?? 0;
  const last = history[history.length - 1] ?? first;
  if (first <= 0) return 0;
  return Math.round(((last - first) / first) * 1000) / 10;
}

export function toListingDto(row: ListingRow) {
  return {
    id: row.id,
    kind: 'card' as const,
    name: row.name,
    set: row.set,
    rarity: row.rarity,
    image: row.image,
    imageBack: row.imageBack ?? undefined,
    price: row.priceIdrx,
    expectedValue: row.expectedValueIdrx,
    buyback: row.buybackIdrx,
    seller: row.sellerAddress,
    listedAt: row.listedAt.toISOString(),
    grade: row.grade,
    grader: row.grader,
    gradeScore: row.gradeScore,
    language: row.language,
    era: row.era,
    element: row.element,
    category: row.category,
    views: row.views,
    status: row.status,
    nft: row.nft ? toNftDto(row.nft) : null,
  };
}

export type ListingDto = ReturnType<typeof toListingDto>;

/**
 * Bundel detail satu listing. Semua data display diambil dari listing/NFT row:
 * certificate, vault location, history, offers, card number, dan variant harus
 * berasal dari DB/API create, bukan generator serializer.
 */
export function toCardDetailDto(row: ListingRow, related: ListingRow[]) {
  const listing = toListingDto(row);
  const languageLong = row.language === 'Japan' ? 'Japanese' : row.language;
  const languageTag = row.language === 'Japan' ? 'JAPAN' : row.language.toUpperCase();
  const priceHistory = readPriceHistory(row.priceHistory, [
    row.expectedValueIdrx,
    row.priceIdrx,
  ]);

  const details = [
    { label: 'Set', value: row.set },
    { label: 'Rarity', value: row.rarity },
    { label: 'Category', value: row.category },
    { label: 'Grader', value: row.grader },
    ...(row.cardNumber ? [{ label: 'Card no.', value: row.cardNumber }] : []),
    ...(row.variant ? [{ label: 'Variant', value: row.variant }] : []),
    { label: 'Language', value: languageLong },
  ];

  return {
    listing,
    title: `${row.name.toUpperCase()} - ${row.category} - ${row.grade}`,
    tags: [row.grade, languageTag, row.era] as [string, string, string],
    consignedBy: row.sellerAddress,
    certificate: row.certificate ?? null,
    estMarketValueIdr: row.expectedValueIdrx,
    vaultLocation: row.vaultLocation ?? null,
    contractAddress: row.nft?.assetAddress ?? row.contractAddress ?? null,
    change30dPct: changePct(priceHistory),
    priceHistory,
    offers: readOffers(row.offerRecords ?? []),
    details,
    collectionLabel: row.set,
    related: related.map(toListingDto),
  };
}
