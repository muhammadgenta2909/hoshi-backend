/**
 * Tipe wire CollectorCrypt Gacha API — cerminan 1:1 dari kontrak resmi mereka.
 *
 * ATURAN: file ini HANYA boleh berisi bentuk yang benar-benar ada di dokumentasi.
 * Jangan menambah field karangan sendiri — kalau bentuknya tidak didokumentasikan,
 * biarkan `unknown` dan biarkan pemanggil yang mempersempit (narrow).
 */

/**
 * Tier rarity CollectorCrypt: HANYA 4. Ini BUKAN 5-tier Hoshi
 * (Common|Rare|Epic|Legendary|Legendary Rare) — jangan pernah melewatkan nilai ini
 * ke `normalizeRarity()` milik packs.catalog: 'Uncommon' akan diam-diam jadi 'Common'.
 *
 * CASING: ini bentuk KANONIK kita (kapital) yang disimpan ke DB supaya data kita
 * konsisten dengan dirinya sendiri. API CC TIDAK konsisten soal kapitalisasi:
 * /api/machines & /api/stock mengirim key huruf-kecil (lihat CcRarityWire), sedang
 * contoh openPack di dokumentasi memakai "Epic" (kapital) dan getRecentWinners malah
 * mengirim prize_tier NUMERIK. Karena itu SETIAP nilai rarity dari wire WAJIB
 * dilewatkan `toCcRarity()` dulu — jangan pernah mengasumsikan kapitalisasinya.
 */
export type CcRarity = 'Common' | 'Uncommon' | 'Rare' | 'Epic';

export const CC_RARITIES: readonly CcRarity[] = [
  'Common',
  'Uncommon',
  'Rare',
  'Epic',
] as const;

/**
 * Casing APA ADANYA di wire untuk key peta rarity (/api/machines, /api/stock).
 * Ground truth: {"common":..,"uncommon":..,"rare":..,"epic":..} — huruf kecil.
 * Sengaja dibuat tipe TERPISAH dari CcRarity (kapital) supaya keduanya tidak mungkin
 * tertukar oleh sistem tipe: peta wire di-key CcRarityWire, DB kita di-key CcRarity.
 */
export type CcRarityWire = 'common' | 'uncommon' | 'rare' | 'epic';

export const CC_RARITIES_WIRE: readonly CcRarityWire[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
] as const;

/**
 * Peta bernilai per-rarity DARI WIRE (odds, stock, tierRanges pada /api/machines,
 * dan seluruh /api/stock). Di-key HURUF-KECIL karena itulah yang benar-benar datang.
 * Membaca map ini dengan key kapital (mis. `odds['Common']`) SELALU `undefined`.
 */
export type CcRarityMap<T> = Partial<Record<CcRarityWire, T>>;

/**
 * Normaliser rarity kanonik: case-INSENSITIVE, mengembalikan bentuk kapital kita.
 * Mengembalikan `null` untuk apa pun yang tak dikenal — TIDAK PERNAH menebak, tidak
 * pernah default ke 'Common'. Pakai ini di SETIAP batas tempat rarity CC masuk domain
 * kita (mis. sebelum menyimpan rarity hasil openPack) supaya DB kita seragam kapital
 * berapa pun casing yang dikirim CC.
 */
export function toCcRarity(value: string): CcRarity | null {
  if (typeof value !== 'string') return null;
  switch (value.trim().toLowerCase()) {
    case 'common':
      return 'Common';
    case 'uncommon':
      return 'Uncommon';
    case 'rare':
      return 'Rare';
    case 'epic':
      return 'Epic';
    default:
      return null;
  }
}

/** 1 USDC = 1_000_000 base units (6 desimal). */
const USDC_BASE_UNITS_PER_DOLLAR = 1_000_000;

/**
 * Konversi DOLAR USDC PENUH -> USDC base units (integer, 6 desimal).
 *
 * FAKTA YANG BIKIN BUG INI: /api/machines mengirim `price`/`ev` dalam DOLAR PENUH
 * (pokemon_50 -> 50, pokemon_1000 -> 1000), BUKAN base units — CC tidak pernah
 * mengirim 50_000_000. Memperlakukannya sebagai base units membuat kita menagih user
 * Indonesia ~Rp 0,04 untuk pack seharga USD 50. Uang tetap INTEGER: kita bulatkan
 * (ev bisa float) lalu pastikan hasilnya safe-integer, dan tolak input tak-hingga/negatif.
 */
export function usdDollarsToUsdcBaseUnits(dollars: number): number {
  if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0) {
    throw new RangeError(
      `Nilai USDC tidak sah untuk dikonversi ke base units: ${String(dollars)}`,
    );
  }
  const baseUnits = Math.round(dollars * USDC_BASE_UNITS_PER_DOLLAR);
  if (!Number.isSafeInteger(baseUnits)) {
    throw new RangeError(
      `Konversi USDC di luar rentang integer aman: ${String(baseUnits)}`,
    );
  }
  return baseUnits;
}

/** Bentuk body error CC saat non-2xx (dipakai untuk meneruskan pesan aslinya). */
export interface CcErrorBody {
  message?: string;
  error?: string;
}

/* --- POST /api/generatePack --- */

export interface CcGeneratePackRequest {
  /**
   * WAJIB. Wallet yang membayar USDC DAN menandatangani transaksi.
   *
   * TIDAK PERNAH boleh berasal dari body request. Hanya ada DUA sumber yang sah, dan
   * keduanya ditentukan server:
   *   - jalur user-bayar (GachaService.generate): JWT, yaitu user.walletAddress.
   *   - jalur treasury-bayar (GachaService.purchase): alamat treasury Hoshi dari
   *     environment — user Indonesia bayar rupiah dan tidak punya USDC/SOL sama sekali.
   * Kalau body boleh menentukannya, penyerang tinggal menyebut wallet KORBAN sebagai
   * pembayar dan kita yang menerbitkan transaksi yang mendebit korban.
   */
  playerAddress: string;
  /** Default CC: "pokemon_50". */
  packType?: string;
  turbo?: boolean;
  /**
   * Kartu menang dikirim ke alamat INI, bukan ke playerAddress.
   * BAHAYA: jangan pernah diisi dari input user — payer bisa dibuat berbeda dari
   * penerima kartu (pola pencurian klasik). Hanya boleh diisi oleh kebijakan server.
   *
   * Jalur treasury-bayar adalah persis "kebijakan server" itu: pembayarnya treasury,
   * dan field ini diisi wallet user DARI JWT supaya kartunya tetap mendarat di user.
   * Tetap tidak boleh berasal dari body: JWT curian pun tidak boleh bisa membelokkan
   * kartu yang treasury bayar ke wallet lain.
   */
  altPlayerAddress?: string;
  /** Turbo saja: hasil auto-sell USDC dikirim ke sini. Batasan sama seperti altPlayerAddress. */
  altFundsRecipient?: string;
}

export interface CcGeneratePackResponse {
  /** Format "slug-uuid". Prefix slug = identitas revenue kita (bagi hasil 50%). */
  memo: string;
  /** Base64, BELUM ditandatangani. Hanya wallet user yang boleh menandatanganinya. */
  transaction: string;
}

/* --- POST /api/generateYoloPacks --- */

export interface CcGenerateYoloPacksRequest {
  /** Rentang yang diterima CC: 1..100. 100 pack × ~$50 = $5.000 USDC sekali request. */
  count: number;
  packType?: string;
  playerAddress: string;
  turbo?: boolean;
  altPlayerAddress?: string;
  altFundsRecipient?: string;
}

export interface CcYoloTransaction {
  memo: string;
  transaction: string;
}

export interface CcGenerateYoloPacksResponse {
  yoloId: string;
  count: number;
  transactions: CcYoloTransaction[];
}

/* --- POST /api/submitTransaction --- */

export type CcConfirmationStatus = 'confirmed' | 'finalized' | 'submitted';

export interface CcSubmitTransactionRequest {
  /** Base64 hasil tanda tangan wallet user. */
  signedTransaction: string;
}

export interface CcSubmitTransactionResponse {
  success: boolean;
  signature: string;
  confirmationStatus: CcConfirmationStatus;
}

/* --- POST /api/openPack --- */

export interface CcOpenPackRequest {
  memo: string;
}

/** Atribut metadata NFT — bentuk isinya tidak dijanjikan kontrak, biarkan opaque. */
export interface CcNftMetadata {
  name: string;
  description: string;
  attributes: unknown[];
}

export interface CcNftWon {
  content: {
    metadata: CcNftMetadata;
  };
}

/**
 * Hasil undian. `roll`/`rarity`/`points` berasal dari VRF on-chain CC
 * (program ccvrfu3fSpbnPLiUqdWAt85Zn9nq96ekwGTbHqGtdgQ) dan bisa diverifikasi
 * sendiri oleh user lewat /api/vrf/verify?memo=. Ini SATU-SATUNYA sumber kebenaran:
 * dilarang menghitung ulang rarity secara lokal.
 */
export interface CcOpenPackResponse {
  success: boolean;
  transactionSignature: string;
  nft_address: string;
  /**
   * Kode keadaan NON-TERMINAL (mis. 'WAITING_FOR_PAYMENT'). Kontrak mereka menyebut
   * openPack bisa membalas `{ success: true, code: ... }` — jadi `success: true` SAJA
   * bukan bukti pack sudah terbuka, dan pada keadaan itu `nft_address` di atas (yang
   * mereka ketik wajib) justru tidak terbit. Perlakukan OPENED sebagai terminal-only:
   * cek `code` dan `nft_address` dulu, jangan percaya `success` sendirian.
   */
  code?: string | null;
  /**
   * Opsional DENGAN SENGAJA. Pack `turbo` menjual-otomatis hadiahnya jadi USDC, jadi bisa
   * saja tidak ada NFT untuk dinamai — dan bentuk ini cuma cerminan dokumentasi mereka,
   * bukan kontrak yang mereka jamin. Menandainya wajib lalu men-deref buta = sebuah pack
   * yang SUDAH terbuka on-chain (ireversibel) gagal tercatat dan tersangkut selamanya.
   */
  nftWon?: CcNftWon | null;
  points?: number | null;
  roll?: number | null;
  /**
   * Rarity hasil undian APA ADANYA dari CC. CASING BELUM DIPASTIKAN: dokumentasi
   * memakai "Epic" (kapital) sementara /api/machines memakai huruf-kecil, dan CC
   * terbukti tidak konsisten (getRecentWinners malah mengirim prize_tier NUMERIK).
   * Karena itu tipenya `string` mentah — WAJIB dilewatkan `toCcRarity()` sebelum
   * disimpan/dibandingkan. Jangan pernah mengasumsikan sudah kapital.
   */
  rarity: string;
}

/* --- POST /api/buyback (jendela 72 jam) --- */

export interface CcBuybackRequest {
  playerAddress: string;
  nftAddress: string;
  /** Penerima dana refund selain playerAddress. Batasan sama seperti altPlayerAddress. */
  altRecipient?: string;
}

export interface CcBuybackResponse {
  success: boolean;
  /** Base64, belum ditandatangani. */
  serializedTransaction: string;
  /**
   * UNIT BELUM DIPASTIKAN. Ground truth belum bisa memanggil buyback (butuh treasury
   * berdana), jadi satuan/casing-nya tak terverifikasi. API yang SAMA mengirim `price`
   * dalam DOLAR PENUH, jadi besar kemungkinan ini pun DOLAR, BUKAN base units.
   * Verifikasi lewat panggilan live sebelum menyimpannya sebagai base units — klien
   * SENGAJA tidak mengubah nilai ini karena menormalkan tebakan bisa jadi bug baru.
   */
  refundAmount: number;
  memo: string;
}

/* --- GET /api/buyback/check?memo= --- */

export interface CcBuybackCheckResponse {
  exists: boolean;
  playerWallet: string;
  nft: string;
  transactionSignature: string;
  /** UNIT BELUM DIPASTIKAN — lihat catatan di CcBuybackResponse.refundAmount. */
  buybackAmount: number;
  status: string;
}

/* --- GET /api/buyback/available?wallet=&nft= --- */

export interface CcBuybackAvailableResponse {
  available: boolean;
  /**
   * UNIT BELUM DIPASTIKAN. Komentar lama mengklaim base units ($50 = 50_000_000), tetapi
   * ground truth TIDAK mengonfirmasi itu — API yang sama mengirim `price` dalam dolar
   * penuh. Verifikasi lewat panggilan live sebelum dipercaya; jangan asumsikan base units.
   */
  amount: number;
}

/* --- GET /api/machines --- */

/**
 * Rentang roll VRF per tier (ground truth: {"start":30,"end":60}). Snapshot apa adanya
 * untuk audit; JANGAN dipakai menghitung ulang undian — rarity resmi hanya dari VRF openPack.
 */
export interface CcTierRange {
  start: number;
  end: number;
}

/**
 * Bentuk MENTAH satu mesin /api/machines — cerminan verbatim yang dikirim CC (ground
 * truth). SEMUA nilai uang di sini masih DOLAR PENUH. JANGAN dikonsumsi langsung oleh
 * service: pakai hasil `CcGachaClient.machines()` (CcMachineNormalized) yang harganya
 * sudah dinormalisasi ke base units. SUMBER KEBENARAN harga/odds/EV — dilarang hardcode.
 */
export interface CcMachine {
  code: string;
  name: string;
  shortName: string;
  image: string;
  thumbnailUrl: string;
  videoSrc: string;
  videoHevc: string;
  public: boolean;
  /** Pemilik mesin bila privat; bentuknya tak dijanjikan kontrak → opaque. */
  owner: unknown;
  /**
   * HARGA DALAM DOLAR USDC PENUH (mis. pokemon_50 -> 50, pokemon_1000 -> 1000).
   * BUKAN base units — CC TIDAK PERNAH mengirim 50_000_000.
   *
   * BAHAYA (bug yang benar-benar pernah terjadi): memperlakukan angka ini sebagai base
   * units lalu `usdcBaseUnitsToDecimalString(50)` -> "0.00005", sehingga user Indonesia
   * ditagih ~Rp 0,04 untuk pack seharga USD 50 (atau order gagal karena di bawah minimum
   * mint) dan plafon treasury tak pernah tersentuh. Selalu konversi via
   * `usdDollarsToUsdcBaseUnits()`; di klien ini sudah dilakukan dan hasilnya ada di
   * `CcMachineNormalized.priceUsdcBaseUnits`.
   */
  price: number;
  /** Berapa kartu per pack. */
  contains: number;
  /** Persentase instant-buyback (mis. 85 = 85%). BUKAN nilai uang. */
  instantBuyback: number;
  freeSpins: boolean;
  turboMode: boolean;
  pointsMultiplier: number;
  lowThreshold: number;
  /** Target EV dalam dolar penuh. Display/tuning, bukan input uang. */
  targetEv: number;
  /**
   * Expected value dalam DOLAR PENUH dan berupa FLOAT (mis. 64.78889966676375).
   * DISPLAY-ONLY — tidak pernah jadi input jalur uang (uang tetap integer base units),
   * jadi TIDAK dikonversi ke base units.
   */
  ev: number;
  /** Odds per tier, key HURUF-KECIL (lihat CcRarityMap/CcRarityWire). */
  odds: CcRarityMap<number>;
  tierRanges: CcRarityMap<CcTierRange>;
  /** Stok per tier, key HURUF-KECIL. */
  stock: CcRarityMap<number>;
}

/** Respons MENTAH GET /api/machines (array CcMachine dengan harga dolar-penuh). */
export type CcMachinesResponse = CcMachine[];

/**
 * Mesin SETELAH dinormalisasi di boundary klien (CcGachaClient.machines()).
 * `price` (dolar) sengaja DIHILANGKAN dan diganti dua field yang tak mungkin tertukar
 * namanya, supaya tak ada service hilir yang bisa membaca "price" lalu keliru
 * menganggapnya base units.
 */
export interface CcMachineNormalized extends Omit<CcMachine, 'price'> {
  /** Nilai `price` mentah dari CC dalam DOLAR USDC PENUH. Display-only. */
  priceUsdcDollars: number;
  /**
   * Harga dalam USDC base units (6 desimal, integer) = round(dollars × 1e6).
   * INI SATU-SATUNYA nilai harga yang boleh masuk jalur uang (snapshot DB, quote
   * rupiah, plafon treasury). $50 -> 50_000_000.
   */
  priceUsdcBaseUnits: number;
}

/** Array hasil normalisasi yang dikembalikan CcGachaClient.machines(). */
export type CcMachinesNormalizedResponse = CcMachineNormalized[];

/* --- GET /api/stock --- */

/** Inventory per rarity, key HURUF-KECIL (ground truth: {"common":28,...}). */
export type CcStockResponse = CcRarityMap<number>;

/* --- GET /api/status --- */

/** Status operasional mesin. Field-nya tidak dienumerasi kontrak → opaque. */
export type CcStatusResponse = Record<string, unknown>;

/* --- GET /api/pack/status?memo= --- */

/**
 * Lifecycle penuh sebuah memo (purchase, send, buyback). Field turunannya tidak
 * dienumerasi kontrak. Ini ORACLE IDEMPOTEN kita: satu-satunya cara sah memastikan
 * apakah uang benar-benar berpindah on-chain (submitTransaction TIDAK idempoten).
 */
export interface CcPackStatusResponse {
  purchase?: unknown;
  send?: unknown;
  buyback?: unknown;
  [key: string]: unknown;
}

/* --- GET /api/getRecentWinners?packType= --- */

/** 5 pemenang terakhir. Bentuk item tidak dijanjikan kontrak → opaque. */
export type CcRecentWinnersResponse = unknown;

/* --- GET /api/vrf/verify?memo= --- */

/** Bukti VRF untuk sebuah memo. Bentuknya tidak dienumerasi kontrak → opaque. */
export type CcVrfVerifyResponse = Record<string, unknown>;

/* --- GET /api/getNfts?code=&rarity=&page=&limit= --- */

export interface CcGetNftsQuery {
  code?: string;
  rarity?: CcRarity;
  page?: number;
  limit?: number;
}

/** Daftar NFT katalog. Bentuk item tidak dienumerasi kontrak → opaque. */
export type CcGetNftsResponse = unknown;
