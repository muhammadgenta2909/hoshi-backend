-- Link marketplace purchases to the NFT minted for the buyer.
ALTER TABLE "listings" ADD COLUMN "nftId" TEXT;

CREATE UNIQUE INDEX "listings_nftId_key" ON "listings"("nftId");
CREATE INDEX "listings_buyerId_idx" ON "listings"("buyerId");

ALTER TABLE "listings" ADD CONSTRAINT "listings_nftId_fkey" FOREIGN KEY ("nftId") REFERENCES "nfts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
