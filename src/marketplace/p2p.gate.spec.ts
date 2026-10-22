import {
  assertEscrowBackedIfRequired,
  assertP2pSaleAvailable,
  isEscrowBackedUserListing,
  listingNeedsEscrow,
  p2pModeOf,
  unescrowedUserListingWhere,
} from './p2p.gate';

/**
 * GERBANG P2P — SATU predikat yang dipakai bersama listing (marketplace) dan tagihan (payments).
 *
 * Kenapa file ini ada terpisah: sebelum pass ini predikatnya DITULIS DUA KALI, di marketplace
 * (`p2pRealArmed`) dan di `fulfilUserListing`, dengan komentar "HARUS identik" sebagai satu-
 * satunya penjaganya. Komentar tidak bisa gagal saat CI berjalan; test ini bisa.
 */
describe('p2p gate', () => {
  const cfg = (values: Record<string, string | undefined> = {}) => ({
    get: <T = string>(k: string) => values[k] as unknown as T | undefined,
  });

  /** detectProductionSignal() membaca process.env langsung, jadi kita kendalikan di sini. */
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.SOLANA_CLUSTER;
    delete process.env.SOLANA_RPC_URL;
    delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
  });
  afterAll(() => {
    process.env = savedEnv;
  });

  describe('p2pModeOf', () => {
    it('tanpa flag apa pun → OFF (default aman: tidak ada settlement P2P real)', () => {
      expect(p2pModeOf(cfg())).toBe('OFF');
    });

    it('HOSHI_P2P_ENABLED=true (bukan mock) → ARMED', () => {
      expect(p2pModeOf(cfg({ HOSHI_P2P_ENABLED: 'true' }))).toBe('ARMED');
      expect(p2pModeOf(cfg({ HOSHI_P2P_ENABLED: ' TRUE ' }))).toBe('ARMED');
    });

    it('salah ketik TIDAK diam-diam jadi ARMED', () => {
      expect(p2pModeOf(cfg({ HOSHI_P2P_ENABLED: '1' }))).toBe('OFF');
      expect(p2pModeOf(cfg({ HOSHI_P2P_ENABLED: 'yes' }))).toBe('OFF');
    });

    it('CC_MOCK=1 di lingkungan non-produksi → MOCK, dan MOCK MENANG atas flag armed', () => {
      // Urutan ini menentukan: kalau armed menang, staging akan mencoba memindahkan kartu
      // on-chain yang mock-nya tidak pernah benar-benar punya.
      expect(p2pModeOf(cfg({ CC_MOCK: '1' }))).toBe('MOCK');
      expect(p2pModeOf(cfg({ CC_MOCK: '1', HOSHI_P2P_ENABLED: 'true' }))).toBe(
        'MOCK',
      );
    });

    it('CC_MOCK=1 TAPI deployment terlihat produksi → BUKAN mock (mock tak pernah menutupi mainnet)', () => {
      process.env.SOLANA_CLUSTER = 'mainnet-beta';
      expect(p2pModeOf(cfg({ CC_MOCK: '1' }))).toBe('OFF');
      expect(p2pModeOf(cfg({ CC_MOCK: '1', HOSHI_P2P_ENABLED: 'true' }))).toBe(
        'ARMED',
      );
    });
  });

  describe('listingNeedsEscrow', () => {
    it('hanya ARMED + kartu ber-aset-on-chain yang butuh escrow', () => {
      expect(listingNeedsEscrow('ARMED', 'Asset1')).toBe(true);
      expect(listingNeedsEscrow('ARMED', null)).toBe(false);
      expect(listingNeedsEscrow('MOCK', 'Asset1')).toBe(false);
      expect(listingNeedsEscrow('OFF', 'Asset1')).toBe(false);
    });

    it('listing tanpa aset on-chain TIDAK dikirim ke PENDING_ESCROW — tak ada yang bisa dititipkan', () => {
      // Ini SENGAJA berbeda dari `isEscrowBackedUserListing`: "tidak perlu langkah escrow"
      // BUKAN "boleh dibeli". Baris seperti ini tetap ACTIVE supaya ia MUNCUL di angka
      // radius-ledakan admin (yang hanya menghitung ACTIVE) alih-alih menghilang ke dalam
      // PENDING_ESCROW yang tak punya jalan keluar.
      expect(listingNeedsEscrow('ARMED', null)).toBe(false);
      expect(
        isEscrowBackedUserListing({
          id: 'l',
          ccNftAddress: null,
          escrowedAt: null,
        }),
      ).toBe(false);
    });
  });

  describe('isEscrowBackedUserListing', () => {
    // PREDIKAT TUNGGAL. Lima tempat bersandar padanya (gerbang, feed publik, dashboard
    // admin, serializer, settlement); kalau ia salah, kelimanya salah dengan cara yang sama.
    it('butuh KEDUA fakta: ada aset on-chain DAN escrow terbukti memegangnya', () => {
      const at = new Date();
      expect(
        isEscrowBackedUserListing({
          id: 'l',
          ccNftAddress: 'A1',
          escrowedAt: at,
        }),
      ).toBe(true);
      expect(
        isEscrowBackedUserListing({
          id: 'l',
          ccNftAddress: 'A1',
          escrowedAt: null,
        }),
      ).toBe(false);
      // Baris yang dulu lolos dari SEMUA pagar: listing user tanpa aset on-chain.
      expect(
        isEscrowBackedUserListing({
          id: 'l',
          ccNftAddress: null,
          escrowedAt: at,
        }),
      ).toBe(false);
      expect(
        isEscrowBackedUserListing({
          id: 'l',
          ccNftAddress: null,
          escrowedAt: null,
        }),
      ).toBe(false);
    });
  });

  describe('assertP2pSaleAvailable', () => {
    const escrowed = {
      id: 'l1',
      ccNftAddress: 'Asset1',
      escrowedAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const unescrowed = { id: 'l1', ccNftAddress: 'Asset1', escrowedAt: null };

    it('OFF → P2P_DISABLED 503, dan pesannya MENYEBUT bahwa tak ada uang diambil', () => {
      let thrown: unknown;
      try {
        assertP2pSaleAvailable('OFF', escrowed);
      } catch (err) {
        thrown = err;
      }
      const body = (thrown as { response: Record<string, unknown> }).response;
      expect(body).toMatchObject({
        code: 'P2P_DISABLED',
        stage: 'NO_EFFECT',
        statusCode: 503,
        retryable: true,
        listingId: 'l1',
      });
      // Kalimatnya adalah bagian dari perbaikannya: pembeli harus tahu ia TIDAK membayar apa pun.
      expect(String(body.message)).toContain('tidak ada uang yang diambil');
    });

    it('OFF menolak BAHKAN kalau kartunya ada di escrow (flag mati = settlement tak jalan)', () => {
      expect(() => assertP2pSaleAvailable('OFF', escrowed)).toThrow();
    });

    it('ARMED + ber-escrow → LOLOS', () => {
      expect(() => assertP2pSaleAvailable('ARMED', escrowed)).not.toThrow();
    });

    it('ARMED + TANPA escrow → P2P_LISTING_NOT_ESCROWED 409 (perangkap refund hari arming)', () => {
      let thrown: unknown;
      try {
        assertP2pSaleAvailable('ARMED', unescrowed);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as { response: unknown }).response).toMatchObject({
        code: 'P2P_LISTING_NOT_ESCROWED',
        stage: 'NO_EFFECT',
        statusCode: 409,
      });
    });

    it('ARMED + listing USER TANPA aset on-chain → DITOLAK (populasi yang dulu lolos)', () => {
      // Dulu jalur ini LOLOS, dengan alasan "tidak ada yang bisa gagal diserahkan". Itu
      // terbalik: settlement ARMED HANYA bisa menyerahkan `ccNftAddress` dari escrow, jadi
      // baris tanpa aset on-chain justru yang PASTI gagal — sesudah pembeli membayar.
      let thrown: unknown;
      try {
        assertP2pSaleAvailable('ARMED', {
          id: 'l2',
          ccNftAddress: null,
          escrowedAt: null,
        });
      } catch (err) {
        thrown = err;
      }
      const body = (thrown as { response: Record<string, unknown> }).response;
      expect(body).toMatchObject({
        code: 'P2P_LISTING_NOT_ESCROWED',
        stage: 'NO_EFFECT',
        statusCode: 409,
        retryable: true,
        listingId: 'l2',
      });
      // Pesannya TIDAK boleh menyuruh "pajang ulang": tidak ada kartu untuk dititipkan,
      // jadi relist akan mengulang kegagalan yang sama.
      expect(String(body.message)).toContain('tidak punya aset on-chain');
      expect(String(body.message)).toContain('tidak ada uang yang diambil');
    });

    it('MOCK TIDAK menuntut escrow — settlement mock tak pernah menyentuh on-chain', () => {
      // Kalau MOCK ikut menuntut escrow, staging mati total tanpa melindungi apa pun.
      expect(() => assertP2pSaleAvailable('MOCK', unescrowed)).not.toThrow();
    });
  });

  describe('assertEscrowBackedIfRequired', () => {
    it('hanya paruh B — OFF TIDAK ditolak (dipakai jalur yang tak menerbitkan tagihan)', () => {
      expect(() =>
        assertEscrowBackedIfRequired('OFF', {
          id: 'l1',
          ccNftAddress: 'Asset1',
          escrowedAt: null,
        }),
      ).not.toThrow();
    });

    it('ARMED + tanpa escrow tetap ditolak', () => {
      expect(() =>
        assertEscrowBackedIfRequired('ARMED', {
          id: 'l1',
          ccNftAddress: 'Asset1',
          escrowedAt: null,
        }),
      ).toThrow();
    });

    it('ARMED + tanpa aset on-chain ditolak juga — jalur demo tak boleh lebih longgar', () => {
      // `buy()` menandai listing SOLD dan me-mint NFT BARU ke pembeli TANPA mengkredit
      // penjual. Untuk listing USER saat settlement real berlaku, itu merampas kartu
      // penjual — tak peduli baris itu punya aset on-chain atau tidak.
      expect(() =>
        assertEscrowBackedIfRequired('ARMED', {
          id: 'l1',
          ccNftAddress: null,
          escrowedAt: null,
        }),
      ).toThrow();
    });

    it('ARMED + ber-escrow LOLOS (pagarnya bukan "tolak semua")', () => {
      expect(() =>
        assertEscrowBackedIfRequired('ARMED', {
          id: 'l1',
          ccNftAddress: 'Asset1',
          escrowedAt: new Date(),
        }),
      ).not.toThrow();
    });
  });

  describe('unescrowedUserListingWhere', () => {
    it('adalah terjemahan SQL dari negasi isEscrowBackedUserListing', () => {
      // Bentuknya dipakai DUA kali dengan arti berlawanan: feed publik memakainya di dalam NOT
      // (kecualikan), dashboard admin memakainya langsung (tampilkan radius ledakan). Kalau
      // definisinya menyimpang dari predikatnya, salah satunya bohong.
      // `consignmentId: null` adalah BAGIAN DARI terjemahannya, bukan tambahan kosmetik: kartu
      // TITIPAN punya sellerId != null dan (dipaku CHECK constraint) ccNftAddress/escrowedAt
      // selalu NULL, jadi tanpa itu ia cocok SEMPURNA di sini — dan akibatnya menyalakan
      // HOSHI_P2P_ENABLED akan MENGHILANGKAN setiap listing titipan dari feed publik, sekaligus
      // melaporkannya sebagai radius ledakan escrow yang tidak pernah bisa disembuhkan.
      expect(unescrowedUserListingWhere()).toEqual({
        sellerId: { not: null },
        consignmentId: null,
        OR: [{ ccNftAddress: null }, { escrowedAt: null }],
      });
    });

    it('cocok untuk TIAP baris yang predikatnya sebut tidak escrow-backed (dan tidak lebih)', () => {
      // Simulasi kecil evaluator WHERE-nya: kalau SQL dan predikat TS menyimpang, salah satu
      // dari dua arah pemakaian (sembunyikan / hitung) akan melewatkan baris.
      const where = unescrowedUserListingWhere();
      const matches = (row: {
        sellerId: string | null;
        ccNftAddress: string | null;
        escrowedAt: Date | null;
      }) =>
        row.sellerId !== null &&
        where.OR.some((c) =>
          'ccNftAddress' in c
            ? row.ccNftAddress === null
            : row.escrowedAt === null,
        );
      const at = new Date();
      const rows = [
        { sellerId: 'u1', ccNftAddress: 'A1', escrowedAt: at },
        { sellerId: 'u1', ccNftAddress: 'A1', escrowedAt: null },
        { sellerId: 'u1', ccNftAddress: null, escrowedAt: null },
        { sellerId: null, ccNftAddress: null, escrowedAt: null },
      ];
      expect(rows.map(matches)).toEqual([false, true, true, false]);
      // Baris user (3 pertama) harus persis berlawanan dengan predikatnya.
      expect(
        rows
          .slice(0, 3)
          .map((r) => !isEscrowBackedUserListing({ id: 'l', ...r })),
      ).toEqual([false, true, true]);
    });
  });
});
