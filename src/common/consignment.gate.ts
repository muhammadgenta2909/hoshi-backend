import { HttpStatus } from '@nestjs/common';
import { ConsignmentStatus, Prisma } from '@prisma/client';
import { CONSIGNMENT_ERROR_CODE, consignmentError } from './consignment.errors';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ SATU DEFINISI "HOSHI SEDANG MEMEGANG KARTU INI" — kembar FISIK dari `p2p.gate.ts`.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * KENAPA FILE INI ADA, dan kenapa bentuknya menyalin `p2p.gate.ts` sedekat ini:
 *
 * Jalur P2P sudah mengajarkan pelajarannya dengan mahal. Gerbangnya BUKAN membaca flag
 * (`HOSHI_P2P_ENABLED`) melainkan FAKTA TERSIMPAN (`Listing.escrowedAt`), supaya mengubah flag di
 * tengah hidup sebuah kartu tidak bisa mengubah apa yang BENAR tentang kartu yang sudah bergerak.
 * Custody fisik adalah persoalan yang sama, satu lapis lebih rendah: yang menentukan boleh-tidaknya
 * sebuah kartu titipan dijual BUKAN status di layar admin dan BUKAN flag apa pun, melainkan satu
 * kenyataan — apakah kartunya ada di rak Hoshi SEKARANG.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ FAKTANYA, satu kalimat:                                                                      │
 * │                                                                                              │
 * │   LISTING TITIPAN BOLEH HIDUP  ⇔  custodyAcceptedAt != null                                  │
 * │                                 ∧  custodyReleasedAt == null                                 │
 * │                                 ∧  status ∈ { IN_CUSTODY, LISTED }                           │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * DUA KOLOM, BUKAN SATU YANG DI-TOGGLE — dan itu PENINGKATAN yang disengaja atas `escrowedAt`.
 * `escrowedAt` BOLEH dihapus, tapi hanya dengan bukti dari rantai (`assertCardLeftEscrow`). Di
 * sini tidak ada rantai: tidak ada apa pun yang bisa membuktikan sebuah kartu fisik sudah turun
 * dari rak selain seorang manusia yang menuliskannya. Jadi alih-alih "hapus fakta dengan bukti",
 * custody memakai DUA fakta append-only. Akibatnya kelas bug yang `assertCardLeftEscrow` ada untuk
 * mencegahnya — satu aksi user biasa menghapus satu-satunya petunjuk bahwa sebuah kartu
 * tertinggal — TIDAK ADA SECARA STRUKTURAL di sini: tidak ada tulisan yang menghapus apa pun.
 *
 * `status` ikut dibaca BUKAN sebagai sumber kebenaran melainkan sebagai pagar ketiga: ia
 * menyingkirkan INTAKE (disepakati tapi kartunya belum diserahkan — stempel custody memang masih
 * null di sana, jadi syarat pertama sudah menolaknya) dan SOLD (kartunya masih di rak tapi sudah
 * MILIK PEMBELI, jadi tidak boleh dijual lagi maupun ditarik pemilik lamanya). Tanpa `status`,
 * SOLD akan lolos: stempelnya accepted-non-null dan released-null.
 */

/* ─────────────────────────────── ALASAN LEDGER ─────────────────────────────── */

/**
 * Alasan `BalanceEntry` untuk hasil penjualan kartu TITIPAN. SENGAJA BUKAN `'P2P_SALE'`: buku
 * besar harus menyebut rail MANA yang membayar, karena kedua rail itu punya kewajiban hukum yang
 * berbeda (di P2P Hoshi tidak pernah memegang kartunya; di sini Hoshi memegangnya).
 *
 * `refId` yang dipakai bersamanya adalah `merchantOrderId` — unik secara global, jadi tidak ada
 * tabrakan kunci yang mungkin dengan rail mana pun. `@@unique([reason, refId])` adalah pagar
 * KEDUA terhadap kredit dobel; pagar PERTAMA adalah klaim atomik `ACTIVE → SOLD` pada listing.
 *
 * Ada DI SINI dan bukan di `consignment.service.ts` supaya `PaymentsService` bisa memakainya
 * tanpa menyeret seluruh modul titipan (dan siklus impor) ke dalam modul pembayaran.
 */
export const CONSIGNMENT_SALE_REASON = 'CONSIGNMENT_SALE';

/** Alasan `BalanceEntry` untuk ganti rugi kartu yang hilang/rusak dalam pengawasan Hoshi. */
export const CONSIGNMENT_COMPENSATION_REASON = 'CONSIGNMENT_COMPENSATION';

/** Bagian catatan titipan yang dibutuhkan gerbang. SENGAJA sekecil mungkin, sama seperti P2pListingFacts. */
export interface ConsignmentCustodyFacts {
  id: string;
  status: ConsignmentStatus;
  /** FAKTA: kartunya TERBUKTI diserahkan ke Hoshi. Ditulis sekali, tidak pernah dihapus. */
  custodyAcceptedAt: Date | null;
  /** FAKTA: kartunya sudah KELUAR dari Hoshi (ditarik / dikirim ke pembeli / hilang). */
  custodyReleasedAt: Date | null;
}

/**
 * true ⇔ Hoshi TERBUKTI memegang kartu ini SEKARANG. Fakta, bukan flag.
 *
 * Kembaran `isEscrowBackedUserListing` (`p2p.gate.ts`). Dipakai gerbang penerbitan tagihan,
 * settlement, jalur kirim domestik, penarikan, dan dashboard admin — SATU definisi, supaya SQL
 * dan TS tidak bisa melenceng.
 */
export function isInHoshiCustody(c: ConsignmentCustodyFacts): boolean {
  return (
    c.custodyAcceptedAt != null &&
    c.custodyReleasedAt == null &&
    (c.status === ConsignmentStatus.IN_CUSTODY ||
      c.status === ConsignmentStatus.LISTED)
  );
}

/**
 * true ⇔ kartunya MASIH SECARA FISIK di rak Hoshi — tanpa peduli sudah terjual atau belum.
 *
 * SENGAJA BERBEDA dari `isInHoshiCustody`, dan perbedaannya penting. Ada dua pertanyaan yang
 * mudah tertukar:
 *
 *   "Boleh dijual?"      → `isInHoshiCustody`. Butuh status IN_CUSTODY/LISTED. Kartu yang sudah
 *                          SOLD jelas tidak boleh dijual lagi ke orang kedua.
 *   "Masih ada di rak?"  → fungsi INI. Hanya soal fisik: pernah diterima, belum pernah keluar.
 *                          Kartu yang sudah SOLD MASIH ADA di rak — justru sedang menunggu
 *                          dikirim ke pembelinya.
 *
 * Memakai `isInHoshiCustody` untuk pertanyaan kedua adalah bug yang sudah pernah terjadi di sini:
 * settlement menulis status SOLD, lalu gerbang kirim menolak SETIAP permintaan pembeli dengan 409
 * selamanya — pembeli sudah bayar, kartunya ada di rak, dan tidak ada jalan mengeluarkannya.
 * Hoshi memegang uang DAN kartunya. Semua test tetap hijau karena fixture-nya memasang
 * consignment LISTED di atas listing yang sudah SOLD — keadaan yang tidak bisa terjadi.
 *
 * Aturannya: pertanyaan "boleh dijual" pakai yang atas, "masih ada" pakai yang ini. Jangan
 * dilonggarkan salah satunya supaya bisa dipakai keduanya.
 */
export function isPhysicallyHeldByHoshi(c: ConsignmentCustodyFacts): boolean {
  return c.custodyAcceptedAt != null && c.custodyReleasedAt == null;
}

/**
 * Bentuk WHERE Prisma — TERJEMAHAN HARFIAH dari `isInHoshiCustody`, supaya SQL dan TS tidak bisa
 * menyimpang. SENGAJA fungsi, bukan konstanta: objek literal yang di-spread ke beberapa query
 * Prisma akan berbagi sub-objek yang SAMA, dan satu pemanggil yang memutasinya diam-diam mengubah
 * pagar pemanggil lain (alasan yang sama dengan `unescrowedUserListingWhere`).
 */
export function inCustodyWhere(): Prisma.ConsignmentWhereInput {
  return {
    custodyAcceptedAt: { not: null },
    custodyReleasedAt: null,
    status: {
      in: [ConsignmentStatus.IN_CUSTODY, ConsignmentStatus.LISTED],
    },
  };
}

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ GERBANG TUNGGAL "boleh menerbitkan kewajiban untuk listing TITIPAN ini?"                     │
 * │ PANGGIL SEBELUM UANG BERGERAK. Call-site yang memanggilnya SESUDAH invoice terbit sedang     │
 * │ membohongi kontrak error-nya (stage NO_EFFECT berarti NOL Rupiah diambil).                   │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Pasangan `assertP2pSaleAvailable`. Bedanya: di sini TIDAK ADA paruh "fitur dimatikan". Titipan
 * tidak punya flag — ia punya kartu fisik, dan pertanyaannya hanya satu: apakah kartunya ada.
 */
export function assertConsignmentSaleAvailable(
  c: ConsignmentCustodyFacts,
  listingId: string,
): void {
  if (isInHoshiCustody(c)) return;
  throw consignmentError({
    status: HttpStatus.CONFLICT,
    code: CONSIGNMENT_ERROR_CODE.NOT_IN_CUSTODY,
    message:
      c.custodyAcceptedAt == null
        ? 'Kartu ini sedang tidak tersedia: serah-terima fisiknya belum tercatat di Hoshi, jadi ' +
          'belum boleh dijual. Tidak ada pembayaran yang dibuat dan tidak ada uang yang diambil.'
        : 'Kartu ini sedang tidak tersedia: kartunya sudah tidak lagi berada di penyimpanan ' +
          'Hoshi (ditarik pemiliknya, sudah dikirim, atau sedang bermasalah). Tidak ada ' +
          'pembayaran yang dibuat dan tidak ada uang yang diambil.',
    listingId,
    consignmentId: c.id,
  });
}

/**
 * Aksi ini memang TIDAK BERLAKU untuk kartu titipan. Dipakai di setiap rute penjual/penawar yang
 * sah untuk listing biasa tapi salah untuk titipan (menawar, relist, escrow, ubah harga sendiri,
 * batalkan sendiri) — dengan `message` yang MENYEBUT rute yang benar, bukan sekadar menolak.
 */
export function consignmentUnsupported(
  message: string,
  listingId: string,
  status: number = HttpStatus.CONFLICT,
): never {
  throw consignmentError({
    status,
    code: CONSIGNMENT_ERROR_CODE.UNSUPPORTED_ACTION,
    message,
    listingId,
  });
}

/* ─────────────────────── PREDIKAT KLAIM ATOMIK (dibagi antar modul) ─────────────────────── */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KETIGA `where` DI BAWAH ADALAH GERBANGNYA — bukan sekadar filter.                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Polanya sama dengan `VaultService.claim` (STORED→MINTING) dan `submitEscrow`
 * (PENDING_ESCROW→ACTIVE): pemeriksaan dan penulisannya adalah SATU pernyataan `updateMany`, dan
 * `count !== 1` berarti KALAH — bukan error, melainkan jawaban. Itulah yang membuat keputusannya
 * tidak bisa basi karena balapan.
 *
 * Mereka HIDUP DI FILE GERBANG, bukan di service-nya, karena `PaymentsService` juga memakainya
 * saat settlement. Kalau predikat settlement disalin ke sana, ia bisa MELENCENG dari predikat yang
 * dipakai saat listing dibuat — dan melencengnya baru ketahuan SESUDAH pembeli membayar.
 */

/** Terima custody: HANYA dari INTAKE, dan HANYA kalau stempelnya memang belum pernah ditulis. */
export function acceptCustodyClaimWhere(
  id: string,
): Prisma.ConsignmentWhereInput {
  return {
    id,
    status: ConsignmentStatus.INTAKE,
    // Stempel custody ditulis SEKALI. Predikat ini yang menjamin "sekali" — bukan urutan kode.
    custodyAcceptedAt: null,
  };
}

/**
 * Pajang: HANYA dari IN_CUSTODY, dan HANYA kalau kartunya TERBUKTI ada di tangan Hoshi.
 *
 * INI ADALAH INVARIAN UTAMA FITUR INI. `Listing.create` yang menulis `consignmentId` berjalan di
 * transaksi yang SAMA dengan klaim ini, jadi baris Listing titipan TIDAK BISA LAHIR tanpa custody
 * yang tercatat — secara konstruksi, bukan karena ada yang ingat memeriksa.
 */
export function listClaimWhere(id: string): Prisma.ConsignmentWhereInput {
  return {
    id,
    status: ConsignmentStatus.IN_CUSTODY,
    custodyAcceptedAt: { not: null },
    custodyReleasedAt: null,
    // Belum pernah punya listing. Relasi 1-1; `Listing.consignmentId` juga @unique di DB.
    listing: { is: null },
  };
}

/**
 * Settlement: LISTED → SOLD, dan HANYA kalau kartunya MASIH di tangan Hoshi saat pembayaran
 * mendarat. Penarikan yang menang balapan di antara invoice dan pembayaran membuat klaim ini
 * cocok 0 baris → `failToRefund` → Rupiah pembeli utuh dan aman di-refund, kartu tidak bergerak.
 */
export function consignmentSaleClaimWhere(
  id: string,
): Prisma.ConsignmentWhereInput {
  return {
    id,
    status: ConsignmentStatus.LISTED,
    custodyAcceptedAt: { not: null },
    custodyReleasedAt: null,
  };
}

/**
 * Tarik kembali dari pajangan: LISTED → IN_CUSTODY. Pasangan dari klaim settlement di atas, dan
 * keduanya menamai `status: 'LISTED'` — itulah sebabnya "ditarik" dan "terjual" tidak mungkin
 * dua-duanya berhasil.
 */
export function takeDownClaimWhere(id: string): Prisma.ConsignmentWhereInput {
  return {
    id,
    status: ConsignmentStatus.LISTED,
    custodyReleasedAt: null,
  };
}

/* ────────────────────────── KETERJANGKAUAN JALAN KELUAR ────────────────────────── */

/**
 * PETA JALAN KELUAR tiap status. Dipakai dokumentasi, rute admin, DAN
 * `consignment-exit-reachability.spec.ts` yang mengiterasi SELURUH enum — sehingga nilai status
 * BARU tidak bisa ditambahkan tanpa seseorang sadar-sadar mendaftarkan jalan keluarnya (atau
 * menyatakannya terminal). Pola yang sama dengan `redemption-exit-reachability.spec.ts`.
 *
 * Array KOSONG = TERMINAL DENGAN SENGAJA (bukan buntu yang terlupakan).
 */
export const CONSIGNMENT_EXITS: Record<
  ConsignmentStatus,
  readonly ConsignmentStatus[]
> = {
  // Disepakati tapi kartunya belum diserahkan: boleh jadi custody, boleh dibatalkan.
  [ConsignmentStatus.INTAKE]: [
    ConsignmentStatus.IN_CUSTODY,
    ConsignmentStatus.CANCELLED,
  ],
  // Di rak: boleh dipajang, boleh dikembalikan ke pemilik, bisa hilang.
  [ConsignmentStatus.IN_CUSTODY]: [
    ConsignmentStatus.LISTED,
    ConsignmentStatus.RELEASED,
    ConsignmentStatus.LOST,
  ],
  // Terpajang: boleh ditarik kembali (→ IN_CUSTODY), terjual, atau hilang.
  [ConsignmentStatus.LISTED]: [
    ConsignmentStatus.IN_CUSTODY,
    ConsignmentStatus.SOLD,
    ConsignmentStatus.LOST,
  ],
  // Terjual: kartunya MILIK PEMBELI, masih di rak sampai dikirim. Tidak bisa kembali ke penjual.
  [ConsignmentStatus.SOLD]: [
    ConsignmentStatus.RELEASED,
    ConsignmentStatus.LOST,
  ],
  [ConsignmentStatus.RELEASED]: [],
  [ConsignmentStatus.LOST]: [],
  [ConsignmentStatus.CANCELLED]: [],
};

/**
 * Status TERMINAL. Tiga, dan ketiganya BERBEDA soal custody — jadi jangan disamakan:
 *   • RELEASED / LOST  → custody PERNAH ada dan sudah selesai ⇒ `custodyReleasedAt` TERISI.
 *   • CANCELLED        → custody TIDAK PERNAH ada (kesepakatan batal sebelum serah-terima)
 *                        ⇒ `custodyAcceptedAt` DAN `custodyReleasedAt` dua-duanya NULL.
 * Menulis `custodyReleasedAt` pada baris CANCELLED akan BERBOHONG: tidak ada yang dilepaskan.
 */
export const CONSIGNMENT_TERMINAL_STATUSES: readonly ConsignmentStatus[] = [
  ConsignmentStatus.RELEASED,
  ConsignmentStatus.LOST,
  ConsignmentStatus.CANCELLED,
];

/**
 * "Baris titipan yang masih HIDUP" — dipakai untuk kunci anti-dobel-titip.
 *
 * SENGAJA lebih luas dari `inCustodyWhere()`: ia ikut memuat INTAKE (kesepakatan sudah dibuat,
 * kartunya belum diserahkan). Dua kesepakatan aktif untuk SATU slab bernomor sertifikat sama
 * tetap harus ditolak, karena kartunya cuma satu.
 *
 * CANCELLED dikecualikan: kesepakatan yang batal harus MELEPASKAN nomor sertifikatnya, kalau
 * tidak satu intake yang ditinggalkan akan mengunci kartu itu dari Hoshi selamanya.
 *
 * TERJEMAHAN HARFIAH dari partial unique index `consignments_active_cert_uniq`
 * (migration 20260922000000). Kalau salah satunya berubah, yang lain WAJIB ikut.
 */
export function liveConsignmentWhere(): Prisma.ConsignmentWhereInput {
  return {
    custodyReleasedAt: null,
    status: { not: ConsignmentStatus.CANCELLED },
  };
}
