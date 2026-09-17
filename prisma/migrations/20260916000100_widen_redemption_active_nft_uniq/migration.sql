-- Lebarkan partial unique index anti dobel-redeem supaya mencakup SETIAP status IN-FLIGHT.
--
-- SEBELUM: WHERE status IN ('REQUESTED','PACKING','SHIPPED') -- hanya jalur record-only.
-- Akibatnya baris jalur REAL (AWAITING_PAYMENT / READY_TO_FUND / FUNDING / FUNDED /
-- BURN_SUBMITTED / IN_TRANSIT / RECLAIM_DUE / SHIP_FAILED_POST_BURN) TIDAK memblokir redemption
-- kedua untuk mint yang sama, jadi panggilan API berulang bisa mendanai kartu yang sama dua kali.
--
-- TIDAK ikut dilebarkan (sengaja, ini status SELESAI/BATAL):
--   CANCELED    -- permintaan dibatalkan, mint bebas diminta lagi.
--   DELIVERED   -- terminal sukses; kartu sudah dibakar & sampai.
--   REFUND_DUE  -- abort PRA-danai, Rupiah sedang dibalikkan; user HARUS bisa mencoba lagi.
--
-- ============================ BACA SEBELUM MENJALANKAN ============================
-- JANGAN jalankan migration ini ke database live sebelum memeriksa bentrokan. Index yang lebih
-- lebar bisa DITOLAK kalau data yang sudah ada punya lebih dari satu baris in-flight untuk
-- nftAddress yang sama (mis. dua user berbeda, atau satu user dengan satu baris lama nyangkut).
-- Periksa dulu dengan:
--
--   SELECT "nftAddress", COUNT(*) AS n, array_agg(id) AS ids, array_agg(status) AS statuses
--   FROM "card_redemptions"
--   WHERE status IN ('REQUESTED','PACKING','SHIPPED','AWAITING_PAYMENT','READY_TO_FUND',
--                    'FUNDING','FUNDED','BURN_SUBMITTED','IN_TRANSIT','RECLAIM_DUE',
--                    'SHIP_FAILED_POST_BURN')
--   GROUP BY "nftAddress" HAVING COUNT(*) > 1;
--
-- Nol baris -> aman di-apply. Ada baris -> selesaikan dulu duplikatnya SATU PER SATU (jangan
-- di-bulk-update): untuk tiap grup, sisakan baris yang benar-benar hidup dan pindahkan sisanya ke
-- status selesai yang BENAR. HATI-HATI: baris FUNDED/FUNDING/BURN_SUBMITTED berarti USDC treasury
-- SUDAH/MUNGKIN keluar (refundSafe=false) -- baris seperti itu TIDAK BOLEH di-CANCELED begitu saja;
-- selesaikan lewat RECLAIM_DUE / verifikasi ke CollectorCrypt dulu.
--
-- Gerbang anti dobel-redeem di API (ACTIVE_STATUSES, redemption.service.ts) BERDIRI SENDIRI dan
-- sudah menutup lubangnya meski index ini tidak pernah dilebarkan.
-- ==================================================================================
DROP INDEX IF EXISTS "card_redemptions_active_nft_uniq";

CREATE UNIQUE INDEX "card_redemptions_active_nft_uniq"
  ON "card_redemptions"("nftAddress")
  WHERE "status" IN (
    'REQUESTED',
    'PACKING',
    'SHIPPED',
    'AWAITING_PAYMENT',
    'READY_TO_FUND',
    'FUNDING',
    'FUNDED',
    'BURN_SUBMITTED',
    'IN_TRANSIT',
    'RECLAIM_DUE',
    'SHIP_FAILED_POST_BURN'
  );
