-- ASAL kartu di request kirim: PACK | CC_CATALOG | P2P | HOSHI. Membantu admin tahu siapa yang
-- kirim fisik (CC gudang US vs stok Hoshi sendiri). Nullable — baris lama tetap null.
ALTER TABLE "card_redemptions" ADD COLUMN "source" TEXT;
