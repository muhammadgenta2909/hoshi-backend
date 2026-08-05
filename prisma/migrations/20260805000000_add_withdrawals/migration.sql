-- Tarik saldo penjual (payout manual): enum status + tabel withdrawals.
-- Saat request dibuat, saldo langsung di-debit (hold); admin transfer manual lalu tandai PAID;
-- kalau ditolak, saldo dikembalikan (credit refund). Lihat model Withdrawal di schema.prisma.
CREATE TYPE "WithdrawalStatus" AS ENUM ('REQUESTED', 'PAID', 'REJECTED');

CREATE TABLE "withdrawals" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amountIdr" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "destBank" TEXT NOT NULL,
    "destAccount" TEXT NOT NULL,
    "destName" TEXT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "withdrawals_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "withdrawals_userId_idx" ON "withdrawals"("userId");
CREATE INDEX "withdrawals_status_idx" ON "withdrawals"("status");

ALTER TABLE "withdrawals" ADD CONSTRAINT "withdrawals_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
