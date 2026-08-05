-- Kirim kartu fisik ke rumah (redeem) — RECORD-ONLY: mencatat niat + tujuan kirim, TIDAK burn/
-- transfer NFT, TIDAK menyentuh treasury. Tabel TERPISAH dari "withdrawals" (itu penarikan saldo).
-- Alamat di-snapshot penuh supaya perubahan/hapus alamat tak mengubah pesanan lama.
CREATE TYPE "RedemptionStatus" AS ENUM ('REQUESTED', 'PACKING', 'SHIPPED', 'CANCELED');

CREATE TABLE "card_redemptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "nftAddress" TEXT NOT NULL,
    "cardName" TEXT NOT NULL,
    "cardImage" TEXT,
    "cardSet" TEXT,
    "shippingAddressId" TEXT,
    "recipientName" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "street" TEXT NOT NULL,
    "apt" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT,
    "zip" TEXT NOT NULL,
    "phoneCountryCode" TEXT,
    "phoneNumber" TEXT,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'REQUESTED',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    CONSTRAINT "card_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "card_redemptions_userId_createdAt_idx" ON "card_redemptions"("userId", "createdAt");
CREATE INDEX "card_redemptions_nftAddress_idx" ON "card_redemptions"("nftAddress");

-- Anti double-ship (durable): paling banyak SATU permintaan AKTIF per kartu fisik. Partial unique
-- index menegakkan invarian di DB (bukan cuma cek aplikasi yang TOCTOU): dua POST /redemptions
-- paralel untuk nftAddress yang sama → salah satu kena P2002 → ditangani jadi error ramah.
-- WHERE status aktif → setelah CANCELED, kartu boleh diminta lagi.
CREATE UNIQUE INDEX "card_redemptions_active_nft_uniq" ON "card_redemptions"("nftAddress") WHERE "status" IN ('REQUESTED', 'PACKING', 'SHIPPED');

ALTER TABLE "card_redemptions" ADD CONSTRAINT "card_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
