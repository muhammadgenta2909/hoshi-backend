-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ KONSINYASI (TITIPAN): KARTU ORANG LAIN, FISIKNYA DI TANGAN HOSHI.                          ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- KEPUTUSAN PRODUK yang memicu migration ini: vault CollectorCrypt tidak bisa melayani Indonesia
-- (pengiriman fisik kena pajak impor ~20%), jadi HOSHI yang jadi vault-nya. PM mendatangi pemilik
-- kartu lokal, mengambil kartunya ke penyimpanan Hoshi di Indonesia, memotret & menilai,
-- memajangnya, lalu menjualnya. Komisi Hoshi 5%.
--
-- RISIKO YANG DITAKUTKAN PEMILIK PRODUK, persis kalimatnya:
--   "jangan sampai ada case misal kita jual kartu seseorang, tapi dia ternyata jual pribadi ke
--    orang lain"
--
-- Risiko itu ditutup oleh URUTAN, bukan kepintaran: KARTUNYA SUDAH DI TANGAN HOSHI SEBELUM
-- listing-nya tayang. Orang yang sudah menyerahkan kartunya tidak bisa menjualnya di tempat lain.
-- Migration ini adalah lapis DATABASE dari urutan itu.
--
-- ════════════════════════ AMAN DI-APPLY KE DATA YANG SUDAH ADA ════════════════════════════════
--
-- SELURUH isi migration ini ADITIF dan NULLABLE:
--   * tiga tabel BARU (consignments, consignment_photos, consignment_events) — lahir kosong;
--   * satu kolom BARU nullable di "listings" ("consignmentId") — SEMUA baris lama mendapat NULL;
--   * CHECK constraint yang HANYA berlaku bila "consignmentId" IS NOT NULL — jadi ia TIDAK BISA
--     menolak satu pun baris yang sudah ada (semuanya NULL);
--   * satu partial unique index di tabel BARU yang kosong.
--
-- Artinya: SETIAP BARIS LAMA MEMPERTAHANKAN ARTINYA PERSIS. `consignmentId IS NULL` ⇒ ketiga
-- jenis listing lama (katalog CC, stok Hoshi, listing user P2P) berperilaku identik dengan
-- sebelum migration ini.
--
-- ──────────────────────────── PRA-CEK (WAJIB DIJALANKAN LEBIH DULU) ──────────────────────────
--
-- Satu-satunya pernyataan di bawah yang BISA ditolak data yang sudah ada adalah CHECK constraint
-- "listings_consignment_shape_chk". Ia tidak seharusnya bisa gagal (kolomnya baru lahir dan
-- seluruhnya NULL), tapi PostgreSQL memvalidasi CHECK terhadap SELURUH tabel saat ADD CONSTRAINT,
-- jadi kalau ada apa pun yang tidak terduga, ALTER TABLE-nya gagal dan migration berhenti.
-- JALANKAN INI LEBIH DULU; ia HARUS mengembalikan 0:
--
--   SELECT count(*) AS offending
--   FROM "listings"
--   WHERE "consignmentId" IS NOT NULL
--     AND NOT (
--       "ccNftAddress" IS NULL
--       AND "escrowedAt" IS NULL
--       AND "sellerId" IS NOT NULL
--       AND "sellable" = false
--       AND "source" <> 'COLLECTORCRYPT'
--     );
--
-- Sebelum migration ini kolomnya belum ada, jadi query itu hanya bisa dijalankan SESUDAH langkah
-- (3) di bawah dan SEBELUM langkah (4). Kalau operator memilih memecah apply-nya, itu titik
-- pisahnya. Kalau hasilnya BUKAN 0, JANGAN paksa: itu berarti ada baris titipan yang berbentuk
-- salah, dan CHECK ini justru yang harus menahannya.
--
-- Pra-cek kedua, untuk partial unique index di langkah (5) — tabelnya baru lahir kosong, jadi ini
-- formalitas, tapi tuliskan supaya apply ulang di lingkungan yang sudah berisi data tetap aman:
--
--   SELECT "grader", "certNumber", count(*)
--   FROM "consignments"
--   WHERE "certNumber" IS NOT NULL
--     AND "custodyReleasedAt" IS NULL
--     AND "status" <> 'CANCELLED'
--   GROUP BY 1, 2 HAVING count(*) > 1;
--
-- HARUS mengembalikan 0 baris. Kalau tidak: ada DUA titipan hidup untuk satu slab bernomor
-- sertifikat sama — yaitu satu kartu fisik yang tercatat dua kali, dan itu HARUS diselesaikan
-- manusia sebelum index-nya dipasang.
--
-- ⚠️ MIGRATION INI TIDAK DIJALANKAN OLEH AGEN. DATABASE_URL menunjuk host Neon REMOTE.
--    File saja; operator yang meng-apply.
-- =============================================================================================

-- ─────────────────────────────────────── (1) ENUM ────────────────────────────────────────────
--
-- Setiap status punya JALAN KELUAR yang bisa digerakkan admin, dan itu diuji lengkap terhadap
-- enum di consignment-exit-reachability.spec.ts (pola yang sama dengan
-- redemption-exit-reachability.spec.ts): status enum BARU tidak bisa ditambahkan tanpa jalan
-- keluarnya ikut didaftarkan.
--
--   INTAKE     → IN_CUSTODY | CANCELLED
--   IN_CUSTODY → LISTED | RELEASED | LOST
--   LISTED     → IN_CUSTODY (ditarik) | SOLD | LOST
--   SOLD       → RELEASED (dikirim ke pembeli) | LOST
--   RELEASED / LOST / CANCELLED = terminal.
CREATE TYPE "ConsignmentStatus" AS ENUM (
  'INTAKE',
  'IN_CUSTODY',
  'LISTED',
  'SOLD',
  'RELEASED',
  'LOST',
  'CANCELLED'
);

CREATE TYPE "ConsignmentPhotoKind" AS ENUM (
  'FRONT',
  'BACK',
  'CERT',
  'DAMAGE',
  'HANDOVER',
  'OTHER'
);

-- ──────────────────────────────────── (2) TABEL BARU ─────────────────────────────────────────
--
-- KENAPA MODEL BARU DAN BUKAN "VaultItem" YANG DIPERLUAS. `VaultItem` bukan catatan custody; ia
-- catatan KLAIM-MINT, dan hampir setiap kolomnya berarti KEBALIKAN dari yang dibutuhkan titipan:
--   * `ownerId` NULL selama STORED, baru terisi saat user MENGKLAIM inventaris Hoshi —
--     sedangkan pemilik kartu titipan sudah DIKETAHUI dan NON-NULL sejak detik pertama;
--   * `VaultStatus` adalah daur hidup MINT (STORED→MINTING→MINTED), bukan daur hidup CUSTODY;
--   * `cardId` FK WAJIB ke `Card` (onDelete: Restrict) — memaksa satu baris katalog per slab
--     titipan akan mengisi katalog dengan sampah yang sesudah itu tidak bisa dihapus lagi;
--   * tidak ada kolom untuk bukti, kondisi, siapa yang menerima, harga sepakat, komisi.
-- Dan yang lebih penting, memakainya ulang TIDAK AMAN: `VaultService.findAvailable()` adalah
-- `where: { status: STORED }` TANPA filter pemilik, jadi baris titipan ber-status STORED akan
-- muncul di `GET /vault/available` dan bisa diklaim lewat `POST /vault/:id/claim` — yang me-mint
-- NFT KARTU ORANG LAIN ke siapa pun yang minta duluan. Model yang keamanannya bergantung pada
-- penjaga demo adalah model yang salah.
CREATE TABLE "consignments" (
  "id" TEXT NOT NULL,

  -- SIAPA PEMILIKNYA. Snapshot nama/telepon diambil SAAT SERAH-TERIMA: kolom di "users" bisa
  -- berubah kemudian, dan apa yang benar pada HARI penyerahan tidak bisa diturunkan ulang dari
  -- baris yang bisa berubah.
  "consignorId" TEXT NOT NULL,
  "consignorNameAtIntake" TEXT NOT NULL,
  "consignorPhoneAtIntake" TEXT NOT NULL,
  "consignorIdKind" TEXT,
  -- EMPAT DIGIT TERAKHIR SAJA. Nomor identitas lengkap TIDAK PERNAH disimpan: ia tidak diperlukan
  -- untuk apa pun yang dilakukan sistem ini, dan menyimpannya hanya menambah barang berharga
  -- milik orang lain yang bisa bocor.
  "consignorIdLast4" TEXT,

  -- SIAPA YANG MENERIMA. Stempel waktu saja adalah "kata Hoshi"; tanda terima bertanda tangan
  -- yang MENYEBUT NAMA PENERIMA bukan.
  "receivedById" TEXT NOT NULL,
  "receivedAtPlace" TEXT NOT NULL,

  -- APA YANG DITERIMA. `grader` + `certNumber` adalah identitas terkuat yang tersedia, dan ia
  -- bisa diperiksa DI SITUS GRADER-nya sendiri — bukti yang tidak bersandar pada "kata Hoshi".
  "cardName" TEXT NOT NULL,
  "cardSet" TEXT,
  "cardNumber" TEXT,
  "language" TEXT,
  "tcg" TEXT,
  "grader" "Grader",
  "certNumber" TEXT,
  "gradeLabel" TEXT,
  "gradeScore" DOUBLE PRECISION,
  -- WAJIB (NOT NULL), bahkan untuk slab. Kalimat inilah yang jadi tumpuan kalau ada sengketa
  -- berbulan-bulan kemudian; kolom nullable akan membuat "kosong" jadi keadaan normal.
  "conditionNote" TEXT NOT NULL,
  "rawCondition" TEXT,

  -- BUKTI MILIK PEMILIK (salinannya ada di tangan dia), bukan milik Hoshi.
  "intakeReceiptRef" TEXT,
  "agreementRef" TEXT,

  -- KESEPAKATAN. `commissionBps` adalah SNAPSHOT: perubahan HOSHI_MARKETPLACE_FEE_BPS TIDAK BOLEH
  -- mengubah apa yang sudah dijanjikan untuk kartu yang sudah ada di tangan kita.
  "askPriceIdr" INTEGER NOT NULL,
  "reservePriceIdr" INTEGER,
  "commissionBps" INTEGER NOT NULL DEFAULT 500,

  -- ══ FAKTA CUSTODY (APPEND-ONLY) ══
  -- `custodyAcceptedAt` ditulis SEKALI oleh langkah accept dan TIDAK PERNAH dikosongkan.
  -- `custodyReleasedAt` ditulis SEKALI saat kartunya keluar. DUA kolom, bukan satu yang di-toggle:
  -- inilah yang membuat kelas bug "satu aksi biasa menghapus satu-satunya petunjuk" (yang
  -- `assertCardLeftEscrow` ada untuk mencegahnya di jalur escrow) TIDAK ADA di sini secara
  -- struktural — tidak ada tulisan yang menghapus apa pun.
  "status" "ConsignmentStatus" NOT NULL DEFAULT 'INTAKE',
  "custodyAcceptedAt" TIMESTAMP(3),
  "custodyReleasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  "releaseReceiptRef" TEXT,
  "storageProvider" "StorageProvider" NOT NULL DEFAULT 'HOSHI',
  "storageLocation" TEXT,
  "withdrawRequestedAt" TIMESTAMP(3),

  -- HASIL
  "soldOrderId" TEXT,
  "payoutIdrx" INTEGER,
  "commissionIdrx" INTEGER,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "consignments_pkey" PRIMARY KEY ("id")
);

-- Foto bukti. APPEND-ONLY di lapis aplikasi: tidak ada endpoint update/delete untuk baris ini.
-- Foto yang bisa diam-diam diganti sesudah sengketa dimulai TIDAK ADA HARGANYA sebagai bukti.
CREATE TABLE "consignment_photos" (
  "id" TEXT NOT NULL,
  "consignmentId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "kind" "ConsignmentPhotoKind" NOT NULL,
  "note" TEXT,
  "takenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "addedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignment_photos_pkey" PRIMARY KEY ("id")
);

-- JEJAK AUDIT: SIAPA melakukan APA dan KAPAN, satu baris per perubahan keadaan. Append-only.
-- KOREKSI ditulis sebagai baris BARU ber-kind 'CORRECTION' — sehingga koreksi TERLIHAT sebagai
-- koreksi, bukan sebagai kolom yang diam-diam berubah isinya.
CREATE TABLE "consignment_events" (
  "id" TEXT NOT NULL,
  "consignmentId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "fromStatus" "ConsignmentStatus",
  "toStatus" "ConsignmentStatus",
  -- Bukan FK dengan sengaja: baris audit tidak boleh bisa menghalangi apa pun, dan tidak boleh
  -- ikut terhapus bersama akun pelakunya.
  "actorId" TEXT,
  "actorLabel" TEXT,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "consignment_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consignments_status_idx" ON "consignments"("status");
CREATE INDEX "consignments_consignorId_idx" ON "consignments"("consignorId");
CREATE INDEX "consignments_custodyReleasedAt_idx" ON "consignments"("custodyReleasedAt");
CREATE INDEX "consignment_photos_consignmentId_idx" ON "consignment_photos"("consignmentId");
CREATE INDEX "consignment_events_consignmentId_idx" ON "consignment_events"("consignmentId");
CREATE INDEX "consignment_events_kind_idx" ON "consignment_events"("kind");

-- Restrict pada KEDUA relasi ke "users", sama seperti "balance_entries"."userId" dan
-- "withdrawals"."userId": catatan tentang BARANG ORANG LAIN harus hidup lebih lama dari fitur
-- hapus-akun apa pun yang mungkin ditambahkan nanti. Hari ini tidak ada endpoint hapus-akun di
-- repo ini; FK ini memastikan kalau suatu saat ada, ia MENOLAK alih-alih meninggalkan catatan
-- yatim. Baris RELEASED/CANCELLED pun ikut menahan — DISENGAJA: buktinya harus hidup lebih lama
-- dari akunnya dengan alasan yang sama seperti buku besar uang.
ALTER TABLE "consignments"
  ADD CONSTRAINT "consignments_consignorId_fkey"
  FOREIGN KEY ("consignorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "consignments"
  ADD CONSTRAINT "consignments_receivedById_fkey"
  FOREIGN KEY ("receivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cascade: sebuah foto / baris audit tidak punya arti lepas dari catatan serah-terimanya.
ALTER TABLE "consignment_photos"
  ADD CONSTRAINT "consignment_photos_consignmentId_fkey"
  FOREIGN KEY ("consignmentId") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "consignment_events"
  ADD CONSTRAINT "consignment_events_consignmentId_fkey"
  FOREIGN KEY ("consignmentId") REFERENCES "consignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ──────────────────── (3) DISKRIMINATOR DI "listings" — SATU KOLOM ───────────────────────────
--
-- NULLABLE, jadi SETIAP baris lama mendapat NULL dan artinya TIDAK BERUBAH SEDIKIT PUN.
-- @unique: satu kartu titipan = paling banyak satu listing hidup.
-- Restrict: catatan titipan tidak bisa dihapus selagi listing-nya masih menunjuknya.
ALTER TABLE "listings" ADD COLUMN "consignmentId" TEXT;

CREATE UNIQUE INDEX "listings_consignmentId_key" ON "listings"("consignmentId");

ALTER TABLE "listings"
  ADD CONSTRAINT "listings_consignmentId_fkey"
  FOREIGN KEY ("consignmentId") REFERENCES "consignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ (4) BARIS TERPENTING DI SELURUH FITUR INI.                                                 ║
-- ║ "KARTU TITIPAN TIDAK BISA MENEMPUH SETTLEMENT ESCROW" JADI INVARIAN DATABASE.              ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- Cabang settlement REAL `fulfilUserListing` menuntut `ccNftAddress != null && escrowedAt != null`
-- (`isEscrowBackedUserListing`). CHECK ini MEMAKU kedua kolom itu NULL selamanya untuk baris
-- titipan. Jadi bahkan kalau SETIAP penjaga TypeScript dihapus, `isEscrowBackedUserListing`
-- mengembalikan false dan settlement escrow MENOLAK — SEBELUM klaim ACTIVE→SOLD diambil, jadi
-- pembeli bisa di-refund penuh dan kartunya tidak pernah bergerak.
--
-- Itu penting karena mode kegagalan yang ditutup di sini adalah mode kegagalan yang PALING MAHAL
-- di repo ini: gagal SESUDAH pembeli membayar.
--
-- Tentang `sellerId IS NOT NULL`: selalu ada orang yang harus dibayar. Listing titipan tanpa
-- penjual = penjualan yang uangnya tidak punya tujuan.
--
-- Tentang `sellable = false`: untuk baris titipan flag ini memang INERT hari ini — ketiga
-- pembacanya (`isHoshiSellableStock`, `listUnsellableStock`, `setListingsSellable`) SEMUA juga
-- menuntut `sellerId IS NULL`, jadi baris titipan sudah tersingkir dari ketiganya. Dipaku false
-- sebagai PERTAHANAN BERLAPIS: kalau suatu saat ada yang melonggarkan syarat `sellerId == null`
-- di `isHoshiSellableStock`, `sellable = false` tetap menahan kartu titipan keluar dari
-- `fulfilHoshiInventory` — jalur yang akan menyelesaikan penjualannya dengan HOSHI MENYIMPAN 100%
-- DAN PEMILIK KARTUNYA TIDAK DIBAYAR SEPESER PUN.
--
-- Tentang `source <> 'COLLECTORCRYPT'`: kartu titipan ada di rak Hoshi di Indonesia. Baris
-- ber-source CC berarti "fisiknya di gudang CollectorCrypt" dan mengarahkan pengiriman ke jalur
-- CC Vault (burn NFT + USDC + tanda tangan wallet) — jalur yang tidak punya apa pun untuk
-- dikerjakan di sini.
--
-- JALANKAN PRA-CEK DI KEPALA FILE SEBELUM BARIS INI.
ALTER TABLE "listings" ADD CONSTRAINT "listings_consignment_shape_chk" CHECK (
  "consignmentId" IS NULL OR (
    "ccNftAddress" IS NULL
    AND "escrowedAt" IS NULL
    AND "sellerId" IS NOT NULL
    AND "sellable" = false
    AND "source" <> 'COLLECTORCRYPT'
  )
);

-- ────────────────── (5) SATU KARTU FISIK TIDAK BISA DITITIPKAN DUA KALI ──────────────────────
--
-- Pola yang SAMA dengan "card_redemptions_active_nft_uniq": unik HANYA atas baris yang custody-nya
-- MASIH HIDUP. Kartu yang sudah dikembalikan (custodyReleasedAt terisi) keluar dari index, jadi
-- kartu yang sama BOLEH dititipkan lagi nanti — tanpa melonggarkan apa pun selagi ia masih di rak.
--
-- "MASIH HIDUP" DI SINI LEBIH LUAS dari "sedang di tangan Hoshi": baris INTAKE (sudah sepakat,
-- kartunya belum diserahkan) IKUT terkunci, karena dua kesepakatan aktif untuk satu slab yang sama
-- tetap salah — kartunya cuma satu. Tapi baris CANCELLED DIKECUALIKAN: kesepakatan yang batal
-- HARUS melepaskan nomor sertifikatnya, kalau tidak satu intake yang ditinggalkan akan mengunci
-- kartu itu dari Hoshi selamanya. (Padanan TS: `liveConsignmentWhere()` di
-- src/common/consignment.gate.ts — kalau salah satunya berubah, yang lain WAJIB ikut.)
--
-- CATATAN JUJUR TENTANG BATASNYA: untuk kartu MENTAH (tanpa nomor sertifikat) TIDAK ADA KUNCI, dan
-- index ini tidak menjangkaunya. Yang menjaga di sana adalah manusia: foto serah-terima, dan
-- kenyataan bahwa Hoshi harus benar-benar memegang dua kartu fisik.
--
-- DAN CATATAN YANG LEBIH PENTING: ketakutan pemilik produk — "kita jual kartu seseorang, tapi dia
-- ternyata jual pribadi ke orang lain" — BUKAN ditutup oleh index ini. Itu ditutup oleh URUTAN:
-- tidak ada yang bisa menjual pribadi kartu yang sudah ia serahkan ke Hoshi, dan tidak ada listing
-- titipan yang bisa lahir sebelum penyerahan itu (klaim atomik berpredikat `custodyAcceptedAt`
-- di ConsignmentService.createListingFor, dalam transaksi yang sama dengan Listing.create).
CREATE UNIQUE INDEX "consignments_active_cert_uniq"
  ON "consignments" ("grader", "certNumber")
  WHERE "certNumber" IS NOT NULL
    AND "custodyReleasedAt" IS NULL
    AND "status" <> 'CANCELLED';
