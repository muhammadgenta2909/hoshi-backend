-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ ONGKIR DOMESTIK BERTINGKAT PER-WILAYAH — TIER-nya jadi DATA, bukan kode.                   ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- KEPUTUSAN PRODUK yang memicu migration ini: ongkir kirim domestik BUKAN flat nasional, melainkan
-- BERTINGKAT PER WILAYAH — mulai dari pembelahan baku Indonesia (Jawa vs luar Jawa), dengan
-- kemungkinan pembelahan yang lebih halus nanti. Syaratnya: MENAMBAH TIER TIDAK BOLEH BUTUH
-- PERUBAHAN KODE.
--
-- Karena itu yang ditambahkan di sini bukan enum wilayah dan bukan tabel pemetaan kedua, melainkan
-- TIGA KOLOM pada tabel tarif yang sudah ada, sehingga SATU BARIS = SATU TIER yang membawa
-- harganya SEKALIGUS daftar provinsinya:
--
--   provinces   TEXT[]  daftar nama provinsi (SUDAH dinormalkan: huruf kecil, tanpa tanda baca)
--                       yang masuk tier ini. Boleh banyak EJAAN per provinsi
--                       ('jawa barat','jabar','west java') karena kolom `state` pada alamat diisi
--                       dari dropdown geo (sebagian nama INGGRIS) ATAU diketik bebas user ketika
--                       CSC_API_KEY kosong.
--   fallback    BOOLEAN tier penampung untuk provinsi yang TIDAK cocok ke mana pun — termasuk
--                       alamat yang tidak menyebut provinsi sama sekali (`state` nullable).
--   label       TEXT    nama manusiawi tier ("Jawa", "Luar Jawa").
--   placeholder BOOLEAN angkanya masih penampung (belum pernah di-set manusia).
--
-- Menambah tier      = INSERT satu baris (lewat PUT /api/admin/shipping/domestic-rates).
-- Memindah provinsi  = edit `provinces` di dua baris, lewat rute yang sama.
-- Harga satu provinsi= baris ber-scope 'STATE:<provinsi>'.
-- Ketiganya NOL deploy, NOL migrasi, NOL restart.
--
-- ============================ AMAN DI-APPLY KE DATA YANG SUDAH ADA ============================
--   * Tabel "domestic_shipping_rates" lahir KOSONG di migration 20260921000000 dan belum pernah
--     ada rute yang menulisinya di produksi, jadi kemungkinan besar ia masih nol baris.
--   * Walau begitu ketiga kolom baru diberi DEFAULT dan/atau NULLABLE, sehingga baris LAMA (kalau
--     ada) tetap sah dan ARTINYA TIDAK BERUBAH: provinces = '{}' (tidak cocok provinsi apa pun),
--     fallback = false, placeholder = false. Sebuah baris lama ber-scope '*' karena itu tetap
--     berlaku sebagai FLAT NASIONAL persis seperti sebelumnya — ia dipakai di lapis 4 resolusi.
--   * TIDAK ADA SEED di migration ini, DENGAN SENGAJA. Nilai awal tier (Jawa / luar Jawa beserta
--     angka penampungnya) hidup di SATU tempat saja: DOMESTIC_DEFAULT_TIERS di
--     src/payments/domestic-shipping-rate.ts. Menyalinnya ke SQL akan melahirkan dua daftar
--     "default" yang bisa melenceng — dan yang di SQL tidak akan pernah ikut berubah saat
--     kodenya diperbaiki.
-- =============================================================================================

ALTER TABLE "domestic_shipping_rates"
  ADD COLUMN "provinces" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "fallback" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "label" TEXT,
  ADD COLUMN "placeholder" BOOLEAN NOT NULL DEFAULT false;

-- Pencarian tier lewat provinsi memakai kecocokan array. Tabelnya cuma segelinting baris (satu per
-- tier) dan kode MENARIK SELURUH baris aktif lalu memilih di aplikasi — jadi index ini bukan untuk
-- kecepatan hari ini, melainkan jaring kalau suatu saat pemilihannya dipindahkan ke SQL.
CREATE INDEX "domestic_shipping_rates_provinces_idx"
  ON "domestic_shipping_rates" USING GIN ("provinces");

-- Satu tier penampung saja yang boleh aktif. Ini INVARIANT KONFIGURASI, ditegakkan DB supaya ia
-- tidak bergantung pada rute admin selalu ingat memeriksanya. (Resolusi di aplikasi tetap
-- memilih yang TERMAHAL kalau toh ada dua — sabuk kedua, untuk data yang lahir sebelum index ini.)
CREATE UNIQUE INDEX "domestic_shipping_rates_single_fallback_uniq"
  ON "domestic_shipping_rates" (("fallback"))
  WHERE "fallback" = true AND "active" = true;
