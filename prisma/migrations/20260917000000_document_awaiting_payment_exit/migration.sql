-- B1 (KAMBUH KE-3) — AWAITING_PAYMENT AKHIRNYA PUNYA JALAN KELUAR YANG BENAR-BENAR BISA DIPAKAI.
--
-- Migration ini TIDAK MENGUBAH predikat index apa pun: daftar statusnya BYTE-IDENTIK dengan
-- 20260916000100 dan 20260916000200. Yang berubah ada di aplikasi. Index-lah tempat paling jujur
-- untuk menyimpan dokumentasinya — ia yang dibaca operator jam 3 pagi saat sebuah kartu terkunci.
--
-- ============================ APA YANG SEBENARNYA RUSAK ============================
-- Pass sebelumnya menambahkan AWAITING_PAYMENT ke predikat index ini DAN ke ACTIVE_STATUSES.
-- Pelebaran itu BENAR. Yang salah: SEMUA jalan keluarnya ternyata bergantung pada SATU daftar
-- status PaymentOrder yang sama, dan daftar itu memuat FULFILLING + REFUND_DUE. Begitu order
-- ongkir yang dipin masuk ke salah satunya, keempat pintu tertutup SEKALIGUS:
--
--   1. batal user             -> 400 REDEMPTION_CANCEL_PAYMENT_LANDED
--   2. terbitkan invoice lagi -> 400 (klaim AWAITING_PAYMENT tidak boleh dilepas)
--   3. sapuan kedaluwarsa     -> butuh order PENDING|PAID; FULFILLING/REFUND_DUE tak pernah cocok
--   4. fulfilShipping         -> tidak akan pernah jalan lagi (klaim atomiknya sudah terpakai)
--
-- ...dan admin TIDAK punya satu pun transisi keluar dari AWAITING_PAYMENT. Satu proses yang mati
-- tepat sesudah klaim atomik (deploy / OOM / restart droplet) sudah cukup untuk memicunya, dan
-- akibatnya GLOBAL: index ini unik per "nftAddress" tanpa memandang pemilik, sementara tidak ada
-- apa pun yang menggerbang jual-beli marketplace pada state redemption. Penjual dengan baris
-- nyangkut masih bisa menjual kartunya, dan PEMBELI-lah yang kena P2002 -> REDEMPTION_ALREADY_ACTIVE
-- selamanya, tanpa aksi apa pun yang tersedia untuk kedua pihak.
--
-- ============================ APA YANG DIPERBAIKI ============================
--   • Daftar status order yang MELARANG batal-sendiri dipersempit jadi (PAID, FULFILLED) saja
--     (CANCEL_BLOCKING_ORDER_STATUSES di src/redemption/redemption.service.ts). FULFILLING dan
--     REFUND_DUE tidak lagi mengunci: di AWAITING_PAYMENT baris redemption-nya NOL uang — utangnya
--     hidup di baris PaymentOrder, dan baris itu TIDAK ikut dibatalkan.
--   • Rute admin BARU: POST /admin/redemptions/:id/cancel-awaiting-payment (AWAITING_PAYMENT ->
--     CANCELED, wajib beralasan, tulisan berpagar, refundSafe TIDAK PERNAH ditulis). Berlaku untuk
--     SETIAP status order, termasuk PAID/FULFILLED — jalan keluar terakhir saat usernya sudah pergi.
--   • Pembukuan WAJIB sesudah kedua pembatalan (src/payments/shipping-refund-debt.ts): order ongkir
--     yang macet di FULFILLING diubah jadi REFUND_DUE (utang TERCATAT), sisanya DILAPORKAN.
--
-- ┌─────────── APA YANG DILIHAT OPERATOR UNTUK SETIAP UTANG YANG BARU TERCATAT ────────────────┐
-- │ 1. Baris PaymentOrder-nya sendiri: status = 'REFUND_DUE', refundSafe = true (DIBACA, tidak  │
-- │    pernah ditulis oleh jalur pembatalan), dan kolom `error` diawali                         │
-- │    "UTANG ONGKIR KIRIM FISIK: redemption <id> DIBATALKAN (<siapa>) ...".                    │
-- │      SELECT "merchantOrderId","priceIdr","refundSafe","error" FROM payment_orders           │
-- │      WHERE status='REFUND_DUE' AND "packType"='SHIPPING';                                   │
-- │ 2. Log ERROR: "REFUND_DUE[ONGKIR KIRIM FISIK] <merchantOrderId> (user <id>, Rp <n>): ..."   │
-- │    Untuk order yang TIDAK diubah (PAID/FULFILLED/REFUND_DUE lama) log-nya diawali            │
-- │    "ONGKIR TERTINGGAL <merchantOrderId> ..." beserta aksi yang harus/tidak harus diambil.    │
-- │ 3. Respons API pembatalan (user maupun admin) memuat array `shippingDebts`:                 │
-- │    { merchantOrderId, priceIdr, statusBefore, statusAfter, refundSafe, recordedNow,          │
-- │      operatorAction }.                                                                      │
-- │ 4. Catatan baris redemption (kolom `note`) memuat jejak pembatalannya, DITAMBAHKAN bukan     │
-- │    menimpa.                                                                                 │
-- │ ATURAN REFUND TETAP SAMA: baca kolom `refundSafe`, BUKAN status/teks. true = user bayar &    │
-- │ belum menerima -> refund BENAR. false = JANGAN refund (rugi dobel).                          │
-- └─────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- ┌──────────────────────── JALAN KELUAR PER STATUS PEMBLOKIR (diperbarui) ────────────────────┐
-- │ STATUS                 UANG           JALAN KELUAR                                         │
-- │ REQUESTED              nol            POST /payments/shipping        -> AWAITING_PAYMENT    │
-- │                                       POST /redemptions/:id/cancel   -> CANCELED (user)     │
-- │                                       PATCH admin status -> PACKING/SHIPPED/CANCELED        │
-- │ AWAITING_PAYMENT       nol (belum)    callback/reconciler IDRX PAID   -> READY_TO_FUND      │
-- │                                       invoice EXPIRED (recordUnfulfilled) -> REQUESTED      │
-- │                                       POST /redemptions/:id/cancel   -> CANCELED (user),    │
-- │                                         berlaku JUGA saat order ongkirnya FULFILLING /      │
-- │                                         REFUND_DUE; ditolak hanya untuk PAID / FULFILLED    │
-- │                                       POST /admin/redemptions/:id/cancel-awaiting-payment   │
-- │                                                                      -> CANCELED (SETIAP    │
-- │                                                                         status order)       │
-- │ READY_TO_FUND          Rupiah LUNAS   POST /redemptions/:id/fund-and-prepare -> FUNDING     │
-- │                                       POST /admin/redemptions/:id/settle-refund-due         │
-- │                                                                      -> REFUND_DUE          │
-- │ FUNDING                USDC mungkin   fund-and-prepare sukses        -> FUNDED              │
-- │                                       PATCH admin status            -> RECLAIM_DUE          │
-- │ FUNDED                 USDC PINDAH    POST /redemptions/:id/submit-burn -> BURN_SUBMITTED   │
-- │                                       PATCH admin status            -> RECLAIM_DUE          │
-- │ BURN_SUBMITTED         USDC PINDAH    GET /redemptions/:id/status (poll CC) -> IN_TRANSIT/  │
-- │                                                          DELIVERED/SHIP_FAILED_POST_BURN    │
-- │                                       POST /admin/redemptions/:id/recover-burn-submitted    │
-- │                                                                      -> FUNDED              │
-- │ IN_TRANSIT             USDC PINDAH    poll CC                        -> DELIVERED           │
-- │ RECLAIM_DUE            USDC PINDAH    PATCH admin status             -> CANCELED            │
-- │                                         (sesudah USDC direklaim; refundSafe TETAP false)    │
-- │ SHIP_FAILED_POST_BURN  USDC PINDAH    PATCH admin status             -> DELIVERED           │
-- │ PACKING (record-only)  nol            PATCH admin status             -> SHIPPED/CANCELED    │
-- │ SHIPPED (record-only)  nol            PATCH admin status             -> DELIVERED           │
-- └────────────────────────────────────────────────────────────────────────────────────────────┘
--
-- KELASNYA DITUTUP, BUKAN CUMA INSTANSNYA. Test "jalan keluar terdeklarasi" yang lama HIJAU
-- sepanjang bug ini hidup, karena ia hanya memeriksa ADA-TIDAKNYA STRING di tabel dokumentasi.
-- Penggantinya, src/redemption/redemption-exit-reachability.spec.ts, mendaftarkan tiap jalan
-- keluar sebagai FUNGSI yang benar-benar dipanggil dan menuntut baris redemption-nya BERGERAK,
-- untuk SETIAP kombinasi status redemption x status PaymentOrder (seluruh enum + "tanpa order").
-- Menambah status ke predikat index ini tanpa menambah jalan keluarnya kini = test MERAH.
--
-- ============================ BACA SEBELUM MENJALANKAN ============================
-- Migration ini TIDAK membuat, menghapus, atau mengubah index apa pun. Ia hanya menempelkan
-- COMMENT, dan hanya kalau index-nya memang sudah ada — aman dijalankan lebih dulu atau lebih
-- belakang dari 20260916000100/20260916000200, dan tidak mengambil kunci penulisan tabel.
-- ==================================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'card_redemptions_active_nft_uniq'
  ) THEN
    EXECUTE $c$
      COMMENT ON INDEX "card_redemptions_active_nft_uniq" IS
        'Anti dobel-redeem: satu nftAddress hanya boleh punya SATU redemption in-flight. Predikatnya mencakup SETIAP status in-flight, dan SETIAP status di predikat itu WAJIB punya minimal satu transisi keluar yang BISA DIJALANKAN (B1) - dibuktikan oleh src/redemption/redemption-exit-reachability.spec.ts, yang menguji setiap kombinasi status redemption x status PaymentOrder. Tabel jalan keluar terbaru ada di prisma/migrations/20260917000000_document_awaiting_payment_exit/migration.sql. AWAITING_PAYMENT: batal user (ditolak hanya bila order ongkirnya PAID/FULFILLED) + POST /admin/redemptions/:id/cancel-awaiting-payment (berlaku untuk SETIAP status order). Pembatalan TIDAK menelan uang: order ongkir yang macet di FULFILLING ditandai REFUND_DUE dengan refundSafe apa adanya, dan setiap order yang terpengaruh dilaporkan di respons + log ERROR. Menambah status ke predikat ini TANPA menambah jalan keluarnya = mengunci kartu user selamanya, dan karena index ini GLOBAL per nftAddress, yang terkunci bisa PEMBELI berikutnya, bukan hanya pemilik sekarang. Di luar predikat (bebas): CANCELED, DELIVERED, REFUND_DUE.'
    $c$;
  END IF;
END
$$;
