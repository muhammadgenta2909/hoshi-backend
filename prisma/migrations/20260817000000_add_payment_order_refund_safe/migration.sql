-- Flag terstruktur "aman refund" pada payment_orders.
-- true (default)  = user bayar tapi belum terima kartu  → refund BENAR.
-- false           = kegagalan PASCA-belanja (treasury sudah/mungkin bayar + kartu sudah/mungkin
--                   terkirim) → REFUND = RUGI DOBEL; cek on-chain + kirim ulang manual, JANGAN refund.
-- Gerbang refund apa pun WAJIB membaca kolom ini, BUKAN teks `error`.
ALTER TABLE "payment_orders" ADD COLUMN "refundSafe" BOOLEAN NOT NULL DEFAULT true;
