-- Order MARKETPLACE (reseller kartu CollectorCrypt): tautan ke Listing yang dibeli.
--
-- NULLABLE tanpa DEFAULT: order pack gacha yang sudah ada tetap NULL (bukan marketplace),
-- dan itu memang jawaban yang benar. Aman untuk baris lama. Saat fulfilment,
-- `listingId IS NOT NULL` mengarahkan ke jalur settlement reseller (treasury beli di CC
-- lalu transfer ke pembeli), bukan gacha.purchase(). Index dipakai untuk memindai order
-- per-listing (mis. cek order menggantung untuk sebuah listing).
ALTER TABLE "payment_orders" ADD COLUMN "listingId" TEXT;

CREATE INDEX "payment_orders_listingId_idx" ON "payment_orders"("listingId");
