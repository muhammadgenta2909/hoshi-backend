-- Tautan order → offer untuk memisahkan rail bayar-offer (harga offer) dari rail beli-langsung
-- (harga listing) pada listing yang sama. Kritis buat idempotensi harga; lihat komentar schema.
ALTER TABLE "payment_orders" ADD COLUMN "offerId" TEXT;

CREATE INDEX "payment_orders_offerId_idx" ON "payment_orders"("offerId");
