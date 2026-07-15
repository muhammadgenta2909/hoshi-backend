-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FULFILLING', 'FULFILLED', 'EXPIRED', 'FAILED', 'REFUND_DUE');

-- CreateTable
CREATE TABLE "payment_orders" (
    "id" TEXT NOT NULL,
    "merchantOrderId" TEXT NOT NULL,
    "idrxRequestId" TEXT,
    "reference" TEXT,
    "userId" TEXT NOT NULL,
    "packType" TEXT NOT NULL,
    "priceIdr" INTEGER NOT NULL,
    "priceUsdc" INTEGER NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "qrContent" TEXT,
    "virtualAccountNo" TEXT,
    "paymentUrl" TEXT,
    "expiresAt" TIMESTAMP(3),
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "idrxPaymentStatus" TEXT,
    "idrxUserMintStatus" TEXT,
    "txHash" TEXT,
    "packMemo" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "fulfilledAt" TIMESTAMP(3),

    CONSTRAINT "payment_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_merchantOrderId_key" ON "payment_orders"("merchantOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_orders_packMemo_key" ON "payment_orders"("packMemo");

-- CreateIndex
CREATE INDEX "payment_orders_status_idx" ON "payment_orders"("status");

-- CreateIndex
CREATE INDEX "payment_orders_userId_idx" ON "payment_orders"("userId");

-- AddForeignKey
ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
