-- ══════════════════════════════════════════════════════════════════════════════════════════════
--  F1 + F3 — POPULASI YANG LOLOS DARI SEMUA PAGAR, DAN PLAFON YANG BISA DILEWATI BERSAMAAN.
--
--  Migration ini TIDAK MENGUBAH SATU BARIS DATA PUN. Ia mengganti satu indeks parsial, menambah
--  satu indeks biasa, dan menempelkan COMMENT (termasuk RUNBOOK operator di bawah). Aman
--  dijalankan kapan saja.
--
--  Alasan "kenapa tidak ada UPDATE di sini" persis sama dengan migration 20260918000100 dan tidak
--  diulang: SQL tidak bisa membaca env, kartu tidak bisa di-escrow tanpa tanda tangan penjual, dan
--  membatalkan listing orang lain secara massal tidak bisa dibatalkan. Gerbangnya RUNTIME.
-- ══════════════════════════════════════════════════════════════════════════════════════════════


-- ── F1 ────────────────────────────────────────────────────────────────────────────────────────
--  Indeks lama (listings_unescrowed_user_idx, dibuat 20260918000100) menuntut
--  "ccNftAddress" IS NOT NULL. Itu SALAH, dan salahnya sejalan dengan bug-nya: predikat
--  "tidak escrow-backed" yang benar untuk listing USER adalah
--
--      "sellerId" IS NOT NULL AND ("ccNftAddress" IS NULL OR "escrowedAt" IS NULL)
--
--  Settlement ARMED hanya bisa menyerahkan "ccNftAddress" DARI escrow, jadi baris user TANPA aset
--  on-chain sama tidak-bisa-diselesaikannya dengan baris yang belum dititipkan — dan jauh lebih
--  mudah dibuat (POST /marketplace tanpa fromPackMemo, nol prasyarat selain login). Dengan indeks
--  & predikat lama, baris seperti itu tidak ditolak, tetap tampil di feed publik, tidak ditandai
--  kepada pemiliknya, dan TIDAK IKUT DIHITUNG di angka radius-ledakan yang dibaca operator
--  sebelum menyalakan HOSHI_P2P_ENABLED.
DROP INDEX IF EXISTS "listings_unescrowed_user_idx";

CREATE INDEX "listings_unescrowed_user_idx"
  ON "listings" ("status")
  WHERE "sellerId" IS NOT NULL
    AND ("ccNftAddress" IS NULL OR "escrowedAt" IS NULL);

COMMENT ON INDEX "listings_unescrowed_user_idx" IS
  'Menopang gerbang B: saat HOSHI_P2P_ENABLED menyala, listing USER yang TIDAK escrow-backed tidak boleh muncul sebagai bisa-dibeli. "Escrow-backed" butuh DUA fakta — ccNftAddress ADA (ada yang bisa diserahkan) DAN escrowedAt ADA (escrow terbukti memegangnya); kurang salah satu berarti settlement PASTI gagal SESUDAH pembeli membayar. Predikat tunggalnya hidup di src/marketplace/p2p.gate.ts (isEscrowBackedUserListing / unescrowedUserListingWhere) dan indeks ini adalah terjemahan SQL dari negasinya. Baris-baris ini dikecualikan dari feed publik dan ditolak di semua jalur penerbitan tagihan.';


-- ── F3 ────────────────────────────────────────────────────────────────────────────────────────
--  Menopang agregat "kewajiban terutang" (issued tapi belum consumed) yang sekarang dikurangkan
--  dari saldo SOL escrow sebelum cadangan diperiksa. Query itu berjalan DI DALAM transaksi yang
--  memegang kunci serialisasi sponsor, jadi ia harus murah: selama transaksi itu berjalan, tidak
--  ada keputusan sponsor lain yang bisa jalan.
CREATE INDEX IF NOT EXISTS "escrow_fee_sponsorships_consumedAt_issuedAt_idx"
  ON "escrow_fee_sponsorships" ("consumedAt", "issuedAt");

COMMENT ON TABLE "escrow_fee_sponsorships" IS
  'Ledger sponsor gas escrow. SEMUA keputusan plafon (per-penjual 24 jam, global 24 jam, dan cadangan SOL escrow) diserialkan dengan pg_advisory_xact_lock(826100918) yang diambil sebagai pernyataan PERTAMA di dalam transaksi yang membaca agregat DAN menulis barisnya. Kunci ber-cakupan TRANSAKSI (bukan sesi) supaya aman di bawah connection pooling mode-transaksi dan dilepas otomatis kalau prosesnya mati. JANGAN menambah jalur tulis ke tabel ini yang tidak mengambil kunci itu: bentuk baca-lalu-tulis tanpa kunci membuat N permintaan bersamaan membaca total yang SAMA dan melewati ketiga plafon sekaligus.';

COMMENT ON COLUMN "escrow_fee_sponsorships"."consumedAt" IS
  'NULL = sponsorship SUDAH kami tandatangani tapi transaksinya belum disiarkan penjual. Baris seperti ini adalah KEWAJIBAN HIDUP: transaksinya ada di tangan penjual dan bisa disiarkan kapan saja selama blockhash-nya berlaku, jadi lamports-nya dikurangkan dari saldo SOL escrow sebelum preflight cadangan. Plafon 24 jam TETAP dihitung dari issuedAt (bukan consumedAt) — menghitung yang "terpakai" saja akan mengecilkan paparan.';


-- ══════════════════════════════════════════════════════════════════════════════════════════════
--  RUNBOOK OPERATOR — HARI MENYALAKAN HOSHI_P2P_ENABLED. Menggantikan versi sebelumnya.
--
--  Repo ini tidak punya file runbook; prosedurnya hidup di sini supaya ia ikut terbaca operator
--  langsung dari database (\d+ listings / COMMENT) dan tidak bisa hilang bersama satu refactor.
-- ══════════════════════════════════════════════════════════════════════════════════════════════
--
--  ── 0. PRA-CEK (JALANKAN SEBELUM DEPLOY, LALU SEBELUM MENYALAKAN FLAG) ───────────────────────
--
--  0a. RADIUS LEDAKAN — berapa listing yang akan langsung hilang dari feed publik. Angka yang
--      SAMA dipakai GET /admin/escrow/overview → unescrowedActiveCount. Sejak pass ini ia
--      MENCAKUP listing user tanpa aset on-chain (yang dulu tidak terhitung), jadi angkanya akan
--      NAIK dibanding yang pernah dilihat operator — itu koreksi, bukan regresi:
--
--        SELECT count(*) FILTER (WHERE "ccNftAddress" IS NOT NULL) AS bisa_dipulihkan_relist,
--               count(*) FILTER (WHERE "ccNftAddress" IS NULL)     AS harus_dibatalkan,
--               count(*)                                           AS total
--        FROM "listings"
--        WHERE "status" = 'ACTIVE'
--          AND "sellerId" IS NOT NULL
--          AND ("ccNftAddress" IS NULL OR "escrowedAt" IS NULL);
--
--  0b. INVOICE YANG MASIH HIDUP UNTUK LISTING SEPERTI ITU — INI YANG PALING MUDAH TERLEWAT.
--      Gerbang baru menolak SEBELUM tagihan terbit, tapi order yang dibuat SEBELUM deploy ini
--      sudah memegang paymentUrl IDRX yang MASIH BISA DIBAYAR. Pembayaran yang mendarat setelah
--      deploy tetap jatuh ke REFUND_DUE (refund-safe, kartu tidak bergerak, penjual tidak
--      dikredit) — tapi uang pembeli sungguhan sudah berpindah dan harus di-refund manual.
--      Cari & kabari pembelinya SEBELUM menyalakan flag:
--
--        SELECT po."merchantOrderId", po."userId" AS pembeli, po."priceIdr", po."status",
--               po."expiresAt", po."paymentUrl" IS NOT NULL AS punya_link_bayar,
--               l."id" AS listing, l."sellerId" AS penjual,
--               l."ccNftAddress", l."escrowedAt"
--        FROM "payment_orders" po
--        JOIN "listings" l ON l."id" = po."listingId"
--        WHERE po."status" IN ('PENDING', 'PAID', 'FULFILLING')
--          AND l."sellerId" IS NOT NULL
--          AND (l."ccNftAddress" IS NULL OR l."escrowedAt" IS NULL)
--        ORDER BY po."createdAt";
--
--      Tindakan: minta pembeli JANGAN membayar link itu (ia tidak bisa diselesaikan). Order yang
--      terlanjur dibayar muncul sebagai REFUND_DUE dengan refundSafe = true → refund manual.
--      JANGAN meng-EXPIRE order yang invoice IDRX-nya masih hidup: EXPIRED itu terminal dan tidak
--      direkonsiliasi, jadi pembayaran yang telat mendarat akan hilang diam-diam.
--
--  ── 1. PEMULIHAN UNTUK PENJUAL (SATU AKSI) ───────────────────────────────────────────────────
--
--  YANG BERUBAH DI PASS INI: `POST /marketplace/:id/relist` DULU menuntut buyerId = pemanggil,
--  padahal create() TIDAK PERNAH mengisi buyerId — jadi untuk listing yang dibuat-dan-belum-
--  pernah-terjual (yaitu SELURUH populasi di atas) ia selalu menjawab 400 "Only the owner can
--  list this card." Prosedur lama (cancel → POST /marketplace dengan fromPackMemo) juga
--  menjalankan ULANG ccListingAttrs() dan bisa gagal 422 kalau CollectorCrypt lambat atau
--  grade-nya tidak didukung — gagal karena sebab yang tidak ada hubungannya dengan escrow.
--
--    • Listing user ACTIVE dengan ccNftAddress ADA tapi escrowedAt NULL
--        → `POST /marketplace/:id/relist` (SATU aksi). Listing pindah ke PENDING_ESCROW dan
--          penjual diminta menandatangani transfer→escrow. TIDAK menyentuh CollectorCrypt sama
--          sekali, jadi tidak bisa gagal karena CC lambat. Pemiliknya adalah penjual selama
--          buyerId masih NULL; untuk baris yang PERNAH terjual pemiliknya tetap pembeli.
--
--    • Listing user dengan ccNftAddress NULL
--        → TIDAK ADA jalur escrow: tak ada kartu on-chain untuk dititipkan. relist menjawab
--          409 P2P_LISTING_NOT_ESCROWED dengan kalimat itu. Satu-satunya tindakan yang benar:
--          `POST /marketplace/:id/cancel`. Kartunya tidak pernah bergerak — cancel hanya menutup
--          listing-nya.
--
--  ── 2. APA YANG DILIHAT PEMBELI & PENJUAL SETELAH FLAG MENYALA ───────────────────────────────
--
--    • Feed publik (GET /marketplace) MENGECUALIKAN seluruh populasi di atas.
--    • Pemiliknya TETAP melihat listing-nya di /me/listings, ditandai `needsEscrowDeposit: true`.
--      DTO yang sama membawa `ccNftAddress`: ADA ⇒ tombolnya "pajang ulang" (relist);
--      NULL ⇒ tombolnya "tarik listing" (cancel) — JANGAN tawarkan relist di sana, ia akan 409.
--    • Setiap jalur yang menerbitkan kewajiban (beli, tawar, terima tawaran) menolak dengan
--      kode P2P_LISTING_NOT_ESCROWED, stage NO_EFFECT: NOL Rupiah diambil.
--
--  ── 3. SPONSOR GAS: APA YANG TERJADI KALAU IA TIDAK BISA BERJALAN ────────────────────────────
--
--    Sejak pass ini, sponsor yang tidak bisa berjalan (kuota penuh, saldo escrow tipis, fee tak
--    terbaca) TIDAK LAGI memblokir penjual yang memang punya SOL: transaksinya dibangun ulang
--    dengan PENJUAL sebagai fee payer, tanpa tanda tangan escrow dan tanpa baris ledger. Penjual
--    yang saldonya tidak cukup tetap menerima sebab sponsor yang sebenarnya (429 SPONSOR_QUOTA /
--    503 SPONSOR_UNAVAILABLE), bukan kegagalan simulasi yang membingungkan.
--
--    Pantau kesehatan sponsor (angka ini sekarang PLAFON YANG DIJAMIN, bukan perkiraan):
--
--      SELECT sum("feeLamports")                                  AS diterbitkan_24j,
--             sum("feeLamports") FILTER (WHERE "consumedAt" IS NULL) AS terutang_belum_disiarkan,
--             count(*)                                            AS transaksi_24j
--      FROM "escrow_fee_sponsorships"
--      WHERE "issuedAt" >= now() - interval '24 hours';
-- ══════════════════════════════════════════════════════════════════════════════════════════════
