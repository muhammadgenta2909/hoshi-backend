-- ╔════════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ ANTI DOBEL-KIRIM untuk kartu STOK HOSHI: partial unique index pada (listingId).            ║
-- ╚════════════════════════════════════════════════════════════════════════════════════════════╝
--
-- MASALAHNYA. Gerbang anti-dobel yang sudah ada, "card_redemptions_active_nft_uniq", berkunci
-- (nftAddress). Kartu stok Hoshi TIDAK punya alamat NFT — settlement-nya database-only
-- (fulfilHoshiInventory: "nol on-chain"). Kode menuliskan turunan deterministik
-- `hoshi-listing:<listingId>` ke kolom itu, sehingga index yang sudah ada SUDAH berlaku untuk
-- jalur domestik. Index di bawah adalah LAPIS KEDUA pada kunci yang SEBENARNYA (id listing),
-- supaya properti "satu kartu fisik tidak bisa punya dua permintaan kirim aktif" tidak
-- bergantung pada bentuk string turunan itu bertahan selamanya.
--
-- DAFTAR STATUS-nya PERSIS SAMA dengan card_redemptions_active_nft_uniq (migration
-- 20260916000100) — yaitu ACTIVE_STATUSES di src/redemption/redemption.service.ts. Kalau daftar
-- itu dilebarkan lagi, KEDUA index ini harus dilebarkan bersama.
--
-- BARIS JALUR CC TIDAK TERSENTUH: listingId mereka NULL, dan di Postgres NULL tidak pernah
-- bentrok di unique index (dua baris NULL selalu dianggap berbeda).
--
-- ============================ AMAN DI-APPLY TANPA PEMERIKSAAN ============================
-- Kolom "listingId" baru saja ditambahkan (migration 20260921000000) dan belum pernah ditulis
-- oleh kode mana pun, jadi SETIAP baris yang sudah ada bernilai NULL → nol kemungkinan bentrok.
-- Kalau migration ini karena sesuatu dijalankan terlambat (sesudah jalur domestik dipakai),
-- periksa dulu dengan:
--
--   SELECT "listingId", COUNT(*) AS n, array_agg(id) AS ids, array_agg(status) AS statuses
--   FROM "card_redemptions"
--   WHERE "listingId" IS NOT NULL
--     AND status IN ('REQUESTED','PACKING','SHIPPED','AWAITING_PAYMENT','READY_TO_FUND',
--                    'FUNDING','FUNDED','BURN_SUBMITTED','IN_TRANSIT','RECLAIM_DUE',
--                    'SHIP_FAILED_POST_BURN')
--   GROUP BY "listingId" HAVING COUNT(*) > 1;
--
-- Nol baris -> aman. Ada baris -> selesaikan SATU PER SATU (jangan bulk-update): sisakan baris
-- yang benar-benar hidup, pindahkan sisanya ke status selesai yang BENAR. Baris DOMESTIK tidak
-- pernah membawa USDC (tidak ada pendanaan di jalur ini), jadi yang perlu dicek cuma ongkir
-- Rupiah-nya: order SHIPPING yang sudah PAID/FULFILLED wajib jadi utang refund yang TERCATAT.
-- ========================================================================================
CREATE UNIQUE INDEX "card_redemptions_active_listing_uniq"
  ON "card_redemptions"("listingId")
  WHERE "listingId" IS NOT NULL
    AND "status" IN (
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
