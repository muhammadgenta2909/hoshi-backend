import { Grader } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  CorrectConsignmentLabelDto,
  CreateConsignmentDto,
} from './consignment.dto';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   TAG MASUK DAFTAR GRADER — DAN DAFTARNYA TETAP DAFTAR.

   Kenapa berkas ini ada, dan kenapa ia menguji DUA HAL SEKALIGUS:

     Hoshi menyimpan kartu fisik milik kolektor Indonesia di raknya. Apa yang tertulis di kolom
     `grader` adalah KLAIM TENTANG KARTU ORANG LAIN — klaim yang tercetak di struk serah-terima,
     tayang sebagai badge slab di marketplace, dan bisa dicek siapa pun di situs grader-nya.

     Sebelum TAG ada di enum, operator yang memegang slab TAG cuma punya dua pilihan: memilih
     grader yang SALAH, atau menandainya "mentah". Dua-duanya berbohong — dan yang kedua bahkan
     mengunci kartunya di rak (kartu tanpa grader ditolak `createListingFor`). Itu yang diperbaiki.

     Tapi perbaikan itu punya cara gagal yang khas: melonggarkan validasinya jadi "terima apa
     saja" supaya TAG lewat. Kalau itu yang terjadi, satu salah ketik ("PSAA", "Tag Grading",
     "TGA") menjadi label PERMANEN pada kartu milik orang lain, dan tidak ada satu lapis pun yang
     berbunyi. Maka kedua sisi dipaku bersama DI SATU BERKAS: nama baru DITERIMA, nama karangan
     tetap DITOLAK.

   KENAPA DI LAPIS DTO, bukan di service: inilah satu-satunya lapis yang berdiri di depan HTTP.
   Test service memakai objek DTO yang sudah dianggap sah, jadi ia tidak bisa membuktikan apa pun
   tentang string yang benar-benar dikirim browser.

   DUA DTO, DUA VALIDATOR YANG BERBEDA — dan itu disengaja:
     · `CreateConsignmentDto.grader`       → `@IsEnum(Grader)`                  (intake; boleh absen)
     · `CorrectConsignmentLabelDto.grader` → `@IsIn([...Object.values(Grader), ''])`
       (koreksi label; string KOSONG punya arti sendiri = "kartunya ternyata MENTAH, kosongkan
        kolomnya" — sesuatu yang `@IsEnum` tidak bisa nyatakan, karena itu validatornya beda.)
   Keduanya membaca enum `Grader` yang DI-GENERATE Prisma, bukan daftar yang diketik ulang. Itu
   alasan menambah grader berikutnya cukup lewat migrasi + schema.prisma.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Bentuk intake paling pendek yang lolos SEMUA validator lain — supaya yang diuji hanya grader. */
const intake = (grader?: unknown) => ({
  consignorNameAtIntake: 'Budi Santoso',
  consignorPhoneAtIntake: '081234567890',
  receivedAtPlace: 'Rumah pemilik, Bandung',
  cardName: 'Charizard Base Set',
  conditionNote: 'Slab utuh, tidak ada retak, label lurus.',
  askPriceIdr: 24_250_000,
  ...(grader === undefined ? {} : { grader }),
});

const intakeGraderErrors = (grader?: unknown) =>
  validateSync(plainToInstance(CreateConsignmentDto, intake(grader)), {
    whitelist: true,
  }).filter((e) => e.property === 'grader');

const correctGraderErrors = (grader: unknown) =>
  validateSync(
    plainToInstance(CorrectConsignmentLabelDto, {
      grader,
      note: 'Dropdown Grader tertinggal kosong saat intake; dicocokkan ulang dengan slab.',
    }),
    { whitelist: true },
  ).filter((e) => e.property === 'grader');

describe('Grader — TAG diterima, grader karangan tetap ditolak', () => {
  it('enum `Grader` memuat TAG TEPAT SETELAH PSA (urutan ini juga urutan sort Postgres)', () => {
    // Urutan di sini BUKAN kosmetik: Postgres mengurutkan enum menurut `enumsortorder`, dan
    // migration `20260926000000_grader_add_tag` menyisipkan TAG dengan `AFTER 'PSA'` supaya
    // urutan database PERSIS sama dengan urutan schema.prisma yang tercermin di sini. Kalau
    // baris ini merah, salah satu dari dua tempat itu bergeser sendirian.
    expect(Object.values(Grader)).toEqual(['PSA', 'TAG', 'CGC', 'BGS']);
  });

  describe('CreateConsignmentDto (intake di teras rumah kolektor)', () => {
    it.each(Object.values(Grader))('menerima %s', (grader) => {
      expect(intakeGraderErrors(grader)).toHaveLength(0);
    });

    it('menerima TAG secara eksplisit — inilah kartu yang dulu tak bisa dicatat jujur', () => {
      expect(intakeGraderErrors('TAG')).toHaveLength(0);
    });

    it('tetap boleh ABSEN — kartu MENTAH masih sah dititipkan (grader null)', () => {
      expect(intakeGraderErrors(undefined)).toHaveLength(0);
    });

    // Daftarnya BERTAMBAH, aturannya TIDAK MELEMAH. 'SGC' dan 'BECKETT' adalah grader SUNGGUHAN
    // yang (masih) di luar enum — dan justru karena sungguhan, merekalah yang paling mungkin
    // diketik operator. 'TGA'/'Tag Grading'/'tag ' adalah salah ketik TAG itu sendiri.
    it.each(['SGC', 'BECKETT', 'TGA', 'Tag Grading', 'tag ', 'PSAA', ''])(
      'menolak %p',
      (grader) => {
        expect(intakeGraderErrors(grader).length).toBeGreaterThan(0);
      },
    );
  });

  describe('CorrectConsignmentLabelDto (koreksi label sesudah serah-terima)', () => {
    it.each(Object.values(Grader))('menerima %s', (grader) => {
      expect(correctGraderErrors(grader)).toHaveLength(0);
    });

    it('menerima STRING KOSONG — artinya "kartunya ternyata MENTAH, kosongkan kolomnya"', () => {
      expect(correctGraderErrors('')).toHaveLength(0);
    });

    it.each(['SGC', 'BECKETT', 'TGA', 'Tag Grading', 'tag', 'PSA '])(
      'menolak %p',
      (grader) => {
        expect(correctGraderErrors(grader).length).toBeGreaterThan(0);
      },
    );
  });
});
