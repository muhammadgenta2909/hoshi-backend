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

/* ───────────────── PEMILIKNYA: PERTANYAAN KEDUA, DAN SENGAJA TERPISAH ───────────────── */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ DUA PERTANYAAN YANG TIDAK BOLEH DICAMPUR:                                                    ║
 * ║   "kartunya ada di rak kita?"   → isInHoshiCustody / isPhysicallyHeldByHoshi (di atas)        ║
 * ║   "kita tahu siapa yang dibayar kalau terjual?" → isConsignorLinked (INI)                     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Sejak titipan bisa diterima dari orang yang belum punya akun Hoshi, kedua jawaban itu BISA
 * BERBEDA, dan kombinasi yang penting adalah kombinasi yang dulu mustahil:
 *
 *   custody ADA  +  pemilik BELUM tertaut  =  kartunya di rak kita, dan ia TIDAK BOLEH DIJUAL.
 *
 * Kalau keduanya digabung jadi satu predikat, operator yang melihat penolakan akan diberi
 * pemulihan yang salah ("catat serah-terimanya") untuk kartu yang sudah ada di raknya, dan
 * pemulihan yang benar (tukarkan kode klaim / tautkan akun) tidak akan pernah disebut. Karena itu
 * `isInHoshiCustody` SENGAJA TIDAK membaca `consignorId`, dan fungsi ini SENGAJA tidak membaca
 * stempel custody.
 */
export function isConsignorLinked(c: { consignorId: string | null }): boolean {
  return c.consignorId != null;
}

/**
 * Gerbang "boleh dipajang / boleh dibayar ke seseorang". Melempar `OWNER_UNLINKED`, yang punya
 * pemulihan sendiri dan TIDAK PERNAH tertukar dengan `NOT_IN_CUSTODY`.
 *
 * Seperti `assertConsignmentSaleAvailable`, stage-nya NO_EFFECT: setiap call-site memanggilnya
 * SEBELUM apa pun bergerak.
 */
export function requireLinkedConsignorId(
  c: { id: string; consignorId: string | null },
  listingId?: string,
): string {
  // MENGEMBALIKAN ID-nya, bukan void, DENGAN SENGAJA: setiap pemanggil membutuhkan nilai itu
  // (untuk `Listing.sellerId`, untuk kredit saldo), dan fungsi yang mengembalikannya membuat
  // TypeScript ikut menegakkan gerbangnya — tidak ada call-site yang bisa memanggil pemeriksaan
  // ini lalu tetap memakai `c.consignorId` yang masih bertipe nullable.
  if (c.consignorId != null) return c.consignorId;
  throw consignmentError({
    status: HttpStatus.CONFLICT,
    code: CONSIGNMENT_ERROR_CODE.OWNER_UNLINKED,
    message:
      'Titipan ini belum terhubung ke akun Hoshi mana pun, jadi ia belum bisa dipajang: kalau ' +
      'kartunya terjual, tidak ada siapa pun yang bisa dikredit. Kartunya TETAP tercatat, TETAP ' +
      'ada di penyimpanan, dan TETAP bisa diminta kembali kapan saja oleh orang yang ' +
      'menyerahkannya. Minta pemiliknya menukarkan kode klaim di tanda terimanya ' +
      '(POST /consignments/claim), atau tautkan akunnya setelah identitasnya diperiksa langsung ' +
      '(POST /admin/consignments/:id/link-consignor).',
    consignmentId: c.id,
    ...(listingId ? { listingId } : {}),
  });
}

/* ──────────────── "MASIH MENUNGGU PEMILIKNYA?" — SATU DEFINISI, TS DAN SQL ──────────────── */

/**
 * Status yang MENUTUP pertanyaan "titipan ini masih menunggu pemiliknya?" — meski pemiliknya
 * memang belum pernah tertaut ke akun mana pun.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ ARTI HIMPUNANNYA, satu kalimat: "kami MASIH memegang sesuatu milik orang ini, dan kami       │
 * │ belum bisa menyerahkannya karena belum tahu siapa dia di sistem."                            │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * CANCELLED — kesepakatan batal SEBELUM serah-terima. Tidak pernah ada yang dipegang.
 *
 * RELEASED — kartunya SUDAH KELUAR dari Hoshi dan custody-nya SELESAI. Dua jalan ke sana, dan
 * keduanya bermuara sama:
 *   • WITHDRAWN — kartunya DIKEMBALIKAN ke orang yang menyerahkannya, dari tangan ke tangan,
 *     berikut tanda terima pengembalian. Itulah, tepatnya, satu-satunya cara sebuah baris bisa
 *     RELEASED tanpa pemilik tertaut.
 *   • SHIPPED_TO_BUYER — hanya sah dari SOLD, dan SOLD MUSTAHIL tanpa pemilik tertaut (CHECK
 *     `consignments_listed_requires_owner_chk` + `listClaimWhere`). Jadi jalur ini tidak pernah
 *     melahirkan baris RELEASED yang belum bertuan.
 * Kartunya sudah pulang: tidak ada yang bisa dipajang, tidak ada Rupiah yang perlu tujuan, dan
 * tidak ada satu pun aksi operator yang bisa "menyelesaikan" barisnya. Membiarkannya di sini
 * berarti satu angka badge yang tidak pernah bisa turun dan satu baris `actionRequired` yang
 * tombolnya cuma menyetel ulang jam 30 hari — persis bentuk peringatan yang mengajari orang
 * mengabaikan seluruh daftarnya.
 *
 * PENAUTANNYA TETAP MUNGKIN, dan itu bukan kontradiksi: `claimCodeRedeemWhere` SENGAJA tidak
 * mengecualikan RELEASED, karena pemilik yang kartunya sudah pulang tetap berhak menukarkan
 * kodenya dan melihat riwayat serah-terimanya sendiri. Yang berubah di sini cuma satu hal:
 * penautan itu bukan lagi sesuatu yang HOSHI UTANG kepada seseorang, jadi ia tidak duduk di
 * antrean kerja operator.
 *
 * LOST SENGAJA TETAP DI DALAM — jangan disapu bersama RELEASED. Custody-nya juga selesai, tapi
 * kartunya TIDAK pulang: Hoshi berutang ganti rugi, dan `compensate` menuntut
 * `requireLinkedConsignorId`. Ganti rugi tanpa pemilik tertaut TIDAK PUNYA TUJUAN, jadi baris itu
 * memang masih menunggu orangnya — justru paling mendesak di antara semuanya.
 */
const AWAITING_CLAIM_CLOSED_STATUSES: readonly ConsignmentStatus[] = [
  ConsignmentStatus.CANCELLED,
  ConsignmentStatus.RELEASED,
];

/**
 * true ⇔ titipan ini masih MENUNGGU pemiliknya tertaut, dan penautan itu masih berarti sesuatu
 * yang belum Hoshi tunaikan.
 *
 * Kembar TS dari `awaitingConsignorWhere()` di bawah. Keduanya ADA supaya jawaban yang dihitung
 * di baris (flag `awaitingOwnerClaim`, badge dashboard, daftar `awaitingOwner`) dan jawaban yang
 * ditanyakan ke Postgres (filter `?filter=AWAITING_OWNER`) TIDAK BISA MELENCENG — dua salinan
 * aturan berarti satu di antaranya akan diam-diam salah, dan yang terlihat di layar adalah
 * hitungan yang tidak cocok dengan daftarnya.
 */
export function isAwaitingConsignorClaim(c: {
  status: ConsignmentStatus;
  consignorId: string | null;
}): boolean {
  if (isConsignorLinked(c)) return false;
  return !AWAITING_CLAIM_CLOSED_STATUSES.includes(c.status);
}

/**
 * "Titipan yang masih MENUNGGU pemiliknya" — dipakai dashboard admin.
 *
 * Barang orang lain yang tergeletak tanpa ada yang melihat adalah cara paling umum sebuah janji
 * custody diingkari tanpa siapa pun berniat begitu; baris tanpa pemilik tertaut adalah bentuk
 * paling parah dari itu, karena tidak ada siapa pun di sisi Hoshi yang bisa dihubungi SISTEM.
 * Yang menghubunginya adalah manusia, memakai `consignorNameAtIntake` / `consignorPhoneAtIntake`
 * — itulah gunanya dua kolom snapshot itu tetap WAJIB meski akunnya belum ada.
 *
 * TERJEMAHAN HARFIAH dari `isAwaitingConsignorClaim` di atas — baca alasan tiap status di sana.
 */
export function awaitingConsignorWhere(): Prisma.ConsignmentWhereInput {
  return {
    consignorId: null,
    status: { notIn: [...AWAITING_CLAIM_CLOSED_STATUSES] },
  };
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
 * Pajang: HANYA dari IN_CUSTODY, HANYA kalau kartunya TERBUKTI ada di tangan Hoshi, DAN HANYA
 * kalau kita tahu SIAPA YANG HARUS DIBAYAR kalau ia terjual.
 *
 * INI ADALAH INVARIAN UTAMA FITUR INI. `Listing.create` yang menulis `consignmentId` berjalan di
 * transaksi yang SAMA dengan klaim ini, jadi baris Listing titipan TIDAK BISA LAHIR tanpa custody
 * yang tercatat — secara konstruksi, bukan karena ada yang ingat memeriksa.
 *
 * ── `consignorId: { not: null }` — DUA SYARAT, BUKAN SATU ────────────────────────────────────
 *
 * Sejak titipan bisa diterima dari orang yang BELUM punya akun (kode klaim di tanda terima),
 * "kartunya ada di rak" TIDAK LAGI berarti "boleh dijual". Menjual kartu yang pemiliknya belum
 * tertaut berarti Hoshi memegang UANG ORANG yang tidak punya tujuan: `fulfilConsignment`
 * mengkredit `sellerId`, dan tanpa pemilik tertaut tidak ada nilai yang jujur untuk diisikan ke
 * sana. Itulah kegagalan yang digambarkan pemilik produk sebagai memegang uang orang tanpa cara
 * menghubunginya.
 *
 * Syarat ini ditaruh DI DALAM PREDIKAT KLAIM, bukan sebagai `if` terpisah di service, dengan
 * alasan yang persis sama dengan syarat custody: `createListingFor` adalah satu-satunya penulis
 * `Listing.consignmentId` di repo ini dan ia membuat baris listing di transaksi yang SAMA dengan
 * klaim ini. Jadi listing untuk titipan tanpa pemilik TIDAK BISA ADA — bukan karena ada yang
 * ingat memeriksa.
 *
 * Pagar KEDUA dan KETIGA ada di database dan tidak bisa dilewati kode TypeScript mana pun:
 *   • CHECK `consignments_listed_requires_owner_chk` — baris tanpa `consignorId` tidak bisa
 *     berstatus LISTED maupun SOLD (migration 20260923000000);
 *   • CHECK `listings_consignment_shape_chk` — baris listing titipan WAJIB `sellerId IS NOT NULL`
 *     (migration 20260922000000), dan `sellerId` diisi dari `consignorId`.
 */
export function listClaimWhere(id: string): Prisma.ConsignmentWhereInput {
  return {
    id,
    status: ConsignmentStatus.IN_CUSTODY,
    custodyAcceptedAt: { not: null },
    custodyReleasedAt: null,
    // Tahu siapa yang dibayar. Lihat paragraf di atas — ini gerbang, bukan filter.
    consignorId: { not: null },
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

/* ═══════════════ PENGEMBALIAN KE PEMILIK: ONGKIR BALIK + RESI ═══════════════ */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ "DITARIK" DAN "SUDAH PULANG" ADALAH DUA FAKTA YANG BERBEDA — dan itulah seluruh isi bagian  ║
 * ║ ini. Yang pertama adalah PERMINTAAN (`withdrawRequestedAt`), yang kedua adalah PERPINDAHAN  ║
 * ║ FISIK (`custodyReleasedAt`). Selama kartunya masih di rak, ia MASIH tanggung jawab Hoshi.   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Sebelum bagian ini ada, penarikan hanya menerima sebuah `note` bebas. Akibatnya sistem bisa
 * menyatakan sebuah kartu "ditarik" tanpa pernah tahu ke MANA ia dikirim, SIAPA yang menanggung
 * ongkirnya, dan apakah ia BENAR-BENAR SAMPAI — untuk barang senilai puluhan juta milik orang
 * lain, ketiganya adalah kegagalan custody, bukan kekurangan fitur.
 */

/**
 * CARA kartunya pulang. DUA, dan KEDUANYA harus ada:
 *
 *   PICKUP   diambil sendiri di tempat Hoshi. TIDAK butuh alamat — dan memaksanya mengisi alamat
 *            hanya akan melahirkan alamat karangan di baris yang paling tidak membutuhkannya.
 *            Yang dibutuhkan justru SIAPA yang mengambil (`returnPickedUpBy`); "kapan"-nya adalah
 *            `custodyReleasedAt`, yang sudah ada.
 *   COURIER  dikirim kurir. Butuh alamat LENGKAP + resi.
 *
 * Nilai string-nya KONTRAK: ia tersimpan apa adanya di `Consignment.returnMethod` dan dijaga CHECK
 * `consignments_return_shape_chk` (migration 20260925000000).
 */
export const CONSIGNMENT_RETURN_METHOD = {
  PICKUP: 'PICKUP',
  COURIER: 'COURIER',
} as const;

export type ConsignmentReturnMethod =
  (typeof CONSIGNMENT_RETURN_METHOD)[keyof typeof CONSIGNMENT_RETURN_METHOD];

/**
 * SIAPA yang menanggung ongkir balik.
 *
 * ⚠️ DICATAT SAJA — PENAGIHANNYA BELUM OTOMATIS. Tidak ada invoice yang terbit dari nilai ini,
 * tidak ada saldo yang dipotong, dan NOL Rupiah bergerak di seluruh jalur penarikan: menarik
 * kartu tetap GRATIS bagi pemiliknya, dan itu janji produk yang kalau dilemahkan berarti dihapus.
 *
 * Yang ditutupnya adalah kebocoran DIAM-DIAM. Tanpa kolom ini, ongkos yang ditanggung Hoshi tidak
 * pernah muncul di laporan mana pun, jadi tidak ada seorang pun yang bisa memutuskan apakah
 * angkanya wajar. Kalau suatu hari penagihannya diputuskan, ia WAJIB memakai jalur pembayaran
 * yang SUDAH ADA (PaymentOrder/IDRX) — jangan membangun rail uang baru untuk ini.
 */
export const CONSIGNMENT_RETURN_PAYER = {
  /** Pemilik kartu. */
  OWNER: 'OWNER',
  HOSHI: 'HOSHI',
} as const;

export type ConsignmentReturnPayer =
  (typeof CONSIGNMENT_RETURN_PAYER)[keyof typeof CONSIGNMENT_RETURN_PAYER];

/**
 * Bagian baris titipan yang dibutuhkan gerbang pengembalian. SENGAJA sekecil mungkin, sama
 * seperti `ConsignmentCustodyFacts` di atas.
 */
export interface ConsignmentReturnFacts {
  returnMethod: string | null;
  returnRecipientName: string | null;
  returnPhoneNumber: string | null;
  returnStreet: string | null;
  returnCity: string | null;
  returnState: string | null;
  returnZip: string | null;
  returnCountry: string | null;
}

/**
 * Kolom alamat yang WAJIB terisi untuk pengembalian lewat kurir.
 *
 * SATU DAFTAR, dipakai predikat SQL (`withdrawnReleaseClaimWhere`), pemeriksaan TS
 * (`isReturnAddressComplete`), DAN pesan errornya — supaya "alamat lengkap" tidak bisa berarti
 * tiga hal yang berbeda di tiga tempat. Kembarannya di database adalah CHECK
 * `consignments_return_shape_chk`; kalau salah satunya berubah, yang lain WAJIB ikut.
 *
 * `returnApt` dan `returnPhoneCountryCode` SENGAJA TIDAK di sini: yang pertama memang sering tidak
 * ada (rumah, bukan apartemen), yang kedua punya arti bawaan yang jelas untuk nomor Indonesia.
 * Kolom yang diwajibkan padahal sering kosong hanya mengajari orang mengisinya dengan tanda hubung.
 */
export const RETURN_ADDRESS_REQUIRED_FIELDS = [
  'returnRecipientName',
  'returnPhoneNumber',
  'returnStreet',
  'returnCity',
  'returnState',
  'returnZip',
  'returnCountry',
] as const satisfies readonly (keyof ConsignmentReturnFacts)[];

/** true ⇔ alamat pengembaliannya LENGKAP menurut satu-satunya definisi yang ada. */
export function isReturnAddressComplete(f: ConsignmentReturnFacts): boolean {
  return RETURN_ADDRESS_REQUIRED_FIELDS.every((k) => {
    const v = f[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

/** Kolom alamat yang MASIH KURANG — dipakai pesan error supaya ia menyebut apa, bukan "tidak lengkap". */
export function missingReturnAddressFields(
  f: ConsignmentReturnFacts,
): string[] {
  return RETURN_ADDRESS_REQUIRED_FIELDS.filter((k) => {
    const v = f[k];
    return !(typeof v === 'string' && v.trim().length > 0);
  });
}

/**
 * true ⇔ baris ini SUDAH siap ditandai keluar sebagai pengembalian ke pemilik.
 *
 * Bukan "boleh ditarik" — penarikan boleh diminta kapan saja, gratis, tanpa syarat. Ini
 * pertanyaan yang jauh lebih sempit: apakah kita tahu cukup banyak untuk BERANI melepas custody.
 */
export function isReturnPlanReady(f: ConsignmentReturnFacts): boolean {
  if (f.returnMethod === CONSIGNMENT_RETURN_METHOD.PICKUP) return true;
  if (f.returnMethod === CONSIGNMENT_RETURN_METHOD.COURIER) {
    return isReturnAddressComplete(f);
  }
  return false;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KLAIM ATOMIK "KARTUNYA PULANG": IN_CUSTODY → RELEASED, dan HANYA kalau kita tahu KE MANA.   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * INILAH lapis yang membuat "tidak bisa menandai terkirim tanpa alamat" ditegakkan POSTGRES, bukan
 * sekadar oleh `if` di service. Pemeriksaan di service tetap ada — ia yang menulis PESANNYA — tapi
 * yang tidak bisa dilewati adalah predikat ini: kalau alamatnya belum ada, klaimnya cocok 0 baris,
 * `custodyReleasedAt` tidak pernah ditulis, dan kartunya tetap tercatat sebagai tanggung jawab
 * Hoshi. Itu arah gagal yang benar — kartu yang masih di rak tidak boleh bisa "selesai".
 *
 * KENAPA ALAMATNYA DIBACA DARI BARIS, BUKAN DARI BODY PERMINTAAN. Pelajarannya sama dengan
 * `escrowedAt`: gerbang membaca FAKTA TERSIMPAN. Operator yang mencatat alamat pada detik yang
 * sama dengan pelepasan custody tetap bisa — service menulis rencananya LEBIH DULU, di transaksi
 * yang SAMA, lalu klaim ini membacanya dari baris. Urutan itu yang membuat "alamatnya ada" tidak
 * pernah cuma berarti "alamatnya disebut di body yang sedang diproses".
 *
 * RESI (`returnCourier`/`returnTrackingNo`) SENGAJA TIDAK ADA DI PREDIKAT INI, dan itu bukan
 * kelonggaran: nomor resi LAHIR pada detik yang sama dengan pelepasan custody (ia ditulis oleh
 * `data` update yang sama), jadi menuntutnya di `where` berarti menuntut sebuah baris membawa
 * nilai sebelum nilai itu ada. Resi ditegakkan pemeriksaan service SEBELUM transaksi dibuka —
 * lihat `release()`. Yang bisa ditegakkan predikat adalah fakta yang SUDAH tersimpan, dan itu
 * alamatnya.
 */
export function withdrawnReleaseClaimWhere(
  id: string,
): Prisma.ConsignmentWhereInput {
  const addressComplete = Object.fromEntries(
    RETURN_ADDRESS_REQUIRED_FIELDS.map((k) => [k, { not: null }]),
  ) as Prisma.ConsignmentWhereInput;
  return {
    id,
    // Pengembalian ke pemilik HANYA sah dari IN_CUSTODY — listing yang masih tayang wajib
    // diturunkan dulu lewat penarikan. Sama persis dengan gerbang `release` sebelum bagian ini ada.
    status: ConsignmentStatus.IN_CUSTODY,
    // Custody ditulis SEKALI. Predikat ini yang menjamin "sekali", bukan urutan kode.
    custodyReleasedAt: null,
    OR: [
      { returnMethod: CONSIGNMENT_RETURN_METHOD.PICKUP },
      {
        returnMethod: CONSIGNMENT_RETURN_METHOD.COURIER,
        ...addressComplete,
      },
    ],
  };
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TUKARKAN KODE KLAIM: titipan TANPA pemilik → titipan MILIK user yang memegang kodenya.       ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Bentuknya klaim atomik seperti yang lain, dan di sini bentuk itu MELAKUKAN PEKERJAAN NYATA:
 * dua orang yang menukarkan kode yang sama pada detik yang sama tidak bisa dua-duanya menang,
 * karena `count !== 1` berarti kalah. Tidak ada jendela "baca lalu tulis".
 *
 * KEEMPAT SYARATNYA, dan kenapa masing-masing ada:
 *   claimCodeHash          kodenya cocok. Yang disimpan HANYA hash-nya (lihat
 *                          `consignment-claim-code.ts`); teks kodenya tidak ada di mana pun.
 *   consignorId: null      belum ada pemiliknya. Titipan yang SUDAH punya pemilik tidak bisa
 *                          "diklaim ulang" oleh siapa pun — termasuk oleh pemiliknya sendiri.
 *   claimCodeExpiresAt     kertas yang tertinggal setahun di laci BUKAN kunci yang masih hidup.
 *   status != CANCELLED    kesepakatan yang batal sebelum serah-terima tidak punya apa pun untuk
 *                          ditautkan. (RELEASED dan LOST SENGAJA TIDAK dikecualikan: kartu yang
 *                          sudah dikembalikan tetap punya riwayat yang berhak dilihat pemiliknya,
 *                          dan kartu yang HILANG justru HARUS bisa ditautkan — kalau tidak, ganti
 *                          ruginya tidak punya tujuan.)
 *
 * PENTING — yang menulis penukaran WAJIB mengosongkan `claimCodeHash` di transaksi yang SAMA.
 * "Sekali pakai" jadi bentuk baris, bukan janji: sesudah ditukarkan, kode itu tidak cocok dengan
 * apa pun di tabel.
 */
export function claimCodeRedeemWhere(
  claimCodeHash: string,
  now: Date,
): Prisma.ConsignmentWhereInput {
  return {
    claimCodeHash,
    consignorId: null,
    claimCodeExpiresAt: { gt: now },
    status: { not: ConsignmentStatus.CANCELLED },
  };
}

/**
 * Admin menautkan akun pemilik ke titipan yang belum punya pemilik (Path A: pemiliknya masuk
 * akun saat serah-terima, atau identitasnya diperiksa langsung belakangan), DAN admin
 * menerbitkan / menerbitkan ulang kode klaim untuk baris yang sama.
 *
 * DUA SYARAT, dan keduanya ada DI DALAM KLAIM — bukan sebagai `if` terpisah di service:
 *
 *   consignorId: null    penautan TIDAK PERNAH menimpa pemilik yang sudah ada. Kartu orang lain
 *                        tidak boleh berpindah pemilik lewat satu panggilan admin yang salah
 *                        ketik — kalau baris ini sudah bertuan, klaimnya cocok 0 baris dan admin
 *                        diberi tahu apa adanya.
 *   status != CANCELLED  kesepakatan yang batal sebelum serah-terima tidak punya apa pun untuk
 *                        ditautkan, dan tidak punya apa pun untuk dibuka dengan kode.
 *
 * SYARAT KEDUA DULU HANYA ADA SEBAGAI PEMBACAAN TERPISAH di `linkConsignor`/`issueClaimCode`, dan
 * itu bocor: pembatalan yang mendarat DI ANTARA pembacaan dan penulisan menghasilkan salah satu
 * dari dua hal — pemilik yang tertaut ke kesepakatan yang sudah batal, atau (lebih buruk bagi
 * orang yang sedang berdiri di depan operator) selembar kode klaim yang baru saja DICETAK dan
 * TIDAK AKAN PERNAH BISA DITUKARKAN, karena `claimCodeRedeemWhere` memang mengecualikan
 * CANCELLED. Kondisinya harus dibawa klaimnya sendiri, supaya "kode yang bisa diterbitkan" dan
 * "kode yang bisa ditukarkan" tidak mungkin berbeda.
 *
 * RELEASED dan LOST SENGAJA TIDAK dikecualikan — sama persis dengan `claimCodeRedeemWhere`:
 * kartu yang sudah dikembalikan tetap punya riwayat yang berhak dilihat pemiliknya, dan kartu
 * yang HILANG justru HARUS bisa ditautkan, kalau tidak ganti ruginya tidak punya tujuan.
 */
export function linkConsignorClaimWhere(
  id: string,
): Prisma.ConsignmentWhereInput {
  return {
    id,
    consignorId: null,
    status: { not: ConsignmentStatus.CANCELLED },
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
