-- CreateEnum
CREATE TYPE "VaultStatus" AS ENUM ('STORED', 'MINTING', 'MINTED', 'REDEEMED');

-- CreateEnum
CREATE TYPE "NftStatus" AS ENUM ('MINTED', 'TRANSFERRED', 'BURNED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "nonce" TEXT,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "set" TEXT,
    "rarity" TEXT,
    "attributes" JSONB,
    "metadataUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfts" (
    "id" TEXT NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "mintTx" TEXT,
    "metadataUri" TEXT,
    "name" TEXT,
    "status" "NftStatus" NOT NULL DEFAULT 'MINTED',
    "cardId" TEXT,
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nfts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vault_items" (
    "id" TEXT NOT NULL,
    "serialNumber" TEXT,
    "status" "VaultStatus" NOT NULL DEFAULT 'STORED',
    "cardId" TEXT NOT NULL,
    "ownerId" TEXT,
    "nftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vault_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_walletAddress_key" ON "users"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "nfts_assetAddress_key" ON "nfts"("assetAddress");

-- CreateIndex
CREATE INDEX "nfts_ownerAddress_idx" ON "nfts"("ownerAddress");

-- CreateIndex
CREATE UNIQUE INDEX "vault_items_serialNumber_key" ON "vault_items"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "vault_items_nftId_key" ON "vault_items"("nftId");

-- AddForeignKey
ALTER TABLE "nfts" ADD CONSTRAINT "nfts_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nfts" ADD CONSTRAINT "nfts_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_nftId_fkey" FOREIGN KEY ("nftId") REFERENCES "nfts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
