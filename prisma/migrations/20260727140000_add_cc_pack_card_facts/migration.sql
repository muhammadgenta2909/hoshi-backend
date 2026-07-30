-- Fakta kartu dari KATALOG CollectorCrypt untuk kartu hasil pull.
--
-- Sebelum ini, satu-satunya keterangan kartu yang kita simpan adalah `nftName`
-- (nama metadata on-chain, dibatasi 32 karakter). Grade ditebak dengan regex atas
-- nama itu, sehingga kartu PSA 10 bisa tampil "Ungraded" di halaman vault padahal
-- halaman marketplace — yang membaca field terstruktur CC — menampilkan grade yang
-- benar. Kolom di bawah menyimpan jawaban CC apa adanya.
--
-- Semua NULLABLE dan tanpa DEFAULT: NULL berarti "CC belum memberi tahu kita",
-- dan itu memang jawaban yang harus ditampilkan. Aman untuk baris lama.
ALTER TABLE "cc_pack_purchases"
  ADD COLUMN "ccItemName" TEXT,
  ADD COLUMN "ccGradeCompany" TEXT,
  ADD COLUMN "ccGradeScore" DOUBLE PRECISION,
  ADD COLUMN "ccGradeLabel" TEXT,
  ADD COLUMN "ccGradeCert" TEXT,
  ADD COLUMN "ccSet" TEXT,
  ADD COLUMN "ccCategory" TEXT,
  ADD COLUMN "ccLanguage" TEXT,
  ADD COLUMN "ccYear" INTEGER,
  ADD COLUMN "ccVault" TEXT,
  ADD COLUMN "ccSerial" TEXT,
  ADD COLUMN "ccFactsSyncedAt" TIMESTAMP(3),
  ADD COLUMN "ccFactsAttemptAt" TIMESTAMP(3);
