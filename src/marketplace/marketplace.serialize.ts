import { Activity, Listing, Nft, Offer, Prisma, User } from '@prisma/client';
import { isEscrowBackedUserListing } from './p2p.gate';

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

/**
 * Konteks yang TIDAK bisa dibaca dari baris listing itu sendiri. Satu-satunya isinya sekarang
 * adalah "jalur escrow real sedang berlaku", dan ia sengaja DIOPER, bukan dibaca dari env di
 * dalam serializer: serializer ini dipakai admin, feed publik, dan halaman pemilik, dan tiap
 * pemanggil harus terlihat memutuskan sendiri konteks mana yang benar untuknya.
 */
export interface ListingDtoOpts {
  /**
   * true = HOSHI_P2P_ENABLED menyala (bukan mock) → penjualan antar user diselesaikan lewat
   * escrow sungguhan. Default false, yang berarti `needsEscrowDeposit` selalu false — nilai
   * yang benar untuk mode mock/unarmed, di mana listing tanpa escrow memang sah.
   */
  p2pEscrowRequired?: boolean;
}

export function toListingDto(row: ListingRow, opts: ListingDtoOpts = {}) {
  // FAKTA, bukan flag: escrow TERBUKTI memegang kartu ini (lihat migration 20260918000100).
  const escrowed = row.escrowedAt != null;
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
    // Kapan kartu ini BERPINDAH TANGAN. `listedAt` adalah kapan PENJUAL memajangnya
    // — untuk kartu hasil sync CollectorCrypt itu waktu sync, sama sekali tak terkait
    // dengan kapan pembeli mendapatkannya. Tab Assets di /account mengurutkan koleksi
    // milik user, jadi ia butuh waktu perolehan, bukan waktu pajang. null = belum terjual.
    soldAt: row.soldAt?.toISOString() ?? null,
    grade: row.grade,
    grader: row.grader,
    gradeScore: row.gradeScore,
    language: row.language,
    era: row.era,
    element: row.element,
    category: row.category,
    // Game/TCG franchise dari CC ("Pokemon" dst). Dipakai FE utk deteksi jenis kartu 100%
    // akurat; null ⇒ FE jatuh ke heuristik kata kunci. Muncul di list DAN detail (detail
    // menyematkan toListingDto).
    tcg: row.tcg ?? null,
    views: row.views,
    status: row.status,
    // Provenance vault: 'HOSHI' | 'COLLECTORCRYPT'. Badge di kartu dirender dari
    // sini — bukan lagi disimpulkan dari buyback > 0 (itu semantik lama yang
    // salah kaprah: buyback>0 artinya "ada jaminan buyback", bukan "vault Hoshi").
    source: row.source,
    // true ⇒ CC punya buyback offer aktif untuk kartu ini (harga & eksekusi
    // milik CollectorCrypt; kita hanya meneruskan sinyalnya).
    ccHasBuyback: row.ccHasBuyback,
    // Alamat NFT on-chain kartu (di-set saat LIST untuk kartu hasil pack, @unique).
    // Frontend memakainya untuk mencocokkan kartu vault ↔ listing-nya SEBELUM terjual
    // (relasi `nft` baru terisi saat mint pembelian, jadi tidak bisa dipakai di sini).
    ccNftAddress: row.ccNftAddress ?? null,
    // ── Flow B (jual-beli antar user) ─────────────────────────────────────────
    // true = wallet escrow Hoshi TERBUKTI memegang kartu ini. Diturunkan dari kolom escrowedAt,
    // yaitu FAKTA historis — BUKAN dari pembacaan HOSHI_P2P_ENABLED saat request ini terjadi.
    escrowed,
    // true = listing ini TIDAK BISA DIBELI sekarang: jalur escrow real berlaku, ini listing
    // milik seorang USER, tapi ia tidak escrow-backed — entah kartunya tidak pernah dititipkan
    // ke escrow (dibuat sebelum fiturnya dinyalakan), entah ia tidak punya aset on-chain sama
    // sekali (dibuat lewat POST /marketplace tanpa fromPackMemo, jadi tidak ada yang bisa
    // dititipkan). PEMILIK harus bertindak; PEMBELI tidak boleh ditawari tombol beli. Server
    // menolaknya di semua jalur penerbitan tagihan apa pun yang dilakukan UI — field ini supaya
    // UI tidak perlu menawarkan tombol yang pasti gagal.
    //
    // PEMULIHANNYA BEDA untuk dua sub-kasus, dan UI bisa membedakannya dari `ccNftAddress` yang
    // ada di DTO ini juga: ada ⇒ satu aksi `POST /marketplace/:id/relist` (→ PENDING_ESCROW,
    // lalu tanda tangan escrow); null ⇒ tidak ada kartu on-chain untuk dititipkan, satu-satunya
    // jalan adalah membatalkan listing-nya.
    //
    // Predikatnya SATU fungsi bersama dengan gerbang, feed publik, dashboard admin dan
    // settlement (src/marketplace/p2p.gate.ts). Dulu ia ditulis ulang di sini DAN MELESET: ia
    // menuntut `ccNftAddress != null`, sehingga populasi yang paling mudah dibuat tidak pernah
    // ditandai kepada pemiliknya.
    needsEscrowDeposit:
      opts.p2pEscrowRequired === true &&
      row.sellerId != null &&
      !isEscrowBackedUserListing(row),
    nft: row.nft ? toNftDto(row.nft) : null,
  };
}

export type ListingDto = ReturnType<typeof toListingDto>;

/**
 * Bundel detail satu listing. Semua data display diambil dari listing/NFT row:
 * certificate, vault location, history, offers, card number, dan variant harus
 * berasal dari DB/API create, bukan generator serializer.
 */
export function toCardDetailDto(
  row: ListingRow,
  related: ListingRow[],
  opts: ListingDtoOpts = {},
) {
  const listing = toListingDto(row, opts);
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
    ...(row.tcg ? [{ label: 'Game', value: row.tcg }] : []),
    { label: 'Category', value: row.category },
    { label: 'Grader', value: row.grader },
    ...(row.cardNumber ? [{ label: 'Card no.', value: row.cardNumber }] : []),
    ...(row.variant ? [{ label: 'Variant', value: row.variant }] : []),
    { label: 'Language', value: languageLong },
  ];

  return {
    // Objek listing penuh (image, price, status, source, views, dst.) — frontend
    // (LeftColumn/RightColumn) mendestrukturnya; TANPA ini halaman detail throw.
    listing,
    // Judul = nama katalog CollectorCrypt apa adanya (row.name = facts.itemName),
    // identik dengan H1 halaman Vault (pull.ccItemName). Dulu di sini di-UPPERCASE
    // dan ditempeli " - {category} - {grade}", membuat kartu yang sama tampak beda
    // di dua halaman; grade sudah muncul sebagai tag + baris "Card Grade" dan
    // category sudah jadi baris detail, jadi imbuhan itu memang berlebih.
    title: row.name,
    tags: [row.grade, languageTag, row.era] as [string, string, string],
    consignedBy: row.sellerAddress,
    // true = ada PENJUAL USER (listing P2P) → fee 5% dipotong dari penjual. false = milik Hoshi
    // sendiri / katalog CC (tak ada penjual eksternal). Sinyal andal (sellerAddress bisa apa saja).
    sellerConsigned: row.sellerId != null,
    // true = stok Hoshi genuine yang boleh dibeli (jalur Hoshi-inventory). Baris seed/placeholder
    // (source=HOSHI,sellerId=null tapi sellable=false) → false, jadi UI tak menawarkan beli.
    sellable: row.sellable,
    certificate: row.certificate ?? null,
    estMarketValueIdr: row.expectedValueIdrx,
    vaultLocation: row.vaultLocation ?? null,
    contractAddress: row.nft?.assetAddress ?? row.contractAddress ?? null,
    change30dPct: changePct(priceHistory),
    priceHistory,
    offers: readOffers(row.offerRecords ?? []),
    details,
    collectionLabel: row.set,
    // WAJIB lambda, BUKAN `related.map(toListingDto)`: Array.map mengoper (nilai, INDEX, array),
    // jadi bentuk pendeknya akan menyuntikkan index numerik sebagai `opts` dan mematikan
    // penandaan needsEscrowDeposit tanpa satu pun error TypeScript.
    related: related.map((r) => toListingDto(r, opts)),
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
