-- CreateEnum
CREATE TYPE "MarketThreadStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "MarketSenderType" AS ENUM ('BUYER', 'SELLER');

-- CreateTable
CREATE TABLE "market_threads" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "status" "MarketThreadStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderType" "MarketSenderType" NOT NULL,
    "body" TEXT NOT NULL,
    "readByBuyer" BOOLEAN NOT NULL DEFAULT false,
    "readBySeller" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "market_threads_buyerId_idx" ON "market_threads"("buyerId");

-- CreateIndex
CREATE INDEX "market_threads_sellerId_idx" ON "market_threads"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "market_threads_listingId_buyerId_key" ON "market_threads"("listingId", "buyerId");

-- CreateIndex
CREATE INDEX "market_messages_threadId_createdAt_idx" ON "market_messages"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "market_threads" ADD CONSTRAINT "market_threads_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_threads" ADD CONSTRAINT "market_threads_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_threads" ADD CONSTRAINT "market_threads_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "market_messages" ADD CONSTRAINT "market_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "market_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
