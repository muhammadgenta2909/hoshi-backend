/**
 * Tipe wire untuk API KATALOG PUBLIK CollectorCrypt Marketplace V2:
 * `GET https://api.collectorcrypt.com/marketplace` — TANPA auth, TANPA API key.
 * (Berbeda total dengan API gacha di cc-gacha.types.ts yang butuh x-api-key.)
 *
 * Bentuk di bawah diverifikasi terhadap respons live 2026-07-17 (2 sampel kartu
 * Pokemon). Dokumentasi resmi: https://docs.collectorcrypt.com/marketplace/api
 *
 * JEBAKAN SATUAN: `listing.price` adalah DOLAR UTUH (mis. 143.99), dan pernah
 * terlihat sebagai STRING ("25") di contoh dokumentasi — selalu lewat Number()
 * sebelum dipakai. JANGAN konversi ke base unit 6-desimal untuk disimpan:
 * kartu > $2.147 akan overflow Int32. Simpan sebagai dolar Float.
 */

/** Sub-objek listing aktif pada satu kartu katalog. */
export interface CcMarketListing {
  /** Selalu 'USDC' sejauh terobservasi. */
  currency?: string;
  /** DOLAR UTUH; number di respons live, string di contoh docs. */
  price: number | string;
  receiptId?: string;
  sellerId?: string;
  /** 'CC' (native) | 'ME' (agregasi Magic Eden). */
  marketplace?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** Satu kartu pada array `filterNFtCard`. Field di luar kebutuhan sync dibiarkan lepas. */
export interface CcMarketCard {
  id: string;
  itemName: string;
  /** Alamat asset Solana — kunci upsert kita (unik per kartu fisik ter-vault). */
  nftAddress: string;
  blockchain?: string | null;
  category?: string | null;
  type?: string | null;
  year?: number | null;
  /** Label grade mentah, mis. "MINT 9" / "NM-MT 8" / "GEM-MT 10". */
  grade?: string | null;
  gradeNum?: number | null;
  /** 'PSA' | 'CGC' | 'Beckett' | 'SGC' | ... — lebih luas dari enum Grader kita. */
  gradingCompany?: string | null;
  gradingID?: string | null;
  /** Nilai asuransi dalam dolar; string di respons live ("85"). */
  insuredValue?: string | number | null;
  set?: string | null;
  serial?: string | null;
  language?: string | null;
  /** Nama vault fisik CC, mis. "OmniVault". */
  vault?: string | null;
  vaultId?: string | null;
  frontImage?: string | null;
  backImage?: string | null;
  images?: {
    front?: string;
    frontM?: string;
    frontS?: string;
    back?: string;
    backM?: string;
    backS?: string;
  } | null;
  /** null/absen ⇒ kartu tidak sedang dilisting (bukan "Buy now"). */
  listing?: CcMarketListing | null;
  owner?: { id?: string; name?: string | null; wallet?: string } | null;
}

/** Amplop respons GET /marketplace. */
export interface CcMarketBrowseResponse {
  /** Jumlah hasil setelah filter. */
  findTotal: number;
  /** Jumlah seluruh kartu di katalog mereka. */
  total: number;
  totalPages: number;
  filterNFtCard: CcMarketCard[];
}

/** Query yang kita pakai — subset dari filter lengkap di dokumentasi mereka. */
export interface CcMarketBrowseQuery {
  /** 1-indexed. */
  page?: number;
  /** Ukuran halaman, maks 100 di sisi mereka. */
  step?: number;
  /** CSV kategori, mis. "Pokemon" atau "Pokemon,One Piece". */
  categories?: string;
  /** 'CC' = hanya listing native mereka (bukan agregasi Magic Eden). */
  marketplaceSource?: string;
  /** 'Buy now' = hanya yang sedang dilisting dengan harga. */
  marketplaceStatus?: string;
  listPriceMin?: number;
  listPriceMax?: number;
  /** true ⇒ hanya kartu dengan buyback offer AKTIF dari CC. */
  ccBuyback?: boolean;
  orderBy?: string;
  search?: string;
}
