-- Penerimaan paket domestik: tombol "Pesanan Diterima" + konfirmasi otomatis 7 hari.
-- Semua kolom NULLABLE dan ditambah dengan IF NOT EXISTS → aman untuk tabel yang sudah berisi,
-- tidak bisa ditolak oleh data yang ada.
ALTER TABLE "card_redemptions" ADD COLUMN IF NOT EXISTS "shippedAt" TIMESTAMP(3);
ALTER TABLE "card_redemptions" ADD COLUMN IF NOT EXISTS "deliveredAt" TIMESTAMP(3);
ALTER TABLE "card_redemptions" ADD COLUMN IF NOT EXISTS "deliveredBy" TEXT;

-- Baris yang SUDAH SHIPPED sebelum kolom ini ada: pakai updatedAt sebagai perkiraan waktu kirim,
-- supaya mereka juga ikut aturan 7 hari (bukan menggantung selamanya).
UPDATE "card_redemptions" SET "shippedAt" = "updatedAt"
  WHERE "status" = 'SHIPPED' AND "shippedAt" IS NULL AND "listingId" IS NOT NULL;
