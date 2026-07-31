import { Injectable, Logger } from '@nestjs/common';
import type { CcPackPurchase } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CcMarketClient } from './cc-market.client';
import { readCardFacts, type CcCardFacts } from './cc-card-facts';

/**
 * Lebih pendek dari default klien (30 dtk): lookup satu kartu berjalan di JALUR
 * PANGGILAN USER (buka pack / buka vault / pajang kartu). Kartu tetap sah walau
 * lookup-nya gagal — yang tidak boleh adalah menyandera request-nya.
 */
const LOOKUP_TIMEOUT_MS = 6_000;

/** Jeda sebelum mencoba lagi kartu yang tidak ditemukan CC (mis. NFT devnet). */
const RETRY_AFTER_MS = 60 * 60 * 1_000;

/** Batas baris yang diperbaiki per pemanggilan `repairMissing` (jaga latensi). */
const REPAIR_BATCH = 8;

/** Pull MOCK (staging/devnet) — memo `mock-…`, nftAddress `MOCKNFT…` (lihat
 *  GachaService CC MOCK). Tidak akan pernah ada di katalog CC, jadi kita lewati. */
function isMockPack(memo: string, nftAddress: string): boolean {
  return memo.startsWith('mock-') || nftAddress.startsWith('MOCKNFT');
}

/** Kolom fakta CC pada baris pull — dibaca/ditulis sebagai satu kesatuan. */
type PackFactsRow = Pick<
  CcPackPurchase,
  | 'memo'
  | 'nftAddress'
  | 'ccItemName'
  | 'ccGradeCompany'
  | 'ccGradeScore'
  | 'ccGradeLabel'
  | 'ccGradeCert'
  | 'ccSet'
  | 'ccCategory'
  | 'ccLanguage'
  | 'ccYear'
  | 'ccVault'
  | 'ccSerial'
  | 'ccFactsSyncedAt'
  | 'ccFactsAttemptAt'
>;

/**
 * Menjawab satu pertanyaan: "menurut CollectorCrypt, kartu di alamat ini kartu
 * apa dan grade-nya berapa?"
 *
 * Kenapa perlu ada: kartu hasil pull cuma membawa `nftName` — yaitu nama METADATA
 * on-chain, yang dibatasi 32 karakter dan tidak menjamin memuat grade. Menebak
 * grade dengan regex atas nama itu (perilaku lama) menghasilkan "Ungraded" untuk
 * kartu yang sebenarnya PSA 10, sementara halaman marketplace — yang membaca field
 * TERSTRUKTUR katalog CC — menampilkan grade yang benar. Dua halaman, dua jawaban,
 * satu di antaranya salah.
 *
 * Aturan main di sini: HANYA fakta dari CC yang disimpan. Kalau CC tidak mengenali
 * kartunya, kolomnya tetap null dan UI berkata "belum diketahui". Tidak ada nilai
 * default, tidak ada tebakan dari nama, tidak ada pembulatan grader.
 */
@Injectable()
export class CcCardFactsService {
  private readonly logger = new Logger(CcCardFactsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly market: CcMarketClient,
  ) {}

  /**
   * Cari satu kartu di katalog publik CC lewat alamat asset Solana-nya.
   *
   * `search=<nftAddress>` terverifikasi mengembalikan tepat kartu itu
   * (findTotal=1). Hasilnya tetap dicocokkan ULANG dengan `nftAddress` yang sama
   * persis — pencarian teks yang suatu hari melebar tidak boleh diam-diam
   * memberi kita grade milik kartu lain.
   *
   * TIDAK PERNAH melempar: katalog CC down bukan alasan untuk menggagalkan pack
   * yang sudah terbuka on-chain atau memblokir halaman vault.
   */
  async resolveByNftAddress(nftAddress: string): Promise<CcCardFacts | null> {
    try {
      const res = await this.market.browse(
        { page: 1, step: 5, search: nftAddress },
        { timeoutMs: LOOKUP_TIMEOUT_MS },
      );
      const card = (res.filterNFtCard ?? []).find(
        (c) => c.nftAddress === nftAddress,
      );
      if (!card) {
        // Hasil NORMAL, bukan kesalahan: kartu devnet/mock/baru memang belum tentu ada
        // di katalog publik CC. Debug, bukan warn — supaya log tidak banjir (mis. saat
        // banyak pack mock dibuka di staging). Kegagalan NYATA (catch di bawah) tetap warn.
        this.logger.debug(`Kartu ${nftAddress} tidak ada di katalog CC.`);
        return null;
      }
      return readCardFacts(card);
    } catch (err) {
      this.logger.warn(
        `Lookup katalog CC untuk ${nftAddress} gagal: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      return null;
    }
  }

  /**
   * Fakta untuk satu baris pull. Yang sudah tersimpan dipakai apa adanya; kalau
   * belum pernah berhasil di-sync, kartunya dicari sekali lalu hasilnya disimpan.
   *
   * `null` = CC belum bisa memberi tahu kita. Pemanggil WAJIB memperlakukan itu
   * sebagai "tidak diketahui" (tampilkan apa adanya / tolak membuat listing) —
   * bukan sebagai izin untuk mengisi sendiri.
   */
  async ensureFacts(pack: PackFactsRow): Promise<CcCardFacts | null> {
    if (pack.ccFactsSyncedAt) return this.storedFacts(pack);
    if (!pack.nftAddress) return null;
    // Pull MOCK (staging/devnet) tidak akan PERNAH ada di katalog CC — jangan buang
    // panggilan katalog + log untuknya. Memo-nya `mock-…`, nftAddress-nya `MOCKNFT…`.
    if (isMockPack(pack.memo, pack.nftAddress)) return null;

    // Kartu yang baru saja gagal dicari (mis. NFT devnet yang memang tidak ada di
    // katalog produksi CC) tidak dicoba ulang tiap request.
    if (
      pack.ccFactsAttemptAt &&
      Date.now() - pack.ccFactsAttemptAt.getTime() < RETRY_AFTER_MS
    ) {
      return null;
    }

    const facts = await this.resolveByNftAddress(pack.nftAddress);
    await this.persist(pack.memo, facts);
    return facts;
  }

  /**
   * Perbaikan latar belakang untuk baris yang faktanya belum pernah terisi —
   * mis. pack yang terbuka saat katalog CC sedang down. Dipanggil tanpa `await`
   * dari jalur baca; kegagalannya tidak pernah terlihat oleh user.
   */
  async repairMissing(userId: string): Promise<void> {
    const stale = new Date(Date.now() - RETRY_AFTER_MS);
    const rows = await this.prisma.ccPackPurchase.findMany({
      where: {
        userId,
        nftAddress: { not: null },
        ccFactsSyncedAt: null,
        // Jangan pernah repair pull MOCK — sama seperti ensureFacts, mereka tak akan
        // ada di katalog CC, jadi hanya membuang panggilan tiap siklus repair.
        memo: { not: { startsWith: 'mock-' } },
        OR: [{ ccFactsAttemptAt: null }, { ccFactsAttemptAt: { lt: stale } }],
      },
      orderBy: { openedAt: 'desc' },
      take: REPAIR_BATCH,
    });
    for (const row of rows) {
      if (!row.nftAddress) continue;
      const facts = await this.resolveByNftAddress(row.nftAddress);
      await this.persist(row.memo, facts);
    }
  }

  /* --- Internal --- */

  /** Kolom yang sudah tersimpan → bentuk `CcCardFacts`. */
  private storedFacts(pack: PackFactsRow): CcCardFacts {
    return {
      itemName: pack.ccItemName,
      gradeCompany: pack.ccGradeCompany,
      gradeScore: pack.ccGradeScore,
      gradeLabel: pack.ccGradeLabel,
      gradeCert: pack.ccGradeCert,
      set: pack.ccSet,
      category: pack.ccCategory,
      language: pack.ccLanguage,
      year: pack.ccYear,
      vault: pack.ccVault,
      serial: pack.ccSerial,
    };
  }

  /**
   * Tulis hasil lookup. `facts === null` HANYA memperbarui `ccFactsAttemptAt`:
   * percobaan yang gagal tidak boleh menimpa fakta yang pernah berhasil didapat,
   * dan tidak boleh dicatat seolah-olah sudah tersinkron.
   */
  private async persist(
    memo: string,
    facts: CcCardFacts | null,
  ): Promise<void> {
    const now = new Date();
    try {
      await this.prisma.ccPackPurchase.update({
        where: { memo },
        data: facts
          ? {
              ccItemName: facts.itemName,
              ccGradeCompany: facts.gradeCompany,
              ccGradeScore: facts.gradeScore,
              ccGradeLabel: facts.gradeLabel,
              ccGradeCert: facts.gradeCert,
              ccSet: facts.set,
              ccCategory: facts.category,
              ccLanguage: facts.language,
              ccYear: facts.year,
              ccVault: facts.vault,
              ccSerial: facts.serial,
              ccFactsSyncedAt: now,
              ccFactsAttemptAt: now,
            }
          : { ccFactsAttemptAt: now },
      });
    } catch (err) {
      // Baris bisa saja terhapus di antara baca dan tulis. Menyimpan fakta adalah
      // pekerjaan sampingan — jangan pernah menjatuhkan pemanggilnya.
      this.logger.warn(
        `Gagal menyimpan fakta CC untuk memo ${memo}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
    }
  }
}
