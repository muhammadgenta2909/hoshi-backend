import { HttpStatus } from '@nestjs/common';
import { detectProductionSignal } from '../common/demo-mode';
import { P2P_ERROR_CODE, p2pNoEffectError } from './p2p.errors';

/**
 * SATU tempat yang memutuskan "jalur settlement P2P mana yang akan berjalan", dipakai bersama
 * oleh MarketplaceService (saat listing dibuat) dan PaymentsService (saat tagihan diterbitkan
 * dan saat settlement berjalan).
 *
 * KENAPA HARUS SATU TEMPAT: sebelum ini predikatnya ditulis DUA KALI — `p2pRealArmed()` di
 * marketplace dan pasangan `mock`/`armed` di `fulfilUserListing` — dengan komentar "HARUS
 * identik" sebagai satu-satunya yang menjaganya. Kalau keduanya menyimpang, listing akan dibuat
 * dengan asumsi settlement yang berbeda dari yang benar-benar dijalankan; itu persis bentuk bug
 * yang menyebabkan kartu "terjual" tanpa pernah bisa diserahkan.
 */
export type P2pMode =
  /** Staging/devnet CC_MOCK: settlement DISIMULASI (kredit saldo penjual, nol on-chain). */
  | 'MOCK'
  /** Produksi + HOSHI_P2P_ENABLED=true: escrow benar-benar memindahkan kartu. */
  | 'ARMED'
  /** Default: settlement P2P real TIDAK berjalan. Tidak boleh ada tagihan P2P yang terbit. */
  | 'OFF';

/** Pembaca config minimal — supaya file ini tidak bergantung pada Nest ConfigService. */
export interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

/**
 * MOCK CC aktif: staging/devnet + CC_MOCK=1 + bukan sinyal produksi. Nilai yang SAMA dengan
 * `PaymentsService.ccMockEnabled` dan `MarketplaceService.ccMockEnabled` — sengaja: listing &
 * settlement harus sepakat soal mock vs real.
 */
export function ccMockEnabled(config: ConfigReader): boolean {
  return (
    config.get<string>('CC_MOCK') === '1' && detectProductionSignal() === null
  );
}

/** Mode settlement P2P yang BERLAKU SEKARANG. */
export function p2pModeOf(config: ConfigReader): P2pMode {
  if (ccMockEnabled(config)) return 'MOCK';
  const armed =
    (config.get<string>('HOSHI_P2P_ENABLED') ?? '').trim().toLowerCase() ===
    'true';
  return armed ? 'ARMED' : 'OFF';
}

/** Bagian listing yang dibutuhkan gerbang. Sengaja sekecil mungkin. */
export interface P2pListingFacts {
  id: string;
  /** Aset on-chain nyata yang mewakili kartu ini. null = listing Hoshi ketikan biasa. */
  ccNftAddress: string | null;
  /** FAKTA: escrow TERBUKTI memegang kartunya. Bukan flag — lihat migration 20260918000100. */
  escrowedAt: Date | null;
}

/**
 * Apakah listing INI perlu langkah escrow saat dipajang? Hanya untuk kartu USER yang mewakili
 * aset on-chain nyata DAN saat settlement real yang akan berjalan.
 */
export function listingNeedsEscrow(
  mode: P2pMode,
  ccNftAddress: string | null | undefined,
): boolean {
  return !!ccNftAddress && mode === 'ARMED';
}

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GERBANG TUNGGAL "boleh menerbitkan kewajiban untuk listing USER ini?"                    │
 * │ PANGGIL SEBELUM UANG BERGERAK. Tiap call-site yang memanggilnya SESUDAH invoice terbit   │
 * │ sedang membohongi kontrak error-nya (stage NO_EFFECT berarti nol Rupiah diambil).        │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * DUA penolakan, dan keduanya menutup kebocoran uang yang BERBEDA:
 *
 *  1. mode OFF (A) — `fulfilUserListing` akan menolak settle apa pun, jadi setiap Rupiah yang
 *     mendarat untuk listing user PASTI berakhir sebagai refund manual. Tolak di depan.
 *
 *  2. mode ARMED tapi kartunya TIDAK PERNAH masuk escrow (B) — escrow tidak memegang apa pun
 *     untuk diserahkan, jadi settlement akan gagal SESUDAH pembeli membayar. Keputusan ini
 *     bersandar pada FAKTA `escrowedAt`, BUKAN pada flag: listing yang kartunya memang ada di
 *     escrow tetap boleh dibeli walau flag berubah-ubah sesudahnya.
 *
 * MODE MOCK sengaja TIDAK memeriksa escrow: settlement mock tidak pernah menyentuh on-chain,
 * jadi menuntut escrow di staging hanya akan mematikan staging tanpa melindungi apa pun.
 */
export function assertP2pSaleAvailable(
  mode: P2pMode,
  listing: P2pListingFacts,
): void {
  if (mode === 'OFF') {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.DISABLED,
      'Jual-beli kartu antar pengguna belum aktif di Hoshi. Tidak ada pembayaran yang ' +
        'dibuat dan tidak ada uang yang diambil — kartu ini belum bisa dibeli lewat jalur ini.',
      listing.id,
    );
  }
  assertEscrowBackedIfRequired(mode, listing);
}

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────┐
 * │ PREDIKAT TUNGGAL: "listing USER ini BISA diselesaikan saat ARMED?"                        │
 * └──────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Settlement ARMED (PaymentsService.fulfilUserListing) melakukan PERSIS SATU hal on-chain:
 * `escrow.transferCoreAssetTo({ assetAddress: listing.ccNftAddress, newOwner: pembeli })`.
 * Jadi ia butuh DUA fakta, dan keduanya harus benar — bukan salah satunya:
 *
 *   • `ccNftAddress != null` — ADA yang bisa diserahkan. Listing user tanpa aset on-chain tidak
 *     mewakili kartu yang bisa berpindah; tidak ada jalur settlement real untuknya sama sekali.
 *   • `escrowedAt != null`   — escrow TERBUKTI memegangnya (di-set submitEscrow setelah
 *     kepemilikan dikonfirmasi on-chain). FAKTA tersimpan, bukan flag saat request.
 *
 * KENAPA INI SATU FUNGSI DAN BUKAN LIMA SALINAN: sebelum pass ini predikatnya ditulis ulang di
 * lima tempat (gerbang, WHERE feed publik, WHERE dashboard admin, serializer, dan settlement) dan
 * SEMUANYA menuliskan `ccNftAddress != null` sebagai SYARAT untuk memeriksa escrow — bukan sebagai
 * bagian dari syarat "bisa diselesaikan". Akibatnya listing user ber-`ccNftAddress` NULL lolos
 * dari kelimanya: tidak ditolak, tetap tampil di feed publik, tidak ditandai ke pemiliknya, dan
 * TIDAK IKUT DIHITUNG di angka radius-ledakan yang dibaca operator sebelum menyalakan flag.
 * Populasi itu justru yang paling mudah dibuat: `POST /marketplace` TANPA `fromPackMemo`.
 *
 * Sekarang: satu definisi, dan SQL-nya (unescrowedUserListingWhere) adalah terjemahan harfiah
 * dari negasinya.
 */
export function isEscrowBackedUserListing(listing: P2pListingFacts): boolean {
  return listing.ccNftAddress != null && listing.escrowedAt != null;
}

/**
 * HANYA paruh KEDUA gerbang di atas (B), tanpa paruh "fitur mati" (A).
 *
 * Dipakai jalur yang TIDAK menerbitkan tagihan dan karenanya TIDAK punya urusan dengan flag
 * fitur — saat ini `MarketplaceService.buy`, jalur demo instant-mint yang sudah punya
 * penjaganya sendiri (`assertDemoOnly`). Yang tetap berbahaya di sana adalah kasus B:
 * devnet yang SUDAH armed me-mint NFT BARU untuk kartu yang aslinya masih di wallet penjual,
 * karena listing itu lahir sebelum escrow diwajibkan. Bersandar pada FAKTA escrowedAt.
 *
 * Kenapa jalur demo ikut menolak listing user TANPA aset on-chain saat ARMED: `buy()` menandai
 * listing SOLD dan me-mint NFT BARU ke pembeli TANPA mengkredit penjual satu rupiah pun. Untuk
 * listing HOSHI (sellerId null) itu jalur demo yang sah; untuk listing USER saat settlement real
 * sedang berlaku, itu merampas kartu penjual. Tidak ada sub-kasus listing user yang aman di sini
 * saat ARMED — jadi predikatnya TIDAK dipecah supaya jalur ini lebih longgar.
 */
export function assertEscrowBackedIfRequired(
  mode: P2pMode,
  listing: P2pListingFacts,
): void {
  if (mode !== 'ARMED' || isEscrowBackedUserListing(listing)) return;
  // SATU kode (kontrak frontend tidak berubah), DUA kalimat — karena pemulihannya berbeda:
  // kartu on-chain yang belum dititipkan BISA dipulihkan dengan SATU aksi (relist → PENDING_ESCROW
  // → tanda tangan). Listing tanpa aset on-chain TIDAK bisa: tak ada kartu untuk dititipkan, jadi
  // menyuruh pemiliknya "pajang ulang" hanya akan mengulang kegagalan yang sama.
  throw p2pNoEffectError(
    HttpStatus.CONFLICT,
    P2P_ERROR_CODE.LISTING_NOT_ESCROWED,
    listing.ccNftAddress == null
      ? 'Kartu ini tidak punya aset on-chain, jadi tidak bisa dijual lewat jalur jual-beli ' +
          'antar pengguna. Tidak ada pembayaran yang dibuat dan tidak ada uang yang diambil. ' +
          'Penjual perlu menarik (cancel) listing ini; yang bisa dijual lewat jalur ini hanya ' +
          'kartu hasil pull yang punya aset on-chain.'
      : 'Kartu ini belum dititipkan ke brankas (escrow) Hoshi, jadi belum bisa dibeli. ' +
          'Tidak ada pembayaran yang dibuat dan tidak ada uang yang diambil. Penjual perlu ' +
          'memajang ulang kartunya lebih dulu.',
    listing.id,
  );
}

/** Bentuk WHERE Prisma untuk "listing USER yang TIDAK escrow-backed". */
export interface UnescrowedUserListingWhere {
  sellerId: { not: null };
  /**
   * KARTU TITIPAN DIKECUALIKAN. Ia punya `sellerId != null` dan (menurut CHECK constraint
   * `listings_consignment_shape_chk`) SELALU `ccNftAddress` NULL dan `escrowedAt` NULL — jadi
   * tanpa baris ini ia cocok SEMPURNA dengan klausa "listing user yang tidak escrow-backed".
   * Lihat komentar panjang di `unescrowedUserListingWhere` untuk kedua bug yang ditutupnya.
   */
  consignmentId: null;
  OR: [{ ccNftAddress: null }, { escrowedAt: null }];
}

/**
 * Klausa Prisma "listing USER yang TIDAK escrow-backed" — baris yang, saat armed, TIDAK BOLEH
 * tampil sebagai bisa dibeli. Dipakai feed publik (dikecualikan lewat NOT) dan dashboard admin
 * (dipakai langsung, untuk melihat radius ledakannya).
 *
 * TERJEMAHAN HARFIAH dari negasi `isEscrowBackedUserListing` untuk listing user:
 *   sellerId IS NOT NULL AND (ccNftAddress IS NULL OR escrowedAt IS NULL)
 *
 * `OR` itu BAGIAN DARI PAGARNYA, bukan kelonggaran: versi lama menuntut
 * `ccNftAddress IS NOT NULL`, sehingga baris yang paling mudah dibuat — listing user tanpa aset
 * on-chain — tidak pernah masuk hitungan maupun tersaring dari feed.
 *
 * SENGAJA fungsi, bukan konstanta: objek literal yang di-spread ke beberapa query Prisma akan
 * berbagi array `OR` yang SAMA, dan satu pemanggil yang memutasinya diam-diam mengubah pagar
 * pemanggil lain. Fungsi mengembalikan objek baru tiap kali.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ `consignmentId: null` MENUTUP DUA BUG SEKALIGUS, dan keduanya nyata saat ARMED.              │
 * │                                                                                              │
 * │ Kartu TITIPAN punya `sellerId != null` dan — dipaku CHECK constraint                         │
 * │ `listings_consignment_shape_chk` — SELALU `ccNftAddress` NULL dan `escrowedAt` NULL. Jadi ia │
 * │ cocok SEMPURNA dengan klausa ini, padahal ia sama sekali bukan urusan escrow.                │
 * │                                                                                              │
 * │  1. FEED PUBLIK. `MarketplaceService.list()` memakai klausa ini sebagai `where.NOT` saat      │
 * │     ARMED. Tanpa pengecualian ini, MENYALAKAN HOSHI_P2P_ENABLED akan MENGHILANGKAN SETIAP    │
 * │     LISTING TITIPAN dari marketplace — kartu yang fisiknya ada di rak kami, yang paling      │
 * │     pasti bisa kami serahkan, justru yang lenyap.                                            │
 * │  2. ANGKA RADIUS LEDAKAN. `admin.escrowOverview().unescrowedActive` dibaca operator SEBELUM  │
 * │     menyalakan flag. Tanpa pengecualian ini, ia menghitung kartu titipan sebagai "baris yang │
 * │     akan rusak kalau di-arm" — melaporkan bahaya yang tidak ada, pada baris yang tidak bisa  │
 * │     disembuhkan oleh tindakan escrow apa pun.                                                │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 */
export function unescrowedUserListingWhere(): UnescrowedUserListingWhere {
  return {
    sellerId: { not: null },
    consignmentId: null,
    OR: [{ ccNftAddress: null }, { escrowedAt: null }],
  };
}
