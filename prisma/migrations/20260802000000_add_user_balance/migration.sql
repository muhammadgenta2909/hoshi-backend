-- Saldo in-app (Rupiah) per user — dikreditkan saat kartu user terjual (Flow B P2P).
ALTER TABLE "users" ADD COLUMN "balanceIdrx" BIGINT NOT NULL DEFAULT 0;

-- Ledger mutasi saldo (append-only; audit tiap kredit/debit).
CREATE TABLE "balance_entries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deltaIdrx" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "refId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "balance_entries_pkey" PRIMARY KEY ("id")
);

-- Idempotensi: (reason, refId) unik → callback/reconciler diulang tak menggandakan kredit.
-- (refId NULL diperlakukan distinct oleh Postgres, jadi entri tanpa refId tetap boleh banyak.)
CREATE UNIQUE INDEX "balance_entries_reason_refId_key" ON "balance_entries"("reason", "refId");
CREATE INDEX "balance_entries_userId_idx" ON "balance_entries"("userId");

ALTER TABLE "balance_entries" ADD CONSTRAINT "balance_entries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
