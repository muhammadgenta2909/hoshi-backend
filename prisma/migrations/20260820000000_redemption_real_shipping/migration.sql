-- Jalur REAL kirim-fisik (CC Vault Shipping API). ADDITIVE + idempotent — baris record-only lama
-- tetap valid; kolom/status baru cuma kepakai kalau HOSHI_CC_SHIPPING_ENABLED di-arm.

-- 1. Status baru buat RedemptionStatus (append; TIDAK dipakai di transaksi ini → aman di Postgres).
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'AWAITING_PAYMENT';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'READY_TO_FUND';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'FUNDING';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'FUNDED';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'BURN_SUBMITTED';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'IN_TRANSIT';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'DELIVERED';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'REFUND_DUE';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'RECLAIM_DUE';
ALTER TYPE "RedemptionStatus" ADD VALUE IF NOT EXISTS 'SHIP_FAILED_POST_BURN';

-- 2. Kolom jalur-real di card_redemptions (semua nullable / punya default → backfill aman).
ALTER TABLE "card_redemptions"
  ADD COLUMN IF NOT EXISTS "ccShippingAddressId" TEXT,
  ADD COLUMN IF NOT EXISTS "outboundShipmentId" TEXT,
  ADD COLUMN IF NOT EXISTS "totalCostUsdc" INTEGER,
  ADD COLUMN IF NOT EXISTS "paymentOrderId" TEXT,
  ADD COLUMN IF NOT EXISTS "fundingSignature" TEXT,
  ADD COLUMN IF NOT EXISTS "burnSignature" TEXT,
  ADD COLUMN IF NOT EXISTS "trackingIds" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "trackingUrls" TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "refundSafe" BOOLEAN NOT NULL DEFAULT true;

-- @unique(outboundShipmentId) — invariant anti dobel-burn (NULL boleh banyak).
CREATE UNIQUE INDEX IF NOT EXISTS "card_redemptions_outboundShipmentId_key" ON "card_redemptions"("outboundShipmentId");

-- 3. Tautan order ongkir Rupiah ke redemption.
ALTER TABLE "payment_orders" ADD COLUMN IF NOT EXISTS "redemptionId" TEXT;
CREATE INDEX IF NOT EXISTS "payment_orders_redemptionId_idx" ON "payment_orders"("redemptionId");
