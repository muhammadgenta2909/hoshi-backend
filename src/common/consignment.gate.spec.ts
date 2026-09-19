import { ConsignmentStatus } from '@prisma/client';
import {
  CONSIGNMENT_EXITS,
  CONSIGNMENT_TERMINAL_STATUSES,
  acceptCustodyClaimWhere,
  assertConsignmentSaleAvailable,
  consignmentSaleClaimWhere,
  inCustodyWhere,
  isInHoshiCustody,
  listClaimWhere,
  liveConsignmentWhere,
  takeDownClaimWhere,
} from './consignment.gate';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ PREDIKAT CUSTODY — kembar FISIK dari `p2p.gate.spec.ts`.                                     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Yang dijaga file ini persis satu hal: "boleh dijual" bersandar pada FAKTA TERSIMPAN tentang di
 * mana kartunya berada — bukan pada flag, bukan pada status saja, bukan pada bentuk baris.
 */
describe('consignment.gate', () => {
  const ACCEPTED = new Date('2026-09-01T00:00:00.000Z');
  const RELEASED = new Date('2026-09-10T00:00:00.000Z');

  const facts = (over: {
    status: ConsignmentStatus;
    custodyAcceptedAt?: Date | null;
    custodyReleasedAt?: Date | null;
  }) => ({
    id: 'c-1',
    status: over.status,
    custodyAcceptedAt:
      over.custodyAcceptedAt === undefined ? ACCEPTED : over.custodyAcceptedAt,
    custodyReleasedAt: over.custodyReleasedAt ?? null,
  });

  describe('isInHoshiCustody', () => {
    it('TRUE hanya kalau KETIGA fakta benar: diterima, belum dilepas, status IN_CUSTODY/LISTED', () => {
      expect(
        isInHoshiCustody(facts({ status: ConsignmentStatus.IN_CUSTODY })),
      ).toBe(true);
      expect(
        isInHoshiCustody(facts({ status: ConsignmentStatus.LISTED })),
      ).toBe(true);
    });

    it('FALSE saat serah-terima belum pernah tercatat — ini yang menutup risiko jual-ganda', () => {
      // Kesepakatan sudah ada, kartunya masih di tangan pemiliknya. Selama stempel ini null,
      // TIDAK ADA listing titipan yang boleh lahir — dan orang yang belum menyerahkan kartunya
      // memang masih bisa menjualnya sendiri ke orang lain. Urutannya yang menutup risikonya.
      expect(
        isInHoshiCustody(
          facts({ status: ConsignmentStatus.INTAKE, custodyAcceptedAt: null }),
        ),
      ).toBe(false);
    });

    it('FALSE begitu kartunya KELUAR, apa pun sebabnya (ditarik / dikirim / hilang)', () => {
      for (const status of [
        ConsignmentStatus.RELEASED,
        ConsignmentStatus.LOST,
      ]) {
        expect(
          isInHoshiCustody(facts({ status, custodyReleasedAt: RELEASED })),
        ).toBe(false);
      }
    });

    it('FALSE untuk SOLD walau kartunya masih di rak — kartunya sudah MILIK PEMBELI', () => {
      // Inilah kenapa `status` ikut dibaca: stempel accepted-nya ada dan released-nya belum,
      // jadi dua syarat pertama saja akan MELOLOSKAN baris SOLD — dan baris SOLD tidak boleh
      // bisa dijual lagi maupun ditarik oleh pemilik lamanya.
      expect(isInHoshiCustody(facts({ status: ConsignmentStatus.SOLD }))).toBe(
        false,
      );
    });

    it('FALSE untuk baris CANCELLED (kesepakatan batal sebelum ada kartu yang berpindah)', () => {
      expect(
        isInHoshiCustody(
          facts({
            status: ConsignmentStatus.CANCELLED,
            custodyAcceptedAt: null,
          }),
        ),
      ).toBe(false);
    });

    it('FAKTA, BUKAN FLAG: nilai kembalinya tidak bergantung pada apa pun selain ketiga kolom itu', () => {
      // Pelajaran `escrowedAt`. Tidak ada env, tidak ada ConfigService, tidak ada jam dinding di
      // tanda tangan fungsinya — jadi tidak ada cara flag berubah mengubah kebenaran tentang
      // kartu yang sudah berpindah tangan.
      expect(isInHoshiCustody.length).toBe(1);
    });
  });

  describe('inCustodyWhere — terjemahan SQL dari predikatnya', () => {
    it('adalah terjemahan HARFIAH; kalau keduanya menyimpang, salah satunya bohong', () => {
      expect(inCustodyWhere()).toEqual({
        custodyAcceptedAt: { not: null },
        custodyReleasedAt: null,
        status: {
          in: [ConsignmentStatus.IN_CUSTODY, ConsignmentStatus.LISTED],
        },
      });
    });

    it('cocok untuk TIAP status yang predikat TS-nya terima, dan tidak lebih', () => {
      const where = inCustodyWhere();
      const statusIn = where.status as { in: ConsignmentStatus[] };
      for (const status of Object.values(ConsignmentStatus)) {
        const row = facts({ status });
        const sqlSaysYes =
          row.custodyAcceptedAt !== null &&
          row.custodyReleasedAt === null &&
          statusIn.in.includes(status);
        expect(sqlSaysYes).toBe(isInHoshiCustody(row));
      }
    });

    it('OBJEK BARU tiap panggilan — satu pemanggil tidak bisa memutasi pagar pemanggil lain', () => {
      expect(inCustodyWhere()).not.toBe(inCustodyWhere());
      expect(liveConsignmentWhere()).not.toBe(liveConsignmentWhere());
    });
  });

  describe('assertConsignmentSaleAvailable — gerbang SEBELUM uang bergerak', () => {
    it('lolos diam-diam untuk kartu yang memang ada di rak', () => {
      expect(() =>
        assertConsignmentSaleAvailable(
          facts({ status: ConsignmentStatus.LISTED }),
          'listing-1',
        ),
      ).not.toThrow();
    });

    it('menolak dengan stage NO_EFFECT: NOL Rupiah diambil, jadi tidak ada utang refund', () => {
      try {
        assertConsignmentSaleAvailable(
          facts({
            status: ConsignmentStatus.RELEASED,
            custodyReleasedAt: RELEASED,
          }),
          'listing-1',
        );
        throw new Error('seharusnya melempar');
      } catch (err) {
        const body = (err as { response: Record<string, unknown> }).response;
        expect(body.code).toBe('CONSIGNMENT_NOT_IN_CUSTODY');
        expect(body.stage).toBe('NO_EFFECT');
        expect(body.retryable).toBe(true);
        expect(body.listingId).toBe('listing-1');
        expect(body.consignmentId).toBe('c-1');
      }
    });

    it('pesannya MEMBEDAKAN "belum pernah diserahkan" dari "sudah keluar" — pemulihannya beda', () => {
      const never = (() => {
        try {
          assertConsignmentSaleAvailable(
            facts({
              status: ConsignmentStatus.INTAKE,
              custodyAcceptedAt: null,
            }),
            'l',
          );
        } catch (e) {
          return String(
            (e as { response: { message: string } }).response.message,
          );
        }
        return '';
      })();
      const gone = (() => {
        try {
          assertConsignmentSaleAvailable(
            facts({
              status: ConsignmentStatus.LOST,
              custodyReleasedAt: RELEASED,
            }),
            'l',
          );
        } catch (e) {
          return String(
            (e as { response: { message: string } }).response.message,
          );
        }
        return '';
      })();
      expect(never).toContain('belum tercatat');
      expect(gone).toContain('sudah tidak lagi');
      expect(never).not.toBe(gone);
      // KEDUANYA wajib menyatakan bahwa tidak ada uang yang diambil — itu isi janji NO_EFFECT.
      for (const m of [never, gone]) {
        expect(m).toContain('tidak ada uang yang diambil');
      }
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ KLAIM ATOMIK: gerbangnya ADALAH predikatnya. Kalau `where`-nya melonggar, gerbangnya       ║
   * ║ melonggar — tanpa satu baris `if` pun berubah.                                            ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   */
  describe('predikat klaim atomik', () => {
    it('acceptCustody: HANYA dari INTAKE, dan HANYA kalau stempelnya belum pernah ditulis', () => {
      // `custodyAcceptedAt: null` inilah yang membuat "ditulis sekali" jadi properti DB, bukan
      // properti urutan kode. Menghapusnya berarti dua permintaan bersamaan bisa dua-duanya
      // "menerima" kartu yang sama, dengan stempel waktu yang berbeda.
      expect(acceptCustodyClaimWhere('c-1')).toEqual({
        id: 'c-1',
        status: ConsignmentStatus.INTAKE,
        custodyAcceptedAt: null,
      });
    });

    it('list: menuntut custody TERBUKTI ada — inilah invarian utama fitur ini', () => {
      // `Listing.create` yang menulis consignmentId berjalan di transaksi yang SAMA dengan klaim
      // ini. Jadi baris Listing titipan tidak bisa LAHIR tanpa custody. Kalau predikat ini
      // kehilangan `custodyAcceptedAt`, listing bisa tayang untuk kartu yang masih dipegang
      // pemiliknya — yaitu persis risiko yang seluruh fitur ini dibangun untuk menutupnya.
      expect(listClaimWhere('c-1')).toEqual({
        id: 'c-1',
        status: ConsignmentStatus.IN_CUSTODY,
        custodyAcceptedAt: { not: null },
        custodyReleasedAt: null,
        listing: { is: null },
      });
    });

    it('settlement dan penarikan menamai STATUS SUMBER YANG SAMA (LISTED) — itu yang bikin keduanya tidak mungkin sama-sama menang', () => {
      const sale = consignmentSaleClaimWhere('c-1');
      const takeDown = takeDownClaimWhere('c-1');
      expect(sale.status).toBe(ConsignmentStatus.LISTED);
      expect(takeDown.status).toBe(ConsignmentStatus.LISTED);
      // Keduanya juga menuntut kartunya masih di rak.
      expect(sale.custodyReleasedAt).toBeNull();
      expect(takeDown.custodyReleasedAt).toBeNull();
    });

    it('settlement menuntut custody, bukan sekadar status — penarikan yang menang balapan membuatnya cocok 0 baris', () => {
      expect(consignmentSaleClaimWhere('c-1')).toEqual({
        id: 'c-1',
        status: ConsignmentStatus.LISTED,
        custodyAcceptedAt: { not: null },
        custodyReleasedAt: null,
      });
    });
  });

  /**
   * `liveConsignmentWhere` adalah padanan TS dari partial unique index
   * `consignments_active_cert_uniq`. Keduanya harus berbunyi sama, kalau tidak pemeriksaan
   * aplikasi dan pagar DB akan menolak himpunan baris yang berbeda.
   */
  describe('liveConsignmentWhere — kunci anti-dobel-titip', () => {
    it('lebih LUAS dari custody: INTAKE ikut mengunci nomor sertifikat (kartunya cuma satu)', () => {
      expect(liveConsignmentWhere()).toEqual({
        custodyReleasedAt: null,
        status: { not: ConsignmentStatus.CANCELLED },
      });
    });

    it('CANCELLED dikecualikan: kesepakatan yang batal harus MELEPAS nomor sertifikatnya', () => {
      // Kalau tidak, satu intake yang ditinggalkan akan mengunci kartu itu dari Hoshi selamanya —
      // termasuk dari pemiliknya sendiri kalau suatu saat ia mau menitipkannya lagi.
      const where = liveConsignmentWhere();
      const matches = (row: {
        status: ConsignmentStatus;
        custodyReleasedAt: Date | null;
      }) =>
        row.custodyReleasedAt === null &&
        row.status !== (where.status as { not: ConsignmentStatus }).not;
      expect(
        matches({
          status: ConsignmentStatus.CANCELLED,
          custodyReleasedAt: null,
        }),
      ).toBe(false);
      expect(
        matches({ status: ConsignmentStatus.INTAKE, custodyReleasedAt: null }),
      ).toBe(true);
    });
  });

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ KETERJANGKAUAN JALAN KELUAR — atas SELURUH enum, bukan atas daftar yang ditulis tangan.   ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Pola yang sama dengan `redemption-exit-reachability.spec.ts`, dan alasannya sama: memblokir
   * tanpa jalan keluar = mengunci barang orang lain. Di sini barangnya KARTU FISIK MILIK ORANG
   * LAIN, jadi "terjebak di satu status" berarti seseorang tidak bisa mengambil kembali miliknya.
   */
  describe('keterjangkauan jalan keluar (seluruh enum)', () => {
    it('SETIAP nilai ConsignmentStatus punya baris di tabel jalan keluar', () => {
      for (const status of Object.values(ConsignmentStatus)) {
        expect(CONSIGNMENT_EXITS[status]).toBeDefined();
      }
      expect(Object.keys(CONSIGNMENT_EXITS).sort()).toEqual(
        Object.values(ConsignmentStatus).sort(),
      );
    });

    it('status NON-terminal punya minimal satu jalan keluar; terminal punya NOL — dan keduanya disengaja', () => {
      for (const status of Object.values(ConsignmentStatus)) {
        const exits = CONSIGNMENT_EXITS[status];
        const terminal = CONSIGNMENT_TERMINAL_STATUSES.includes(status);
        expect(exits.length > 0).toBe(!terminal);
      }
    });

    it('setiap status TERJANGKAU dari INTAKE — tak ada pulau yang tidak bisa dimasuki', () => {
      const seen = new Set<ConsignmentStatus>([ConsignmentStatus.INTAKE]);
      const queue: ConsignmentStatus[] = [ConsignmentStatus.INTAKE];
      while (queue.length > 0) {
        for (const next of CONSIGNMENT_EXITS[queue.shift()!]) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect([...seen].sort()).toEqual(Object.values(ConsignmentStatus).sort());
    });

    it('dari SETIAP status, minimal satu status TERMINAL bisa dicapai — tak ada baris yang terjebak selamanya', () => {
      const reachesTerminal = (from: ConsignmentStatus): boolean => {
        const seen = new Set<ConsignmentStatus>([from]);
        const queue = [from];
        while (queue.length > 0) {
          const cur = queue.shift()!;
          if (CONSIGNMENT_TERMINAL_STATUSES.includes(cur)) return true;
          for (const next of CONSIGNMENT_EXITS[cur]) {
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
        return false;
      };
      for (const status of Object.values(ConsignmentStatus)) {
        expect(reachesTerminal(status)).toBe(true);
      }
    });

    it('SOLD TIDAK PERNAH kembali ke tangan penjual — kartunya sudah milik pembeli', () => {
      // Kalau baris ini pernah merah, seseorang menambahkan jalur "batalkan penjualan" yang
      // mengembalikan kartu yang sudah dibayar orang lain.
      expect(CONSIGNMENT_EXITS[ConsignmentStatus.SOLD]).not.toContain(
        ConsignmentStatus.IN_CUSTODY,
      );
      expect(CONSIGNMENT_EXITS[ConsignmentStatus.SOLD]).not.toContain(
        ConsignmentStatus.LISTED,
      );
    });

    it('CANCELLED hanya terjangkau dari INTAKE — kesepakatan hanya bisa batal SEBELUM kartunya berpindah', () => {
      for (const status of Object.values(ConsignmentStatus)) {
        if (status === ConsignmentStatus.INTAKE) continue;
        expect(CONSIGNMENT_EXITS[status]).not.toContain(
          ConsignmentStatus.CANCELLED,
        );
      }
    });
  });
});
