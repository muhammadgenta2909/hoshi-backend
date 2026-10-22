import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as web3 from '@solana/web3.js';
import { base58 } from '@metaplex-foundation/umi/serializers';
import nacl from 'tweetnacl';
import { PrismaService } from '../prisma/prisma.service';
import { EscrowService } from './escrow.service';
import {
  SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
  SPONSOR_LOCK_KEY,
} from './escrow-fee-sponsor';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ ESCROW SERVICE — BAGIAN YANG MENYENTUH SOLANA & DB. SEBELUM FILE INI ADA, TIDAK ADA SATU PUN ║
 * ║ TEST YANG PERNAH MENJALANKANNYA.                                                             ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * `escrow-fee-sponsor.spec.ts` menguji FUNGSI KEPUTUSAN yang murni — ia menerima
 * `feeLamports: number | null` sebagai INPUT. Artinya seluruh 16 test-nya tetap hijau walau
 * PRODUSEN angka itu (`readFeeForTx`) mengembalikan null untuk SETIAP transaksi. Dan memang itulah
 * yang terjadi: `Message.from` (parser LEGACY) melempar untuk pesan v0 yang dibangun umi, jadi
 * pemeriksaan plafon nomor 1 menolak 100% permintaan dan TIDAK ADA satu listing pun yang pernah
 * bisa dititipkan ke escrow. Lubangnya bukan di logikanya — lubangnya adalah tidak ada yang pernah
 * menjalankan produsennya.
 *
 * Karena itu file ini menguji PRODUSENNYA, terhadap pesan yang BENAR-BENAR dibangun umi:
 * `readFeeForTx`, `readEscrowLamports`, `simulateBeforeBroadcast`, `noteSponsorshipConsumed`,
 * bangunan dua-tanda-tangan, serialisasi plafon, dan jalur mundur "penjual bayar gas".
 *
 * Yang di-mock HANYA `Connection` web3.js (jaringan) dan `fetchAsset` (jaringan) — pembangun
 * transaksi umi, serializer, parser pesan, dan verifikasi tanda tangan semuanya ASLI. RAHASIA:
 * tidak ada satu pun assert atas isi secret key.
 */
jest.mock('@solana/web3.js', () => {
  const actual =
    jest.requireActual<typeof import('@solana/web3.js')>('@solana/web3.js');
  const connMocks = {
    getFeeForMessage: jest.fn(),
    getBalance: jest.fn(),
    simulateTransaction: jest.fn(),
    getLatestBlockhash: jest.fn(),
  };
  class Connection {
    rpcEndpoint: string;
    getFeeForMessage = connMocks.getFeeForMessage;
    getBalance = connMocks.getBalance;
    simulateTransaction = connMocks.simulateTransaction;
    getLatestBlockhash = connMocks.getLatestBlockhash;
    constructor(endpoint: string) {
      // umi (createWeb3JsRpc) membaca `rpcEndpoint` untuk menebak cluster-nya; tanpa itu
      // ia melempar "Invalid URL" sebelum satu test pun jalan.
      this.rpcEndpoint = endpoint;
    }
  }
  return { ...actual, Connection, __connMocks: connMocks };
});

jest.mock('@metaplex-foundation/mpl-core', () => {
  const actual = jest.requireActual<
    typeof import('@metaplex-foundation/mpl-core')
  >('@metaplex-foundation/mpl-core');
  return { ...actual, fetchAsset: jest.fn() };
});

const { fetchAsset } = jest.requireMock<{ fetchAsset: jest.Mock }>(
  '@metaplex-foundation/mpl-core',
);
const conn = (web3 as unknown as { __connMocks: Record<string, jest.Mock> })
  .__connMocks;

/** Nama transaksi = signature fee payer (indeks 0), dalam base58 — sama seperti yang dipakai RPC. */
const base58Encode = (bytes: Uint8Array): string =>
  base58.deserialize(bytes)[0];

const SELLER_WALLET = web3.Keypair.generate().publicKey.toBase58();
const ASSET = web3.Keypair.generate().publicKey.toBase58();
const BLOCKHASH = '11111111111111111111111111111111';
const FEE = 5_000;
const RICH_ESCROW = 1_000_000_000; // 1 SOL

/* ─────────────────────────── ledger palsu (in-memory) ─────────────────────────── */

interface LedgerRow {
  id: string;
  listingId: string;
  sellerId: string;
  assetAddress: string;
  feeLamports: number;
  /** IDENTITAS reservasi: nama transaksi sponsor yang ditandatangani untuk baris ini. */
  sponsoredTxSignature: string | null;
  issuedAt: Date;
  consumedAt: Date | null;
  signature: string | null;
}

interface SponsorWhere {
  id?: string | { in: string[] };
  sellerId?: string;
  consumedAt?: null;
  signature?: string | null;
  sponsoredTxSignature?: string;
  issuedAt?: { gte: Date };
}

/**
 * Prisma palsu yang MENIRU SEMANTIK `pg_advisory_xact_lock`, bukan sekadar mencatat panggilan:
 * transaksi yang meminta kunci itu MENUNGGU sampai pemegangnya selesai, dan barisnya baru terlihat
 * oleh penunggu setelah transaksi pemegang berakhir. Tanpa peniruan ini, "test konkurensi" hanya
 * akan membuktikan bahwa mock-nya berurutan.
 */
function makeFakePrisma(opts: { honourLock?: boolean } = {}) {
  const honourLock = opts.honourLock !== false;
  const rows: LedgerRow[] = [];
  const lockCalls: string[] = [];
  let chain: Promise<void> = Promise.resolve();
  let seq = 0;

  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waitFor = chain;
    chain = chain.then(() => mine);
    await waitFor;
    return release;
  };

  const match = (row: LedgerRow, where: SponsorWhere = {}): boolean => {
    if (where.sellerId !== undefined && row.sellerId !== where.sellerId)
      return false;
    if (where.consumedAt === null && row.consumedAt !== null) return false;
    if (where.issuedAt?.gte && row.issuedAt < where.issuedAt.gte) return false;
    if (
      where.sponsoredTxSignature !== undefined &&
      row.sponsoredTxSignature !== where.sponsoredTxSignature
    )
      return false;
    if (where.signature !== undefined && row.signature !== where.signature)
      return false;
    if (typeof where.id === 'string' && row.id !== where.id) return false;
    if (
      where.id &&
      typeof where.id === 'object' &&
      !where.id.in.includes(row.id)
    )
      return false;
    return true;
  };

  const txClient = () => ({
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      lockCalls.push(sql);
      return Promise.resolve(1);
    }),
    escrowFeeSponsorship: {
      aggregate: (args: { where?: SponsorWhere }) =>
        Promise.resolve({
          _sum: {
            feeLamports: rows
              .filter((r) => match(r, args.where))
              .reduce((a, r) => a + r.feeLamports, 0),
          },
        }),
      count: (args: { where?: SponsorWhere }) =>
        Promise.resolve(rows.filter((r) => match(r, args.where)).length),
      create: (args: {
        data: Omit<LedgerRow, 'id' | 'issuedAt' | 'consumedAt' | 'signature'>;
      }) => {
        const row: LedgerRow = {
          id: `sp-${++seq}`,
          issuedAt: new Date(),
          consumedAt: null,
          signature: null,
          ...args.data,
        };
        rows.push(row);
        return Promise.resolve(row);
      },
    },
  });

  const prisma = {
    rows,
    lockCalls,
    // Pembukuan konsumsi berjalan DI LUAR transaksi (best-effort), tapi ia membaca & menulis
    // BARIS YANG SAMA — jadi ia dilayani dari array yang sama, bukan dari mock lepas yang bisa
    // "berhasil" tanpa pernah menyentuh apa pun.
    escrowFeeSponsorship: {
      findMany: jest.fn((args: { where?: SponsorWhere }) =>
        Promise.resolve(
          rows
            .filter((r) => match(r, args.where))
            .sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime())
            .map((r) => ({ id: r.id })),
        ),
      ),
      count: jest.fn((args: { where?: SponsorWhere }) =>
        Promise.resolve(rows.filter((r) => match(r, args.where)).length),
      ),
      updateMany: jest.fn(
        (args: {
          where?: SponsorWhere;
          data: Partial<Pick<LedgerRow, 'consumedAt' | 'signature'>>;
        }) => {
          const hit = rows.filter((r) => match(r, args.where));
          for (const row of hit) Object.assign(row, args.data);
          return Promise.resolve({ count: hit.length });
        },
      ),
    },
    $transaction: jest.fn(
      async (fn: (tx: ReturnType<typeof txClient>) => Promise<unknown>) => {
        const client = txClient();
        const held: (() => void)[] = [];
        // Kunci diambil saat pernyataan lock-nya dijalankan, persis seperti Postgres.
        const original = client.$executeRawUnsafe;
        client.$executeRawUnsafe = jest.fn(async (sql: string) => {
          await original(sql);
          if (honourLock && sql.includes('pg_advisory_xact_lock')) {
            held.push(await acquire());
          }
          return 1;
        });
        try {
          return await fn(client);
        } finally {
          // Dilepas saat transaksi berakhir — commit MAUPUN rollback, sama seperti
          // pg_advisory_xact_lock. Itu yang membuat penolakan plafon tidak bisa memacetkan antrean.
          for (const release of held) release();
        }
      },
    ),
  };
  return prisma;
}

describe('EscrowService (Solana + DB)', () => {
  let service: EscrowService;
  let prisma: ReturnType<typeof makeFakePrisma>;
  let configValues: Record<string, string>;
  let escrowSecret: Uint8Array;
  let escrowPubkey: string;

  const build = async (fake = makeFakePrisma()) => {
    prisma = fake;
    const moduleRef = await Test.createTestingModule({
      providers: [
        EscrowService,
        {
          provide: ConfigService,
          useValue: { get: (k: string) => configValues[k] },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(EscrowService);
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const kp = web3.Keypair.generate();
    escrowSecret = kp.secretKey;
    escrowPubkey = kp.publicKey.toBase58();
    configValues = {
      HOSHI_ESCROW_SECRET_KEY: JSON.stringify(Array.from(escrowSecret)),
      SOLANA_RPC_URL: 'http://localhost:8899',
    };

    fetchAsset.mockResolvedValue({
      owner: SELLER_WALLET,
      updateAuthority: { type: 'None' },
    });
    conn.getLatestBlockhash.mockResolvedValue({
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 1_000,
    });
    conn.getFeeForMessage.mockResolvedValue({
      context: { slot: 1 },
      value: FEE,
    });
    conn.getBalance.mockImplementation((pk: web3.PublicKey) =>
      Promise.resolve(pk.toBase58() === escrowPubkey ? RICH_ESCROW : 0),
    );
    conn.simulateTransaction.mockResolvedValue({ value: { err: null } });

    await build();
  });

  const prepare = (
    over: Partial<Parameters<EscrowService['buildTransferToEscrowTx']>[0]> = {},
  ) =>
    service.buildTransferToEscrowTx({
      assetAddress: ASSET,
      ownerWallet: SELLER_WALLET,
      listingId: 'listing-1',
      sellerId: 'seller-1',
      ...over,
    });

  /* ══════════════════════════ F2 — PARSER PESAN ══════════════════════════ */

  describe('readFeeForTx terhadap pesan v0 yang BENAR-BENAR dibangun umi', () => {
    it('membaca fee dari pesan v0 — parser LEGACY akan melempar untuk byte yang sama', async () => {
      const b64 = await prepare();
      const serialized = web3.VersionedTransaction.deserialize(
        Buffer.from(b64, 'base64'),
      ).message.serialize();

      // JANGKAR REGRESI: ini PERSIS byte yang dulu dioper ke `Message.from`. Kalau suatu hari
      // seseorang mengembalikan parser legacy, baris ini yang menjelaskan kenapa tidak boleh.
      expect(serialized[0]).toBe(0x80); // penanda versi v0
      expect(() => web3.Message.from(Buffer.from(serialized))).toThrow(
        /VersionedMessage\.deserialize/,
      );

      // Dan parser yang dipakai sekarang MEMANG membacanya: getFeeForMessage menerima pesan v0.
      expect(conn.getFeeForMessage).toHaveBeenCalledTimes(1);
      const calls = conn.getFeeForMessage.mock.calls as unknown[][];
      const passed = calls[0][0] as web3.VersionedMessage;
      expect(passed.version).toBe(0);
      // Fee payer = akun pertama = wallet escrow (sponsor menyala).
      expect(passed.staticAccountKeys[0].toBase58()).toBe(escrowPubkey);
    });

    it('fee terbaca → plafon LOLOS dan penitipan benar-benar terbit (dulu 100% ditolak 503)', async () => {
      await expect(prepare()).resolves.toEqual(expect.any(String));
      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0]).toMatchObject({
        listingId: 'listing-1',
        sellerId: 'seller-1',
        assetAddress: ASSET,
        feeLamports: FEE,
      });
    });

    it('RPC tak menjawab angka → null → DITOLAK di hulu, bukan ditebak', async () => {
      const read = (m: Uint8Array) =>
        (
          service as unknown as {
            readFeeForTx(msg: Uint8Array): Promise<number | null>;
          }
        ).readFeeForTx(m);
      // Pesan v0 ASLI, supaya yang diuji di sini benar-benar jawaban RPC-nya dan bukan
      // kegagalan parse yang kebetulan juga menghasilkan null.
      const message = web3.VersionedTransaction.deserialize(
        Buffer.from(await prepare(), 'base64'),
      ).message.serialize();

      conn.getFeeForMessage.mockResolvedValue({ value: null });
      await expect(read(message)).resolves.toBeNull();

      conn.getFeeForMessage.mockRejectedValue(new Error('rpc down'));
      await expect(read(message)).resolves.toBeNull();

      // Byte sampah → parser melempar → null (fail-closed), BUKAN nol.
      conn.getFeeForMessage.mockResolvedValue({ value: FEE });
      await expect(read(new Uint8Array([0xff, 0xff]))).resolves.toBeNull();
    });
  });

  /* ══════════════════════════ BANGUNAN DUA TANDA TANGAN ══════════════════════════ */

  describe('bangunan dua tanda tangan (fee payer ≠ authority)', () => {
    it('escrow menandatangani sebagai FEE PAYER; slot penjual dibiarkan KOSONG untuk ditandatangani sendiri', async () => {
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(await prepare(), 'base64'),
      );

      expect(tx.message.header.numRequiredSignatures).toBe(2);
      expect(tx.signatures).toHaveLength(2);
      // Fee payer (indeks 0) = escrow, dan SUDAH ditandatangani.
      expect(tx.message.staticAccountKeys[0].toBase58()).toBe(escrowPubkey);
      const empty = new Uint8Array(64);
      expect(Buffer.from(tx.signatures[0]).equals(Buffer.from(empty))).toBe(
        false,
      );
      // Slot kedua (penjual, AUTHORITY kartu) masih kosong — kartu TIDAK bisa berpindah tanpa dia.
      expect(Buffer.from(tx.signatures[1]).equals(Buffer.from(empty))).toBe(
        true,
      );
      expect(tx.message.staticAccountKeys.map((k) => k.toBase58())).toContain(
        SELLER_WALLET,
      );

      // Tanda tangan escrow diverifikasi SUNGGUHAN terhadap pesan itu: transaksi yang kami
      // tandatangani tidak bisa dipakai untuk apa pun selain yang kami susun.
      expect(
        nacl.sign.detached.verify(
          tx.message.serialize(),
          tx.signatures[0],
          new web3.PublicKey(escrowPubkey).toBytes(),
        ),
      ).toBe(true);
    });

    it('sponsor DIMATIKAN → penjual fee payer, satu tanda tangan, NOL baris ledger', async () => {
      configValues.HOSHI_ESCROW_SPONSOR_FEE = 'false';
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(await prepare(), 'base64'),
      );

      expect(tx.message.staticAccountKeys[0].toBase58()).toBe(SELLER_WALLET);
      expect(tx.message.header.numRequiredSignatures).toBe(1);
      expect(prisma.rows).toHaveLength(0);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('kartu bukan milik penjual (on-chain) → ditolak sebelum apa pun dibangun', async () => {
      fetchAsset.mockResolvedValue({
        owner: web3.Keypair.generate().publicKey.toBase58(),
        updateAuthority: { type: 'None' },
      });
      await expect(prepare()).rejects.toThrow(/bukan milik wallet Anda/);
      expect(prisma.rows).toHaveLength(0);
    });
  });

  /* ══════════════════════════ F3 — PLAFON DI BAWAH KONKURENSI ══════════════════════════ */

  describe('F3 — plafon sponsor di bawah permintaan bersamaan', () => {
    it('mengambil kunci advisory ber-cakupan transaksi SEBELUM membaca agregat', async () => {
      await prepare();
      expect(prisma.lockCalls).toEqual([
        `SELECT pg_advisory_xact_lock(${SPONSOR_LOCK_KEY})`,
      ]);
    });

    it('5 permintaan BERSAMAAN dengan plafon 2/penjual → TEPAT 2 lolos, 3 ditolak QUOTA, 2 baris ledger', async () => {
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '2';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          prepare({ listingId: `listing-${i}` }),
        ),
      );

      const ok = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(ok).toHaveLength(2);
      expect(rejected).toHaveLength(3);
      for (const r of rejected) {
        expect(r.reason).toMatchObject({
          response: {
            code: 'P2P_ESCROW_SPONSOR_QUOTA',
            stage: 'NO_EFFECT',
          },
        });
      }
      // Yang DITOLAK tidak meninggalkan jejak: transaksinya rollback.
      expect(prisma.rows).toHaveLength(2);
    });

    it('plafon GLOBAL 24 jam juga tidak bisa dilewati bersama-sama', async () => {
      // 3 × 5.000 lamport tapi plafon global hanya 12.000 → paling banyak 2 yang boleh terbit.
      configValues.HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS = '12000';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          prepare({ listingId: `listing-${i}`, sellerId: `seller-${i}` }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
      expect(prisma.rows.reduce((a, r) => a + r.feeLamports, 0)).toBe(10_000);
    });

    it('TANPA kunci itu, 5 permintaan yang sama menembus plafon — inilah bug-nya', async () => {
      // Kontrol negatif. Ia membuktikan dua hal sekaligus: (a) test di atas benar-benar menguji
      // kuncinya, bukan mock yang kebetulan berurutan; (b) bentuk baca-lalu-tulis yang lama
      // memang bisa dilewati N kali oleh N permintaan bersamaan.
      await build(makeFakePrisma({ honourLock: false }));
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '2';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, i) =>
          prepare({ listingId: `listing-${i}` }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect(prisma.rows).toHaveLength(5); // plafon 2 dilewati 2,5×
      // …dan kode produksinya TETAP mengirim pernyataan kuncinya; yang dimatikan hanya tiruan
      // Postgres-nya di sini.
      expect(prisma.lockCalls).toHaveLength(5);
    });

    it('CADANGAN SOL escrow: kewajiban yang belum disiarkan ikut dikurangkan dari saldo', async () => {
      // Saldo hanya cukup untuk cadangan + SATU fee. Permintaan kedua harus ditolak walau
      // saldo on-chain-nya belum berubah — transaksi pertama masih di tangan penjual.
      conn.getBalance.mockImplementation((pk: web3.PublicKey) =>
        Promise.resolve(pk.toBase58() === escrowPubkey ? 10_000_000 + FEE : 0),
      );

      await expect(prepare({ listingId: 'listing-a' })).resolves.toEqual(
        expect.any(String),
      );
      await expect(prepare({ listingId: 'listing-b' })).rejects.toMatchObject({
        response: { code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE' },
      });
      expect(prisma.rows).toHaveLength(1);
    });

    it('transaksi plafon GAGAL dijalankan → 503 NO_EFFECT, bukan 500, dan NOL baris ledger', async () => {
      const broken = makeFakePrisma();
      broken.$transaction = jest
        .fn()
        .mockRejectedValue(new Error('lock wait timeout')) as never;
      await build(broken);

      await expect(prepare()).rejects.toMatchObject({
        response: {
          code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          stage: 'NO_EFFECT',
          statusCode: 503,
        },
      });
      expect(prisma.rows).toHaveLength(0);
    });
  });

  /* ══════════════════════════ JALUR MUNDUR: PENJUAL BAYAR GAS ══════════════════════════ */

  describe('jalur mundur "penjual bayar gas" saat sponsor tidak bisa berjalan', () => {
    const sellerHasSol = () =>
      conn.getBalance.mockImplementation((pk: web3.PublicKey) =>
        Promise.resolve(pk.toBase58() === escrowPubkey ? 0 : 50_000_000),
      );

    it('kuota penjual habis TAPI penjual punya SOL → transaksi penjual-bayar, NOL baris ledger', async () => {
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '1';
      await prepare({ listingId: 'listing-a' }); // menghabiskan kuotanya
      expect(prisma.rows).toHaveLength(1);

      sellerHasSol();
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(await prepare({ listingId: 'listing-b' }), 'base64'),
      );

      // Penjual jadi fee payer: nol lamport escrow, dan penitipan ini TIDAK memakai kuota.
      expect(tx.message.staticAccountKeys[0].toBase58()).toBe(SELLER_WALLET);
      expect(tx.message.header.numRequiredSignatures).toBe(1);
      expect(prisma.rows).toHaveLength(1);
    });

    it('escrow kehabisan SOL TAPI penjual punya → penjual tetap bisa menjual', async () => {
      sellerHasSol(); // saldo escrow 0 → preflight cadangan menolak
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(await prepare(), 'base64'),
      );
      expect(tx.message.staticAccountKeys[0].toBase58()).toBe(SELLER_WALLET);
      expect(prisma.rows).toHaveLength(0);
    });

    it('penjual TIDAK punya SOL → sebab SPONSOR yang sebenarnya dilaporkan, bukan kegagalan simulasi nanti', async () => {
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '1';
      await prepare({ listingId: 'listing-a' });

      // getBalance default di spec ini: penjual 0.
      await expect(prepare({ listingId: 'listing-b' })).rejects.toMatchObject({
        response: {
          code: 'P2P_ESCROW_SPONSOR_QUOTA',
          stage: 'NO_EFFECT',
          statusCode: 429,
        },
      });
      expect(prisma.rows).toHaveLength(1);
    });

    it('saldo penjual TIDAK TERBACA → jangan menebak: laporkan sebab sponsor yang jujur', async () => {
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '1';
      await prepare({ listingId: 'listing-a' });

      conn.getBalance.mockImplementation((pk: web3.PublicKey) =>
        pk.toBase58() === escrowPubkey
          ? Promise.resolve(RICH_ESCROW)
          : Promise.reject(new Error('rpc down')),
      );
      await expect(prepare({ listingId: 'listing-b' })).rejects.toMatchObject({
        response: { code: 'P2P_ESCROW_SPONSOR_QUOTA' },
      });
    });
  });

  /* ══════════════════════════ SALDO & SIMULASI PRA-SIAR ══════════════════════════ */

  describe('readEscrowLamports', () => {
    const read = (s: EscrowService) =>
      (
        s as unknown as { readEscrowLamports(): Promise<number | null> }
      ).readEscrowLamports();

    it('mengembalikan saldo escrow apa adanya', async () => {
      await expect(read(service)).resolves.toBe(RICH_ESCROW);
    });

    it('RPC gagal → null (ditolak di hulu), BUKAN 0 yang akan terlihat seperti "escrow kosong"', async () => {
      conn.getBalance.mockRejectedValue(new Error('rpc down'));
      await expect(read(service)).resolves.toBeNull();
    });
  });

  describe('simulateBeforeBroadcast (lewat broadcastSignedToEscrow)', () => {
    const signedTx = async () => prepare();

    it('simulasi menemukan error program → DITOLAK pra-siar, kontrak P2P, nol lamport bergerak', async () => {
      conn.simulateTransaction.mockResolvedValue({
        value: { err: { InstructionError: [0, 'Custom'] } },
      });

      await expect(
        service.broadcastSignedToEscrow(await signedTx()),
      ).rejects.toMatchObject({
        response: {
          code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE',
          stage: 'NO_EFFECT',
          statusCode: 422,
        },
      });
    });

    it('simulasi TIDAK BISA DIJALANKAN (RPC mati) → tetap DITOLAK (masih pra-siar → aman)', async () => {
      conn.simulateTransaction.mockRejectedValue(new Error('rpc unreachable'));

      await expect(
        service.broadcastSignedToEscrow(await signedTx()),
      ).rejects.toMatchObject({
        response: { code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE' },
      });
    });

    it('simulasi bersih → transaksi disiarkan dan signature base58 dikembalikan', async () => {
      const b64 = await signedTx();
      const umi = (
        service as unknown as {
          getEscrowUmi(): {
            rpc: Record<string, unknown>;
          };
        }
      ).getEscrowUmi();
      const sigBytes = new Uint8Array(64).fill(7);
      umi.rpc.sendTransaction = jest.fn().mockResolvedValue(sigBytes);
      umi.rpc.confirmTransaction = jest.fn().mockResolvedValue({
        value: { err: null },
      });
      umi.rpc.getLatestBlockhash = jest.fn().mockResolvedValue({
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 1_000,
      });

      await expect(service.broadcastSignedToEscrow(b64)).resolves.toEqual(
        expect.any(String),
      );
      expect(conn.simulateTransaction).toHaveBeenCalledWith(
        expect.any(web3.VersionedTransaction),
        expect.objectContaining({
          sigVerify: false,
          replaceRecentBlockhash: false,
        }),
      );
    });
  });

  /* ══════════════════════════ PEMBUKUAN SPONSOR ══════════════════════════ */

  describe('noteSponsorshipConsumed — YANG DICOCOKKAN ADALAH TRANSAKSINYA, BUKAN LISTING-NYA', () => {
    it('setiap reservasi menyimpan NAMA transaksi yang diterbitkannya', async () => {
      const b64 = await prepare();
      const tx = web3.VersionedTransaction.deserialize(
        Buffer.from(b64, 'base64'),
      );

      expect(prisma.rows).toHaveLength(1);
      // Escrow adalah fee payer → signature indeks 0 ADALAH id transaksinya.
      expect(prisma.rows[0].sponsoredTxSignature).toBe(
        base58Encode(tx.signatures[0]),
      );
      expect(prisma.rows[0].consumedAt).toBeNull();
    });

    it('broadcast sponsor menghabiskan PERSIS sponsorship yang membayarinya', async () => {
      const b64 = await prepare();
      const sig = base58Encode(
        web3.VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
          .signatures[0],
      );

      await service.noteSponsorshipConsumed(sig);

      expect(prisma.rows[0].consumedAt).toBeInstanceOf(Date);
      expect(prisma.rows[0].signature).toBe(sig);
    });

    it('JALUR PENJUAL-BAYAR TIDAK MENGHABISKAN APA PUN — ini bug yang diperbaiki', async () => {
      // Reservasi #1 disponsori tapi TIDAK PERNAH disiarkan (penjual menutup tab).
      await prepare();
      expect(prisma.rows).toHaveLength(1);

      // Reservasi #2 jatuh ke jalur mundur "penjual bayar gas": kuota penuh + penjual berdana.
      // NOL baris ledger ditulis untuknya.
      configValues.HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H = '1';
      conn.getBalance.mockResolvedValue(RICH_ESCROW); // penjual juga berdana
      const sellerPaidB64 = await prepare({ listingId: 'listing-1' });
      const sellerPaid = web3.VersionedTransaction.deserialize(
        Buffer.from(sellerPaidB64, 'base64'),
      );
      expect(sellerPaid.message.staticAccountKeys[0].toBase58()).toBe(
        SELLER_WALLET,
      );
      expect(prisma.rows).toHaveLength(1);

      // Menyiarkan transaksi penjual-bayar itu TIDAK boleh menstempel sponsorship #1: escrow
      // tidak pernah membayar transaksi itu. Kalau ia distempel, baris #1 keluar dari agregat
      // KEWAJIBAN TERUTANG dan lantai cadangan SOL escrow jadi optimistis sebesar satu fee.
      await service.noteSponsorshipConsumed(
        base58Encode(sellerPaid.signatures[0]),
      );

      expect(prisma.rows[0].consumedAt).toBeNull();
      expect(prisma.rows[0].signature).toBeNull();
    });

    it('signature yang tidak dikenal / kosong → tidak menulis apa pun', async () => {
      await prepare();
      await service.noteSponsorshipConsumed('');
      await service.noteSponsorshipConsumed('SignatureYangBukanMilikSiapaPun');
      expect(prisma.rows[0].consumedAt).toBeNull();
    });
  });

  /* ══════════════════════════ KONFIGURASI ══════════════════════════ */

  describe('konfigurasi wallet escrow', () => {
    it('tanpa HOSHI_ESCROW_SECRET_KEY → isConfigured false, dan pemakaian dijawab 503', async () => {
      configValues = { SOLANA_RPC_URL: 'http://localhost:8899' };
      expect(service.isConfigured()).toBe(false);
      await expect(prepare()).rejects.toThrow(/belum dikonfigurasi/);
    });

    it('plafon per-transaksi tetap ditegakkan terhadap fee yang BENAR-BENAR dibaca', async () => {
      conn.getFeeForMessage.mockResolvedValue({
        value: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS + 1,
      });
      await expect(prepare()).rejects.toMatchObject({
        response: { code: 'P2P_ESCROW_SPONSOR_UNAVAILABLE' },
      });
      expect(prisma.rows).toHaveLength(0);
    });
  });
});
