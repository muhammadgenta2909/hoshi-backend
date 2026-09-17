import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { validateEnv } from '../config/env.validation';
import { CcShippingMockController } from './cc-shipping-mock.controller';
import { CC_SHIPPING_MOCK_MOUNT } from './cc-shipping-mock.mount';
import { encodeLeg, decodeLeg } from './cc-shipping-mock.tx';
import { burnTxSetIdentity, transactionMessageBytes } from './cc-shipping.txset';

/**
 * PAGAR mock CC Vault Shipping yang dilayani backend sendiri — bukan kontraknya (itu diuji
 * `npm run mock:cc-shipping:smoke`, 56 assertion, lewat core yang sama). Yang diuji di sini adalah
 * hal-hal yang TIDAK terlihat oleh smoke test karena smoke menembak server standalone yang memang
 * tak punya gerbang:
 *
 *   1. gerbang ganda di controller (CC_SHIPPING_MOCK=1 DAN bukan produksi), diperiksa DI DALAM
 *      handler — bukan sekadar rute yang tak didaftarkan, persis pola IdrxMockController;
 *   2. interlock cutover mainnet: backend MENOLAK BOOT kalau mock-nya masih terpasang di mainnet;
 *   3. konsekuensi Task-2 yang paling mudah diam-diam hilang lagi: transaksi mock sekarang
 *      transaksi Solana ASLI, jadi penjaga batch-basi (`burnTxSetIdentity`) BENAR-BENAR AKTIF —
 *      dulu ia mengembalikan null untuk blob JSON dan dilewati (fail-open).
 */

/* ───────────────────────── helper: env & request palsu ───────────────────────── */

const SAVED = { ...process.env };
afterEach(() => {
  process.env = { ...SAVED };
});

function controller(flag: string | undefined): CcShippingMockController {
  const config = {
    get: (k: string) => (k === 'CC_SHIPPING_MOCK' ? flag : undefined),
  } as unknown as ConfigService;
  return new CcShippingMockController(config);
}

/** Cukup dari Express untuk dispatch(): url, method, headers, body. */
function req(method: string, url: string, body?: unknown): Request {
  return {
    method,
    originalUrl: `/api/${CC_SHIPPING_MOCK_MOUNT}${url}`,
    url: `/api/${CC_SHIPPING_MOCK_MOUNT}${url}`,
    headers: { 'user-agent': 'hoshi-gate-spec/1.0' },
    body: body ?? {},
  } as unknown as Request;
}

function res(): Response & { _status: number | null; _body: string } {
  const r = {
    _status: null as number | null,
    _body: '',
    writeHead(status: number) {
      r._status = status;
      return r;
    },
    end(payload?: Buffer) {
      r._body = payload ? payload.toString('utf8') : '';
      return r;
    },
  };
  return r as unknown as Response & { _status: number | null; _body: string };
}

/* ═════════════════════════ 1. gerbang ganda ═════════════════════════ */

describe('CcShippingMockController — gerbang (pola IdrxMockController)', () => {
  // Rute apa pun, sedalam apa pun: gerbangnya diperiksa sebelum apa pun yang lain.
  const ROUTES: [string, string][] = [
    ['POST', '/auth/wallet/nonce'],
    ['GET', '/shipping-address'],
    ['POST', '/redeem/prepare'],
    ['POST', '/blockchain/ccos_x/burn'],
    ['POST', '/__mock/inbound/ccis_x/receive'],
  ];

  it('TANPA CC_SHIPPING_MOCK → setiap endpoint 404, bukan cuma rutenya disembunyikan', () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const c = controller(undefined);
    for (const [method, path] of ROUTES) {
      expect(() => c['dispatch'](req(method, path), res())).toThrow(
        NotFoundException,
      );
    }
  });

  it('CC_SHIPPING_MOCK=0 / nilai lain → tetap 404 (hanya "1" yang menyalakan)', () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    for (const flag of ['0', 'true', 'yes', '']) {
      expect(() =>
        controller(flag)['dispatch'](req('GET', '/shipping-address'), res()),
      ).toThrow(NotFoundException);
    }
  });

  it.each([
    ['SOLANA_CLUSTER=mainnet-beta', { SOLANA_CLUSTER: 'mainnet-beta' }],
    ['SOLANA_CLUSTER=mainnet', { SOLANA_CLUSTER: 'mainnet' }],
    [
      'RPC mainnet',
      { SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x' },
    ],
    [
      'gacha produksi',
      { COLLECTORCRYPT_GACHA_BASE_URL: 'https://gacha.collectorcrypt.com' },
    ],
  ])(
    'FLAG MENYALA tapi deployment terlihat produksi (%s) → tetap 404',
    (_label, env) => {
      Object.assign(process.env, env);
      expect(() =>
        controller('1')['dispatch'](req('GET', '/shipping-address'), res()),
      ).toThrow(NotFoundException);
    },
  );

  it('CC_SHIPPING_MOCK=1 + devnet → melayani kontraknya (dan hanya di sini)', () => {
    process.env.SOLANA_CLUSTER = 'devnet';
    const r = res();
    controller('1')['dispatch'](req('GET', '/shipping-address'), r);
    // Tanpa Authorization → 401 dari core: kontraknya jalan, gerbangnya lolos.
    expect(r._status).toBe(401);
    expect(r._body).toContain('Unauthorized');
  });
});

/* ═════════════════════ 2. interlock cutover mainnet ═════════════════════ */

describe('interlock cutover mainnet — mock shipping tidak boleh terpasang', () => {
  const MAINNET = {
    DATABASE_URL: 'postgresql://u:p@example.test:5432/db',
    JWT_SECRET: 'x'.repeat(32),
    SOLANA_CLUSTER: 'mainnet-beta',
    SOLANA_RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=x',
    COLLECTORCRYPT_GACHA_BASE_URL: 'https://gacha.collectorcrypt.com',
    HOSHI_TREASURY_ADDRESS: 'TreasuryPubkey11111111111111111111111111111',
    COLLECTORCRYPT_SHIPPING_BASE_URL: 'https://api.collectorcrypt.com',
  };

  it('config mainnet yang BERSIH tetap boot (interlock tidak jadi lebih galak dari perlunya)', () => {
    expect(() => validateEnv({ ...MAINNET })).not.toThrow();
  });

  it('mainnet + CC_SHIPPING_MOCK=1 → MENOLAK BOOT', () => {
    expect(() =>
      validateEnv({ ...MAINNET, CC_SHIPPING_MOCK: '1' }),
    ).toThrow(/CC_SHIPPING_MOCK=1/);
  });

  it('mainnet + base URL masih menunjuk mock internal → MENOLAK BOOT, walau flag-nya sudah mati', () => {
    expect(() =>
      validateEnv({
        ...MAINNET,
        COLLECTORCRYPT_SHIPPING_BASE_URL: `https://api.hoshimarket.xyz/api/${CC_SHIPPING_MOCK_MOUNT}`,
      }),
    ).toThrow(/menunjuk mock internal/);
  });

  it('DEVNET dengan mock terpasang penuh → boot normal (staging tidak terganggu)', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: MAINNET.DATABASE_URL,
        JWT_SECRET: MAINNET.JWT_SECRET,
        SOLANA_CLUSTER: 'devnet',
        CC_SHIPPING_MOCK: '1',
        COLLECTORCRYPT_SHIPPING_BASE_URL: `https://hoshi-backend-staging.onrender.com/api/${CC_SHIPPING_MOCK_MOUNT}`,
      }),
    ).not.toThrow();
  });
});

/* ══════════ 3. transaksi mock ASLI → penjaga batch-basi benar-benar aktif ══════════ */

describe('transaksi mock ASLI → penjaga batch-basi (B2) tidak lagi fail-open', () => {
  const owner = {
    wallet: 'CUwSPTKm7pVhEbN3vg6gBoggxpAiV7Mb6bLHjZDFxrLR',
    userId: 'u1',
  };
  const shipment = 'ccos_1';
  const nft = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

  const batch = (b: string) => ({
    outboundShipmentId: shipment,
    transactions: [encodeLeg({ s: shipment, b, k: 'burn', i: 0, n: nft }, owner)],
    delistTransactions: [
      encodeLeg({ s: shipment, b, k: 'delist', i: 0, n: nft }, owner),
    ],
  });

  it('setiap leg bisa dikanonikalisasi (blob JSON lama mengembalikan null → penjaga DILEWATI)', () => {
    const b = batch('batch_1');
    // Kontras eksplisit dengan bentuk LAMA, supaya regresi ke blob JSON langsung ketahuan.
    const legacyJsonBlob = Buffer.from(
      JSON.stringify({ m: 'cc-mock-tx', s: shipment, b: 'batch_1', k: 'burn' }),
      'utf8',
    ).toString('base64');
    expect(transactionMessageBytes(legacyJsonBlob)).toBeNull();

    for (const tx of [...b.transactions, ...b.delistTransactions]) {
      expect(transactionMessageBytes(tx)).not.toBeNull();
    }
  });

  it('burnTxSetIdentity() NON-NULL untuk batch mock → penjaga AKTIF, bukan dilewati', () => {
    expect(burnTxSetIdentity(batch('batch_1'))).not.toBeNull();
  });

  it('batch yang lebih baru punya identitas BERBEDA → batch lama terdeteksi basi', () => {
    const a = burnTxSetIdentity(batch('batch_1'));
    const b = burnTxSetIdentity(batch('batch_2'));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(b).not.toEqual(a);
  });

  it('burn dan de-list tetap dua leg yang BERBEDA dan bisa dibedakan', () => {
    const b = batch('batch_1');
    expect(b.transactions[0]).not.toEqual(b.delistTransactions[0]);
    expect(decodeLeg(b.transactions[0])?.k).toBe('burn');
    expect(decodeLeg(b.delistTransactions[0])?.k).toBe('delist');
    // Menukar leg antar grup = set yang lain → CC/penjaga tidak boleh menganggapnya sama.
    expect(
      burnTxSetIdentity({
        outboundShipmentId: shipment,
        transactions: b.delistTransactions,
        delistTransactions: b.transactions,
      }),
    ).not.toEqual(burnTxSetIdentity(b));
  });
});
