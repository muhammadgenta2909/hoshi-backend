import { ConfigService } from '@nestjs/config';
import { CcPackStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcGachaClient } from './cc-gacha.client';
import { CC_MOCK_MACHINES } from './cc-mock';
import { GachaService } from './gacha.service';
import { PurchasePackDto } from './dto/purchase-pack.dto';

// GachaService (lewat TreasuryService) menarik @solana/web3.js → rantai ESM yang bikin
// jest gagal parse. Di sini semua dep di-inject sebagai mock, jadi implementasi asli tak
// pernah jalan; mock modul ini cukup supaya import-nya bisa di-load. Sama pola dgn
// gacha.service.spec.ts / payments.service.spec.ts.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  Connection: class Connection {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
}));

describe('GachaService — pagar CC_MOCK (staging-only)', () => {
  const ORIG_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIG_ENV };
  });

  const user: AuthUser = {
    id: 'u1',
    walletAddress: 'HoshiUserWallet',
    displayName: null,
    role: 'USER',
  };

  const build = (cfg: Record<string, string | undefined>) => {
    const create = jest.fn().mockImplementation((args: { data: Record<string, unknown> }) =>
      Promise.resolve({
        ...args.data,
        buybackAmountUsdc: null,
        error: null,
        createdAt: new Date(),
      }),
    );
    const prisma = {
      ccPackPurchase: { create },
      // treasuryBalances() (mock) menjumlah order FULFILLED untuk IDRX display — sediakan aggregate.
      paymentOrder: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { priceIdr: 0 } }),
      },
    } as unknown as PrismaService;
    const machines = jest.fn().mockResolvedValue([]);
    const client = { machines } as unknown as CcGachaClient;
    const config = { get: (k: string) => cfg[k] } as unknown as ConfigService;
    const svc = new GachaService(prisma, client, undefined, config);
    return { svc, create, machines };
  };

  const purchaseDto = { packType: 'pokemon_50' } as PurchasePackDto;

  it('CC_MOCK=1 + devnet → machines() katalog palsu, client TIDAK dipanggil', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const { svc, machines } = build({ CC_MOCK: '1' });
    expect(await svc.machines()).toBe(CC_MOCK_MACHINES);
    expect(machines).not.toHaveBeenCalled();
  });

  it('CC_MOCK=1 + devnet → purchase() tulis pack OPENED palsu berkartu', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const { svc, create } = build({ CC_MOCK: '1' });
    const dto = await svc.purchase(purchaseDto, user, { viaRupiahPayment: true });
    expect(create).toHaveBeenCalledTimes(1);
    expect(dto.status).toBe(CcPackStatus.OPENED);
    expect(dto.memo).toMatch(/^mock-/);
    expect(dto.nftImage ?? '').toMatch(/^https?:/);
    expect(dto.rarity).toBeTruthy();
  });

  it('CC_MOCK=1 + devnet → treasuryBalances() saldo sehat palsu (preflight lolos)', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const { svc } = build({ CC_MOCK: '1' });
    const bal = await svc.treasuryBalances();
    expect(bal?.usdcBaseUnits ?? 0).toBeGreaterThan(0);
  });

  it('TANPA CC_MOCK → machines() panggil client asli', async () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const { svc, machines } = build({});
    await svc.machines();
    expect(machines).toHaveBeenCalledTimes(1);
  });

  it('PRODUKSI (mainnet-beta) → CC_MOCK diabaikan, client asli dipanggil', async () => {
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    const { svc, machines } = build({ CC_MOCK: '1' });
    await svc.machines();
    expect(machines).toHaveBeenCalledTimes(1);
  });
});
