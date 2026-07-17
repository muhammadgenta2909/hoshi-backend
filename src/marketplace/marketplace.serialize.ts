import { Activity, Listing, Nft, Offer, Prisma, User } from '@prisma/client';

/**
 * Bentuk yang dikirim ke frontend, cocok 1:1 dengan tipe `Listing` di
 * `lib/market.ts`. Field detail tambahan dibaca dari row listing, bukan dibuat
 * runtime dari daftar mock.
 */
type ListingNft = Pick<Nft, 'id' | 'assetAddress' | 'mintTx'>;
type OfferRecord = Pick<
  Offer,
  'id' | 'user' | 'amount' | 'status' | 'createdAt'
>;
type ListingRow = Listing & {
  nft?: ListingNft | null;
  offerRecords?: OfferRecord[];
};

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
    // Provenance vault: 'HOSHI' | 'COLLECTORCRYPT'. Badge di kartu dirender dari
    // sini — bukan lagi disimpulkan dari buyback > 0 (itu semantik lama yang
    // salah kaprah: buyback>0 artinya "ada jaminan buyback", bukan "vault Hoshi").
    source: row.source,
    // true ⇒ CC punya buyback offer aktif untuk kartu ini (harga & eksekusi
    // milik CollectorCrypt; kita hanya meneruskan sinyalnya).
    ccHasBuyback: row.ccHasBuyback,
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
  const languageTag =
    row.language === 'Japan' ? 'JAPAN' : row.language.toUpperCase();
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

/* ------------------------- offers (profile tabs) -------------------------- */

/** Wallet panjang → bentuk pendek gaya TopNav (mis. "7xKXt..9c14"). */
export function shortWallet(address: string): string {
  if (address.length <= 11) return address;
  return `${address.slice(0, 5)}..${address.slice(-4)}`;
}

/** Nama yang dipakai di kolom From/To: displayName kalau ada, kalau tidak wallet pendek. */
export function displayLabel(
  user: Pick<User, 'displayName' | 'walletAddress'> | null | undefined,
  fallback: string,
): string {
  if (!user) return fallback;
  const name = user.displayName?.trim();
  return name && name.length > 0 ? name : shortWallet(user.walletAddress);
}

type OfferUser = Pick<User, 'id' | 'displayName' | 'walletAddress'>;
type OfferListing = Pick<
  Listing,
  | 'id'
  | 'name'
  | 'image'
  | 'category'
  | 'set'
  | 'priceIdrx'
  | 'status'
  | 'sellerAddress'
> & { seller?: OfferUser | null };

export type OfferRow = Offer & {
  listing: OfferListing;
  buyer?: OfferUser | null;
};

/**
 * Satu baris tab "Offers Made" / "Offers Received". Membawa kedua sisi
 * (buyer + seller) supaya satu tipe cukup untuk kedua tabel.
 */
export function toOfferDto(row: OfferRow) {
  return {
    id: row.id,
    listingId: row.listingId,
    amount: row.amount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    /** true selama offer masih bisa di-accept/reject/cancel. */
    actionable: row.status === 'PENDING' && row.listing.status === 'ACTIVE',
    item: {
      id: row.listing.id,
      name: row.listing.name,
      image: row.listing.image,
      category: row.listing.category,
      set: row.listing.set,
      price: row.listing.priceIdrx,
      status: row.listing.status,
    },
    buyer: {
      id: row.buyerId,
      // `row.user` = label snapshot saat offer dibuat (offer POC lama tak punya buyer).
      label: displayLabel(row.buyer, row.user),
    },
    seller: {
      id: row.listing.seller?.id ?? null,
      label: displayLabel(row.listing.seller, row.listing.sellerAddress),
    },
  };
}

export type OfferDto = ReturnType<typeof toOfferDto>;

/* ------------------------ activity (profile feed) ------------------------- */

export type ActivityRow = Activity;

/**
 * Satu baris feed Activity. Semua kolom tampilan berasal dari snapshot di baris
 * activity, jadi riwayat tetap utuh walau listing/user berubah nama.
 */
export function toActivityDto(row: ActivityRow) {
  return {
    id: row.id,
    type: row.type,
    listingId: row.listingId,
    item: {
      name: row.itemName,
      image: row.itemImage,
      category: row.category,
      set: row.set,
    },
    /** null ⇒ event tanpa nominal; UI merender "----". */
    amount: row.amount,
    from: row.fromId ? { id: row.fromId, label: row.fromLabel } : null,
    to: row.toId ? { id: row.toId, label: row.toLabel } : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export type ActivityDto = ReturnType<typeof toActivityDto>;
