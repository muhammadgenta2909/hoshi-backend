import { Grader } from '@prisma/client';
import type { CcMarketCard } from './cc-market.types';

/**
 * FAKTA kartu menurut KATALOG CollectorCrypt — satu-satunya sumber kebenaran
 * untuk grade sebuah kartu ter-vault. Dipakai bersama oleh dua jalur yang dulu
 * punya logikanya masing-masing (dan karena itu bisa berbeda jawaban):
 *
 *   1. MarketSyncService — kartu katalog CC → Listing.
 *   2. CcCardFactsService — kartu HASIL PULL (CcPackPurchase) → Listing + Vault.
 *
 * Semua field boleh null. `null` artinya CC TIDAK memberi tahu kita, dan itu
 * HARUS ditampilkan sebagai "tidak diketahui" — bukan diisi nilai tebakan.
 * Tidak ada default karangan di file ini; itu disengaja.
 */
export interface CcCardFacts {
  /** Judul katalog LENGKAP. Nama metadata on-chain sering terpotong 32 karakter. */
  itemName: string | null;
  /** gradingCompany APA ADANYA, mis. 'PSA' | 'CGC' | 'Beckett' | 'SGC'. */
  gradeCompany: string | null;
  /** Angka grade, mis. 10 / 9.5. */
  gradeScore: number | null;
  /** Label mentah CC, mis. 'GEM-MT 10' / 'NM-MT 8.5'. */
  gradeLabel: string | null;
  /** Nomor sertifikat grading (gradingID). */
  gradeCert: string | null;
  set: string | null;
  category: string | null;
  language: string | null;
  year: number | null;
  /** Nama vault fisik CC, mis. 'OmniVault'. */
  vault: string | null;
  /** Nomor seri kartu di katalog. */
  serial: string | null;
}

const trimmed = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};

/**
 * gradingCompany CC → enum `Grader` kita. null = perusahaan grading di luar
 * PSA/CGC/Beckett (mis. SGC): JANGAN dipaksa masuk ke salah satu enum — memberi
 * label "PSA" pada slab SGC adalah data palsu, bukan pembulatan.
 */
export function mapGrader(company: string | null | undefined): Grader | null {
  switch ((company ?? '').trim().toUpperCase()) {
    case 'PSA':
      return Grader.PSA;
    case 'CGC':
      return Grader.CGC;
    case 'BECKETT':
    case 'BGS':
      return Grader.BGS;
    default:
      return null;
  }
}

/**
 * Angka grade dari label CC: "MINT 9" → 9, "GEM-MT 10" → 10, "NM-MT 8.5" → 8.5.
 * `gradeNum` dipakai sebagai cadangan (di respons live ia sering null).
 * null = tidak bisa dibaca ⇒ pemanggil WAJIB memperlakukannya sebagai tak diketahui.
 */
export function parseGradeScore(
  card: Pick<CcMarketCard, 'grade' | 'gradeNum'>,
): number | null {
  const fromLabel = /(\d+(?:\.\d+)?)\s*$/.exec(card.grade ?? '');
  if (fromLabel) {
    const n = Number(fromLabel[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (typeof card.gradeNum === 'number' && card.gradeNum > 0)
    return card.gradeNum;
  return null;
}

/**
 * Era Pokémon TCG dari TAHUN kartu (fakta katalog CC). Nilainya harus salah satu
 * union `Era` di frontend (lib/market.ts).
 *
 * Tahun tidak diketahui ⇒ '' (kosong), BUKAN 'Classic'. Menaruh era tertentu pada
 * kartu yang tahunnya tidak kita tahu = mengarang atribut; frontend menyembunyikan
 * badge kosong, dan itu jawaban yang jujur.
 */
export function eraFromYear(year: number | null | undefined): string {
  if (typeof year !== 'number' || year <= 0) return '';
  if (year >= 2023) return 'Scarlet & Violet';
  if (year >= 2020) return 'Sword & Shield';
  if (year >= 2017) return 'Sun & Moon';
  if (year >= 2014) return 'XY';
  if (year >= 2011) return 'Black & White';
  if (year >= 1999) return 'Classic';
  return 'Vintage';
}

/** Satu kartu katalog CC → fakta kita. Field yang tidak dikirim CC tetap null. */
export function readCardFacts(card: CcMarketCard): CcCardFacts {
  return {
    itemName: trimmed(card.itemName),
    gradeCompany: trimmed(card.gradingCompany),
    gradeScore: parseGradeScore(card),
    gradeLabel: trimmed(card.grade),
    gradeCert: trimmed(card.gradingID),
    set: trimmed(card.set) ?? trimmed(card.category),
    category: trimmed(card.category),
    language: trimmed(card.language),
    year: typeof card.year === 'number' && card.year > 0 ? card.year : null,
    vault: trimmed(card.vault),
    serial: trimmed(card.serial),
  };
}

/**
 * Grade yang LAYAK DIPAJANG di marketplace: butuh perusahaan grading yang muat di
 * enum `Grader` kita DAN angka grade yang terbaca. Kalau salah satunya hilang,
 * hasilnya null — dan pemanggil harus menolak membuat listing, bukan menambal.
 */
export function listableGrade(
  facts: Pick<CcCardFacts, 'gradeCompany' | 'gradeScore'>,
): { grader: Grader; gradeScore: number; grade: string } | null {
  const grader = mapGrader(facts.gradeCompany);
  if (!grader || facts.gradeScore === null) return null;
  return {
    grader,
    gradeScore: facts.gradeScore,
    grade: `${grader} ${facts.gradeScore}`,
  };
}
