import { BadRequestException, ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { ListingStatus, Prisma } from '@prisma/client';
import type { MarketplaceService } from '../marketplace/marketplace.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  EscrowService,
  EscrowTransferIndeterminateError,
} from '../escrow/escrow.service';
import {
  AdminService,
  escrowHeldWhere,
  escrowStrandedWhere,
} from './admin.service';

// AdminService -> MarketplaceService -> EscrowService/NftService menarik rantai ESM Solana v1
// (umi-bundle-defaults -> web3.js -> rpc-websockets/uuid) yang bikin jest gagal parse. Pola sama
// dengan admin.service.spec.ts: keduanya cuma token DI yang di-mock, jadi tak ada key dibaca dan
// tak ada transaksi ditandatangani di test ini.
jest.mock('../solana/umi.service', () => ({ UmiService: class UmiService {} }));
jest.mock('@solana/web3.js', () => ({
  Connection: class Connection {},
  Keypair: class Keypair {},
  Message: class Message {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
  clusterApiUrl: () => 'http://localhost:8899',
}));

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ D (checklist 4.6) — ESCROW PUNYA MATA DAN PUNYA JALAN KELUAR.                            ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Sebelum ini: tidak ada satu pun permukaan yang menunjukkan kartu mana yang dipegang wallet
 * escrow, dan satu-satunya reaksi terhadap kegagalan mengembalikan kartu ke penjual adalah baris
 * log "cek on-chain dan kembalikan manual" — di log yang dirotasi. Kartu penjual bisa tertinggal
 * di escrow tanpa seorang pun tahu, dan tidak ada aksi apa pun untuk mengeluarkannya.
 *
 * Yang diuji di sini terutama adalah APA YANG DITOLAK. Aksi yang memindahkan aset nyata dinilai
 * dari pagarnya, bukan dari jalan bahagianya.
 */
describe('AdminService — escrow (D / 4.6)', () => {
  const admin = { id: 'admin-1', walletAddress: 'AdminWalletBase58' };
  const REASON =
    'Cancel gagal mengembalikan kartu; lihat log droplet 2026-09-17.';

  const listingRow = (over: Record<string, unknown> = {}) => ({
    id: 'listing-1',
    name: 'Charizard PSA 10',
    status: ListingStatus.CANCELLED,
    priceIdrx: 1_000_000,
    ccNftAddress: 'CCAsset123',
    escrowedAt: new Date('2026-07-01T00:00:00.000Z'),
    listedAt: new Date('2026-06-01T00:00:00.000Z'),
    sellerId: 'seller-1',
    sellerAddress: 'x0f3a..91c2',
    seller: {
      id: 'seller-1',
      displayName: null,
      walletAddress: 'SellerWalletBase58',
    },
    ...over,
  });

  const make = () => {
    const prisma = {
      listing: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      escrowRecovery: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest
          .fn()
          .mockImplementation((args: { data: unknown }) =>
            Promise.resolve({ id: 'rec-1', ...(args.data as object) }),
          ),
      },
    };
    const escrow = {
      isConfigured: jest.fn().mockReturnValue(true),
      publicKey: 'EscrowWalletBase58',
      ownsAsset: jest.fn().mockResolvedValue(true),
      transferCoreAssetTo: jest.fn().mockResolvedValue('SigBase58'),
    };
    const config = { get: jest.fn().mockReturnValue(undefined) };
    const service = new AdminService(
      prisma as unknown as PrismaService,
      {} as unknown as JwtService,
      config as unknown as ConfigService,
      {} as unknown as MarketplaceService,
      escrow as unknown as EscrowService,
    );
    return { service, prisma, escrow, config };
  };

  describe('escrowOverview', () => {
    it('READ-ONLY dan TIDAK menyentuh on-chain kecuali diminta (verify)', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findMany.mockResolvedValue([listingRow()]);

      const res = await service.escrowOverview();

      // Tanpa verify, dashboard tidak boleh jadi sumber badai RPC.
      expect(escrow.ownsAsset).not.toHaveBeenCalled();
      // null = TIDAK DIPERIKSA. Membedakannya dari false penting: operator tidak boleh
      // menyimpulkan "escrow tidak memegangnya" dari kolom yang tak pernah dibaca.
      expect(res.held[0].escrowOwnsOnChain).toBeNull();
      expect(res.escrowAddress).toBe('EscrowWalletBase58');
    });

    it('verify=true MEMERIKSA kepemilikan on-chain baris yang mengaku ber-escrow', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findMany.mockResolvedValue([listingRow()]);
      escrow.ownsAsset.mockResolvedValue(false);

      const res = await service.escrowOverview({ verify: true });

      expect(escrow.ownsAsset).toHaveBeenCalledWith('CCAsset123');
      // false di sini = klaim DB (escrowedAt terisi) TIDAK cocok dengan on-chain — persis
      // perbedaan yang dulu tak ada cara melihatnya.
      expect(res.held[0].escrowOwnsOnChain).toBe(false);
    });

    it('melaporkan RADIUS LEDAKAN hari arming: jumlah PENUH listing user tanpa escrow (B)', async () => {
      const { service, prisma } = make();
      prisma.listing.count.mockResolvedValue(137);

      const res = await service.escrowOverview({ limit: 1 });

      // Angka ini yang harus dilihat product owner SEBELUM menyalakan HOSHI_P2P_ENABLED. Ia
      // sengaja count() penuh, bukan panjang array yang dipotong `limit` — kalau ia ikut
      // terpotong, dashboard akan melaporkan "2 listing terdampak" untuk 137 penjual.
      expect(res.unescrowedActiveCount).toBe(137);
    });
  });

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ INVARIAN: KARTU YANG DIPEGANG ESCROW TIDAK BOLEH LOLOS DARI SEMUA DAFTAR SEKALIGUS.      ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `escrowedAt` adalah satu-satunya petunjuk bahwa sebuah kartu tertinggal di wallet escrow.
   * Kalau sebuah baris membawa fakta itu tapi tidak muncul di daftar mana pun, kartunya tidak
   * hilang dari blockchain — ia hilang dari PANDANGAN OPERATOR, dan tidak ada yang akan pernah
   * tahu ada yang perlu dipulihkan.
   *
   * Test ini menjalankan SETIAP nilai ListingStatus melalui kedua predikat. Ia gagal kalau:
   *   • ada satu status yang lolos dari dua-duanya (mis. karena `stranded` dikembalikan ke
   *     daftar status yang disebut satu-satu, atau karena ada status baru), ATAU
   *   • bentuk WHERE-nya berubah jadi sesuatu yang tidak bisa ditafsirkan test ini — yang juga
   *     berarti tidak ada lagi yang menjaga invariannya.
   */
  describe('daftar escrow — `held` ∪ `stranded` HARUS menutup setiap baris ber-escrowedAt', () => {
    type StatusFilter =
      | ListingStatus
      | { not?: ListingStatus; in?: ListingStatus[]; notIn?: ListingStatus[] };

    const matchesWhere = (
      where: Prisma.ListingWhereInput,
      row: { status: ListingStatus; escrowedAt: Date | null },
    ): boolean => {
      const shape = where as {
        escrowedAt?: { not: null };
        status?: StatusFilter;
      };
      if (shape.escrowedAt?.not === null && row.escrowedAt === null)
        return false;
      const s = shape.status;
      if (s === undefined) return true;
      if (typeof s === 'string') return row.status === s;
      if (s.not !== undefined) return row.status !== s.not;
      if (s.in !== undefined) return s.in.includes(row.status);
      if (s.notIn !== undefined) return !s.notIn.includes(row.status);
      throw new Error(
        `Bentuk filter status tidak dikenali test invarian ini: ${JSON.stringify(s)}. ` +
          'Perbarui test-nya BERSAMAAN dengan predikatnya — jangan hapus penjaganya.',
      );
    };

    it('tidak ada satu pun ListingStatus yang lolos dari kedua daftar', () => {
      const escrowedAt = new Date('2026-07-01T00:00:00.000Z');
      for (const status of Object.values(ListingStatus)) {
        const row = { status, escrowedAt };
        const seen =
          matchesWhere(escrowHeldWhere(), row) ||
          matchesWhere(escrowStrandedWhere(), row);
        expect({ status, seen }).toEqual({ status, seen: true });
      }
    });

    it('keduanya saling lepas, dan baris TANPA fakta escrow tidak ikut masuk', () => {
      const escrowedAt = new Date('2026-07-01T00:00:00.000Z');
      for (const status of Object.values(ListingStatus)) {
        const row = { status, escrowedAt };
        // Saling lepas: satu baris tidak boleh dihitung dua kali oleh operator.
        expect(
          matchesWhere(escrowHeldWhere(), row) &&
            matchesWhere(escrowStrandedWhere(), row),
        ).toBe(false);
        // Tanpa escrowedAt tidak ada yang perlu dipulihkan → tidak masuk daftar mana pun.
        const plain = { status, escrowedAt: null };
        expect(matchesWhere(escrowHeldWhere(), plain)).toBe(false);
        expect(matchesWhere(escrowStrandedWhere(), plain)).toBe(false);
      }
    });

    it('escrowOverview MEMANG memakai kedua predikat itu (bukan salinan lokalnya)', async () => {
      const { service, prisma } = make();

      await service.escrowOverview();

      expect(prisma.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: escrowHeldWhere() }),
      );
      expect(prisma.listing.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: escrowStrandedWhere() }),
      );
    });

    it('baris PENDING_ESCROW ber-escrowedAt muncul sebagai stranded (dulu tidak di mana pun)', () => {
      // Contoh nyatanya: pemulihan admin yang hasilnya INDETERMINATE SENGAJA tidak membersihkan
      // escrowedAt. Dengan daftar status yang lama (CANCELLED, SOLD) baris itu tidak muncul di
      // satu pun dari tiga daftar.
      const row = {
        status: ListingStatus.PENDING_ESCROW,
        escrowedAt: new Date(),
      };
      expect(matchesWhere(escrowStrandedWhere(), row)).toBe(true);
    });
  });

  describe('recoverEscrowToSeller — pagarnya', () => {
    it('alasan < 10 karakter DITOLAK (aksi ini memindahkan aset nyata)', async () => {
      const { service, escrow } = make();
      await expect(
        service.recoverEscrowToSeller('listing-1', 'oops', admin),
      ).rejects.toThrow(BadRequestException);
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
    });

    it('listing SOLD DITOLAK KERAS — kartunya sudah/mungkin sah milik pembeli', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(
        listingRow({ status: ListingStatus.SOLD }),
      );

      await expect(
        service.recoverEscrowToSeller('listing-1', REASON, admin),
      ).rejects.toThrow(BadRequestException);
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
    });

    it('listing ACTIVE DITOLAK — batalkan dulu (cancel menutup jendela beli secara atomik)', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(
        listingRow({ status: ListingStatus.ACTIVE }),
      );

      await expect(
        service.recoverEscrowToSeller('listing-1', REASON, admin),
      ).rejects.toThrow(BadRequestException);
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
    });

    it('escrow TIDAK memegang kartunya on-chain → DITOLAK (jangan pindahkan yang tak dipegang)', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(listingRow());
      escrow.ownsAsset.mockResolvedValue(false);

      await expect(
        service.recoverEscrowToSeller('listing-1', REASON, admin),
      ).rejects.toThrow(ConflictException);
      expect(escrow.transferCoreAssetTo).not.toHaveBeenCalled();
    });

    it('TUJUAN selalu wallet PENJUAL — tidak ada parameter alamat sama sekali', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(listingRow());

      await service.recoverEscrowToSeller('listing-1', REASON, admin);

      // Kalau alamat tujuan bisa datang dari pemanggil, ini bukan pemulihan melainkan pintu
      // belakang "kirim aset siapa pun ke mana pun".
      expect(escrow.transferCoreAssetTo).toHaveBeenCalledWith({
        assetAddress: 'CCAsset123',
        newOwner: 'SellerWalletBase58',
      });
    });

    it('sukses: penanda escrow dibersihkan lewat tulisan BERPAGAR + audit RETURNED tercatat', async () => {
      const { service, prisma } = make();
      prisma.listing.findUnique.mockResolvedValue(listingRow());

      const res = await service.recoverEscrowToSeller(
        'listing-1',
        REASON,
        admin,
      );

      // Berpagar status: baris yang keburu bergerak di antara baca dan tulis tidak ikut ditimpa.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith({
        where: { id: 'listing-1', status: ListingStatus.CANCELLED },
        data: { escrowedAt: null },
      });
      expect(prisma.escrowRecovery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          outcome: 'RETURNED',
          toWallet: 'SellerWalletBase58',
          adminId: 'admin-1',
          reason: REASON,
          signature: 'SigBase58',
        }) as unknown,
      });
      expect(res.recovery).toBeDefined();
    });

    it('PENDING_ESCROW yang berhasil dipulihkan ikut ditutup jadi CANCELLED', async () => {
      const { service, prisma } = make();
      prisma.listing.findUnique.mockResolvedValue(
        listingRow({ status: ListingStatus.PENDING_ESCROW, escrowedAt: null }),
      );

      await service.recoverEscrowToSeller('listing-1', REASON, admin);

      // Kartunya sudah keluar dari escrow; membiarkan baris "menunggu escrow" akan mengundang
      // penjual menandatangani penitipan yang tidak akan pernah cocok.
      expect(prisma.listing.updateMany).toHaveBeenCalledWith({
        where: { id: 'listing-1', status: ListingStatus.PENDING_ESCROW },
        data: { escrowedAt: null, status: ListingStatus.CANCELLED },
      });
    });

    it('INDETERMINATE: dicatat apa adanya, escrowedAt TIDAK dibersihkan, aksi ditolak', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(listingRow());
      escrow.transferCoreAssetTo.mockRejectedValue(
        new EscrowTransferIndeterminateError(
          'confirm timeout',
          'CCAsset123',
          'SellerWalletBase58',
        ),
      );

      await expect(
        service.recoverEscrowToSeller('listing-1', REASON, admin),
      ).rejects.toThrow(ConflictException);

      // escrowedAt adalah SATU-SATUNYA penanda bahwa kartu ini pernah ada di escrow. Kalau
      // dibersihkan padahal kartunya mungkin masih di sana, petunjuk terakhirnya hilang.
      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      expect(prisma.escrowRecovery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ outcome: 'INDETERMINATE' }) as unknown,
      });
    });

    it('gagal PRA-KIRIM: nol aset berpindah, TIDAK dicatat sebagai pemulihan', async () => {
      const { service, prisma, escrow } = make();
      prisma.listing.findUnique.mockResolvedValue(listingRow());
      escrow.transferCoreAssetTo.mockRejectedValue(new Error('rpc down'));

      await expect(
        service.recoverEscrowToSeller('listing-1', REASON, admin),
      ).rejects.toThrow(ConflictException);

      expect(prisma.listing.updateMany).not.toHaveBeenCalled();
      expect(prisma.escrowRecovery.create).not.toHaveBeenCalled();
    });
  });
});
