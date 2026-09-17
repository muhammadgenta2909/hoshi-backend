import { validateEnv } from '../config/env.validation';
import {
  readSponsorCapEnv,
  sponsorCapEnvProblems,
  SPONSOR_CAP_ENV_KEYS,
} from './sponsor-cap-env';
import {
  assertSponsorWithinCaps,
  sponsorCaps,
  sponsorEnabled,
  SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS,
  SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
  SPONSOR_DEFAULT_MAX_PER_SELLER_24H,
  SPONSOR_DEFAULT_RESERVE_LAMPORTS,
  type SponsorDecisionInput,
} from './escrow-fee-sponsor';

/**
 * PLAFON SPONSOR GAS ESCROW (C).
 *
 * Yang diuji di sini adalah KEPUTUSANNYA, bukan Solana-nya — itu sebabnya plafonnya hidup di
 * modul murni tanpa RPC/key/DB. Tiap test di bawah memetakan satu cara nyata wallet escrow bisa
 * kehabisan SOL, dan escrow yang kehabisan SOL BUKAN cuma kehilangan gas: ia tidak bisa lagi
 * MENYERAHKAN kartu ke pembeli maupun MENGEMBALIKANNYA ke penjual.
 */
describe('escrow fee sponsor — plafon', () => {
  const cfg = (values: Record<string, string> = {}) => ({
    get: <T = string>(k: string) => values[k] as unknown as T | undefined,
  });

  const base = (): SponsorDecisionInput => ({
    caps: sponsorCaps(cfg()),
    feeLamports: 5_000,
    issuedLamports24h: 0,
    issuedBySeller24h: 0,
    escrowLamports: 1_000_000_000, // 1 SOL
    outstandingLamports: 0,
  });

  describe('sponsorEnabled', () => {
    it('DEFAULT NYALA — tanpa sponsor, penjual login-Google (SOL nol) tak bisa menjual sama sekali', () => {
      expect(sponsorEnabled(cfg())).toBe(true);
    });

    it('hanya "false" yang mematikannya (salah ketik TIDAK diam-diam mematikan)', () => {
      expect(sponsorEnabled(cfg({ HOSHI_ESCROW_SPONSOR_FEE: 'false' }))).toBe(
        false,
      );
      expect(sponsorEnabled(cfg({ HOSHI_ESCROW_SPONSOR_FEE: 'FALSE ' }))).toBe(
        false,
      );
      expect(sponsorEnabled(cfg({ HOSHI_ESCROW_SPONSOR_FEE: 'no' }))).toBe(
        true,
      );
      expect(sponsorEnabled(cfg({ HOSHI_ESCROW_SPONSOR_FEE: '0' }))).toBe(true);
    });
  });

  describe('sponsorCaps', () => {
    it('default-nya angka yang tertulis di modul, bukan angka liar', () => {
      expect(sponsorCaps(cfg())).toEqual({
        maxFeeLamports: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
        dailyCapLamports: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS,
        maxPerSeller24h: SPONSOR_DEFAULT_MAX_PER_SELLER_24H,
        reserveLamports: SPONSOR_DEFAULT_RESERVE_LAMPORTS,
      });
    });

    it('"0" berarti NOL — rem tangan operator, BUKAN default', () => {
      // Ini perilaku yang dibalik oleh perbaikan F3. Dulu `parsed > 0 ? parsed : default`
      // membuat operator yang mengetik 0 untuk MENGHENTIKAN sponsor di tengah insiden justru
      // mendapat plafon default 0,02 SOL/hari — kebalikan dari yang dia minta. Untuk batas
      // belanja, "tidak terbaca" tidak boleh berarti "boleh belanja sebanyak default".
      const caps = sponsorCaps(
        cfg({
          HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS: '0',
          HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS: '0',
          HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H: '0',
          HOSHI_ESCROW_SPONSOR_RESERVE_LAMPORTS: '0',
        }),
      );
      expect(caps).toEqual({
        maxFeeLamports: 0,
        dailyCapLamports: 0,
        maxPerSeller24h: 0,
        reserveLamports: 0,
      });
    });

    it('plafon 0 BENAR-BENAR menolak sponsorship (bukan sekadar angka di struct)', () => {
      // Plafon yang "nol" tapi tidak pernah menolak apa pun bukan rem tangan.
      const caps = sponsorCaps(
        cfg({ HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS: '0' }),
      );
      expect(() => assertSponsorWithinCaps({ ...base(), caps })).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_QUOTA',
            stage: 'NO_EFFECT',
          }) as unknown,
        }),
      );
      // Idem untuk rem per-penjual: 0 penitipan/hari berarti NOL.
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          caps: sponsorCaps(
            cfg({ HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H: '0' }),
          ),
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_QUOTA',
          }) as unknown,
        }),
      );
    });

    it('TIDAK di-set (atau kosong) → default bawaan', () => {
      // "Tidak di-set" adalah keadaan NORMAL deployment yang tidak pernah menyentuh plafonnya,
      // dan kosong tidak lebih longgar daripada itu (nilainya persis sama).
      expect(sponsorCaps(cfg({}))).toEqual(sponsorCaps(cfg()));
      expect(
        sponsorCaps(
          cfg({
            HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS: '',
            HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS: '   ',
          }),
        ),
      ).toEqual({
        maxFeeLamports: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
        dailyCapLamports: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS,
        maxPerSeller24h: SPONSOR_DEFAULT_MAX_PER_SELLER_24H,
        reserveLamports: SPONSOR_DEFAULT_RESERVE_LAMPORTS,
      });
    });

    it('nilai yang TIDAK BISA DIBACA fail-closed (0), TIDAK diam-diam jadi default', () => {
      // Boot seharusnya sudah menolak start untuk nilai-nilai ini (lihat env.validation.spec);
      // ini pertahanan lapis kedua untuk proses yang entah bagaimana tetap hidup. Arahnya
      // MENUTUP keran, bukan membukanya sebesar default.
      const caps = sponsorCaps(
        cfg({
          HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS: 'abc',
          HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS: '-1',
          HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H: 'off',
        }),
      );
      expect(caps.maxFeeLamports).toBe(0);
      expect(caps.dailyCapLamports).toBe(0);
      expect(caps.maxPerSeller24h).toBe(0);
      // CADANGAN escrow adalah LANTAI, bukan plafon: menolkannya = mengizinkan sponsor menguras
      // SOL escrow. Nilai tak terbaca karena itu memakai lantai tertinggi yang kami berani
      // sebut (default), bukan 0.
      expect(
        sponsorCaps(cfg({ HOSHI_ESCROW_SPONSOR_RESERVE_LAMPORTS: 'banyak' }))
          .reserveLamports,
      ).toBe(SPONSOR_DEFAULT_RESERVE_LAMPORTS);
    });

    it('override env yang valid dipakai', () => {
      expect(
        sponsorCaps(cfg({ HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H: '3' }))
          .maxPerSeller24h,
      ).toBe(3);
    });
  });

  /* ══════════════ F3 — "TIDAK DI-SET" ≠ "DI-SET KE SESUATU YANG SALAH" ══════════════ */

  describe('plafon yang tidak bisa dibaca = BACKEND MENOLAK START', () => {
    const bootEnv = (over: Record<string, string> = {}) => ({
      DATABASE_URL: 'postgresql://user:pw@localhost:5432/db',
      JWT_SECRET: 'x'.repeat(32),
      ...over,
    });

    it('membedakan unset / nilai / tidak terbaca — SATU aturan untuk boot & runtime', () => {
      expect(readSponsorCapEnv(undefined)).toEqual({ kind: 'unset' });
      expect(readSponsorCapEnv('')).toEqual({ kind: 'unset' });
      expect(readSponsorCapEnv('  ')).toEqual({ kind: 'unset' });
      expect(readSponsorCapEnv('0')).toEqual({ kind: 'value', value: 0 });
      expect(readSponsorCapEnv(' 20000000 ')).toEqual({
        kind: 'value',
        value: 20_000_000,
      });
      // Semua ini "hampir angka" — dan `Number()` akan menerima sebagiannya diam-diam
      // (Number('1e5')=100000, Number('0x10')=16). Untuk batas belanja, hampir tidak cukup.
      const notReadable = [
        'off',
        '-1',
        '1e5',
        '5.5',
        '0x10',
        '20_000',
        '9'.repeat(20),
      ];
      for (const bad of notReadable) {
        expect(readSponsorCapEnv(bad).kind).toBe('invalid');
      }
    });

    it('boot DITOLAK untuk tiap env plafon yang di-set ke nilai tak terbaca', () => {
      for (const key of SPONSOR_CAP_ENV_KEYS) {
        expect(() => validateEnv(bootEnv({ [key]: 'off' }))).toThrow(
          /menolak start/i,
        );
        // Pesannya menyebut variabelnya DAN ejaan yang benar untuk "nolkan".
        expect(() => validateEnv(bootEnv({ [key]: 'off' }))).toThrow(
          new RegExp(key),
        );
      }
      const [problem] = sponsorCapEnvProblems({
        HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS: '-1',
      });
      expect(problem).toMatch(/"0" untuk MENOLKANNYA/);
    });

    it('boot LOLOS untuk "0" dan untuk env yang tidak di-set — keduanya sah', () => {
      expect(() => validateEnv(bootEnv())).not.toThrow();
      const zeroed = Object.fromEntries(
        SPONSOR_CAP_ENV_KEYS.map((k) => [k, '0']),
      );
      expect(() => validateEnv(bootEnv(zeroed))).not.toThrow();
      expect(sponsorCapEnvProblems(zeroed)).toEqual([]);
    });
  });

  describe('assertSponsorWithinCaps', () => {
    it('kasus normal (fee 5.000 lamports, kuota kosong, escrow berdana) → LOLOS', () => {
      expect(() => assertSponsorWithinCaps(base())).not.toThrow();
    });

    it('fee TIDAK TERBACA (null) → DITOLAK, bukan ditebak', () => {
      // Menandatangani kewajiban yang nominalnya tidak diketahui adalah persis yang plafon ini
      // ada untuk mencegah. Fail-closed.
      expect(() =>
        assertSponsorWithinCaps({ ...base(), feeLamports: null }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
            stage: 'NO_EFFECT',
          }) as unknown,
        }),
      );
    });

    it('fee di ATAS plafon per-transaksi → DITOLAK (satu tx tak wajar tak bisa menguras)', () => {
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS + 1,
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          }) as unknown,
        }),
      );
    });

    it('fee PERSIS di plafon per-transaksi → LOLOS (plafon inklusif, batasnya jelas)', () => {
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
        }),
      ).not.toThrow();
    });

    it('PLAFON PER-PENJUAL habis → 429 QUOTA (rem anti-Sybil; identitas gratis)', () => {
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          issuedBySeller24h: SPONSOR_DEFAULT_MAX_PER_SELLER_24H,
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_QUOTA',
            statusCode: 429,
          }) as unknown,
        }),
      );
    });

    it('plafon per-penjual dicek SEBELUM plafon global (satu akun rakus ≠ sistem penuh)', () => {
      // Dua plafon terlampaui sekaligus. Kalau global yang dijawab duluan, pesannya bilang
      // "kuota Hoshi penuh" untuk masalah yang sebenarnya milik SATU akun — menyesatkan operator
      // dan menyembunyikan penyalahgunaan di balik pesan yang terdengar seperti kapasitas.
      let thrown: unknown;
      try {
        assertSponsorWithinCaps({
          ...base(),
          issuedBySeller24h: SPONSOR_DEFAULT_MAX_PER_SELLER_24H,
          issuedLamports24h: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS,
        });
      } catch (err) {
        thrown = err;
      }
      const body = (thrown as { response: { message: string } }).response;
      expect(body.message).toContain('batas penitipan kartu untuk hari ini');
    });

    it('PLAFON GLOBAL 24 jam terlampaui (termasuk fee ini) → 429 QUOTA', () => {
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: 5_000,
          issuedLamports24h: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS - 4_999,
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_QUOTA',
          }) as unknown,
        }),
      );
    });

    it('plafon global PERSIS penuh → LOLOS; satu lamport lagi → DITOLAK', () => {
      const exact = {
        ...base(),
        feeLamports: 5_000,
        issuedLamports24h: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS - 5_000,
      };
      expect(() => assertSponsorWithinCaps(exact)).not.toThrow();
      expect(() =>
        assertSponsorWithinCaps({
          ...exact,
          issuedLamports24h: exact.issuedLamports24h + 1,
        }),
      ).toThrow();
    });

    it('SALDO ESCROW tak terbaca → DITOLAK (tak boleh menyanggupi yang tak bisa dibayar)', () => {
      expect(() =>
        assertSponsorWithinCaps({ ...base(), escrowLamports: null }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          }) as unknown,
        }),
      );
    });

    it('CADANGAN ESCROW dijaga: saldo cukup untuk fee tapi tak menyisakan cadangan → DITOLAK', () => {
      // Ini pemeriksaan yang paling mudah dianggap berlebihan dan paling mahal kalau hilang:
      // cadangan itulah yang membayar gas saat escrow MENYERAHKAN kartu ke pembeli. Menghabiskan
      // SOL untuk penitipan berarti kartu yang sudah dibayar tidak bisa dikirimkan.
      const caps = sponsorCaps(cfg());
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: 5_000,
          escrowLamports: caps.reserveLamports + 4_999,
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          }) as unknown,
        }),
      );
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: 5_000,
          escrowLamports: caps.reserveLamports + 5_000,
        }),
      ).not.toThrow();
    });

    it('CADANGAN dihitung dari saldo BERSIH: kewajiban yang belum disiarkan ikut dikurangkan', () => {
      // Tiap sponsorship yang sudah kami tandatangani tapi belum dipakai adalah transaksi
      // yang ADA DI TANGAN PENJUAL dan masih bisa disiarkan. Saldo on-chain belum berkurang,
      // tapi lamports-nya sudah bukan milik kami untuk dijanjikan lagi. Memakai saldo kotor
      // membuat cadangan bisa ditembus oleh sekumpulan penitipan yang semuanya "belum
      // terpakai" — dan escrow yang kehabisan SOL tak bisa lagi MENYERAHKAN kartu.
      const caps = sponsorCaps(cfg());
      const gross = caps.reserveLamports + 5_000 + 40_000;
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: 5_000,
          escrowLamports: gross,
          outstandingLamports: 0,
        }),
      ).not.toThrow();
      // Saldo kotor yang sama, tapi 40.001 lamport sudah dijanjikan → bersihnya kurang.
      expect(() =>
        assertSponsorWithinCaps({
          ...base(),
          feeLamports: 5_000,
          escrowLamports: gross,
          outstandingLamports: 40_001,
        }),
      ).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({
            code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          }) as unknown,
        }),
      );
    });

    it('kewajiban terutang yang tak masuk akal (negatif/NaN) → DITOLAK, bukan dianggap 0', () => {
      for (const outstanding of [-1, Number.NaN, 1.5]) {
        expect(() =>
          assertSponsorWithinCaps({
            ...base(),
            outstandingLamports: outstanding,
          }),
        ).toThrow(
          expect.objectContaining({
            response: expect.objectContaining({
              code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
            }) as unknown,
          }),
        );
      }
    });

    it('SETIAP penolakan ber-stage NO_EFFECT + retryable true (nol lamport bergerak)', () => {
      const cases: SponsorDecisionInput[] = [
        { ...base(), feeLamports: null },
        { ...base(), feeLamports: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS + 1 },
        { ...base(), issuedBySeller24h: SPONSOR_DEFAULT_MAX_PER_SELLER_24H },
        {
          ...base(),
          issuedLamports24h: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS,
        },
        { ...base(), escrowLamports: 0 },
        { ...base(), outstandingLamports: -1 },
      ];
      for (const input of cases) {
        let thrown: unknown;
        try {
          assertSponsorWithinCaps(input);
        } catch (err) {
          thrown = err;
        }
        const body = (thrown as { response: Record<string, unknown> }).response;
        // Semua pemeriksaan berjalan SEBELUM tanda tangan, jadi klaim "nol lamport bergerak"
        // yang dibawa stage ini benar untuk semuanya. Kalau suatu saat ada penolakan yang terbit
        // SESUDAH tanda tangan, ia WAJIB memakai stage lain — dan test ini yang akan menagihnya.
        expect(body.stage).toBe('NO_EFFECT');
        expect(body.retryable).toBe(true);
      }
    });
  });
});
