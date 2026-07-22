-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('HOSHI', 'COLLECTORCRYPT', 'PWCC', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportThreadStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "SupportSenderType" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "vault_items" ADD COLUMN     "storageProvider" "StorageProvider" NOT NULL DEFAULT 'HOSHI',
ADD COLUMN     "vaultLocation" TEXT;

-- CreateTable
CREATE TABLE "support_threads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT,
    "listingId" TEXT,
    "status" "SupportThreadStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderType" "SupportSenderType" NOT NULL,
    "body" TEXT NOT NULL,
    "readByUser" BOOLEAN NOT NULL DEFAULT false,
    "readByAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_threads_userId_idx" ON "support_threads"("userId");

-- CreateIndex
CREATE INDEX "support_threads_status_updatedAt_idx" ON "support_threads"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "support_messages_threadId_createdAt_idx" ON "support_messages"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "vault_items_status_idx" ON "vault_items"("status");

-- CreateIndex
CREATE INDEX "vault_items_storageProvider_idx" ON "vault_items"("storageProvider");

-- AddForeignKey
ALTER TABLE "support_threads" ADD CONSTRAINT "support_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "support_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
