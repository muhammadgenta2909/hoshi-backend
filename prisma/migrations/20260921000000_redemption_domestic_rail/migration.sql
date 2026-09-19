-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ JALUR KIRIM DOMESTIK (STOK HOSHI) — kolom rail + tabel tarif ongkir.                       ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- FAKTA PRODUK: kartu stok Hoshi disimpan FISIK oleh Hoshi di Indonesia, bukan di vault
-- CollectorCrypt. Pengirimannya paket domestik biasa: NOL NFT, NOL burn, NOL USDC treasury,
-- NOL panggilan CollectorCrypt, NOL tanda tangan wallet. Satu-satunya uang yang bergerak adalah
-- ongkir Rupiah lewat rail invoice IDRX yang SUDAH ADA (packType='SHIPPING').
--
-- AMAN DI-APPLY KE DATA YANG SUDAH ADA:
--   * "listingId" NULLABLE tanpa default → SEMUA baris lama otomatis NULL = jalur CC Vault,
--     yaitu PERSIS perilaku mereka sebelum migration ini. Nol baris berubah arti.
--   * FK-nya ON DELETE RESTRICT (bukan SET NULL) DENGAN SENGAJA: SET NULL akan menjelmakan baris
--     DOMESTIK menjadi baris yang TERLIHAT seperti jalur CC begitu listingnya dihapus — rail
--     bocor, identitas kartu hilang, dan gerbang anti-dobel kehilangan kuncinya. Efek sampingnya
--     disengaja: DELETE /admin/listings/:id akan DITOLAK selama masih ada permintaan kirim yang
--     menunjuk listing itu.
--   * "domestic_shipping_rates" tabel BARU dan KOSONG. Jalur bayar jatuh ke env
--     HOSHI_DOMESTIC_SHIPPING_FLAT_IDR, lalu ke penampung sementara di kode
--     (src/payments/domestic-shipping-rate.ts). Jadi tidak ada langkah seeding yang WAJIB.
--
-- TIDAK ADA status enum BARU di migration ini. Jalur domestik memakai status yang sudah ada
-- (REQUESTED → AWAITING_PAYMENT → PACKING → SHIPPED → DELIVERED / CANCELED), sehingga invariant
-- "setiap status pemblokir punya jalan keluar yang bisa dijalankan"
-- (src/redemption/redemption-exit-reachability.spec.ts) tetap utuh tanpa driver baru.

ALTER TABLE "card_redemptions" ADD COLUMN "listingId" TEXT;

CREATE INDEX "card_redemptions_listingId_idx" ON "card_redemptions"("listingId");

ALTER TABLE "card_redemptions"
  ADD CONSTRAINT "card_redemptions_listingId_fkey"
  FOREIGN KEY ("listingId") REFERENCES "listings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tarif ongkir domestik. Berkunci `scope`: '*' = FLAT NASIONAL (satu-satunya yang dicari hari
-- ini). Tier per-wilayah nanti ('STATE:...', 'CITY:...') masuk sebagai BARIS BARU di tabel yang
-- sama — tidak ada perubahan skema yang dibutuhkan untuk itu.
CREATE TABLE "domestic_shipping_rates" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "priceIdr" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT,
  "updatedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "domestic_shipping_rates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domestic_shipping_rates_scope_key" ON "domestic_shipping_rates"("scope");
