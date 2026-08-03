-- Flow B (real P2P): status antara untuk listing yang menunggu kartu penjual masuk escrow.
-- Kartu USER (mpl-core) baru bisa dibeli setelah benar-benar dititipkan ke wallet escrow;
-- sampai itu terjadi, listing berstatus PENDING_ESCROW (tidak muncul di pasar, tak bisa dibeli).
-- Di jalur mock/unarmed, listing tetap langsung ACTIVE — nilai ini hanya dipakai saat armed.
ALTER TYPE "ListingStatus" ADD VALUE IF NOT EXISTS 'PENDING_ESCROW' BEFORE 'ACTIVE';
