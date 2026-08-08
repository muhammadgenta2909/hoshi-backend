-- Status terminal OFFER: PAID = pembeli sudah membayar & settle. Dipakai sebagai GERBANG settlement
-- (fulfilUserListing meng-klaim offer ACCEPTED→PAID secara atomik) supaya hanya offer yang MASIH
-- diterima penjual yang bisa diselesaikan — menutup balapan "offer basi tetap terbayar".
-- Postgres (Neon PG15+) mengizinkan ADD VALUE di dalam transaksi.
ALTER TYPE "OfferStatus" ADD VALUE 'PAID';
