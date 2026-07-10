-- CreateEnum
CREATE TYPE "ActivityType" AS ENUM ('OFFER_MADE', 'OFFER_CANCELED', 'OFFER_ACCEPTED', 'OFFER_REJECTED', 'SALE_CARD', 'LISTED_CARD', 'LISTING_CANCELED', 'SEND_TO_VAULT', 'SEND_TO_HOME');

-- AlterEnum
ALTER TYPE "OfferStatus" ADD VALUE 'CANCELED';

-- AlterTable
ALTER TABLE "offers" ADD COLUMN     "buyerId" TEXT;

-- CreateTable
CREATE TABLE "activities" (
    "id" TEXT NOT NULL,
    "type" "ActivityType" NOT NULL,
    "listingId" TEXT,
    "itemName" TEXT NOT NULL,
    "itemImage" TEXT,
    "category" TEXT,
    "amount" INTEGER,
    "fromId" TEXT,
    "fromLabel" TEXT,
    "toId" TEXT,
    "toLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activities_fromId_createdAt_idx" ON "activities"("fromId", "createdAt");

-- CreateIndex
CREATE INDEX "activities_toId_createdAt_idx" ON "activities"("toId", "createdAt");

-- CreateIndex
CREATE INDEX "activities_listingId_idx" ON "activities"("listingId");

-- CreateIndex
CREATE INDEX "offers_buyerId_idx" ON "offers"("buyerId");

-- AddForeignKey
ALTER TABLE "offers" ADD CONSTRAINT "offers_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activities" ADD CONSTRAINT "activities_toId_fkey" FOREIGN KEY ("toId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
