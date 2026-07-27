-- CreateEnum
CREATE TYPE "TreasurySwapStatus" AS ENUM ('QUOTED', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'NEEDS_CHECK');

-- CreateTable
CREATE TABLE "treasury_swaps" (
    "id" TEXT NOT NULL,
    "idrxBaseUnits" BIGINT NOT NULL,
    "quotedUsdcBaseUnits" BIGINT NOT NULL,
    "minUsdcBaseUnits" BIGINT NOT NULL,
    "receivedUsdcBaseUnits" BIGINT,
    "rateIdrPerUsdc" INTEGER,
    "priceImpactBps" INTEGER,
    "slippageBps" INTEGER NOT NULL,
    "signature" TEXT,
    "status" "TreasurySwapStatus" NOT NULL DEFAULT 'QUOTED',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "treasury_swaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "treasury_swap_lock" (
    "id" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,

    CONSTRAINT "treasury_swap_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "treasury_swaps_signature_key" ON "treasury_swaps"("signature");

-- CreateIndex
CREATE INDEX "treasury_swaps_status_idx" ON "treasury_swaps"("status");

-- CreateIndex
CREATE INDEX "treasury_swaps_createdAt_idx" ON "treasury_swaps"("createdAt");

