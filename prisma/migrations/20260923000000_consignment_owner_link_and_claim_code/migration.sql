-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ TITIPAN DARI ORANG YANG BELUM PUNYA AKUN — PEMILIK NULLABLE + KODE KLAIM.                  ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- KEPUTUSAN PRODUK yang memicu migration ini: PM mendatangi kolektor lokal DI RUMAH MEREKA.
-- Kebanyakan dari mereka BELUM punya akun Hoshi, dan tidak ada seorang pun yang bisa mengetikkan
-- id database di ponsel sambil pemilik kartunya berdiri di depannya. Sampai migration ini,
-- `consignments."consignorId"` NOT NULL, jadi Hoshi HANYA bisa menerima kartu dari orang yang
-- kebetulan sudah punya akun DAN yang id internalnya entah bagaimana diketahui operator — yang
-- berarti, dalam praktik, hampir tidak ada seorang pun.
--
-- DUA JALAN MASUK SESUDAH INI:
--
--   PATH A  Pemiliknya masuk akun SAAT serah-terima (momen terkuat yang ada untuk mengikat
--           identitas: kedua orangnya berdiri di tempat yang sama). Operator menemukannya lewat
--           GET /admin/consignments/consignor-search — rute yang MENGEMBALIKAN DAFTAR dan tidak
--           pernah mencocokkan sendiri — lalu MEMILIH orangnya. `consignorId` terisi sejak awal.
--
--   PATH B  Pemiliknya belum/tidak mau masuk akun. Baris titipannya lahir TANPA pemilik, dan
--           tanda terima bertanda tangan yang ia bawa pulang memuat KODE KLAIM sekali pakai.
--           Kapan pun setelahnya ia masuk akun dengan cara apa pun, mengetik kodenya, dan barulah
--           `consignorId` terisi.
--
-- KENAPA BUKAN EMAIL. `users."email"` di database ini NULLABLE, TIDAK UNIK, dan TIDAK PERNAH
-- DIVERIFIKASI — siapa pun bisa mengetik alamat orang lain di setelan profilnya sendiri. Hanya
-- `users."walletAddress"` yang UNIQUE. Menautkan kartu senilai puluhan juta Rupiah ke siapa pun
-- yang MENGAKU memiliki sebuah alamat email adalah kelas bug terburuk yang bisa dipunyai fitur
-- ini, dan tidak ada satu pun kolom atau field DTO di jalur ini yang menerimanya.
--
-- ════════════════════════ AMAN DI-APPLY KE DATA YANG SUDAH ADA ════════════════════════════════
--
-- Isi migration ini ADITIF dan MELONGGARKAN, kecuali SATU CHECK yang dibahas di pra-cek:
--   * DROP NOT NULL pada kolom yang sudah ada — pelonggaran murni; TIDAK ADA baris yang bisa
--     ditolak olehnya, dan SETIAP baris lama mempertahankan nilainya persis;
--   * lima kolom BARU yang seluruhnya NULLABLE — semua baris lama mendapat NULL;
--   * satu backfill yang hanya MENYATAKAN ULANG fakta yang sudah dijamin schema lama;
--   * satu partial-free UNIQUE index atas kolom baru yang seluruhnya NULL (Postgres tidak pernah
--     menganggap dua NULL sebagai duplikat, jadi ia tidak bisa menolak baris mana pun);
--   * satu CHECK constraint yang, pada data lama, DIJAMIN terpenuhi — tapi tetap divalidasi
--     Postgres terhadap SELURUH tabel saat ADD CONSTRAINT. Itu satu-satunya pernyataan yang bisa
--     menghentikan migration ini, dan pra-ceknya ada di bawah.
--
-- ──────────────────────────── PRA-CEK (WAJIB DIJALANKAN LEBIH DULU) ──────────────────────────
--
-- (P1) Untuk CHECK "consignments_listed_requires_owner_chk" di langkah (5). Query ini bisa
--      dijalankan SEKARANG, SEBELUM apa pun di-apply — kolomnya sudah ada (hanya NOT NULL), jadi
--      hasilnya HARUS 0 baik sebelum maupun sesudah langkah (1):
--
--        SELECT count(*) AS offending
--        FROM "consignments"
--        WHERE "consignorId" IS NULL
--          AND "status" IN ('LISTED', 'SOLD');
--
--      Sebelum migration ini `consignorId` NOT NULL, jadi jawabannya 0 secara struktural. Kalau
--      hasilnya BUKAN 0 (mis. migration ini di-apply ulang di lingkungan yang sudah berjalan dan
--      sempat melahirkan baris tanpa pemilik), JANGAN PAKSA. Hasil bukan-0 berarti ada kartu
--      orang lain yang TERPAJANG atau SUDAH TERJUAL sementara tidak ada siapa pun yang bisa
--      dibayar — itu harus diselesaikan MANUSIA (tautkan pemiliknya, atau turunkan listing-nya)
--      sebelum constraint-nya dipasang. Constraint inilah yang memang ada untuk menahan keadaan
--      itu; memaksanya lewat berarti membuang satu-satunya penjaga.
--
-- (P2) Untuk UNIQUE index "consignments_claimCodeHash_key" di langkah (4). Kolomnya baru lahir
--      dan seluruhnya NULL, jadi ini formalitas — tapi tuliskan supaya apply ulang di lingkungan
--      yang sudah berisi data tetap aman. Jalankan SESUDAH langkah (2), HARUS 0 baris:
--
--        SELECT "claimCodeHash", count(*)
--        FROM "consignments"
--        WHERE "claimCodeHash" IS NOT NULL
--        GROUP BY 1 HAVING count(*) > 1;
--
--      Hasil bukan-0 baris berarti dua titipan berbagi satu kode klaim — satu kertas yang membuka
--      dua catatan. Selesaikan dulu (terbitkan ulang salah satunya) sebelum index dipasang.
--
-- ⚠️ MIGRATION INI TIDAK DIJALANKAN OLEH AGEN. DATABASE_URL menunjuk host Neon REMOTE.
--    File saja; operator yang meng-apply.
-- =============================================================================================

-- ───────────────── (1) PEMILIKNYA BOLEH BELUM ADA — PELONGGARAN MURNI ────────────────────────
--
-- FK "consignments_consignorId_fkey" (ON DELETE RESTRICT) TIDAK DISENTUH dan tetap berlaku apa
-- adanya: di Postgres, FK tidak pernah menolak nilai NULL, dan baris yang SUDAH menunjuk seorang
-- user tetap menahan penghapusan user itu persis seperti sebelumnya. Catatan tentang BARANG ORANG
-- LAIN tetap hidup lebih lama dari fitur hapus-akun apa pun yang mungkin ditambahkan nanti.
ALTER TABLE "consignments" ALTER COLUMN "consignorId" DROP NOT NULL;

-- ───────────────── (2) KOLOM BARU — SEMUANYA NULLABLE, SEMUANYA ADITIF ───────────────────────
--
-- KAPAN dan LEWAT MANA pemiliknya tertaut. Bukan hiasan: kalau suatu hari ada sengketa tentang
-- SIAPA pemilik sebuah kartu, jawabannya berbeda KEKUATANNYA tergantung jalannya —
--   'AT_INTAKE'  operator memilih akunnya dari daftar saat serah-terima (penilaian manusia),
--   'ADMIN_LINK' operator memilih akunnya belakangan setelah memeriksa identitas (idem, + catatan
--                tertulis WAJIB tentang dasar verifikasinya),
--   'CLAIM_CODE' pemiliknya menukarkan kertas yang berpindah tangan BERSAMA kartunya.
-- Menyimpan mana yang dipakai berarti pertanyaan itu punya jawaban tertulis, bukan ingatan.
ALTER TABLE "consignments" ADD COLUMN "consignorLinkedAt" TIMESTAMP(3);
ALTER TABLE "consignments" ADD COLUMN "consignorLinkMethod" TEXT;

-- KODE KLAIM — HANYA HASH-nya yang disimpan.
--
-- Teks kodenya ada TEPAT SEKALI dalam hidup sebuah proses: di body respons rute penerbitan. Ia
-- TIDAK PERNAH di-log, TIDAK PERNAH masuk baris audit `consignment_events`, dan TIDAK ADA rute
-- yang bisa membacanya kembali. Artinya: dump database ini, layar admin, dan berkas log TIDAK
-- memuat satu pun kode yang bisa dipakai.
--
-- SHA-256 polos sudah cukup DI SINI justru karena kodenya berentropi 50 bit (32^10, dari CSPRNG):
-- tidak ada kamus untuk diserang, jadi KDF lambat hanya akan memperlambat penukaran yang jujur.
-- (Bandingkan "users"."passwordHash", yang melindungi rahasia PILIHAN MANUSIA berentropi rendah —
-- di sana KDF lambat memang wajib.)
--
-- Kolom ini DIKOSONGKAN saat penukaran berhasil, di transaksi yang sama dengan penautannya.
-- "Sekali pakai" karena itu adalah BENTUK BARIS, bukan janji kode: sesudah ditukarkan, kode
-- tersebut tidak cocok dengan apa pun di tabel.
ALTER TABLE "consignments" ADD COLUMN "claimCodeHash" TEXT;
ALTER TABLE "consignments" ADD COLUMN "claimCodeIssuedAt" TIMESTAMP(3);
-- Kertas yang tertinggal setahun di laci BUKAN kunci yang masih hidup. Kedaluwarsa bukan jalan
-- buntu: admin bisa menerbitkan ulang, dan penerbitan ulang MENIMPA hash lama (kertas lama mati).
ALTER TABLE "consignments" ADD COLUMN "claimCodeExpiresAt" TIMESTAMP(3);

-- ───────── (3) BACKFILL — MENYATAKAN ULANG FAKTA, BUKAN MENEBAKNYA ──────────────────────────
--
-- Setiap baris yang ADA saat migration ini berjalan PASTI punya `consignorId`: kolomnya NOT NULL
-- sampai langkah (1) barusan, dan satu-satunya penulisnya (`ConsignmentService.createIntake`)
-- menuntut akun yang sudah ada dan memverifikasinya. Jadi untuk baris-baris itu, "pemiliknya
-- tertaut sejak dicatat, lewat pilihan operator" bukan dugaan melainkan hal yang DIJAMIN SCHEMA.
--
-- `consignorLinkedAt` di-set ke `createdAt` dan BUKAN ke NOW(): yang dicatat kolom ini adalah
-- KAPAN penautannya terjadi, dan untuk baris lama itu adalah hari titipannya dicatat — bukan hari
-- migration ini dijalankan. Menulis NOW() akan membuat setiap titipan lama tampak baru tertaut
-- hari ini, dan itu kebohongan yang akan terbaca sebagai fakta bertahun-tahun kemudian.
--
-- Baris baru TIDAK akan pernah melewati sini; ketiga jalur penautan mengisi kedua kolom sendiri.
UPDATE "consignments"
SET "consignorLinkedAt" = "createdAt",
    "consignorLinkMethod" = 'AT_INTAKE'
WHERE "consignorId" IS NOT NULL
  AND "consignorLinkedAt" IS NULL;

-- ───────── (4) SATU KODE TIDAK PERNAH BISA MEMBUKA DUA TITIPAN ──────────────────────────────
--
-- UNIQUE, bukan index biasa, dan itu MELAKUKAN PEKERJAAN NYATA: sebuah tebakan yang kebetulan
-- berhasil hanya bisa mengenai SATU baris, tidak pernah "kartu mana saja yang kodenya ini".
-- Sekaligus ia membuat penukaran jadi satu index lookup, jadi rute publiknya tidak punya alasan
-- untuk memindai tabel.
--
-- NULL TIDAK DIANGGAP DUPLIKAT oleh Postgres, jadi seluruh baris yang tidak punya kode klaim
-- (semua baris lama, dan semua titipan Path A) hidup berdampingan tanpa bertabrakan.
--
-- JALANKAN PRA-CEK (P2) SEBELUM BARIS INI.
CREATE UNIQUE INDEX "consignments_claimCodeHash_key" ON "consignments"("claimCodeHash");

-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ (5) BARIS TERPENTING DI MIGRATION INI.                                                     ║
-- ║ "KARTU YANG PEMILIKNYA BELUM TERTAUT TIDAK BISA DIJUAL" JADI INVARIAN DATABASE.            ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- Menjual kartu titipan berarti mengkredit saldo pemiliknya (`fulfilConsignment` → BalanceEntry).
-- Kalau pemiliknya belum tertaut, tidak ada nilai yang JUJUR untuk diisikan ke sana — dan yang
-- terjadi bukan sekadar error melainkan keadaan terburuk yang bisa dicapai fitur ini: HOSHI
-- MEMEGANG RUPIAH MILIK SESEORANG TANPA PUNYA CARA MENYALURKANNYA, sesudah pembeli membayar.
--
-- CHECK ini memaku aturan itu di lapis yang tidak bisa dilewati TypeScript mana pun. Ia menamai
-- LISTED dan SOLD, bukan "custody": kartu tanpa pemilik tertaut BOLEH diterima, dipotret,
-- disimpan, ditarik kembali, dan ditandai hilang — yang TIDAK BOLEH hanyalah DIJUAL. Membedakan
-- keduanya penting: kalau constraint ini juga melarang IN_CUSTODY, Path B mati seluruhnya dan
-- kita kembali ke keadaan yang membuat migration ini dibuat.
--
-- PAGAR YANG SUDAH ADA DAN IKUT MENAHAN, dari migration 20260922000000:
--   "listings_consignment_shape_chk" menuntut `sellerId IS NOT NULL` pada SETIAP baris listing
--   titipan, dan `sellerId` diisi dari `consignorId`. Jadi bahkan tanpa CHECK di bawah, database
--   sudah menolak listing untuk titipan tanpa pemilik. CHECK ini ditambahkan karena ia menahan
--   SATU LANGKAH LEBIH AWAL (statusnya, bukan baris listing-nya) dan karena ia menahan juga
--   perpindahan ke SOLD — jalur yang memindahkan uang.
--
-- LAPIS KODENYA: `listClaimWhere()` di src/common/consignment.gate.ts menyebut
-- `consignorId: { not: null }`, dan `Listing.create` berjalan di transaksi yang SAMA dengan klaim
-- itu. Kalau salah satunya berubah, yang lain WAJIB ikut.
--
-- JALANKAN PRA-CEK (P1) SEBELUM BARIS INI.
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_listed_requires_owner_chk" CHECK (
  "consignorId" IS NOT NULL OR "status" NOT IN ('LISTED', 'SOLD')
);
