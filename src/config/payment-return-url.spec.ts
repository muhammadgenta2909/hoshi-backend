// WAJIB paling atas: `validateEnv` memakai decorator class-validator, yang membaca metadata lewat
// Reflect. Spec lain kebetulan mendapatkannya karena mereka membangun modul Nest; berkas ini tidak,
// jadi tanpa baris ini seluruh test di sini gagal dengan "Reflect.getMetadata is not a function".
import 'reflect-metadata';
import { validateEnv } from './env.validation';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   HOSHI_PAYMENT_RETURN_URL — var yang dipakai SETIAP penerbitan tagihan tapi dulu tak tervalidasi.

   Ia dibaca `requiredConfig` di tiga jalur, termasuk satu-satunya rail yang menerbitkan tagihan
   untuk kartu TITIPAN. `requiredConfig` melempar saat DIPANGGIL, bukan saat start. Jadi sebelum
   ini: var-nya salah ketik atau terhapus saat menyunting backend.env di droplet → boot BERHASIL,
   log bersih, dashboard hijau — dan kegagalannya muncul berjam-jam kemudian, di depan pembeli
   pertama yang menekan tombol Beli.

   Dua perlakuan berbeda, dan perbedaannya disengaja:
     • nilai CACAT   → DITOLAK KERAS (@IsUrl). Konfigurasi cacat tidak pernah bisa jalan, jadi
                       tidak ada yang dipertukarkan dengan menolaknya.
     • nilai HILANG  → PERINGATAN, backend tetap menyala. Di droplet, migrasi dan server dirantai
                       `&&` dalam satu CMD: boot yang gagal berarti seluruh api.hoshimarket.xyz
                       mati, bukan cuma checkout-nya. Menukar checkout rusak dengan situs mati
                       bukan perbaikan.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Env minimal yang membuat `validateEnv` lolos, supaya tiap test hanya menguji SATU hal. */
const envDasar = () => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
});

describe('HOSHI_PAYMENT_RETURN_URL', () => {
  let warned: jest.SpyInstance;

  beforeEach(() => {
    warned = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => warned.mockRestore());

  const pesanPeringatan = (): string =>
    (warned.mock.calls as unknown[][])
      .map((args) => String(args[0]))
      .join('\n');

  it('URL yang benar: lolos, tanpa peringatan', () => {
    expect(() =>
      validateEnv({
        ...envDasar(),
        HOSHI_PAYMENT_RETURN_URL: 'https://hoshimarket.xyz/open-packs',
      }),
    ).not.toThrow();
    expect(pesanPeringatan()).not.toContain('HOSHI_PAYMENT_RETURN_URL');
  });

  it('localhost tanpa TLD tetap diterima — lingkungan dev memakainya', () => {
    expect(() =>
      validateEnv({
        ...envDasar(),
        HOSHI_PAYMENT_RETURN_URL: 'http://localhost:3000/open-packs',
      }),
    ).not.toThrow();
  });

  /* ── NILAI CACAT: DITOLAK KERAS ──────────────────────────────────────────────────────────── */

  it.each([
    ['tanpa protokol', 'hoshimarket.xyz/open-packs'],
    ['cuma path', '/open-packs'],
    ['teks sembarang', 'ganti nanti'],
  ])('%s DITOLAK saat boot', (_nama, nilai) => {
    expect(() =>
      validateEnv({ ...envDasar(), HOSHI_PAYMENT_RETURN_URL: nilai }),
    ).toThrow(/HOSHI_PAYMENT_RETURN_URL/);
  });

  /* ── NILAI HILANG: PERINGATAN, BUKAN MATI ───────────────────────────────────────────────── */

  it.each([
    ['tidak ada sama sekali', undefined],
    ['string kosong', ''],
    ['spasi saja', '   '],
  ])('%s: TIDAK mematikan boot, tapi berteriak di log', (_nama, nilai) => {
    const env = { ...envDasar() } as Record<string, unknown>;
    if (nilai !== undefined) env.HOSHI_PAYMENT_RETURN_URL = nilai;

    expect(() => validateEnv(env)).not.toThrow();

    const pesan = pesanPeringatan();
    expect(pesan).toContain('HOSHI_PAYMENT_RETURN_URL');
    // Peringatan yang tidak menyebut AKIBATNYA akan dibaca sebagai berisik lalu diabaikan.
    expect(pesan).toMatch(/tagihan/i);
    expect(pesan).toMatch(/TITIPAN/i);
    // Dan yang tidak menyebut CARA MEMPERBAIKINYA memaksa orang menebak saat panik.
    expect(pesan).toMatch(/backend\.env/i);
  });

  /* Menolak start di sini akan menukar checkout yang rusak dengan SELURUH situs yang mati —
     di droplet `prisma migrate deploy && node dist/main` dirantai, jadi boot gagal = backend
     tidak pernah naik. Test ini yang menahan perubahan itu. */
  it('var yang hilang TIDAK BOLEH menjadi alasan backend menolak menyala', () => {
    expect(() => validateEnv(envDasar())).not.toThrow();
  });
});
