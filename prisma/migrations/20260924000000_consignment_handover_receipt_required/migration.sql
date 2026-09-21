-- ══════════════════════════════════════════════════════════════════════════════════════════════
--  STRUK SERAH TERIMA TITIPAN — foto struk bertanda tangan jadi SYARAT menerima kartu.
--
--  Migration ini TIDAK MENGUBAH SATU BARIS DATA PUN dan TIDAK MENGUBAH SATU PUN BENTUK TABEL.
--  Ia hanya menempelkan COMMENT. Aman dijalankan kapan saja, tidak mengambil kunci penulisan,
--  dan bisa diulang tanpa akibat.
--
--  ═══ KENAPA TIDAK ADA DDL DI SINI — INI JAWABAN, BUKAN KELALAIAN ═══
--
--  (1) NILAI ENUM-nya SUDAH ADA. 'HANDOVER' dibuat bersama tipenya di migration
--      20260922000000_consignment_custody (CREATE TYPE "ConsignmentPhotoKind"). Tidak ada
--      ALTER TYPE ... ADD VALUE yang perlu dijalankan, dan itu kebetulan yang menguntungkan:
--      ALTER TYPE ... ADD VALUE tidak bisa dipakai di dalam transaksi pada PostgreSQL lama,
--      sedangkan Prisma menjalankan tiap migration dalam satu transaksi.
--
--  (2) SYARATNYA BUKAN BENTUK BARIS, MELAINKAN BENTUK TRANSISI. Yang berubah adalah gerbang
--      INTAKE → IN_CUSTODY di `ConsignmentService.acceptCustody`: sekarang ia menuntut foto
--      ber-kind 'HANDOVER' di samping FRONT/BACK (dan CERT bila ada nomor sertifikat).
--      Menuliskannya sebagai CHECK constraint di "consignments" MUSTAHIL — fakta yang diperiksa
--      hidup di TABEL LAIN ("consignment_photos"), dan CHECK tidak boleh membaca tabel lain.
--      Menuliskannya sebagai trigger akan memindahkan satu aturan produk ke tempat yang tidak
--      diuji oleh satu pun test di repo ini.
--
--  (3) TIDAK ADA BACKFILL, DAN ITU KEPUTUSAN. Godaannya jelas: "tandai titipan lama supaya
--      syarat baru tidak berlaku untuknya". Tidak ada yang perlu ditandai, karena struktur
--      rutenya sudah menjawab itu sendiri:
--
--        • acceptCustody HANYA bisa dilewati dari status INTAKE, dengan predikat klaim
--          `acceptCustodyClaimWhere` yang menuntut "custodyAcceptedAt" IS NULL;
--        • baris yang custody-nya SUDAH tercatat tidak pernah kembali ke INTAKE — tidak ada
--          satu pun penulis yang mengosongkan "custodyAcceptedAt" di seluruh repo;
--        • jadi baris yang SUDAH di rak tidak akan pernah melewati gerbang ini lagi, dan tetap
--          bisa dipajang, dijual, ditarik pemiliknya, dan dikirim ke pembelinya seperti biasa.
--
--      Yang terkena syarat baru hanyalah baris yang MASIH berstatus INTAKE — dan itu memang
--      yang dimaksud: kartunya belum berpindah tangan, jadi strukya memang masih bisa dicetak
--      dan ditandatangani sebelum kartunya diterima. Menambahkan kolom "handoverRequiredSince"
--      atau semacamnya hanya akan menambah satu kolom yang harus diingat selamanya untuk
--      menjawab pertanyaan yang sudah dijawab oleh bentuk transisinya.
--
--  YANG DICATAT DI SINI adalah ARTI kolomnya, supaya siapa pun yang membaca database ini tanpa
--  membaca TypeScript-nya tetap tahu kenapa satu nilai enum menjadi syarat masuk rak.
-- ══════════════════════════════════════════════════════════════════════════════════════════════

COMMENT ON COLUMN "consignment_photos"."kind" IS
  'Jenis bukti. WAJIB sebelum custody boleh diterima: FRONT, BACK, HANDOVER — plus CERT bila "consignments"."certNumber" terisi. Ditegakkan di ConsignmentService.acceptCustody, satu-satunya jalan masuk ke IN_CUSTODY. DUA JENIS BUKTI YANG BERBEDA: FRONT/BACK/CERT membuktikan KEADAAN BARANGNYA ("sudah begitu sejak awal?"), sedangkan HANDOVER membuktikan ADANYA KESEPAKATAN — ia adalah foto STRUK SERAH TERIMA sesudah ditandatangani kedua pihak, dan hanya itu yang menjawab "dia memang setuju menitipkannya, dengan harga dan komisi ini, pada hari itu". DAMAGE/OTHER bebas. Baris foto APPEND-ONLY: tidak ada endpoint update/delete, karena bukti yang bisa diam-diam diganti oleh pihak yang menyimpan barang bukan bukti.';

COMMENT ON COLUMN "consignments"."intakeReceiptRef" IS
  'Nomor/arsip STRUK SERAH TERIMA bertanda tangan — opsional, dan sengaja BUKAN gerbang. Yang menjadi gerbang adalah FOTO struknya (consignment_photos.kind = ''HANDOVER''), bukan teks yang diketik di kolom ini: teks bisa diketik tanpa kertasnya pernah ada. Struknya dicetak dua lembar identik (satu untuk pemilik kartu, satu untuk Hoshi) dari konsol admin, ditandatangani di tempat, lalu lembar yang sudah ditandatangani difoto. Salinan pemilik adalah bukti MILIK DIA, bukan milik Hoshi.';

COMMENT ON COLUMN "consignments"."custodyAcceptedAt" IS
  'FAKTA: kartunya TERBUKTI ada di tangan Hoshi. Ditulis SEKALI oleh ConsignmentService.acceptCustody, sesudah bukti lengkap (FRONT/BACK/HANDOVER + CERT bila bernomor sertifikat), catatan kondisi, dan lokasi penyimpanan ada. TIDAK PERNAH dikosongkan oleh kode mana pun — berakhirnya custody ditulis sebagai fakta KEDUA ("custodyReleasedAt"). Karena kolom ini tidak pernah kembali NULL, gerbang bukti di acceptCustody hanya pernah dilewati SEKALI per titipan; itulah sebabnya syarat bukti yang diperketat kemudian tidak bisa mengunci kartu yang sudah lebih dulu ada di rak.';
