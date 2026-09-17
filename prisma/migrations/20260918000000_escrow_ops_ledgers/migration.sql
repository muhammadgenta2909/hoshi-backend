-- ══════════════════════════════════════════════════════════════════════════════════════════════
--  DUA LEDGER OPERASIONAL ESCROW (Flow B / P2P). ADITIF MURNI: dua tabel baru + satu enum baru.
--  TIDAK menyentuh satu baris data pun, TIDAK mengubah kolom mana pun, TIDAK mengambil kunci
--  penulisan pada tabel yang sudah ada. Aman dijalankan kapan saja SEBELUM HOSHI_P2P_ENABLED
--  dinyalakan — dan WAJIB dijalankan sebelum itu (lihat "URUTAN" di bawah).
--
--  URUTAN YANG WAJIB DIPATUHI OPERATOR:
--    1. deploy kode ini,
--    2. jalankan migration ini,
--    3. danai wallet escrow dengan SOL (lihat plafon di EscrowService.sponsorCaps),
--    4. BARU HOSHI_P2P_ENABLED=true.
--  Kalau (4) dijalankan sebelum (2): jalur sponsor gas escrow akan MENOLAK (tabelnya belum ada)
--  dan tidak ada penjual yang bisa menitipkan kartu. Itu gagal-TERTUTUP (tak ada uang bergerak),
--  bukan gagal-terbuka — tapi tetap berarti fitur mati total.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- ── 1. escrow_fee_sponsorships — PLAFON GAS YANG SELAMAT DARI RESTART ────────────────────────
-- Wallet escrow membayar fee jaringan untuk transaksi transfer→escrow milik PENJUAL (fee payer
-- terpisah dari authority: penjual tetap menandatangani sebagai pemilik kartu). Fee itu kecil per
-- transaksi tapi TAK TERBATAS secara agregat kalau tidak diplafon, dan menerbitkan listing itu
-- gratis + bisa diulang — jadi ia target empuk.
--
-- Plafon dihitung dari KOLOM issuedAt (kewajiban yang kami TERBITKAN), bukan dari consumedAt
-- (yang benar-benar tayang). Alasannya menentukan: transaksi yang sudah kami tandatangani ada di
-- tangan penjual dan bisa ia siarkan sendiri kapan saja selama blockhash-nya berlaku — menghitung
-- yang "terpakai" saja akan MENGECILKAN paparan. Fail-closed, pola yang sama dengan
-- TreasuryService.fundUsdc yang menghitung plafon 24 jam dari ledger, bukan dari memori proses.
CREATE TABLE "escrow_fee_sponsorships" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "sellerId" TEXT NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "feeLamports" INTEGER NOT NULL,
    "signature" TEXT,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "escrow_fee_sponsorships_pkey" PRIMARY KEY ("id")
);

-- @unique pada signature: kalaupun dua jalur entah bagaimana menyiarkan transaksi yang sama,
-- hanya satu baris yang bisa mengklaimnya (pola yang sama dengan treasury_swaps.signature).
CREATE UNIQUE INDEX "escrow_fee_sponsorships_signature_key" ON "escrow_fee_sponsorships"("signature");
-- Indeks plafon global 24 jam.
CREATE INDEX "escrow_fee_sponsorships_issuedAt_idx" ON "escrow_fee_sponsorships"("issuedAt");
-- Indeks plafon PER-PENJUAL 24 jam (rem anti-Sybil: identitas di sistem ini gratis).
CREATE INDEX "escrow_fee_sponsorships_sellerId_issuedAt_idx" ON "escrow_fee_sponsorships"("sellerId", "issuedAt");
CREATE INDEX "escrow_fee_sponsorships_listingId_idx" ON "escrow_fee_sponsorships"("listingId");

COMMENT ON TABLE "escrow_fee_sponsorships" IS
  'Ledger sponsor gas escrow (Flow B). Satu baris per transaksi transfer-ke-escrow yang fee jaringannya ditanggung wallet escrow Hoshi. Plafon per-transaksi / per-penjual-24-jam / global-24-jam dihitung dari tabel ini memakai issuedAt (KEWAJIBAN yang diterbitkan), BUKAN consumedAt — transaksi yang sudah ditandatangani bisa disiarkan penjual sendiri. Lihat EscrowService.buildSponsoredTransferToEscrowTx.';
COMMENT ON COLUMN "escrow_fee_sponsorships"."feeLamports" IS
  'PLAFON fee (lamports) yang ditanggung untuk transaksi ini, dibaca dari getFeeForMessage SEBELUM tanda tangan. Melewati plafon per-transaksi = ditolak pra-broadcast (nol lamport bergerak).';
COMMENT ON COLUMN "escrow_fee_sponsorships"."consumedAt" IS
  'Diisi saat transaksi benar-benar disiarkan & escrow terbukti memegang kartunya. TIDAK dipakai untuk menghitung plafon (lihat komentar tabel).';

-- ── 2. escrow_recoveries — JEJAK AUDIT PEMULIHAN MANUAL ──────────────────────────────────────
-- Sebelum ini, kegagalan mengembalikan kartu dari escrow ke penjual hanya menulis "cek on-chain
-- dan kembalikan manual" ke log — dan log droplet dirotasi. Aksi pemulihannya sendiri tidak ada.
-- Tabel ini adalah paruh DURABEL-nya: siapa, kapan, kartu mana, ke wallet mana, dengan alasan apa,
-- dan APA HASILNYA (termasuk hasil yang TIDAK DIKETAHUI).
CREATE TYPE "EscrowRecoveryOutcome" AS ENUM ('RETURNED', 'INDETERMINATE');

CREATE TABLE "escrow_recoveries" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "assetAddress" TEXT NOT NULL,
    "sellerId" TEXT,
    "toWallet" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "adminWallet" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "outcome" "EscrowRecoveryOutcome" NOT NULL,
    "signature" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escrow_recoveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "escrow_recoveries_listingId_idx" ON "escrow_recoveries"("listingId");
CREATE INDEX "escrow_recoveries_createdAt_idx" ON "escrow_recoveries"("createdAt");

COMMENT ON TABLE "escrow_recoveries" IS
  'Jejak audit pemulihan escrow manual (admin). toWallet SELALU diturunkan dari penjual baris listing, TIDAK PERNAH dari input admin — aksi ini tidak punya parameter tujuan. outcome=INDETERMINATE berarti transfer SUDAH disiarkan tapi konfirmasinya hilang: kartu MUNGKIN sudah pindah, penanda escrowedAt SENGAJA tidak dibersihkan, dan aksi ini TIDAK BOLEH diulang tanpa cek on-chain.';
