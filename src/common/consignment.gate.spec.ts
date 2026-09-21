import { ConsignmentStatus } from '@prisma/client';
import {
  CONSIGNMENT_EXITS,
  CONSIGNMENT_TERMINAL_STATUSES,
  acceptCustodyClaimWhere,
  assertConsignmentSaleAvailable,
  awaitingConsignorWhere,
  claimCodeRedeemWhere,
  consignmentSaleClaimWhere,
  inCustodyWhere,
  isAwaitingConsignorClaim,
  isConsignorLinked,
  isInHoshiCustody,
  isReturnAddressComplete,
  isReturnPlanReady,
  linkConsignorClaimWhere,
  listClaimWhere,
  liveConsignmentWhere,
  missingReturnAddressFields,
  requireLinkedConsignorId,
  takeDownClaimWhere,
  withdrawnReleaseClaimWhere,
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
        consignorId: { not: null },
        listing: { is: null },
      });
    });

    it('list: menuntut PEMILIKNYA TERTAUT — kartu di rak tanpa pemilik tidak boleh dipajang', () => {
      // Syarat KEDUA, dan sebabnya berbeda dari syarat custody. Sejak titipan bisa diterima dari
      // orang yang belum punya akun (kode klaim di tanda terima), "kartunya ada di rak" TIDAK
      // LAGI berarti "boleh dijual": `fulfilConsignment` mengkredit `sellerId`, dan tanpa pemilik
      // tertaut tidak ada nilai jujur untuk diisikan ke sana. Menjualnya berarti Hoshi memegang
      // Rupiah milik seseorang tanpa punya cara menyalurkannya — SESUDAH pembeli membayar.
      //
      // Syarat ini ada DI DALAM PREDIKAT KLAIM (bukan sebagai `if` di service) dengan alasan yang
      // sama persis dengan syarat custody: `createListingFor` adalah satu-satunya penulis
      // `Listing.consignmentId` dan ia membuat baris listing di transaksi yang SAMA dengan klaim
      // ini. Menghapus baris ini membuat listing untuk titipan tanpa pemilik jadi MUNGKIN.
      expect(listClaimWhere('c-1').consignorId).toEqual({ not: null });
    });

    it('custody dan pemilik TIDAK BOLEH DISATUKAN: dua pertanyaan, dua pemulihan', () => {
      // "Kartunya ada?" dan "siapa yang dibayar?" adalah dua pertanyaan berbeda dengan pemulihan
      // berbeda. `isInHoshiCustody` SENGAJA tidak membaca `consignorId`, dan `isConsignorLinked`
      // SENGAJA tidak membaca stempel custody — kalau salah satu mulai membaca yang lain,
      // penolakannya akan menyarankan pemulihan yang tidak bisa berhasil.
      //
      // Kombinasi di bawah ini DULU MUSTAHIL (consignorId NOT NULL) dan sekarang NORMAL.
      const heldButUnclaimed = {
        id: 'c-1',
        status: ConsignmentStatus.IN_CUSTODY,
        custodyAcceptedAt: ACCEPTED,
        custodyReleasedAt: null,
        consignorId: null,
      };
      expect(isInHoshiCustody(heldButUnclaimed)).toBe(true);
      expect(isConsignorLinked(heldButUnclaimed)).toBe(false);
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
   * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ PEMILIKNYA — pertanyaan KEDUA, dan gerbangnya sendiri.                                     ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Sejak titipan bisa diterima dari orang yang belum punya akun Hoshi, "kartunya ada di rak" dan
   * "kita tahu siapa yang dibayar" adalah dua fakta yang bisa BERBEDA. Yang dijaga blok ini:
   * keduanya tidak pernah tercampur, dan penolakan masing-masing menyebut pemulihannya sendiri.
   */
  describe('pemilik tertaut (OWNER_UNLINKED)', () => {
    const unlinked = { id: 'c-1', consignorId: null };
    const linked = { id: 'c-1', consignorId: 'user-7' };

    it('requireLinkedConsignorId MENGEMBALIKAN id-nya — supaya TypeScript ikut menegakkan gerbangnya', () => {
      // Mengembalikan nilai, bukan void, DENGAN SENGAJA: tidak ada call-site yang bisa memanggil
      // pemeriksaan ini lalu tetap memakai `consignorId` yang masih bertipe nullable.
      expect(requireLinkedConsignorId(linked)).toBe('user-7');
    });

    it('kodenya OWNER_UNLINKED, BUKAN NOT_IN_CUSTODY — pemulihannya berbeda total', () => {
      // NOT_IN_CUSTODY → "catat serah-terimanya". Untuk kartu yang SUDAH ada di rak, nasihat itu
      // tidak bisa berhasil, dan operator akan mencobanya berulang kali. OWNER_UNLINKED menyebut
      // pemulihan yang benar: pemiliknya menukarkan kode klaim, atau admin menautkan akunnya.
      expect(() => requireLinkedConsignorId(unlinked)).toThrow();
      try {
        requireLinkedConsignorId(unlinked);
      } catch (e) {
        const body = (e as { response?: Record<string, unknown> }).response;
        expect(body?.code).toBe('CONSIGNMENT_OWNER_UNLINKED');
        expect(body?.consignmentId).toBe('c-1');
        // NO_EFFECT: penolakan ini terbit sebelum apa pun bergerak.
        expect(body?.stage).toBe('NO_EFFECT');
        expect(String(body?.message)).toMatch(/kode klaim/i);
      }
    });

    it('awaitingConsignorWhere: yang MENUNGGU pemiliknya — CANCELLED dan RELEASED tidak', () => {
      // Kesepakatan yang batal sebelum serah-terima tidak menunggu siapa pun; kartu yang sudah
      // DIKEMBALIKAN ke orang yang menyerahkannya juga tidak. Memasukkan keduanya ke dashboard
      // hanya membuat daftar "perlu tindakan" berisi baris yang tidak butuh apa-apa.
      expect(awaitingConsignorWhere()).toEqual({
        consignorId: null,
        status: {
          notIn: [ConsignmentStatus.CANCELLED, ConsignmentStatus.RELEASED],
        },
      });
    });

    /**
     * ╔══════════════════════════════════════════════════════════════════════════════════════╗
     * ║ ARTI HIMPUNANNYA: "kami MASIH memegang sesuatu milik orang ini dan belum tahu siapa". ║
     * ╚══════════════════════════════════════════════════════════════════════════════════════╝
     *
     * Kembar TS (`isAwaitingConsignorClaim`) dan kembar SQL (`awaitingConsignorWhere`) HARUS
     * menjawab himpunan yang sama: satu dipakai badge & daftar di memori, satu dipakai filter
     * `?filter=AWAITING_OWNER`. Kalau melenceng, hitungan di layar tidak cocok dengan isinya.
     */
    it('RELEASED KELUAR dari himpunan: kartunya sudah pulang, tidak ada yang bisa diselesaikan', () => {
      // Satu-satunya cara sebuah baris bisa RELEASED tanpa pemilik tertaut adalah WITHDRAWN —
      // kartunya DIKEMBALIKAN dari tangan ke tangan. (SHIPPED_TO_BUYER hanya sah dari SOLD, dan
      // SOLD mustahil tanpa pemilik tertaut.) Tidak ada yang bisa dipajang, tidak ada Rupiah
      // yang butuh tujuan, dan tombol "terbitkan ulang kode" cuma menyetel ulang jam 30 hari.
      expect(
        isAwaitingConsignorClaim({
          status: ConsignmentStatus.RELEASED,
          consignorId: null,
        }),
      ).toBe(false);
    });

    it('LOST TETAP di dalam — ganti rugi butuh tujuan, jadi jangan disapu bersama RELEASED', () => {
      // Custody-nya juga selesai, tapi kartunya TIDAK pulang: Hoshi berutang ganti rugi, dan
      // `compensate` menuntut pemilik yang tertaut. Baris ini justru yang paling mendesak.
      expect(
        isAwaitingConsignorClaim({
          status: ConsignmentStatus.LOST,
          consignorId: null,
        }),
      ).toBe(true);
    });

    it('pemilik yang SUDAH tertaut tidak pernah menunggu, status apa pun', () => {
      for (const status of Object.values(ConsignmentStatus)) {
        expect(
          isAwaitingConsignorClaim({ status, consignorId: 'user-7' }),
        ).toBe(false);
      }
    });

    it('CANCELLED keluar; INTAKE / IN_CUSTODY / LISTED / SOLD tetap di dalam', () => {
      expect(
        isAwaitingConsignorClaim({
          status: ConsignmentStatus.CANCELLED,
          consignorId: null,
        }),
      ).toBe(false);
      for (const status of [
        ConsignmentStatus.INTAKE,
        ConsignmentStatus.IN_CUSTODY,
        ConsignmentStatus.LISTED,
        ConsignmentStatus.SOLD,
      ]) {
        expect(isAwaitingConsignorClaim({ status, consignorId: null })).toBe(
          true,
        );
      }
    });
  });

  /**
   * Penukaran kode klaim dan penautan oleh admin, keduanya berbentuk KLAIM ATOMIK — dan di sini
   * bentuk itu melakukan pekerjaan nyata: `consignorId: null` di predikatnya berarti titipan yang
   * SUDAH bertuan tidak bisa direbut oleh siapa pun, termasuk oleh dua penukaran serentak.
   */
  describe('predikat penautan pemilik', () => {
    const NOW = new Date('2026-09-19T00:00:00.000Z');

    it('penukaran kode: hash + BELUM bertuan + BELUM kedaluwarsa + bukan CANCELLED', () => {
      expect(claimCodeRedeemWhere('deadbeef', NOW)).toEqual({
        claimCodeHash: 'deadbeef',
        consignorId: null,
        claimCodeExpiresAt: { gt: NOW },
        status: { not: ConsignmentStatus.CANCELLED },
      });
    });

    it('penukaran kode TIDAK mengecualikan RELEASED/LOST — dan itu disengaja', () => {
      // Kartu yang sudah dikembalikan tetap punya riwayat yang berhak dilihat pemiliknya, dan
      // kartu yang HILANG justru HARUS bisa ditautkan: kalau tidak, ganti ruginya tidak punya
      // tujuan dan Hoshi memegang kewajiban kepada orang yang tidak bisa ia bayar.
      expect(claimCodeRedeemWhere('deadbeef', NOW).status).toEqual({
        not: ConsignmentStatus.CANCELLED,
      });
    });

    it('penautan admin: gerbangnya `consignorId: null` — TIDAK PERNAH menimpa pemilik yang sudah ada', () => {
      // Kartu orang lain tidak boleh berpindah tangan karena satu panggilan admin yang salah
      // ketik. Kalau barisnya sudah bertuan, klaimnya cocok 0 baris dan tidak ada yang ditulis.
      expect(linkConsignorClaimWhere('c-1')).toEqual({
        id: 'c-1',
        consignorId: null,
        status: { not: ConsignmentStatus.CANCELLED },
      });
    });

    /**
     * ╔══════════════════════════════════════════════════════════════════════════════════════╗
     * ║ "KODE YANG BISA DITERBITKAN" DAN "KODE YANG BISA DITUKARKAN" HARUS HIMPUNAN YANG SAMA.║
     * ╚══════════════════════════════════════════════════════════════════════════════════════╝
     *
     * Syarat CANCELLED dulu hanya ada sebagai PEMBACAAN TERPISAH di service. Pembatalan yang
     * mendarat di antara pembacaan dan penulisan melahirkan salah satu dari dua hal: pemilik
     * yang tertaut ke kesepakatan yang sudah batal, atau — lebih buruk bagi orang yang sedang
     * berdiri di depan operator — selembar kode klaim yang baru DICETAK dan tidak akan pernah
     * bisa ditukarkan, karena predikat penukaran memang mengecualikan CANCELLED.
     */
    it('syarat statusnya SAMA PERSIS dengan predikat penukaran — tidak boleh melenceng', () => {
      expect(linkConsignorClaimWhere('c-1').status).toEqual(
        claimCodeRedeemWhere('deadbeef', NOW).status,
      );
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

  /* ══════════ PENGEMBALIAN KE PEMILIK: "KE MANA?" ADALAH SYARAT, BUKAN CATATAN ══════════ */

  /**
   * Satu kalimat yang dijaga blok ini: KARTU TIDAK BOLEH BISA DINYATAKAN KELUAR TANPA KITA TAHU
   * KE MANA IA PERGI. Sebelum predikat ini ada, sebuah baris bisa berbunyi "dikembalikan"
   * sementara kartunya masih di rak — atau sudah dikirim ke alamat yang tidak pernah ditulis
   * siapa pun.
   */
  describe('rencana pengembalian', () => {
    const alamatLengkap = {
      returnMethod: 'COURIER',
      returnRecipientName: 'Budi Santoso',
      returnPhoneNumber: '081234567890',
      returnStreet: 'Jl. Merdeka No. 10',
      returnCity: 'Kota Bandung',
      returnState: 'Jawa Barat',
      returnZip: '40115',
      returnCountry: 'Indonesia',
    };
    const kosong = {
      returnMethod: null,
      returnRecipientName: null,
      returnPhoneNumber: null,
      returnStreet: null,
      returnCity: null,
      returnState: null,
      returnZip: null,
      returnCountry: null,
    };

    it('DIAMBIL SENDIRI tidak pernah butuh alamat — memaksanya hanya melahirkan alamat karangan', () => {
      expect(isReturnPlanReady({ ...kosong, returnMethod: 'PICKUP' })).toBe(
        true,
      );
    });

    it('KURIR butuh alamat LENGKAP; setengah jadi dibaca sebagai BELUM SIAP', () => {
      expect(isReturnPlanReady(alamatLengkap)).toBe(true);
      expect(isReturnPlanReady({ ...alamatLengkap, returnZip: null })).toBe(
        false,
      );
      // String kosong BUKAN alamat. Kolom yang diisi spasi adalah cara paling mudah melewati
      // pemeriksaan "tidak null" tanpa pernah memberi tahu kurir ke mana harus pergi.
      expect(isReturnPlanReady({ ...alamatLengkap, returnStreet: '   ' })).toBe(
        false,
      );
    });

    it('CARA PENGEMBALIAN YANG TIDAK DIKENAL dibaca sebagai BELUM SIAP — fail-closed', () => {
      expect(
        isReturnPlanReady({ ...alamatLengkap, returnMethod: 'DRONE' }),
      ).toBe(false);
      expect(isReturnPlanReady(kosong)).toBe(false);
    });

    it('MENYEBUT kolom mana yang kurang — supaya satu telepon ke pemiliknya cukup', () => {
      expect(
        missingReturnAddressFields({
          ...alamatLengkap,
          returnState: null,
          returnZip: null,
        }),
      ).toEqual(['returnState', 'returnZip']);
      expect(missingReturnAddressFields(alamatLengkap)).toEqual([]);
      expect(isReturnAddressComplete(alamatLengkap)).toBe(true);
    });

    it('PREDIKAT KLAIMNYA menyebut alamat — jadi Postgres yang menolak, bukan urutan kode', () => {
      const where = withdrawnReleaseClaimWhere('c-1');
      // Custody ditulis SEKALI, dan hanya dari IN_CUSTODY: listing yang masih tayang wajib
      // diturunkan dulu lewat penarikan.
      expect(where).toMatchObject({
        id: 'c-1',
        status: ConsignmentStatus.IN_CUSTODY,
        custodyReleasedAt: null,
      });
      // DUA cabang, dan keduanya harus ada: ambil sendiri berdiri sendiri, kurir menuntut alamat.
      expect(where.OR).toEqual([
        { returnMethod: 'PICKUP' },
        expect.objectContaining({
          returnMethod: 'COURIER',
          returnRecipientName: { not: null },
          returnPhoneNumber: { not: null },
          returnStreet: { not: null },
          returnCity: { not: null },
          returnState: { not: null },
          returnZip: { not: null },
          returnCountry: { not: null },
        }) as unknown,
      ]);
    });

    it('bentuknya FUNGSI, bukan konstanta — dua pemanggil tidak berbagi objek yang sama', () => {
      // Alasan yang sama dengan `inCustodyWhere()`: objek literal yang di-spread ke beberapa
      // query Prisma akan berbagi sub-objek, dan satu pemanggil yang memutasinya diam-diam
      // mengubah pagar pemanggil lain.
      expect(withdrawnReleaseClaimWhere('c-1')).not.toBe(
        withdrawnReleaseClaimWhere('c-1'),
      );
      expect(withdrawnReleaseClaimWhere('c-1')).toEqual(
        withdrawnReleaseClaimWhere('c-1'),
      );
    });
  });
});
