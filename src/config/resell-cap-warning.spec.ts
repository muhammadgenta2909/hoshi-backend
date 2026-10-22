// WAJIB paling atas — `validateEnv` memakai decorator class-validator yang membaca metadata
// lewat Reflect. Lihat catatan yang sama di payment-return-url.spec.ts.
import 'reflect-metadata';
import { validateEnv } from './env.validation';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   PLAFON BELANJA RESELLER — BERTERIAK HANYA KETIKA IA BENAR-BENAR BERBAHAYA.

   Jalur reseller CC adalah SATU-SATUNYA di repo ini yang membelanjakan USDC treasury sendiri.
   Plafon per-kartunya, `HOSHI_CC_MAX_CARD_PRICE_USDC`, punya bawaan 5.000.000.000 base unit =
   $5.000 PER KARTU — angka yang tidak pernah diputuskan siapa pun, dan berkali-kali lipat di atas
   float treasury yang wajar untuk fase ini.

   DUA SISI YANG SAMA PENTINGNYA, dan itulah yang diuji di sini:

     • Selama jalurnya MATI, angka itu tidak membelanjakan apa pun. Berteriak di situ memaksa
       orang mengisi var untuk fitur yang tidak mereka pakai — dan peringatan yang berbunyi tanpa
       bahaya adalah cara melatih orang mengabaikan peringatan. Test "diam saat dorman" menjaga itu.

     • Begitu jalurnya DIARMED, setiap pembelian diadili angka yang tidak pernah diputuskan. Di
       situ, dan hanya di situ, ia layak berteriak.

   Dan ia TIDAK PERNAH menolak start: mematikan seluruh backend karena satu var yang belum diisi
   menukar risiko sempit dengan situs yang mati.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

const envDasar = () => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
});

describe('plafon belanja reseller CC', () => {
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => warned.mockRestore());

  const pesan = (): string =>
    (warned.mock.calls as unknown[][]).map((a) => String(a[0])).join('\n');
  const berteriak = (): boolean => /HOSHI_CC_MAX_CARD_PRICE_USDC/.test(pesan());

  /* ── DIAM SAAT DORMAN ────────────────────────────────────────────────────────────────────── */

  it.each([
    ['flag tidak ada sama sekali', undefined],
    ['flag kosong', ''],
    ['flag "false"', 'false'],
    // Saklar belanja dibaca `.trim().toLowerCase() === 'true'` — TIDAK ADA nilai yang
    // "kira-kira menyala". Ini menguncinya: "1"/"yes" bukan cara menyalakan belanja.
    ['flag "1" (tidak menyalakan belanja)', '1'],
    ['flag "yes" (tidak menyalakan belanja)', 'yes'],
  ])('%s + plafon kosong → TIDAK berteriak', (_nama, flag) => {
    const env = { ...envDasar() } as Record<string, unknown>;
    if (flag !== undefined) env.HOSHI_CC_RESELL_ENABLED = flag;

    expect(() => validateEnv(env)).not.toThrow();
    expect(berteriak()).toBe(false);
  });

  /* ── BERTERIAK SAAT DIARMED TANPA PLAFON ─────────────────────────────────────────────────── */

  it.each([
    ['plafon tidak ada', undefined],
    ['plafon kosong', ''],
    ['plafon spasi saja', '   '],
  ])('reseller ARMED + %s → BERTERIAK', (_nama, cap) => {
    const env = {
      ...envDasar(),
      HOSHI_CC_RESELL_ENABLED: 'true',
    } as Record<string, unknown>;
    if (cap !== undefined) env.HOSHI_CC_MAX_CARD_PRICE_USDC = cap;

    expect(() => validateEnv(env)).not.toThrow();
    expect(berteriak()).toBe(true);
  });

  it('teriakannya menyebut ANGKA BAWAANNYA — peringatan tanpa angka menyuruh orang menebak', () => {
    validateEnv({ ...envDasar(), HOSHI_CC_RESELL_ENABLED: 'true' });
    const p = pesan();
    expect(p).toMatch(/5000000000/);
    expect(p).toMatch(/\$5\.000 PER KARTU/i);
    // Dan menyebut CARA memperbaikinya, termasuk satuannya — base unit, bukan dolar.
    expect(p).toMatch(/backend\.env/i);
    expect(p).toMatch(/100000000/); // contoh $100 dalam base unit
  });

  it('"TRUE " (huruf besar + spasi) tetap dibaca ARMED — trim+lowercase', () => {
    validateEnv({ ...envDasar(), HOSHI_CC_RESELL_ENABLED: 'TRUE ' });
    expect(berteriak()).toBe(true);
  });

  /* ── DIAM KALAU PLAFONNYA MEMANG DIISI ───────────────────────────────────────────────────── */

  it('reseller ARMED + plafon diisi → TIDAK berteriak', () => {
    validateEnv({
      ...envDasar(),
      HOSHI_CC_RESELL_ENABLED: 'true',
      HOSHI_CC_MAX_CARD_PRICE_USDC: '100000000', // $100
    });
    expect(berteriak()).toBe(false);
  });

  /* Menolak start akan menukar risiko sempit (satu plafon belum diisi) dengan kerusakan total
     (seluruh api.hoshimarket.xyz mati, karena migrasi dan server dirantai dalam satu CMD). */
  it('tidak pernah menjadi alasan backend menolak menyala', () => {
    expect(() =>
      validateEnv({ ...envDasar(), HOSHI_CC_RESELL_ENABLED: 'true' }),
    ).not.toThrow();
  });
});
