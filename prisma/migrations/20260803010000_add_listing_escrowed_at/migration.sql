-- Flow B (real P2P): penanda bahwa kartu listing ini BENAR-BENAR dititip di wallet escrow.
-- Di-set oleh submitEscrow setelah kepemilikan escrow dikonfirmasi on-chain; dibaca oleh cancel
-- (kembalikan kartu HANYA jika ter-set) dan buy/acceptOffer (tolak jalur demo untuk listing ber-escrow).
-- FAKTA historis yang tak bergantung pada flag HOSHI_P2P_ENABLED/CC_MOCK saat aksi berikutnya terjadi,
-- sehingga disarm setelah escrow tidak pernah menelantarkan kartu penjual secara diam-diam.
ALTER TABLE "listings" ADD COLUMN "escrowedAt" TIMESTAMP(3);
