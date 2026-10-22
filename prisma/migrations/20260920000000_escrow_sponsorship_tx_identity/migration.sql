-- ╔══════════════════════════════════════════════════════════════════════════════════════════╗
-- ║ SPONSORSHIP GAS PUNYA NAMA: KOLOM IDENTITAS TRANSAKSI YANG KAMI TANDATANGANI.            ║
-- ╚══════════════════════════════════════════════════════════════════════════════════════════╝
--
-- MASALAHNYA. `noteSponsorshipConsumed` mencocokkan baris ledger dengan
-- `{ listingId, consumedAt: null }` saja, lalu menstempelnya `consumedAt` + signature. Untuk satu
-- listing bisa ada LEBIH DARI SATU reservasi (penjual menekan "titipkan" dua kali, blockhash
-- pertama kedaluwarsa, dst), dan ada pula penitipan yang SAMA SEKALI TIDAK disponsori: kalau
-- sponsor tidak bisa berjalan, transaksinya dibangun ulang dengan PENJUAL sebagai fee payer dan
-- NOL baris ledger ditulis. Dalam keadaan itu, menyiarkan transaksi penjual-bayar akan menstempel
-- baris sponsor yang transaksinya tidak pernah disiarkan — dengan signature yang escrow tidak
-- pernah membayarnya. Akibatnya baris itu keluar dari agregat KEWAJIBAN TERUTANG, dan lantai
-- cadangan SOL escrow (saldo - terutang) menjadi optimistis sebesar satu fee. Lantai itu ada
-- supaya escrow tidak pernah kehabisan SOL untuk MENYERAHKAN kartu ke pembeli.
--
-- PERBAIKANNYA. Setiap reservasi menyimpan NAMA transaksi yang diterbitkannya. Escrow adalah fee
-- payer transaksi sponsor, jadi tanda tangannya adalah ID transaksi itu — persis string yang
-- dikembalikan RPC saat transaksinya disiarkan. Konsumsi dicocokkan dengan kolom ini, sehingga:
--   • broadcast penjual-bayar TIDAK cocok dengan baris mana pun → tidak menghabiskan apa pun;
--   • broadcast sponsor menghabiskan PERSIS sponsorship yang membayarinya.
--
-- TANPA UNIQUE INDEX, dan itu disengaja: dua permintaan dalam slot blockhash yang sama
-- menghasilkan pesan byte-identik → signature identik. Itu dua KEWAJIBAN untuk satu transaksi
-- (plafon terpakai dua kali — arah yang aman) dan satu broadcast memang menghabiskan keduanya.
-- Unique index akan menolak reservasi kedua SESUDAH plafonnya diputuskan, yaitu sesudah titik
-- yang tidak bisa dibatalkan.
--
-- AMAN & IDEMPOTEN untuk baris lama: kolomnya NULLABLE. Baris lama (kalau ada) ber-null dan
-- karena itu tidak akan pernah cocok dengan signature broadcast apa pun — yaitu tidak akan pernah
-- ditandai terpakai oleh transaksi yang bukan miliknya. Itu arah yang benar: kewajiban yang
-- namanya tidak kita ketahui tetap dihitung terutang sampai jendela 24 jamnya lewat.
ALTER TABLE "escrow_fee_sponsorships" ADD COLUMN "sponsoredTxSignature" TEXT;

CREATE INDEX "escrow_fee_sponsorships_sponsoredTxSignature_idx" ON "escrow_fee_sponsorships"("sponsoredTxSignature");

COMMENT ON COLUMN "escrow_fee_sponsorships"."sponsoredTxSignature" IS
  'IDENTITAS reservasi: signature transaksi sponsor yang ditandatangani escrow untuk baris ini (escrow = fee payer, jadi signature ini = ID transaksinya). Ditulis di dalam transaksi keputusan plafon. Dicocokkan saat penitipan disiarkan supaya broadcast penjual-bayar tidak menghabiskan sponsorship mana pun. Sengaja TIDAK unique.';
