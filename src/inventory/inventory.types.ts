// Seam untuk fitur Open Packs: dari mana kartu yang bisa dimenangkan berasal.
// Satu interface (InventoryProvider) menstandarkan sumber apa pun — vault Hoshi
// sendiri, CollectorCrypt, atau mock — sehingga logika buka-pack (gacha) tidak
// peduli sumbernya. Ganti/ tambah sumber = tambah provider baru, alur draw tetap.

/**
 * Rarity tier — mirror union `Tier` di frontend (lib/packs.ts) supaya odds,
 * nilai kartu, dan badge rarity tidak pernah bercabang beda antar layer.
 */
export type CardRarity =
  | 'Common'
  | 'Rare'
  | 'Epic'
  | 'Legendary'
  | 'Legendary Rare';

/**
 * Sumber inventory sebuah kartu. Menambah sumber baru = tambah nilai di sini
 * + satu kelas provider; tidak ada yang berubah di alur buka-pack.
 */
export type InventorySource = 'hoshi-vault' | 'collectorcrypt' | 'mock';

/** Satu kartu yang bisa diberikan sebuah pack, dinormalkan lintas semua sumber. */
export interface InventoryCard {
  source: InventorySource;
  /**
   * Handle native provider untuk me-reserve/mengirim unit persis ini
   * (Hoshi: vaultItemId · CollectorCrypt: asset pNFT · mock: id sintetis).
   */
  ref: string;
  name: string;
  rarity: CardRarity;
  imageUrl?: string;
  /** Nilai wajar dalam IDRX (dipakai untuk expected value + kuotasi buyback). */
  valueIdr: number;
}

/**
 * Kunci eksklusif berumur pendek atas satu kartu, supaya dua buka-pack
 * bersamaan tidak pernah memenangkan unit yang sama dan unit eksternal tidak
 * terjual dari sisi lain saat proses berjalan.
 */
export interface InventoryHold {
  source: InventorySource;
  holdId: string;
  card: InventoryCard;
}

/**
 * Bukti kartu sampai ke user: asset on-chain (di-mint untuk vault Hoshi,
 * ditransfer untuk CollectorCrypt) dan — bila lokal — id baris Nft.
 */
export interface InventoryDelivery {
  source: InventorySource;
  card: InventoryCard;
  assetAddress?: string;
  txSignature?: string;
  nftId?: string;
}

/** Penerima kartu saat delivery (wallet user + id user internal). */
export interface DeliveryRecipient {
  userId: string;
  ownerAddress: string;
}

/**
 * Kontrak yang membuat Open Packs bisa mengambil kartu dari mana saja. Setiap
 * provider mengikuti pola 2-fase yang sudah dipakai vault (reserve → deliver,
 * dengan release() sebagai kompensasi) supaya logika gacha agnostik-sumber.
 */
export interface InventoryProvider {
  readonly source: InventorySource;

  /** Kartu yang saat ini bisa dimenangkan untuk `packId`. */
  listAvailable(packId: string): Promise<InventoryCard[]>;

  /** Kunci satu kartu secara atomik. Lempar error bila sudah tidak tersedia. */
  reserve(card: InventoryCard): Promise<InventoryHold>;

  /** Kirim kartu yang sudah dikunci ke user (mint / transfer). Ireversibel. */
  deliver(
    hold: InventoryHold,
    recipient: DeliveryRecipient,
  ): Promise<InventoryDelivery>;

  /** Batalkan kunci (best-effort) saat draw dibatalkan atau delivery gagal. */
  release(hold: InventoryHold): Promise<void>;
}
