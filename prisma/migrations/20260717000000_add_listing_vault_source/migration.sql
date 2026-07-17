-- CreateEnum
CREATE TYPE "ListingSource" AS ENUM ('HOSHI', 'COLLECTORCRYPT');

-- AlterTable
ALTER TABLE "listings" ADD COLUMN     "ccHasBuyback" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ccNftAddress" TEXT,
ADD COLUMN     "ccPriceUsd" DOUBLE PRECISION,
ADD COLUMN     "ccSyncedAt" TIMESTAMP(3),
ADD COLUMN     "source" "ListingSource" NOT NULL DEFAULT 'HOSHI';

-- CreateIndex
CREATE UNIQUE INDEX "listings_ccNftAddress_key" ON "listings"("ccNftAddress");

-- CreateIndex
CREATE INDEX "listings_source_idx" ON "listings"("source");
