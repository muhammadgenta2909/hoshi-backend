import {
  CLAIM_CODE_LENGTH,
  CLAIM_CODE_TTL_DAYS,
  claimCodeExpiryFrom,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  normalizeClaimCode,
} from './consignment-claim-code';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KODE KLAIM — secarik kertas yang berpindah tangan BERSAMA kartunya.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Dua sifat yang dijaga file ini, dan keduanya punya harga kalau hilang:
 *
 *   1. TIDAK BISA DITEBAK. 50 bit entropi dari CSPRNG. Kalau alfabet atau panjangnya menyusut,
 *      rute penukaran publik berubah menjadi sesuatu yang bisa dibobol dengan sabar.
 *   2. BISA DIKETIK ULANG OLEH MANUSIA. Kodenya ditulis/dicetak di kertas lalu diketik di ponsel;
 *      normalisasinya harus memaafkan huruf kecil, tanda hubung, dan tiga pasang karakter yang
 *      memang tertukar dalam tulisan tangan (O/0, I/1, L/1) — tanpa memaafkan apa pun yang lain.
 */
describe('consignment-claim-code', () => {
  /** Crockford Base32: 10 digit + 22 huruf, TANPA I, L, O, U. */
  const ALPHABET = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/;

  describe('generateClaimCode', () => {
    it('selalu 10 simbol dari alfabet Crockford Base32 (50 bit entropi)', () => {
      for (let i = 0; i < 200; i++) {
        const code = generateClaimCode();
        expect(code).toHaveLength(CLAIM_CODE_LENGTH);
        expect(code).toMatch(ALPHABET);
      }
    });

    it('TIDAK PERNAH menghasilkan I, L, O, atau U', () => {
      // I/L/O tertukar dengan 1/1/0 pada tulisan tangan — dan karena `normalizeClaimCode`
      // MEMETAKAN mereka, kode yang mengandung salah satunya akan punya dua bentuk kanonik yang
      // berbeda dan satu di antaranya tidak akan pernah cocok. U dibuang mengikuti Crockford,
      // supaya kode acak tidak mengeja kata tak pantas di tanda terima bertanda tangan orang lain.
      const bulk = Array.from({ length: 500 }, () => generateClaimCode()).join(
        '',
      );
      expect(bulk).not.toMatch(/[ILOU]/);
    });

    it('tidak mengulang dirinya (CSPRNG, bukan penghitung)', () => {
      const seen = new Set(
        Array.from({ length: 500 }, () => generateClaimCode()),
      );
      expect(seen.size).toBe(500);
    });
  });

  describe('normalizeClaimCode — kertas ke ponsel', () => {
    it('huruf kecil, tanda hubung, dan spasi TIDAK berpengaruh', () => {
      const code = generateClaimCode();
      const pretty = formatClaimCode(code);
      expect(normalizeClaimCode(pretty)).toBe(code);
      expect(normalizeClaimCode(pretty.toLowerCase())).toBe(code);
      expect(normalizeClaimCode(` ${pretty} `)).toBe(code);
      expect(normalizeClaimCode(pretty.replace('-', ' '))).toBe(code);
    });

    it('O→0 dan I/L→1 — tiga salah baca yang PASTI terjadi pada tulisan tangan', () => {
      // Inilah satu-satunya alasan alfabetnya membuang ketiga huruf itu: pemetaan ini jadi
      // deterministik, bukan tebakan. Tanpa itu, pemilik kartu yang membaca "0" sebagai "O"
      // akan diberi tahu kodenya salah — padahal ia memegang kertas yang benar.
      expect(normalizeClaimCode('O123456789')).toBe('0123456789');
      expect(normalizeClaimCode('I123456789')).toBe('1123456789');
      expect(normalizeClaimCode('L123456789')).toBe('1123456789');
      expect(normalizeClaimCode('o123456789')).toBe('0123456789');
    });

    it('menolak U, simbol asing, dan panjang yang salah — dengan null, bukan pesan', () => {
      // `null` BUKAN pesan untuk pengguna. Pemanggil wajib menjawabnya dengan penolakan yang SAMA
      // PERSIS dengan "kode tidak ditemukan"; kalau bentuk yang salah dibedakan, rute penukaran
      // berubah jadi oracle yang memberi tahu penebak seperti apa kode yang benar.
      expect(normalizeClaimCode('U123456789')).toBeNull();
      expect(normalizeClaimCode('4T9KM-2X7P@')).toBeNull();
      expect(normalizeClaimCode('')).toBeNull();
      expect(normalizeClaimCode('4T9KM')).toBeNull();
      expect(normalizeClaimCode('4T9KM-2X7PQ-4T9KM')).toBeNull();
    });

    it('berhenti lebih awal pada masukan raksasa — tidak ada kerja sia-sia di rute publik', () => {
      expect(normalizeClaimCode('A'.repeat(100_000))).toBeNull();
    });
  });

  describe('hashClaimCode', () => {
    it('SHA-256 hex, dan bentuk yang berbeda dari kode yang SAMA menghasilkan hash yang SAMA', () => {
      const code = generateClaimCode();
      const viaPretty = normalizeClaimCode(formatClaimCode(code).toLowerCase());
      expect(viaPretty).not.toBeNull();
      expect(hashClaimCode(viaPretty!)).toBe(hashClaimCode(code));
      expect(hashClaimCode(code)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hash TIDAK memuat kodenya — dump database tidak memuat kunci yang bisa dipakai', () => {
      const code = generateClaimCode();
      expect(hashClaimCode(code)).not.toContain(code);
    });

    it('dua kode berbeda tidak pernah berbagi hash', () => {
      const a = generateClaimCode();
      const b = generateClaimCode();
      expect(hashClaimCode(a)).not.toBe(hashClaimCode(b));
    });
  });

  describe('formatClaimCode / kedaluwarsa', () => {
    it('dicetak sebagai dua kelompok lima: lebih mudah dibaca dari kertas', () => {
      expect(formatClaimCode('4T9KM2X7PQ')).toBe('4T9KM-2X7PQ');
    });

    it('berlaku 30 hari sejak diterbitkan — cukup lama untuk santai, cukup pendek untuk bukan kunci abadi', () => {
      const now = new Date('2026-09-19T00:00:00.000Z');
      expect(claimCodeExpiryFrom(now).toISOString()).toBe(
        '2026-10-19T00:00:00.000Z',
      );
      expect(CLAIM_CODE_TTL_DAYS).toBe(30);
    });
  });
});
