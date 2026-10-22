-- B1 — SETIAP STATUS PEMBLOKIR SEKARANG PUNYA JALAN KELUAR. Migration ini TIDAK MENGUBAH
-- predikat index apa pun: daftar status-nya BYTE-IDENTIK dengan 20260916000100. Yang berubah ada
-- di aplikasi (jalan keluarnya), dan index-lah tempat yang paling jujur untuk menyimpan
-- dokumentasinya — ia yang akan dibaca operator jam 3 pagi saat sebuah kartu terkunci, bukan file
-- TypeScript.
--
-- KENAPA DAFTARNYA TIDAK BERUBAH. Pass sebelumnya melebarkan index ini supaya mencakup SETIAP
-- status in-flight, termasuk AWAITING_PAYMENT dan READY_TO_FUND. Pelebaran itu BENAR (tanpa itu
-- baris FUNDED — yang berarti USDC treasury SUDAH ada di wallet user — tidak memblokir redemption
-- kedua untuk mint yang sama). Yang SALAH adalah: dua status itu tidak punya satu pun transisi
-- keluar di seluruh sistem, jadi memblokirnya berarti MENGUNCI KARTU SELAMANYA. Perbaikannya
-- adalah menambah jalan keluarnya, BUKAN mempersempit index-nya lagi.
--
-- ┌──────────────────────── JALAN KELUAR PER STATUS PEMBLOKIR ─────────────────────────────────┐
-- │ STATUS                 UANG           JALAN KELUAR                                         │
-- │ REQUESTED              nol            POST /payments/shipping        -> AWAITING_PAYMENT    │
-- │                                       POST /redemptions/:id/cancel   -> CANCELED (user)     │
-- │                                       PATCH /admin/redemptions/:id/status -> PACKING/       │
-- │                                                                         SHIPPED/CANCELED    │
-- │ AWAITING_PAYMENT       nol (belum)    callback/reconciler IDRX PAID   -> READY_TO_FUND      │
-- │                                       invoice EXPIRED (recordUnfulfilled) -> REQUESTED      │
-- │                                       POST /payments/shipping lagi: invoice hidup dipakai   │
-- │                                         ulang; invoice mati -> dilepas ke REQUESTED         │
-- │                                       POST /redemptions/:id/cancel   -> CANCELED (user)     │
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
-- Tiga status yang TIDAK ada di index (dan memang tidak boleh ada): CANCELED, DELIVERED,
-- REFUND_DUE. Ketiganya SELESAI/BATAL, jadi mint-nya harus bebas diminta lagi. REFUND_DUE kini
-- BENAR-BENAR ditulis (dulu nilai enum mati): satu-satunya penulisnya adalah
-- AdminService.settleReadyToFundAsRefundDue, dan di status asalnya (READY_TO_FUND) nol USDC
-- treasury pernah bergerak — aksi itu memverifikasi fundingSignature IS NULL dan refundSafe = true
-- sebagai PREDIKAT tulisannya, bukan sebagai asumsi.
--
-- ============================ BACA SEBELUM MENJALANKAN ============================
-- Migration ini TIDAK membuat, menghapus, atau mengubah index apa pun. Ia hanya menempelkan
-- COMMENT, dan hanya kalau index-nya memang sudah ada — jadi ia aman dijalankan lebih dulu atau
-- lebih belakang dari 20260916000100, dan tidak mengambil kunci penulisan tabel.
-- Prasyarat pelebaran index-nya sendiri (cek duplikat nftAddress in-flight) tetap seperti yang
-- ditulis di 20260916000100 — baca file itu sebelum menerapkannya.
-- ==================================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'card_redemptions_active_nft_uniq'
  ) THEN
    EXECUTE $c$
      COMMENT ON INDEX "card_redemptions_active_nft_uniq" IS
        'Anti dobel-redeem: satu nftAddress hanya boleh punya SATU redemption in-flight. Predikatnya mencakup SETIAP status in-flight, dan SETIAP status di predikat itu WAJIB punya minimal satu transisi keluar (B1) - lihat tabel jalan keluar di prisma/migrations/20260916000200_document_redemption_active_exits/migration.sql dan ACTIVE_STATUSES di src/redemption/redemption.service.ts. Menambah status ke predikat ini TANPA menambah jalan keluarnya = mengunci kartu user selamanya. Di luar predikat (bebas): CANCELED, DELIVERED, REFUND_DUE.'
    $c$;
  END IF;
END
$$;
