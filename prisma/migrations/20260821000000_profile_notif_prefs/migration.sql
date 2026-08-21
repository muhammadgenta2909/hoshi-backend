-- Preferensi notifikasi di profil user (BUKAN uang). ADDITIVE + idempotent — baris user lama
-- tetap valid; kolom baru punya default aman (aktif) → backfill baris eksisting aman.
-- Nama tabel = "users" (User model @@map("users")).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "notifyOffers" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "notifyOfferThreshold" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "notifyMessages" BOOLEAN NOT NULL DEFAULT true;
