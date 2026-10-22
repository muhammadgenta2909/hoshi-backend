-- ══════════════════════════════════════════════════════════════════════════════════════════════
--  B — LISTING TANPA ESCROW TIDAK BOLEH JADI PERANGKAP REFUND DI HARI ARMING.
--
--  Migration ini TIDAK MENGUBAH SATU BARIS DATA PUN. Ia menambah SATU indeks parsial dan
--  menempelkan COMMENT. Aman dijalankan kapan saja; tidak mengambil kunci penulisan tabel
--  (CREATE INDEX di sini SENGAJA tidak CONCURRENTLY karena Prisma menjalankan tiap migration
--  dalam satu transaksi — tabel `listings` kecil, kuncinya sekejap).
--
--  ═══ KENAPA TIDAK ADA UPDATE DI SINI — INI KEPUTUSAN, BUKAN KELALAIAN ═══
--  Setiap listing USER yang ACTIVE hari ini punya escrowedAt = NULL: `listingNeedsEscrow()`
--  hanya meminta escrow saat P2P real ARMED, dan ia belum pernah armed. Godaan yang jelas adalah
--  menulis satu UPDATE di sini yang memindahkan semuanya ke PENDING_ESCROW (atau CANCELLED)
--  supaya tidak ada yang bisa dibeli saat flag dinyalakan.
--
--  ITU SALAH, dan alasannya tidak bisa diperbaiki dengan menulis WHERE yang lebih pintar:
--    • SQL TIDAK BISA MEMBACA ENV. Migration yang sama juga berjalan di STAGING, tempat P2P
--      berjalan dalam mode MOCK (CC_MOCK=1) dan listing user memang SAH tanpa escrow — settlement
--      mock-nya tidak pernah menyentuh on-chain. UPDATE di sini akan MERUSAK listing yang sehat
--      di satu environment demi melindungi environment lain.
--    • Kartunya TIDAK BISA di-escrow otomatis: memindahkannya butuh TANDA TANGAN PENJUAL
--      on-chain. Desain apa pun yang menganggap sebaliknya salah.
--    • Membatalkan listing orang lain secara massal itu tidak bisa dijelaskan ke mereka dan
--      tidak bisa dibatalkan (harga, listedAt, views, offer berjalan ikut hangus).
--
--  YANG DIPAKAI SEBAGAI GANTINYA: gerbang RUNTIME yang bersandar pada FAKTA yang tersimpan
--  (escrowedAt), bukan pada flag saat itu:
--    • feed publik (MarketplaceService.list) MENGECUALIKAN listing user tanpa escrow saat armed;
--    • SETIAP jalur yang menerbitkan tagihan menolaknya SEBELUM invoice terbit
--      (PaymentsService.createListingOrder / createOfferOrder → kode P2P_LISTING_NOT_ESCROWED);
--    • penerimaan offer menolaknya (MarketplaceService.acceptOffer);
--    • pemiliknya TETAP MELIHAT listing-nya di "My listings", ditandai needsEscrowDeposit=true,
--      dan memajang ulang (relist) akan menaruhnya di PENDING_ESCROW lalu meminta tanda tangan.
--  Kartu penjual TIDAK PERNAH bergerak, tidak pernah disembunyikan dari pemiliknya, dan
--  pemulihannya adalah satu aksi biasa yang sudah ada (relist).
-- ══════════════════════════════════════════════════════════════════════════════════════════════

-- Indeks parsial yang menopang filter feed publik: "listing USER yang mewakili aset on-chain
-- tapi TIDAK ada di escrow". Parsial (WHERE "escrowedAt" IS NULL) supaya kecil — baris yang
-- ber-escrow, yang justru mayoritas setelah arming, tidak ikut masuk indeks.
CREATE INDEX "listings_unescrowed_user_idx"
  ON "listings" ("status")
  WHERE "escrowedAt" IS NULL AND "sellerId" IS NOT NULL AND "ccNftAddress" IS NOT NULL;

COMMENT ON INDEX "listings_unescrowed_user_idx" IS
  'Menopang gerbang B: saat HOSHI_P2P_ENABLED menyala, listing USER yang mewakili aset on-chain (ccNftAddress) TAPI escrowedAt IS NULL tidak boleh muncul sebagai bisa-dibeli — escrow tidak pernah memegang kartunya, jadi settlement akan gagal SESUDAH pembeli membayar. Dikecualikan dari feed publik dan ditolak di semua jalur penerbitan tagihan.';

COMMENT ON COLUMN "listings"."escrowedAt" IS
  'FAKTA: wallet escrow Hoshi TERBUKTI memegang kartu ini (di-set submitEscrow setelah kepemilikan dikonfirmasi on-chain). Ini SATU-SATUNYA dasar yang sah untuk setiap keputusan escrow — JANGAN PERNAH menggantinya dengan pembacaan HOSHI_P2P_ENABLED/CC_MOCK saat itu, karena flag bisa berubah di tengah hidup sebuah listing sementara kartunya tidak. NULL = kartu ada di wallet penjual. Konsekuensinya: (a) cancel hanya menarik kartu balik bila ini ter-set — men-disarm P2P sesudah kartu masuk escrow tetap mengembalikan kartu penjual; (b) saat P2P armed, listing user ber-ccNftAddress dengan kolom ini NULL TIDAK BOLEH bisa dibeli (lihat listings_unescrowed_user_idx).';
