import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as web3 from '@solana/web3.js';
import { PrismaService } from '../prisma/prisma.service';
import {
  SHIPPING_FUND_MAX_PER_TX_USDC,
  TreasuryFundIndeterminateError,
  TreasuryService,
} from './treasury.service';

/**
 * fundUsdc — jalur MONEY-CRITICAL yang MEMINDAHKAN USDC treasury ke wallet user. Yang diuji:
 * guard PRA-broadcast (unconfigured / nominal / plafon per-tx / plafon 24 jam / saldo USDC / SOL /
 * simulasi) yang AMAN (refund-safe → exception biasa) vs BATAS INDETERMINATE (broadcast/confirm →
 * TreasuryFundIndeterminateError). Logika fundUsdc yang ASLI diuji; hanya @solana/web3.js yang
 * di-mock (rantai ESM rpc-websockets→uuid tak bisa di-parse jest) — Connection didelegasikan ke
 * jest.fn yang kita kendalikan, dan keypair di-stub. RAHASIA: tak pernah ada assert atas secret key.
 */
jest.mock('@solana/web3.js', () => {
  const connMocks = {
    getParsedTokenAccountsByOwner: jest.fn(),
    getBalance: jest.fn(),
    getLatestBlockhash: jest.fn(),
    simulateTransaction: jest.fn(),
    sendRawTransaction: jest.fn(),
    confirmTransaction: jest.fn(),
  };

  class PublicKey {
    private readonly _v: string;
    constructor(v: unknown) {
      const s = String(v);
      if (s.startsWith('INVALID')) throw new Error('invalid pubkey');
      this._v = s;
    }
    toBuffer(): Buffer {
      return Buffer.from(this._v);
    }
    toBase58(): string {
      return this._v;
    }
    equals(o: unknown): boolean {
      return !!o && (o as PublicKey).toBase58?.() === this._v;
    }
    static findProgramAddressSync(): [PublicKey, number] {
      return [new PublicKey('DerivedAtaPda'), 255];
    }
  }

  class Keypair {
    publicKey = new PublicKey('TreasuryPubkey11111111111111111111111111111');
    secretKey = new Uint8Array(64);
    static fromSecretKey(_secret: Uint8Array): Keypair {
      return new Keypair();
    }
  }

  class TransactionInstruction {
    constructor(public readonly opts: unknown) {}
  }

  class Transaction {
    instructions: unknown[] = [];
    constructor(_opts?: unknown) {}
    add(...ixs: unknown[]): this {
      this.instructions.push(...ixs);
      return this;
    }
    sign(..._signers: unknown[]): void {}
    serialize(): Buffer {
      return Buffer.from('RAWTX');
    }
  }

  class VersionedTransaction {}

  class Connection {
    getParsedTokenAccountsByOwner = connMocks.getParsedTokenAccountsByOwner;
    getBalance = connMocks.getBalance;
    getLatestBlockhash = connMocks.getLatestBlockhash;
    simulateTransaction = connMocks.simulateTransaction;
    sendRawTransaction = connMocks.sendRawTransaction;
    confirmTransaction = connMocks.confirmTransaction;
    constructor(..._args: unknown[]) {}
  }

  const SystemProgram = {
    programId: new PublicKey('11111111111111111111111111111111'),
    transfer: (o: unknown) => new TransactionInstruction(o),
  };

  return {
    __connMocks: connMocks,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
    TransactionInstruction,
    VersionedTransaction,
    SystemProgram,
    clusterApiUrl: () => 'http://localhost:8899',
  };
});

// Handle ke jest.fn Connection yang di-expose oleh factory di atas.
const conn = (web3 as unknown as { __connMocks: Record<string, jest.Mock> })
  .__connMocks;

const TO_WALLET = 'UserWallet1111111111111111111111111111111';
const TREASURY_PUBKEY = 'TreasuryPubkey11111111111111111111111111111';
const AMOUNT = 25_000_000; // $25 dalam USDC base unit (di bawah plafon per-tx & harian)

// Bentuk satu ATA USDC treasury dengan saldo `amount` (base unit, string) untuk sumUsdcAccounts.
const usdcAccounts = (amount: string): unknown => ({
  value: [
    { account: { data: { parsed: { info: { tokenAmount: { amount } } } } } },
  ],
});

const BASE_CONFIG: Record<string, string | undefined> = {
  // JSON byte array (64) — bentuk yang sama dengan PLATFORM_SECRET_KEY. Keypair.fromSecretKey
  // di-mock jadi tak pernah benar-benar mem-parse rahasianya; isinya tak penting.
  HOSHI_TREASURY_SECRET_KEY: JSON.stringify(new Array<number>(64).fill(7)),
  SOLANA_RPC_URL: 'http://localhost:8899',
  // HOSHI_TREASURY_ADDRESS sengaja tak di-set → lewati cek konsistensi alamat.
  // HOSHI_SHIPPING_FUND_DAILY_CAP_USDC tak di-set → default 5_000_000_000.
};

describe('TreasuryService.fundUsdc', () => {
  let prisma: { cardRedemption: { aggregate: jest.Mock } };

  const makeService = (
    over: Record<string, string | undefined> = {},
  ): TreasuryService => {
    const cfg = { ...BASE_CONFIG, ...over };
    const config = {
      get: (k: string) => cfg[k],
    } as unknown as ConfigService;
    return new TreasuryService(config, prisma as unknown as PrismaService);
  };

  let service: TreasuryService;

  // Semua langkah on-chain SUKSES. Tiap tes merusak TEPAT SATU langkah.
  const armHappy = (): void => {
    conn.getParsedTokenAccountsByOwner.mockResolvedValue(usdcAccounts('100000000'));
    conn.getBalance.mockReset();
    // Promise.all([getBalance(treasury), getBalance(user)]) — urutan array deterministik.
    conn.getBalance
      .mockResolvedValueOnce(50_000_000) // treasury lamports (cukup gas)
      .mockResolvedValueOnce(10_000_000); // user lamports (>= MIN → topup 0)
    conn.getLatestBlockhash.mockResolvedValue({
      blockhash: 'BLOCKHASH',
      lastValidBlockHeight: 1000,
    });
    conn.simulateTransaction.mockResolvedValue({ value: { err: null } });
    conn.sendRawTransaction.mockResolvedValue('SIG_OK');
    conn.confirmTransaction.mockResolvedValue({ value: { err: null } });
  };

  beforeEach(() => {
    Object.values(conn).forEach((m) => m.mockReset());
    prisma = {
      cardRedemption: {
        // Default: belum ada pendanaan dalam 24 jam → plafon harian tak menghalangi.
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalCostUsdc: 0 } }),
      },
    };
    service = makeService();
    armHappy();
  });

  /* ───────────────────────── guard PRA-broadcast (semua refund-safe) ───────────────────────── */

  it('refuses when the treasury is not configured, before any on-chain read', async () => {
    const svc = makeService({ HOSHI_TREASURY_SECRET_KEY: '' });

    await expect(
      svc.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(conn.getParsedTokenAccountsByOwner).not.toHaveBeenCalled();
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('rejects a non-positive / non-integer amount', async () => {
    await expect(
      service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: 0 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: 12.5 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('refuses an amount over the per-transfer cap, before any on-chain read', async () => {
    await expect(
      service.fundUsdc({
        toWallet: TO_WALLET,
        amountBaseUnits: SHIPPING_FUND_MAX_PER_TX_USDC + 1,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(conn.getParsedTokenAccountsByOwner).not.toHaveBeenCalled();
  });

  it('refuses once the rolling 24h funding cap would be exceeded (ledger-derived)', async () => {
    // Sudah didanai tepat sebesar plafon harian default ($5000) → pendanaan berikut menembusnya.
    prisma.cardRedemption.aggregate.mockResolvedValue({
      _sum: { totalCostUsdc: 5_000_000_000 },
    });

    await expect(
      service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Plafon dicek SEBELUM baca saldo on-chain.
    expect(conn.getParsedTokenAccountsByOwner).not.toHaveBeenCalled();
  });

  it('refuses when the treasury USDC balance is below the amount', async () => {
    conn.getParsedTokenAccountsByOwner.mockResolvedValue(usdcAccounts('1000000')); // < AMOUNT

    await expect(
      service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Saldo USDC dicek sebelum saldo SOL.
    expect(conn.getBalance).not.toHaveBeenCalled();
  });

  it('refuses when the treasury SOL is insufficient for gas + rent', async () => {
    conn.getBalance.mockReset();
    conn.getBalance
      .mockResolvedValueOnce(5_000_000) // treasury lamports < 10_000_000 gas + 2_100_000 rent
      .mockResolvedValueOnce(10_000_000); // user lamports (topup 0)

    await expect(
      service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Ditolak sebelum membangun transaksi (blockhash).
    expect(conn.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it('rejects an invalid recipient wallet as a BadRequest (pre-fund)', async () => {
    await expect(
      service.fundUsdc({ toWallet: 'INVALID_WALLET', amountBaseUnits: AMOUNT }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('simulation error is a pre-broadcast (refund-safe) exception, NOT indeterminate', async () => {
    conn.simulateTransaction.mockResolvedValue({
      value: { err: { InstructionError: [0, 'Custom'] } },
    });

    const err = await service
      .fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err).not.toBeInstanceOf(TreasuryFundIndeterminateError);
    // Tidak ada broadcast → tidak ada USDC keluar.
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('an un-runnable simulation (RPC throws) is also pre-broadcast refund-safe', async () => {
    conn.simulateTransaction.mockRejectedValue(new Error('rpc unreachable'));

    const err = await service
      .fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err).not.toBeInstanceOf(TreasuryFundIndeterminateError);
    expect(conn.sendRawTransaction).not.toHaveBeenCalled();
  });

  /* ─────────────────────────── BATAS INDETERMINATE (post-broadcast) ─────────────────────────── */

  it('broadcast failure → TreasuryFundIndeterminateError (USDC may have moved); no confirm', async () => {
    conn.sendRawTransaction.mockRejectedValue(new Error('send failed'));

    const err = await service
      .fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TreasuryFundIndeterminateError);
    // Broadcast gagal sebelum sig didapat → penanda "cek on-chain".
    expect((err as TreasuryFundIndeterminateError).signature).toBe('CEK_ON_CHAIN');
    expect((err as TreasuryFundIndeterminateError).toWallet).toBe(TO_WALLET);
    expect(conn.confirmTransaction).not.toHaveBeenCalled();
  });

  it('confirm throwing → TreasuryFundIndeterminateError carrying the broadcast signature', async () => {
    conn.confirmTransaction.mockRejectedValue(new Error('confirm timeout'));

    const err = await service
      .fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TreasuryFundIndeterminateError);
    expect((err as TreasuryFundIndeterminateError).signature).toBe('SIG_OK');
  });

  it('confirm returning an on-chain err → TreasuryFundIndeterminateError (tx aired, finality unknown)', async () => {
    conn.confirmTransaction.mockResolvedValue({
      value: { err: { some: 'onchain-error' } },
    });

    const err = await service
      .fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TreasuryFundIndeterminateError);
    expect((err as TreasuryFundIndeterminateError).signature).toBe('SIG_OK');
  });

  /* ─────────────────────────────────────── happy ─────────────────────────────────────── */

  it('happy path: simulate → broadcast → confirm all pass, returns the signature', async () => {
    const res = await service.fundUsdc({
      toWallet: TO_WALLET,
      amountBaseUnits: AMOUNT,
    });

    expect(res).toEqual({ signature: 'SIG_OK' });
    expect(conn.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(conn.confirmTransaction).toHaveBeenCalledTimes(1);
  });

  it('reads the treasury USDC balance for the treasury pubkey (not the user)', async () => {
    await service.fundUsdc({ toWallet: TO_WALLET, amountBaseUnits: AMOUNT });

    const [ownerArg] = conn.getParsedTokenAccountsByOwner.mock.calls[0] as [
      { toBase58: () => string },
    ];
    expect(ownerArg.toBase58()).toBe(TREASURY_PUBKEY);
  });
});
