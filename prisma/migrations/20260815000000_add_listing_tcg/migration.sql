-- Kolom game/TCG franchise dari CollectorCrypt (card.category): "Pokemon", "One Piece", dst.
-- Dipakai frontend untuk mendeteksi jenis kartu (mis. ikon Pokéball) 100% akurat.
-- Nullable: baris lokal/legacy tanpa data CC = NULL → frontend jatuh ke heuristik nama kartu.
ALTER TABLE "Listing" ADD COLUMN "tcg" TEXT;
