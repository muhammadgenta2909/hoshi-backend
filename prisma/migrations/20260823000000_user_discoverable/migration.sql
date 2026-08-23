-- Flag discoverable di profil user: profil ikut hasil pencarian/discovery user lain.
-- ADDITIVE + idempotent — baris user lama tetap valid; default false = opt-in eksplisit
-- (privasi aman by default) → backfill baris eksisting aman.
-- Nama tabel = "users" (User model @@map("users")).

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "discoverable" BOOLEAN NOT NULL DEFAULT false;
