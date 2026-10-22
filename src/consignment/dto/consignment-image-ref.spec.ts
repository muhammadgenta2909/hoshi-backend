import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ConsignmentPhotoInput,
  CreateConsignmentListingDto,
} from './consignment.dto';
import { ConsignmentPhotoKind } from '@prisma/client';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   RUJUKAN GAMBAR TITIPAN — test yang menjaga INTAKE TETAP BISA DILAKUKAN DI LAPANGAN.

   Berkas ini lahir dari satu kegagalan yang sangat spesifik dan sangat sulit didiagnosis:

     Droplet produksi tidak punya CLOUDINARY_URL (atau kredensialnya kedaluwarsa). Rute unggah
     gambar PUNYA FALLBACK untuk itu — ia mengembalikan DATA URL base64, dibatasi 2MB. Tapi DTO
     titipan memakai @MaxLength(2000), dan 2MB base64 adalah ~2,7 JUTA karakter.

     Hasilnya: operator berdiri di ruang tamu pemilik kartu, memotret kartunya, dan menerima
     400 "url must be shorter than or equal to 2000 characters". Serah-terimanya tidak bisa
     dicatat sama sekali. Kartunya tidak pernah sampai ke rak, apalagi ke etalase.

   YANG MEMBUATNYA MENYESATKAN: `CreateListingDto.image` (listing Hoshi biasa) tidak punya batas
   panjang sama sekali, dan `main.ts` menaikkan limit body ke 12mb justru UNTUK menampung data URL.
   Jadi di lingkungan yang sama, listing Hoshi tetap jalan dan HANYA titipan yang tumbang — pola
   yang akan dibaca berjam-jam sebagai "bug fitur titipan" padahal ia soal lingkungan.

   KALAU SESEORANG MENGEMBALIKAN @MaxLength(2000) KE FIELD-FIELD INI, test "data URL gambar yang
   sangat panjang DITERIMA" akan merah. Itu memang gunanya. Jangan diperbaiki dengan memperkecil
   fixture-nya — fixture yang dikecilkan memperbaiki test, bukan bug-nya.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Data URL 2MB persis seperti yang dikembalikan rute unggah tanpa Cloudinary (~2,8 juta karakter).
 *  Dihitung SEKALI: membangun string sebesar ini berkali-kali membuat suite ini lambat sendiri. */
const DATA_URL_SEBESAR_BATAS_UNGGAH = `data:image/jpeg;base64,${'A'.repeat(
  Math.ceil((2 * 1024 * 1024 * 4) / 3),
)}`;

/** Jauh di atas batas 2000 lama, tapi murah dibangun — untuk test yang tidak sedang membuktikan
 *  ukuran sebenarnya, melainkan hanya bahwa cabang data URL-nya dipakai. */
const DATA_URL_SEDANG = `data:image/png;base64,${'A'.repeat(50_000)}`;

const errorsOf = <T extends object>(
  obj: object,
  cls: ClassConstructor<T>,
): string[] =>
  validateSync(plainToInstance(cls, obj), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).flatMap((e) => Object.values(e.constraints ?? {}));

describe('rujukan gambar titipan: URL pendek ATAU data URL panjang', () => {
  const foto = (url: string) => ({
    url,
    kind: ConsignmentPhotoKind.FRONT,
  });

  describe('ConsignmentPhotoInput.url', () => {
    it('URL http biasa DITERIMA', () => {
      expect(
        errorsOf(
          foto('https://cdn.hoshi/intake/abc-front.jpg'),
          ConsignmentPhotoInput,
        ),
      ).toEqual([]);
    });

    it('URL relatif DITERIMA', () => {
      expect(
        errorsOf(foto('/uploads/consign/abc-front.jpg'), ConsignmentPhotoInput),
      ).toEqual([]);
    });

    /* ── INI TEST YANG MENJAGA INTAKE DI LAPANGAN ────────────────────────────────────────────
       Kalau ini merah, operator tidak bisa mencatat serah-terima di droplet tanpa Cloudinary. */
    it('data URL gambar sebesar batas unggah (2MB → ~2,7 juta karakter) DITERIMA', () => {
      const url = DATA_URL_SEBESAR_BATAS_UNGGAH;
      expect(url.length).toBeGreaterThan(2_700_000);
      expect(errorsOf(foto(url), ConsignmentPhotoInput)).toEqual([]);
    });

    it('URL biasa yang kelewat panjang (>2000) DITOLAK — batasnya masih ada untuk yang bukan data URL', () => {
      const panjang = `https://cdn.hoshi/${'x'.repeat(2100)}.jpg`;
      expect(errorsOf(foto(panjang), ConsignmentPhotoInput).join(' ')).toMatch(
        /data:image\//,
      );
    });

    /* Ia berakhir di atribut `src`. Satu-satunya alasan ia boleh panjang adalah karena ia GAMBAR. */
    it('data URL yang BUKAN gambar DITOLAK meski pendek', () => {
      expect(
        errorsOf(
          foto('data:text/html;base64,PHNjcmlwdD4='),
          ConsignmentPhotoInput,
        ).join(' '),
      ).toMatch(/data:image\//);
    });

    it('string kosong DITOLAK', () => {
      expect(errorsOf(foto(''), ConsignmentPhotoInput).length).toBeGreaterThan(
        0,
      );
    });
  });

  describe('CreateConsignmentListingDto.image / imageBack', () => {
    const pajang = (over: Record<string, unknown>) => ({
      image: '/uploads/consign/abc-front.jpg',
      ...over,
    });

    it('data URL panjang DITERIMA di image — tombol "Pajang sekarang" tidak boleh mati karenanya', () => {
      expect(
        errorsOf(
          pajang({ image: DATA_URL_SEDANG }),
          CreateConsignmentListingDto,
        ),
      ).toEqual([]);
    });

    it('data URL panjang DITERIMA di imageBack (opsional)', () => {
      expect(
        errorsOf(
          pajang({ imageBack: DATA_URL_SEDANG }),
          CreateConsignmentListingDto,
        ),
      ).toEqual([]);
    });

    it('imageBack boleh tidak ada sama sekali', () => {
      expect(errorsOf(pajang({}), CreateConsignmentListingDto)).toEqual([]);
    });

    it('URL bukan-data yang >2000 tetap DITOLAK di image', () => {
      expect(
        errorsOf(
          pajang({ image: `/uploads/${'x'.repeat(2100)}.jpg` }),
          CreateConsignmentListingDto,
        ).join(' '),
      ).toMatch(/data:image\//);
    });
  });
});
