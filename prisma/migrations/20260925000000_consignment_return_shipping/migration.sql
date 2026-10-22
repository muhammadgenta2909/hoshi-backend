-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ PENGEMBALIAN KARTU TITIPAN — ONGKIR BALIK + RESI.                                          ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- MASALAH YANG DITUTUP MIGRATION INI. Penarikan titipan sudah ada sejak 20260922000000, tapi
-- satu-satunya hal yang bisa dicatat tentangnya adalah sebuah `note` bebas. Artinya sistem
-- menyatakan sebuah kartu "ditarik" tanpa pernah tahu:
--
--   • ke MANA kartunya dikirim (tidak ada satu kolom alamat pun di jalur ini),
--   • SIAPA yang menanggung ongkir baliknya (jadi ongkos yang ditanggung Hoshi tidak pernah
--     muncul di laporan mana pun — kebocoran yang tidak bisa dilihat siapa pun),
--   • apakah kartunya BENAR-BENAR SAMPAI (tidak ada resi, jadi "sudah dikirim" adalah klaim
--     yang tidak bisa diperiksa oleh pemilik kartunya sendiri).
--
-- Akibatnya sebuah baris bisa berbunyi RELEASED sementara kartunya masih tergeletak di rak — atau
-- sudah dikirim ke alamat yang tidak pernah ditulis siapa pun. Untuk barang senilai puluhan juta
-- milik orang lain, keduanya adalah kegagalan custody, bukan kekurangan fitur.
--
-- ════════════════════ BENTUK ALAMATNYA SENGAJA BUKAN BENTUK BARU ════════════════════════════
--
-- Kolom alamat di bawah adalah SALINAN PERSIS bentuk yang sudah dipakai `card_redemptions`
-- (jalur kirim domestik untuk stok Hoshi): recipientName / country / street / apt / city / state
-- / zip / phoneCountryCode / phoneNumber. Hanya berawalan `return` supaya tidak bertabrakan di
-- dalam tabel ini. TIDAK ADA bentuk alamat kedua yang diciptakan untuk hal yang sama, dan tarif
-- ongkirnya pun memakai tabel `domestic_shipping_rates` yang SUDAH ADA — satu daftar ongkir untuk
-- seluruh Indonesia, bukan dua yang suatu hari akan berbeda.
--
-- SNAPSHOT, bukan FK ke "shipping_addresses", dan itu keputusan yang mengikat karena DUA sebab:
--   • pemilik kartu BISA belum punya akun sama sekali (Path B / kode klaim di tanda terima), jadi
--     ia tidak punya buku alamat untuk dirujuk;
--   • alamat yang diubah atau dihapus SESUDAH kartunya dikirim tidak boleh mengubah ke mana kartu
--     itu TERCATAT dikirim. Alasan yang sama persis dengan snapshot di "card_redemptions".
--
-- ═══════════════ TIDAK ADA RAIL UANG BARU DI MIGRATION INI, DAN ITU DISENGAJA ════════════════
--
-- `returnShippingPayer` / `returnShippingFeeIdr` hanya MENCATAT. Tidak ada invoice yang terbit
-- darinya, tidak ada saldo yang dipotong, dan penarikan kartu TETAP GRATIS bagi pemiliknya — itu
-- janji produk yang kalau dilemahkan berarti dihapus. Yang ditutup kolom ini adalah kebocoran
-- diam-diam: ongkos yang ditanggung Hoshi sekarang PUNYA ANGKA yang bisa dibaca, dan keputusan
-- apakah ia wajar bisa diambil manusia berdasarkan data, bukan dugaan.
--
-- ═════════════════════ AMAN DI-APPLY KE DATA YANG SUDAH ADA ═════════════════════════════════
--
-- Isi migration ini SELURUHNYA ADITIF:
--   * 16 kolom BARU yang semuanya NULLABLE → setiap baris lama mendapat NULL dan tidak ada satu
--     baris pun yang bisa ditolak. Tidak ada NOT NULL, tidak ada DEFAULT yang menulis ulang
--     tabel, tidak ada perubahan tipe, tidak ada backfill.
--   * 3 CHECK constraint yang, pada SELURUH data lama, terpenuhi SECARA STRUKTURAL: ketiganya
--     berbentuk "<kolom baru> IS NULL OR <syarat>", dan setiap kolom yang mereka sebut baru saja
--     lahir berisi NULL untuk semua baris. ADD CONSTRAINT tetap memindai tabel, jadi pra-ceknya
--     tetap ditulis di bawah — tapi hasilnya tidak bisa bukan-0 kecuali migration ini di-apply
--     ulang di lingkungan yang SUDAH menjalankan kodenya.
--
-- ──────────────────────────── PRA-CEK (WAJIB DIJALANKAN LEBIH DULU) ─────────────────────────
--
-- Jalankan SESUDAH langkah (1), SEBELUM langkah (2). Ketiganya HARUS 0:
--
--   -- (P1) bentuk pengembalian
--   SELECT count(*) FROM "consignments"
--   WHERE "returnMethod" IS NOT NULL
--     AND NOT (
--       "returnMethod" = 'PICKUP'
--       OR ("returnMethod" = 'COURIER'
--           AND "returnRecipientName" IS NOT NULL AND "returnPhoneNumber" IS NOT NULL
--           AND "returnStreet" IS NOT NULL AND "returnCity" IS NOT NULL
--           AND "returnState" IS NOT NULL AND "returnZip" IS NOT NULL
--           AND "returnCountry" IS NOT NULL)
--     );
--
--   -- (P2) penanggung ongkir
--   SELECT count(*) FROM "consignments"
--   WHERE "returnShippingPayer" IS NOT NULL
--     AND "returnShippingPayer" NOT IN ('OWNER', 'HOSHI');
--
--   -- (P3) nominal ongkir
--   SELECT count(*) FROM "consignments" WHERE "returnShippingFeeIdr" < 0;
--
-- Hasil bukan-0 pada (P1) berarti ada kartu yang tercatat "dikirim balik" ke alamat yang tidak
-- lengkap — itu diselesaikan MANUSIA (lengkapi alamatnya dari arsip tanda terima pengembalian,
-- atau kosongkan `returnMethod` kalau barisnya memang salah isi) sebelum constraint dipasang.
-- JANGAN MEMAKSANYA LEWAT: constraint inilah yang ada untuk menahan keadaan itu.
--
-- ⚠️ MIGRATION INI TIDAK DIJALANKAN OLEH AGEN. DATABASE_URL menunjuk host REMOTE.
--    File saja; operator yang meng-apply.
-- =============================================================================================

-- ───────────────── (1) KOLOM BARU — SEMUANYA NULLABLE, SEMUANYA ADITIF ──────────────────────

-- CARA kartunya pulang: 'PICKUP' (diambil sendiri di tempat Hoshi) | 'COURIER' (dikirim kurir).
--
-- DUA CARA, DAN KEDUANYA WAJIB ADA. Memaksa semua pengembalian lewat kurir berarti menagih
-- ongkir kepada orang yang rumahnya lima menit dari kantor; memaksa semuanya diambil sendiri
-- berarti kolektor di Medan tidak pernah bisa mendapatkan kartunya kembali. Kolom ini yang
-- memutuskan BUKTI MANA yang diminta sebelum custody boleh dilepas.
--
-- TEXT, bukan enum Postgres, dengan sengaja: CREATE TYPE + ALTER TYPE ... ADD VALUE tidak bisa
-- dijalankan di dalam transaksi pada PostgreSQL lama, sedangkan Prisma membungkus tiap migration
-- dalam satu transaksi. Nilai yang sah dijaga CHECK di langkah (2) — yang, tidak seperti enum,
-- bisa diperlonggar kemudian tanpa ALTER TYPE.
ALTER TABLE "consignments" ADD COLUMN "returnMethod" TEXT;

-- ALAMAT PENGEMBALIAN — snapshot, bentuk SAMA PERSIS dengan "card_redemptions" (lihat kepala).
ALTER TABLE "consignments" ADD COLUMN "returnRecipientName" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnPhoneCountryCode" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnPhoneNumber" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnStreet" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnApt" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnCity" TEXT;
-- PROVINSI. Ikut menentukan TIER ONGKIR (src/payments/domestic-shipping-rate.ts): provinsi yang
-- tidak dikenali jatuh ke tier PENAMPUNG yang LEBIH MAHAL — tidak pernah gratis, tidak pernah
-- ditagih kurang.
ALTER TABLE "consignments" ADD COLUMN "returnState" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnZip" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnCountry" TEXT;

-- RESI. Tanpa nomor resi, "sudah dikirim" adalah klaim yang TIDAK BISA DIPERIKSA oleh pemilik
-- kartunya sendiri — dan dialah satu-satunya orang yang berhak memeriksanya.
ALTER TABLE "consignments" ADD COLUMN "returnCourier" TEXT;
ALTER TABLE "consignments" ADD COLUMN "returnTrackingNo" TEXT;

-- SIAPA yang mengambil kartunya di tempat (metode PICKUP). Kalimat manusia, bukan id: yang datang
-- mengambil sering BUKAN pemegang akunnya ("Ani, istri pemilik, membawa surat kuasa").
--
-- "KAPAN"-nya SENGAJA TIDAK punya kolom sendiri: itu `custodyReleasedAt`, yang sudah ada dan
-- sudah append-only. Dua tanggal untuk satu kejadian adalah dua tanggal yang suatu hari akan
-- berbeda, dan yang mana yang benar tidak akan bisa dijawab siapa pun.
ALTER TABLE "consignments" ADD COLUMN "returnPickedUpBy" TEXT;

-- SIAPA YANG MENANGGUNG ONGKIR BALIK: 'OWNER' | 'HOSHI'. DICATAT SAJA — lihat kepala file.
ALTER TABLE "consignments" ADD COLUMN "returnShippingPayer" TEXT;
-- Nominal Rupiah UTUH. Diisi operator, atau ditaksir dari tarif wilayah yang SUDAH ADA
-- (`resolveDomesticShippingIdr` atas tabel "domestic_shipping_rates"). Taksiran boleh ditimpa:
-- yang benar adalah angka di struk kurir, bukan tabel kita.
ALTER TABLE "consignments" ADD COLUMN "returnShippingFeeIdr" INTEGER;

-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ (2) BENTUK PENGEMBALIAN JADI INVARIAN DATABASE.                                            ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- BACA BENTUKNYA BAIK-BAIK: "returnMethod IS NULL OR ...". Ia TIDAK menuntut apa pun dari baris
-- yang belum punya rencana pengembalian — dan SELURUH baris yang sudah ada di produksi berbentuk
-- begitu. Itu yang membuat constraint ini tidak bisa menggagalkan migrasi di droplet.
--
-- Yang ia tegakkan adalah KONSISTENSI: begitu seseorang menyatakan sebuah cara pengembalian,
-- barisnya harus membawa bukti yang sesuai dengan cara itu. 'COURIER' tanpa alamat adalah baris
-- yang berbunyi "kartunya dikirim" tanpa bisa menyebut ke mana — persis kegagalan yang seluruh
-- migration ini dibuat untuk menutup.
--
-- APA YANG CHECK INI TIDAK BISA LAKUKAN, DAN DI MANA ATURANNYA HIDUP. Ia TIDAK bisa menuntut
-- "setiap baris RELEASED ber-alasan WITHDRAWN harus punya returnMethod": baris RELEASED yang
-- SUDAH ADA di produksi tidak punya satu pun kolom ini, jadi constraint seperti itu akan menolak
-- data lama dan menggagalkan migrasi. Aturan itu hidup di PREDIKAT KLAIM
-- `withdrawnReleaseClaimWhere()` (src/common/consignment.gate.ts), yang menyebut kolom-kolom di
-- bawah sebagai syarat `IN_CUSTODY → RELEASED` — jadi ia ditegakkan Postgres juga, hanya lewat
-- WHERE klaimnya, bukan lewat CHECK.
--
-- Nilai di luar 'PICKUP'/'COURIER' ikut DITOLAK oleh bentuk yang sama: tidak ada cabang yang
-- menerimanya. Itu peran yang biasanya dipegang enum — dipegang CHECK di sini supaya daftarnya
-- bisa diperlonggar tanpa ALTER TYPE (lihat alasannya di langkah 1).
--
-- JALANKAN PRA-CEK (P1) SEBELUM BARIS INI.
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_return_shape_chk" CHECK (
  "returnMethod" IS NULL
  OR "returnMethod" = 'PICKUP'
  OR (
    "returnMethod" = 'COURIER'
    AND "returnRecipientName" IS NOT NULL
    AND "returnPhoneNumber"   IS NOT NULL
    AND "returnStreet"        IS NOT NULL
    AND "returnCity"          IS NOT NULL
    AND "returnState"         IS NOT NULL
    AND "returnZip"           IS NOT NULL
    AND "returnCountry"       IS NOT NULL
  )
);

-- Penanggung ongkir: dua nilai, tidak lebih. Kolom bebas-isi untuk pertanyaan "siapa yang
-- membayar" akan melahirkan 'hoshi', 'Hoshi', 'kita', '-' — dan laporan yang menjumlahkannya
-- akan diam-diam salah.
--
-- JALANKAN PRA-CEK (P2) SEBELUM BARIS INI.
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_return_payer_chk" CHECK (
  "returnShippingPayer" IS NULL OR "returnShippingPayer" IN ('OWNER', 'HOSHI')
);

-- Ongkir tidak pernah negatif. 0 SENGAJA DIIZINKAN: "diambil sendiri" dan "kurir digratiskan
-- Hoshi" adalah fakta yang berbeda dari "belum dicatat" (NULL), dan keduanya harus bisa ditulis.
--
-- JALANKAN PRA-CEK (P3) SEBELUM BARIS INI.
ALTER TABLE "consignments" ADD CONSTRAINT "consignments_return_fee_chk" CHECK (
  "returnShippingFeeIdr" IS NULL OR "returnShippingFeeIdr" >= 0
);

-- ───────────────── (3) DOKUMENTASI YANG IKUT PINDAH BERSAMA DATABASE ────────────────────────
--
-- COMMENT dibaca siapa pun yang membuka tabel ini lewat psql/dbeaver tanpa repo di tangan — dan
-- pertanyaan "kenapa ada kolom ongkir di jalur yang katanya gratis" HARUS punya jawaban di sana.
COMMENT ON COLUMN "consignments"."returnMethod" IS
  'Cara kartu titipan pulang ke pemiliknya: PICKUP (diambil sendiri) | COURIER (dikirim kurir). '
  'NULL = belum diputuskan. COURIER menuntut alamat lengkap (CHECK consignments_return_shape_chk) '
  'dan resi sebelum custodyReleasedAt boleh ditulis (predikat withdrawnReleaseClaimWhere).';

COMMENT ON COLUMN "consignments"."returnShippingPayer" IS
  'Penanggung ongkir balik: OWNER | HOSHI. DICATAT SAJA — tidak ada invoice, tidak ada potongan '
  'saldo, dan penarikan kartu tetap GRATIS bagi pemiliknya. Kolom ini ada supaya ongkos yang '
  'ditanggung Hoshi berhenti jadi kebocoran yang tidak terlihat di laporan mana pun.';

COMMENT ON COLUMN "consignments"."returnShippingFeeIdr" IS
  'Ongkir balik dalam Rupiah utuh. Boleh ditaksir dari tarif wilayah yang sudah ada '
  '(domestic_shipping_rates, lewat resolveDomesticShippingIdr) dan boleh ditimpa operator — yang '
  'benar adalah angka di struk kurir. 0 sah (digratiskan / diambil sendiri); NULL = belum dicatat.';
