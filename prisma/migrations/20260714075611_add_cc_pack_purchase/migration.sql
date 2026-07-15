-- CreateEnum
CREATE TYPE "CcPackStatus" AS ENUM ('GENERATED', 'SUBMITTING', 'SUBMITTED', 'OPENED', 'BOUGHT_BACK', 'FAILED');

-- CreateTable
CREATE TABLE "cc_pack_purchases" (
    "id" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "playerAddress" TEXT NOT NULL,
    "packType" TEXT NOT NULL,
    "turbo" BOOLEAN NOT NULL DEFAULT false,
    "status" "CcPackStatus" NOT NULL DEFAULT 'GENERATED',
    "priceUsdc" INTEGER,
    "purchaseSignature" TEXT,
    "openSignature" TEXT,
    "rarity" TEXT,
    "nftAddress" TEXT,
    "nftName" TEXT,
    "roll" TEXT,
    "points" INTEGER,
    "buybackAmountUsdc" INTEGER,
    "buybackSignature" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "openedAt" TIMESTAMP(3),

    CONSTRAINT "cc_pack_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cc_pack_purchases_memo_key" ON "cc_pack_purchases"("memo");

-- CreateIndex
CREATE INDEX "cc_pack_purchases_userId_idx" ON "cc_pack_purchases"("userId");

-- CreateIndex
CREATE INDEX "cc_pack_purchases_status_idx" ON "cc_pack_purchases"("status");

-- AddForeignKey
ALTER TABLE "cc_pack_purchases" ADD CONSTRAINT "cc_pack_purchases_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
