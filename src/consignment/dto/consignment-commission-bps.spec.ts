import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateConsignmentDto } from './consignment.dto';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   PLAFON KOMISI TITIPAN — test yang menjaga SATU NOL KELEBIHAN DITOLAK DI DEPAN.

   Kegagalan yang dijaga berkas ini, dan ia tidak butuh bug lain untuk terjadi:

     `Consignment.commissionBps` DI-SNAPSHOT dari apa yang operator ketik saat intake, lalu
     dipakai apa adanya berbulan-bulan kemudian ketika kartunya terjual. Plafon DTO-nya dulu
     @Max(10_000) — 100%, sah secara aritmetika dan MUSTAHIL secara bisnis. Komisi Hoshi 5%.
     Satu nol kelebihan (500 → 5000, 1000 → 10000) lolos validasi tanpa satu pun peringatan.

     Yang terjadi kemudian: `commission = paidBaseIdrx`, `payout = 0`. Sampai perbaikan di
     `fulfilConsignment`, settlement tetap commit penuh — listing SOLD, order FULFILLED, email
     "kartumu terjual" terkirim — dan pemilik kartu menerima NOL tanpa satu baris BalanceEntry pun.

   KENAPA DUA LAPIS, dan kenapa yang ini yang paling murah:

     Lapis settlement (`ConsignmentPayoutEmpty`) menolak SESUDAH pembeli membayar: ongkosnya satu
     refund manual + satu penjualan yang batal. Lapis DI SINI menolak pada detik angkanya diketik,
     saat pemilik kartu masih berdiri di depan meja dan salah ketiknya masih bisa dibetulkan.

   3.000 bps (30%) dipilih SENGAJA longgar terhadap kesepakatan khusus (titipan bernilai kecil,
   kartu yang butuh restorasi/grading ulang) dan tetap KETAT terhadap salah ketik satu nol.
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

/** Bentuk intake paling pendek yang lolos SEMUA validator lain — supaya yang diuji hanya komisi. */
const intake = (commissionBps?: number) => ({
  consignorNameAtIntake: 'Budi Santoso',
  consignorPhoneAtIntake: '081234567890',
  receivedAtPlace: 'Rumah pemilik, Bandung',
  cardName: 'Charizard Base Set',
  conditionNote: 'Slab utuh, tidak ada retak, label lurus.',
  askPriceIdr: 24_250_000,
  ...(commissionBps === undefined ? {} : { commissionBps }),
});

const commissionErrors = (commissionBps?: number) =>
  validateSync(plainToInstance(CreateConsignmentDto, intake(commissionBps)), {
    whitelist: true,
  }).filter((e) => e.property === 'commissionBps');

describe('CreateConsignmentDto.commissionBps — plafon BISNIS, bukan plafon matematis', () => {
  it('MENOLAK 10.000 bps (100%): salah ketik satu nol yang membuat bagian pemilik NOL', () => {
    // Inilah nilai yang dulu lolos. Ia berarti "Hoshi mengambil seluruh hasil penjualan kartu
    // orang lain" — kalimat yang tidak pernah ada di perjanjian mana pun yang ditandatangani
    // siapa pun, dan yang baru ketahuan berbulan-bulan kemudian, sesudah pembeli membayar.
    const errors = commissionErrors(10_000);
    expect(errors).toHaveLength(1);
    expect(errors[0].constraints).toHaveProperty('max');
  });

  it('MENOLAK 5.000 bps (50%) — bentuk salah ketik yang sama, dari nilai default 500', () => {
    expect(commissionErrors(5_000)).toHaveLength(1);
  });

  it('MENERIMA 500 bps (5%) — angka perjanjian yang sebenarnya', () => {
    expect(commissionErrors(500)).toHaveLength(0);
  });

  it('MENERIMA 3.000 bps (30%) — plafonnya sendiri, untuk kesepakatan khusus yang sah', () => {
    // Yang salah bukan "komisi besar", melainkan komisi yang tidak menyisakan APA PUN bagi
    // pemilik kartu. Menurunkan plafon ini sampai menolak kesepakatan khusus yang sah akan
    // memindahkan masalahnya ke operator yang mencari jalan memutar.
    expect(commissionErrors(3_000)).toHaveLength(0);
  });

  it('MENERIMA nilai kosong — defaultnya 500 bps dari schema, bukan dari DTO', () => {
    expect(commissionErrors(undefined)).toHaveLength(0);
  });

  it('MENOLAK nilai negatif — komisi minus berarti Hoshi membayar lebih dari yang diterimanya', () => {
    expect(commissionErrors(-100)).toHaveLength(1);
  });
});
