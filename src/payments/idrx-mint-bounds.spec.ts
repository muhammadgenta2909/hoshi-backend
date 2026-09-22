import {
  BPS_DENOMINATOR,
  CHARGEABLE_PRICE_MAX_IDRX,
  CHARGEABLE_PRICE_MIN_IDRX,
  IDRX_MAX_MINT_IDR,
  IDRX_MIN_MINT_IDR,
  QRIS_FEE_BPS,
  chargeableIdrFor,
  chargeablePriceRangeSentence,
  isChargeablePrice,
} from './idrx-mint-bounds';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   RENTANG HARGA YANG BENAR-BENAR BISA DITAGIHKAN

   Batas IDRX berlaku pada nominal yang DITAGIHKAN, bukan pada harga kartunya — fee QRIS ~0,7%
   ditambahkan DI ATAS harga. Jadi rentang harga kartu yang sah lebih SEMPIT daripada rentang mint,
   dan selisihnya justru di tempat yang mudah salah: Rp 19.900 terlihat "di atas Rp 20.000"? tidak.

   Kalau batas ini meleset SATU rupiah, akibatnya bukan error — melainkan kartu yang tayang di
   marketplace dengan tombol Beli menyala dan tagihan yang tidak pernah bisa terbit. Nol Rupiah
   hilang, dan justru itu yang membuatnya tidak ketahuan: tidak operator, tidak pemilik kartunya.

   Test di bawah menekan PERSIS di batasnya, dari kedua sisi.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('batas harga yang bisa ditagihkan', () => {
  it('fee QRIS ditambahkan DI ATAS harga, dibulatkan ke atas, murni integer', () => {
    expect(chargeableIdrFor(1_000_000)).toBe(1_007_000);
    // 100.001 x 1,007 = 100.701,007 → dibulatkan KE ATAS, bukan ke terdekat.
    expect(chargeableIdrFor(100_001)).toBe(100_702);
    expect(QRIS_FEE_BPS).toBe(70);
    expect(BPS_DENOMINATOR).toBe(10_000);
  });

  describe('batas BAWAH', () => {
    it('harga terendah yang sah menghasilkan tagihan >= minimum mint', () => {
      expect(
        chargeableIdrFor(CHARGEABLE_PRICE_MIN_IDRX),
      ).toBeGreaterThanOrEqual(IDRX_MIN_MINT_IDR);
    });

    it('SATU rupiah di bawahnya sudah menghasilkan tagihan yang ditolak gateway', () => {
      expect(chargeableIdrFor(CHARGEABLE_PRICE_MIN_IDRX - 1)).toBeLessThan(
        IDRX_MIN_MINT_IDR,
      );
    });

    /* Jebakan yang paling mungkin terjadi: harga di atas minimum MINT tapi di bawah minimum
       HARGA. Tanpa pembedaan ini, orang akan mengira Rp 20.000 aman padahal yang diuji salah
       besaran. (Kebetulan Rp 20.000 memang sah; yang TIDAK sah adalah Rp 19.860 ke bawah.) */
    it('membedakan "minimum mint" dari "minimum harga kartu"', () => {
      expect(CHARGEABLE_PRICE_MIN_IDRX).toBeLessThan(IDRX_MIN_MINT_IDR);
      expect(isChargeablePrice(IDRX_MIN_MINT_IDR)).toBe(true);
    });
  });

  describe('batas ATAS', () => {
    it('harga tertinggi yang sah menghasilkan tagihan <= maksimum mint', () => {
      expect(chargeableIdrFor(CHARGEABLE_PRICE_MAX_IDRX)).toBeLessThanOrEqual(
        IDRX_MAX_MINT_IDR,
      );
    });

    it('SATU rupiah di atasnya sudah melewati maksimum mint', () => {
      expect(chargeableIdrFor(CHARGEABLE_PRICE_MAX_IDRX + 1)).toBeGreaterThan(
        IDRX_MAX_MINT_IDR,
      );
    });

    /* Ini yang menangkap kesalahan "pakai batas mint sebagai batas harga": harga tepat di
       maksimum mint justru TIDAK sah, karena fee-nya mendorongnya lewat. */
    it('harga tepat sebesar maksimum MINT justru DITOLAK — fee-nya mendorongnya lewat', () => {
      expect(isChargeablePrice(IDRX_MAX_MINT_IDR)).toBe(false);
      expect(CHARGEABLE_PRICE_MAX_IDRX).toBeLessThan(IDRX_MAX_MINT_IDR);
    });
  });

  describe('isChargeablePrice', () => {
    it.each([
      ['tepat di batas bawah', CHARGEABLE_PRICE_MIN_IDRX, true],
      ['satu di bawah batas bawah', CHARGEABLE_PRICE_MIN_IDRX - 1, false],
      ['tepat di batas atas', CHARGEABLE_PRICE_MAX_IDRX, true],
      ['satu di atas batas atas', CHARGEABLE_PRICE_MAX_IDRX + 1, false],
      ['harga kartu graded murah yang tidak sah', 15_000, false],
      ['harga kartu kelas atas yang tidak sah', 1_200_000_000, false],
      ['harga wajar di tengah', 24_250_000, true],
      ['nol', 0, false],
      ['negatif', -1, false],
    ])('%s', (_nama, harga, harapan) => {
      expect(isChargeablePrice(harga)).toBe(harapan);
    });

    it('menolak pecahan — rupiah tidak punya sen di jalur ini', () => {
      expect(isChargeablePrice(50_000.5)).toBe(false);
    });
  });

  /* Pesan error dan tulisan di layar admin TIDAK BOLEH menyuruh orang menebak batasnya. Operator
     sedang berdiri di depan pemilik kartu; "harga tidak valid" tanpa angka membuat ia menebak. */
  it('kalimat batasnya menyebut kedua angkanya', () => {
    const s = chargeablePriceRangeSentence();
    expect(s).toContain(CHARGEABLE_PRICE_MIN_IDRX.toLocaleString('id-ID'));
    expect(s).toContain(CHARGEABLE_PRICE_MAX_IDRX.toLocaleString('id-ID'));
  });

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     ANGKA HARI INI — DAN TEST INI ADALAH SATU-SATUNYA HAL YANG MENJAGA SALINANNYA DI FRONTEND.

     Formulir intake titipan menampilkan rentang ini kepada operator SEBELUM ia menyepakati harga
     dengan pemilik kartu, dan ia menahan tombol Simpan dengan ambang yang sama. Tapi nilainya
     TIDAK terekspos lewat rute mana pun, jadi frontend MENYALINNYA sebagai angka ketikan di:

         c:\GENTA\hoshi-poc-solana\lib\consignment.ts
         → CHARGEABLE_PRICE_MIN_IDR / CHARGEABLE_PRICE_MAX_IDR

     Salinan angka uang yang bisa berbeda sendiri adalah bagaimana sebuah kartu tayang dengan
     tombol Beli menyala sementara tagihannya tidak pernah bisa terbit — kelas bug yang sama yang
     seluruh berkas ini dibangun untuk menutup. Repo frontend TIDAK PUNYA test runner sama sekali,
     jadi tidak ada apa pun di sana yang bisa berbunyi kalau salinannya basi.

     ⚠️ KALAU TEST INI MERAH karena `QRIS_FEE_BPS` atau batas mint berubah: jangan cuma
     memperbarui angka di bawah. PERBARUI JUGA BERKAS FRONTEND DI ATAS pada perubahan yang sama.
     ══════════════════════════════════════════════════════════════════════════════════════════ */
  it('nilainya hari ini: Rp 19.860 – Rp 993.048.659', () => {
    expect(CHARGEABLE_PRICE_MIN_IDRX).toBe(19_860);
    expect(CHARGEABLE_PRICE_MAX_IDRX).toBe(993_048_659);
  });

  /**
   * PENJAGA DRIFT YANG BENAR-BENAR BERBUNYI, bukan sekadar komentar di atas.
   *
   * Membaca salinan frontend LANGSUNG dari disk dan membandingkannya. Kalau checkout frontend-nya
   * tidak ada di sebelah (CI yang hanya mengambil backend, misalnya), test ini LEWAT dengan tenang
   * — ia tidak punya hak menggagalkan build karena sebuah repo lain tidak ada.
   *
   * Itu membuatnya tidak berguna di CI, dan memang begitu: yang diincar adalah MESIN ORANG YANG
   * MENGUBAH FEE-nya. Di situlah kedua repo ada bersebelahan, dan di situlah satu-satunya momen
   * drift-nya bisa ditangkap sebelum sampai ke produksi.
   */
  it('salinan di frontend tidak boleh basi', () => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    /* eslint-enable @typescript-eslint/no-require-imports */

    const berkas = path.resolve(
      __dirname,
      '../../../hoshi-poc-solana/lib/consignment.ts',
    );
    if (!fs.existsSync(berkas)) return; // frontend tidak ada di sebelah — bukan urusan test ini

    const isi = fs.readFileSync(berkas, 'utf8');
    const angka = (nama: string): number | null => {
      const m = new RegExp(`${nama}\\s*=\\s*([0-9_]+)`).exec(isi);
      return m ? Number(m[1].replace(/_/g, '')) : null;
    };

    const min = angka('CHARGEABLE_PRICE_MIN_IDR');
    const max = angka('CHARGEABLE_PRICE_MAX_IDR');
    // Konstantanya hilang/berganti nama = penjaga ini mati diam-diam. Itu harus terlihat.
    expect({ min, max }).not.toEqual({ min: null, max: null });

    expect(min).toBe(CHARGEABLE_PRICE_MIN_IDRX);
    expect(max).toBe(CHARGEABLE_PRICE_MAX_IDRX);
  });

  /* ── JEBAKAN SATU RUPIAH, DICATAT SUPAYA TIDAK DIULANG ────────────────────────────────────
     Menghitung batas bawah sebagai bilangan real memberi jawaban yang MELESET SATU:
         20.000 / 1,007 = 19.860,97…  → dibulatkan ke atas → 19.861
     Tapi jalur bayar tidak membagi harga; ia MENGALIKAN lalu membulatkan ke atas:
         ceil(19.860 × 10.070 / 10.000) = ceil(19.999,02) = 20.000  ✓ sah
     Jadi 19.860 BISA ditagihkan, dan menolaknya berarti menolak harga yang sebenarnya sah.
     Inilah alasan kedua batas dihitung dengan merapatkan diri ke `chargeableIdrFor`, bukan
     dengan rumus pembagian — dan alasan test ini menekan persis di batasnya dari dua sisi. */
  it('19.860 sah meski pembagian real menyarankan 19.861', () => {
    expect(chargeableIdrFor(19_860)).toBe(IDRX_MIN_MINT_IDR);
    expect(isChargeablePrice(19_860)).toBe(true);
    expect(chargeableIdrFor(19_859)).toBeLessThan(IDRX_MIN_MINT_IDR);
    expect(isChargeablePrice(19_859)).toBe(false);
  });
});
