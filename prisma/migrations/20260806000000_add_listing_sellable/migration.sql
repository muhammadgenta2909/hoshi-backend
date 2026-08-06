-- Flag `sellable`: kartu inventaris Hoshi yang BENAR-BENAR boleh dibeli. Default false supaya baris
-- seed/chart-filler & placeholder (source=HOSHI, sellerId=null = bentuk DEFAULT tiap listing) tak
-- bisa dibeli lewat jalur Hoshi-inventory. Hanya stok admin genuine yang true.
ALTER TABLE "listings" ADD COLUMN "sellable" BOOLEAN NOT NULL DEFAULT false;

-- Backfill stok Hoshi genuine yang SUDAH ada (di-upload admin/import) → boleh dijual. KECUALIkan
-- baris seed chart-filler (sellerAddress='seed-admin') supaya kartu hantu tak jadi buyable.
UPDATE "listings"
SET "sellable" = true
WHERE "source" = 'HOSHI'
  AND "sellerId" IS NULL
  AND "sellerAddress" <> 'seed-admin';
