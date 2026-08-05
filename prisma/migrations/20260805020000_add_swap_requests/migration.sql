-- Ajakan tukar kartu (swap) — RECORD-ONLY: mencatat ajakan + kartu yang ditawarkan + tujuan kontak.
-- TIDAK transfer/burn kartu, TIDAK menyentuh treasury. Kartu di-snapshot (nama/gambar).
CREATE TYPE "SwapStatus" AS ENUM ('REQUESTED', 'CANCELED');

CREATE TABLE "swap_requests" (
    "id" TEXT NOT NULL,
    "proposerId" TEXT NOT NULL,
    "offeredNftAddress" TEXT NOT NULL,
    "offeredCardName" TEXT NOT NULL,
    "offeredCardImage" TEXT,
    "recipientMethod" TEXT NOT NULL,
    "recipientValue" TEXT NOT NULL,
    "status" "SwapStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "swap_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "swap_requests_proposerId_createdAt_idx" ON "swap_requests"("proposerId", "createdAt");

ALTER TABLE "swap_requests" ADD CONSTRAINT "swap_requests_proposerId_fkey" FOREIGN KEY ("proposerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
