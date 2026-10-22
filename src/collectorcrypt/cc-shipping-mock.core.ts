import { createHash, createPublicKey, randomBytes, randomUUID, verify as ed25519Verify } from 'node:crypto';
import bs58 from 'bs58';
import { decodeLeg, encodeLeg, MockLegMarker } from './cc-shipping-mock.tx';

/**
 * Mock CollectorCrypt Vault Shipping API — SATU-SATUNYA implementasi kontraknya.
 *
 * File ini bebas framework: tidak ada Nest, tidak ada Express, tidak ada `node:http`. Ia cuma
 * fungsi murni `handleMockRequest(request) -> response`. Dua pemanggilnya berbagi KODE YANG SAMA:
 *   • cc-shipping-mock.controller.ts — memasangnya di dalam backend (staging bisa memakai mock
 *     tanpa proses kedua, karena Render tidak bisa menjangkau localhost:4010);
 *   • mock-cc-shipping/standalone.ts — server `node:http` tipis untuk dry-run lokal.
 * Tidak ada salinan kedua yang bisa menyimpang: `npm run mock:cc-shipping:smoke` (56 assertion)
 * menguji kontrak ini, di mana pun ia dilayani.
 *
 * TIDAK PERNAH AKTIF DI PRODUKSI. File ini tidak menggerbangi dirinya sendiri — gerbangnya ada di
 * controller (CC_SHIPPING_MOCK=1 DAN detectProductionSignal() === null) dan di interlock cutover
 * mainnet (src/config/env.validation.ts) yang MENOLAK BOOT kalau flag-nya menyala di mainnet.
 *
 * Isinya meniru dokumen "Shipping API | Collector Crypt" seliteral mungkin. Di tempat dokumen
 * diam, perilakunya dibuat minimal dan ditandai `DOC-SILENT:` (mock-cc-shipping/README.md
 * mendaftar semuanya).
 */

/* ─────────────────────────────── config (env, lazy) ─────────────────────────────── */

/**
 * LAZY, bukan konstanta modul: di dalam Nest file ini di-import SEBELUM ConfigModule memuat .env,
 * jadi membaca process.env saat import akan memotret env yang belum lengkap. Dihitung sekali saat
 * request pertama, lalu di-cache.
 *
 * Tiap knob menerima dua nama: `CC_SHIPPING_MOCK_<X>` (dipakai di backend.env, tidak bentrok dengan
 * apa pun) dan `MOCK_<X>` lama (dipakai dry-run standalone & README sebelumnya).
 */
export interface MockConfig {
  partnerAppId: string;
  allowedDomains: string[];
  apiKey: string;
  apiKeyScopes: Set<string>;
  siwsStatement: string;
  siwsChainId: string;
  acceptAnyNft: boolean;
  extraNfts: string[];
  addressMissingStatus: number;
  nonceRateLimit: number;
}

const ALL_SCOPES = [
  'shipping-address',
  'outbound-shipment',
  'redeem',
  'inbound-shipment',
  'customers:provision',
];

function env(name: string): string | undefined {
  const scoped = process.env[`CC_SHIPPING_MOCK_${name}`];
  if (typeof scoped === 'string' && scoped.length > 0) return scoped;
  const legacy = process.env[`MOCK_${name}`];
  if (typeof legacy === 'string' && legacy.length > 0) return legacy;
  return undefined;
}

let cachedConfig: MockConfig | null = null;

export function mockConfig(): MockConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    partnerAppId: env('PARTNER_APP_ID') || 'hoshi-mock-partner',
    allowedDomains: (env('ALLOWED_DOMAINS') || 'localhost,127.0.0.1')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    apiKey: env('API_KEY') || 'ccsk_mock_key_do_not_use_in_prod',
    apiKeyScopes: new Set(
      (env('API_KEY_SCOPES') || ALL_SCOPES.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    siwsStatement: env('SIWS_STATEMENT') || 'Sign in to Collector Crypt.',
    siwsChainId: env('SIWS_CHAIN_ID') || 'mainnet',
    acceptAnyNft: /^(1|true|yes)$/i.test(env('ACCEPT_ANY_NFT') || ''),
    extraNfts: (env('NFT_ADDRESSES') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    /** Dokumen bertentangan dengan dirinya sendiri di error ini (404 di tabel rute, 400 di contoh). */
    addressMissingStatus: env('ADDRESS_NOT_FOUND_STATUS') === '400' ? 400 : 404,
    /** Limit nonce per wallet per menit. `off` mematikannya (dry-run yang banyak mengulang). */
    nonceRateLimit:
      env('NONCE_RATE_LIMIT') === 'off'
        ? 0
        : Number(env('NONCE_RATE_LIMIT') || 10),
  };
  return cachedConfig;
}

/** Hanya untuk test/standalone yang mengubah env setelah import. */
export function resetMockConfigCache(): void {
  cachedConfig = null;
  catalogue = null;
}

const NONCE_TTL_MS = 5 * 60 * 1000; // doc: nonce sekali pakai, berlaku 5 menit
const MESSAGE_EXP_MS = 60 * 60 * 1000; // doc: baris "Expiration Time" memakai jendela LEBIH panjang
const ACCESS_TTL_MS = 15 * 60 * 1000; // doc: access token 15 menit
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // doc: refresh token 7 hari
const TX_TTL_MS = 15 * 60 * 1000; // doc: set transaksi ditahan 15 menit

/* ─────────────────────────────── tiny utils ─────────────────────────────── */

/**
 * Verifikasi ed25519 SUNGGUHAN dengan node:crypto — mock yang melewatinya tidak berguna untuk
 * dry-run. Alamat Solana ITU SENDIRI adalah public key ed25519 32 byte mentah, jadi kuncinya
 * dibangun ulang dari JWK.
 */
function verifyEd25519(
  messageBuf: Buffer,
  signatureBuf: Buffer,
  publicKeyBuf: Buffer,
): boolean {
  if (publicKeyBuf.length !== 32 || signatureBuf.length !== 64) return false;
  try {
    const key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: publicKeyBuf.toString('base64url'),
      },
      format: 'jwk',
    });
    return ed25519Verify(null, messageBuf, key, signatureBuf);
  } catch {
    return false;
  }
}

const money = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const moneyStr = (n: number) => money(n).toFixed(2);
const nowIso = () => new Date().toISOString();
const uuid = () => randomUUID();
const fakeSignature = () => bs58.encode(randomBytes(64));
const isStr = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isStrArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every(isStr);

/* ─────────────────────────────── in-memory state ─────────────────────────────── */

interface MockUser {
  id: string;
  wallet: string | null;
  externalId: string | null;
  email: string | null;
}
interface MockNonce {
  wallet: string;
  domain: string;
  uri: string;
  message: string;
  expiresAt: number;
  used: boolean;
}
interface MockAddress {
  id: string;
  userId: string;
  fullName: string | null;
  streetAddress: string;
  apartment: string | null;
  city: string;
  state: string;
  country: string;
  zip: string | null;
  phoneNumber: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}
interface MockLeg {
  kind: 'burn' | 'delist';
  index: number;
  nftAddress: string;
  b64: string;
}
interface MockBatch {
  id: string;
  issuedAt: number;
  expiresAt: number;
  burnLegs: MockLeg[];
  delistLegs: MockLeg[];
}
interface MockQuote {
  price: number;
  insurancePrice: number;
  feesPrice: number;
  shippingPrice: number;
  total: number;
  numberOfCards: number;
  customsDutiesEstimate: number;
  breakdown: {
    region: string;
    declaredValue: number;
    numberOfCards: number;
    lines: Record<string, unknown>[];
    notes: string[];
  };
}
interface MockShipment {
  id: string;
  customId: string;
  userId: string;
  status: string;
  nftAddresses: string[];
  cardIds: string[];
  shippingAddressId: string;
  deliveryCompany: string;
  coin: string;
  paymentMethod: string;
  payCustomsDuties: boolean;
  comment: string | null;
  quote: MockQuote;
  trackingIds: string[];
  trackingUrls: string[];
  recordedLegs: Map<string, { transactionId: string; transactionUrl: string }>;
  burned: Set<string>;
  paid: boolean;
  cardPaymentConfirmed: boolean;
  batch: MockBatch | null;
  createdAt: string;
  updatedAt: string;
}
interface MockInboundLine {
  kind: string;
  state: string;
  externalRef: string;
  note?: string;
  vaultItem?: Record<string, unknown>;
}
interface MockInbound {
  id: string;
  ownerKeyUserId: string;
  status: string;
  externalRef: string | null;
  trackingId: string | null;
  declaredValue: number | null;
  declaredLines: MockInboundLine[];
  createdAt: string;
  updatedAt: string;
}

const state = {
  nonces: new Map<string, MockNonce>(),
  accessTokens: new Map<string, { userId: string; expiresAt: number }>(),
  refreshTokens: new Map<
    string,
    { userId: string; expiresAt: number; used: boolean }
  >(),
  users: new Map<string, MockUser>(),
  byWallet: new Map<string, string>(),
  byExternalId: new Map<string, string>(),
  addresses: new Map<string, MockAddress>(),
  shipments: new Map<string, MockShipment>(),
  prepareKeys: new Map<string, string>(),
  inbound: new Map<string, MockInbound>(),
  nonceHits: new Map<string, number[]>(),
  counters: { shipment: 0, inbound: 0 },
};

const getUser = (id: string): MockUser | null => state.users.get(id) ?? null;

function userForWallet(wallet: string): MockUser {
  const existing = state.byWallet.get(wallet);
  if (existing) {
    const hit = state.users.get(existing);
    if (hit) return hit;
  }
  const id = 'ccu_' + uuid();
  const row: MockUser = { id, wallet, externalId: null, email: null };
  state.users.set(id, row);
  state.byWallet.set(wallet, id);
  return row;
}

/* ─────────────────────────────── seeded catalogue ─────────────────────────────── */
/**
 * Kartu vault palsu. Flag-flag ini ada supaya dry-run bisa mencapai jalur sedih yang didokumenkan:
 *   escrowed      -> prepare mengembalikan delistTransactions
 *   delistFails   -> burn menjawab 409 dengan delistErrors (tidak ada yang terbakar)
 *   burnFails     -> burn menjawab 200 dengan error non-null di leg itu (lalu /redeem/complete/:id)
 *   notRedeemable -> estimate/prepare menjawab 400 dengan array per-kartu sebagai STRING JSON
 */
interface CatalogueCard {
  cardId: string;
  name: string;
  declaredValue: number;
  kind: string;
  gradingId?: string;
  escrowed?: boolean;
  delistFails?: boolean;
  burnFails?: boolean;
  notRedeemable?: boolean;
  rejectReason?: string;
}

const BASE_CATALOGUE: Record<string, CatalogueCard> = {
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': {
    cardId: 'cc-card-0001',
    name: '1999 Pokemon Base Charizard',
    declaredValue: 80,
    kind: 'Cert',
    gradingId: '12345678',
  },
  '9aBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dE3fGhJkM': {
    cardId: 'cc-card-0002',
    name: '2003 Yu-Gi-Oh Blue-Eyes White Dragon',
    declaredValue: 260,
    kind: 'Cert',
    gradingId: '22345678',
  },
  '3mQzXyW9vU8tS7rQ6pN5mK4jH3gF2eD1cB9aZ8yX7wVt': {
    cardId: 'cc-card-0003',
    name: '2018 Panini Prizm Luka Doncic RC',
    declaredValue: 1200,
    kind: 'Cert',
    gradingId: '32345678',
  },
  ESCRWaBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dEfGh: {
    cardId: 'cc-card-0004',
    name: '2021 Pokemon Evolving Skies Booster Box',
    declaredValue: 450,
    kind: 'Bulk',
    escrowed: true,
  },
  ESCRWFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE: {
    cardId: 'cc-card-0005',
    name: '1986 Fleer Michael Jordan RC',
    declaredValue: 3000,
    kind: 'Cert',
    gradingId: '42345678',
    escrowed: true,
    delistFails: true,
  },
  BURNFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dEf: {
    cardId: 'cc-card-0006',
    name: '2020 Topps Chrome Mookie Betts',
    declaredValue: 45,
    kind: 'CardRaw',
    burnFails: true,
  },
  NOTREDEEMbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE: {
    cardId: 'cc-card-0007',
    name: '2022 Topps Sealed Case',
    declaredValue: 900,
    kind: 'Bulk',
    notRedeemable: true,
    rejectReason: 'Card is pending an inbound scan and cannot be redeemed yet',
  },
};

let catalogue: Map<string, CatalogueCard> | null = null;

function getCatalogue(): Map<string, CatalogueCard> {
  if (catalogue) return catalogue;
  const map = new Map<string, CatalogueCard>(Object.entries(BASE_CATALOGUE));
  for (const addr of mockConfig().extraNfts) {
    if (!map.has(addr)) {
      map.set(addr, {
        cardId: 'cc-card-env-' + (map.size + 1),
        name: 'Env-seeded card',
        declaredValue: 100,
        kind: 'CardRaw',
      });
    }
  }
  catalogue = map;
  return catalogue;
}

function lookupCard(addr: string): CatalogueCard | null {
  const hit = getCatalogue().get(addr);
  if (hit) return hit;
  if (mockConfig().acceptAnyNft) {
    return {
      cardId: 'cc-card-any-' + addr.slice(0, 6),
      name: 'Unlisted card',
      declaredValue: 100,
      kind: 'CardRaw',
    };
  }
  return null;
}

/* ─────────────────────────── country / subdivision tables ─────────────────────────── */

const COUNTRIES = [
  { names: ['US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA'], name: 'United States', region: 'USA' },
  { names: ['CA', 'CAN', 'CANADA'], name: 'Canada', region: 'Canada' },
  { names: ['GB', 'GBR', 'UNITED KINGDOM', 'UK'], name: 'United Kingdom', region: 'Europe' },
  { names: ['DE', 'DEU', 'GERMANY'], name: 'Germany', region: 'Europe' },
  { names: ['FR', 'FRA', 'FRANCE'], name: 'France', region: 'Europe' },
  { names: ['NL', 'NLD', 'NETHERLANDS'], name: 'Netherlands', region: 'Europe' },
  { names: ['IT', 'ITA', 'ITALY'], name: 'Italy', region: 'Europe' },
  { names: ['ES', 'ESP', 'SPAIN'], name: 'Spain', region: 'Europe' },
  { names: ['AU', 'AUS', 'AUSTRALIA'], name: 'Australia', region: 'AustraliaNewZealand' },
  { names: ['NZ', 'NZL', 'NEW ZEALAND'], name: 'New Zealand', region: 'AustraliaNewZealand' },
  { names: ['ID', 'IDN', 'INDONESIA'], name: 'Indonesia', region: 'RestOfWorld' },
  { names: ['SG', 'SGP', 'SINGAPORE'], name: 'Singapore', region: 'RestOfWorld' },
  { names: ['MY', 'MYS', 'MALAYSIA'], name: 'Malaysia', region: 'RestOfWorld' },
  { names: ['PH', 'PHL', 'PHILIPPINES'], name: 'Philippines', region: 'RestOfWorld' },
  { names: ['TH', 'THA', 'THAILAND'], name: 'Thailand', region: 'RestOfWorld' },
  { names: ['JP', 'JPN', 'JAPAN'], name: 'Japan', region: 'RestOfWorld' },
  { names: ['KR', 'KOR', 'SOUTH KOREA'], name: 'South Korea', region: 'RestOfWorld' },
];
const resolveCountry = (raw: unknown) =>
  COUNTRIES.find((c) => c.names.includes(String(raw).trim().toUpperCase())) ||
  null;

/** doc: state disimpan "normalised to the subdivision name, so CA becomes California". */
const SUBDIVISIONS: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', IL: 'Illinois', IN: 'Indiana', MA: 'Massachusetts', MD: 'Maryland', MI: 'Michigan',
  MN: 'Minnesota', NC: 'North Carolina', NJ: 'New Jersey', NV: 'Nevada', NY: 'New York', OH: 'Ohio',
  OR: 'Oregon', PA: 'Pennsylvania', TX: 'Texas', UT: 'Utah', VA: 'Virginia', WA: 'Washington',
  WI: 'Wisconsin',
  ON: 'Ontario', BC: 'British Columbia', QC: 'Quebec', AB: 'Alberta',
  JK: 'Jakarta', JB: 'West Java', BT: 'Banten',
};
const normaliseState = (raw: unknown) =>
  SUBDIVISIONS[String(raw).trim().toUpperCase()] || String(raw).trim();

/* ─────────────────────────────── error helpers ─────────────────────────────── */
/** doc: "Error bodies are not uniform — branch on the HTTP status, never on the presence of a field." */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Record<string, string>;
  constructor(
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ) {
    super('api-error');
    this.status = status;
    this.body = body; // null => body kosong
    this.headers = headers || {};
  }
}
const bad = (message: string) =>
  new ApiError(400, { statusCode: 400, message, error: 'Bad Request' });
/** contoh dokumen: { "statusCode": 400, "message": "Invalid request." } — tanpa kunci `error`. */
const invalidRequest = () =>
  new ApiError(400, { statusCode: 400, message: 'Invalid request.' });
/** doc: "for validation failures and per-card rejections [message] is a string containing JSON." */
const validation = (messages: unknown[]) =>
  new ApiError(400, {
    statusCode: 400,
    message: JSON.stringify(messages),
    error: 'Bad Request',
  });
const unauthorized = (message: string) =>
  new ApiError(401, { statusCode: 401, message, error: 'Unauthorized' });
const forbidden = (message: string) =>
  new ApiError(403, { statusCode: 403, message, error: 'Forbidden' });
/** doc: access token di luar rute shipping dapat "a bare 403 with no message". */
const bareForbidden = () => new ApiError(403, null);
const notFound = (message: string) =>
  new ApiError(404, { statusCode: 404, message, error: 'Not Found' });
const conflict = (message: string, extra?: Record<string, unknown>) =>
  new ApiError(409, {
    statusCode: 409,
    message,
    error: 'Conflict',
    ...(extra || {}),
  });
const tooManyRequests = (message: string, retryAfter: number) =>
  new ApiError(
    429,
    { statusCode: 429, message, retryAfter },
    { 'Retry-After': String(retryAfter) },
  );

/**
 * Validator whitelist. Field `extra` ditolak seperti forbidNonWhitelisted milik class-validator —
 * itulah perilaku yang menangkap kita mengirim field yang tidak pernah CC deklarasikan (mis.
 * `email` di /shipping-address/create, atau body /redeem/prepare dikirim ke /redeem/estimate).
 */
function checkExtraFields(body: Record<string, unknown>, allowed: string[]): void {
  const extras = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extras.length) {
    throw validation(extras.map((k) => `property ${k} should not exist`));
  }
}

/* ─────────────────────────────── pricing ─────────────────────────────── */

const REGION_BASE: Record<string, number> = {
  USA: 5.99, Canada: 14.99, Europe: 19.99, AustraliaNewZealand: 24.99, RestOfWorld: 29.99,
};
const EXTRA_CARD_PRICE = 1.5;

function quoteFor(input: {
  cards: CatalogueCard[];
  address: MockAddress;
  payCustomsDuties: boolean;
  paymentMethod: string;
  deliveryCompany: string;
}): MockQuote {
  const { cards, address, payCustomsDuties, paymentMethod, deliveryCompany } =
    input;
  const region = resolveCountry(address.country)?.region ?? 'RestOfWorld';
  const numberOfCards = cards.length;
  const declaredValue = money(
    cards.reduce((sum, c) => sum + c.declaredValue, 0),
  );
  const base = REGION_BASE[region];
  const extra = money(EXTRA_CARD_PRICE * Math.max(0, numberOfCards - 1));
  const shippingPrice = money(base + extra);
  const insurancePrice = declaredValue <= 100 ? 0 : money(declaredValue * 0.01);
  const subtotal = money(shippingPrice + insurancePrice);
  const feesPrice =
    paymentMethod === 'card' ? money(subtotal * 0.029 + 0.3) : 0;
  const customsDutiesEstimate =
    region === 'USA' ? 0 : money(declaredValue * 0.08);
  const price = money(shippingPrice + insurancePrice + feesPrice);
  const total = money(price + (payCustomsDuties ? customsDutiesEstimate : 0));

  const lines: Record<string, unknown>[] = [
    {
      code: 'SHIPPING_BASE',
      label: `Shipping (${deliveryCompany}, ${region})`,
      amount: base,
    },
  ];
  if (numberOfCards > 1) {
    lines.push({
      code: 'SHIPPING_EXTRA_CARD',
      label: 'Additional cards',
      amount: extra,
      qty: numberOfCards - 1,
      unitPrice: EXTRA_CARD_PRICE,
    });
  }
  lines.push({
    code: 'INSURANCE',
    label: 'Insurance (automatic)',
    amount: insurancePrice,
  });
  if (feesPrice > 0) {
    lines.push({
      code: 'CARD_PAYMENT_FEE',
      label: 'Card payment fee',
      amount: feesPrice,
    });
  }
  if (payCustomsDuties) {
    lines.push({
      code: 'CUSTOMS_DUTIES',
      label: 'Customs duties (prepaid)',
      amount: customsDutiesEstimate,
    });
  }

  const notes = ['Insurance is automatic and cannot be turned off.'];
  if (!payCustomsDuties && customsDutiesEstimate > 0) {
    notes.push(
      'Customs duties are payable to the carrier on delivery unless you opt in.',
    );
  }

  return {
    price, insurancePrice, feesPrice, shippingPrice, total, numberOfCards,
    customsDutiesEstimate,
    breakdown: { region, declaredValue, numberOfCards, lines, notes },
  };
}

/* ─────────────────────────── prepared-transaction plumbing ─────────────────────────── */
/**
 * "Unsigned transaction" mock kini TRANSAKSI SOLANA ASLI (cc-shipping-mock.tx.ts): bisa
 * dideserialisasi & ditandatangani dompet, tapi mustahil mendarat di cluster mana pun. Marker leg
 * (shipment / batch / jenis / index / mint) dibawa di data memo, jadi salinan DITANDATANGANI tetap
 * dikenali — byte pesannya tidak berubah saat ditandatangani.
 */
function issueBatch(shipment: MockShipment, addresses: string[]): MockBatch {
  const batchId = 'batch_' + uuid();
  const issuedAt = Date.now();
  const user = getUser(shipment.userId);
  const owner = { wallet: user?.wallet ?? null, userId: shipment.userId };
  const burnLegs: MockLeg[] = addresses.map((nftAddress, index) => ({
    kind: 'burn',
    index,
    nftAddress,
    b64: encodeLeg(
      { s: shipment.id, b: batchId, k: 'burn', i: index, n: nftAddress },
      owner,
    ),
  }));
  const delistLegs: MockLeg[] = addresses
    .filter((a) => lookupCard(a)?.escrowed)
    .map((nftAddress, index) => ({
      kind: 'delist',
      index,
      nftAddress,
      b64: encodeLeg(
        { s: shipment.id, b: batchId, k: 'delist', i: index, n: nftAddress },
        owner,
      ),
    }));
  shipment.batch = {
    id: batchId,
    issuedAt,
    expiresAt: issuedAt + TX_TTL_MS,
    burnLegs,
    delistLegs,
  };
  return shipment.batch;
}
const batchLive = (shipment: MockShipment) =>
  !!shipment.batch && Date.now() < shipment.batch.expiresAt;

/* ─────────────────────────────── serialisers ─────────────────────────────── */

/** doc: "All cost fields and numberOfCards are strings." */
function serializeShipment(s: MockShipment) {
  return {
    id: s.id,
    customId: s.customId,
    status: s.status,
    numberOfCards: String(s.nftAddresses.length),
    cardIds: s.cardIds,
    deliveryCompany: s.deliveryCompany,
    trackingIds: s.trackingIds,
    trackingUrls: s.trackingUrls,
    shippingCost: moneyStr(s.quote.shippingPrice),
    insuranceCost: moneyStr(s.quote.insurancePrice),
    feesCost: moneyStr(s.quote.feesPrice),
    totalCost: moneyStr(s.quote.total),
    typeCurrency: s.coin,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

function serializeAddress(a: MockAddress) {
  return {
    id: a.id, fullName: a.fullName, streetAddress: a.streetAddress,
    apartment: a.apartment, city: a.city, state: a.state, country: a.country,
    zip: a.zip, phoneNumber: a.phoneNumber, isDefault: a.isDefault,
    createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

/* ─────────────────────────────── SIWS message ─────────────────────────────── */
/**
 * doc: "The parser accepts exactly one form — LF line endings, exactly 11 lines, fixed field
 * order." Teks kanonik Sign-In-With-Solana:
 *   1  <domain> wants you to sign in with your Solana account:
 *   2  <wallet>
 *   3  (kosong)
 *   4  <statement>
 *   5  (kosong)
 *   6  URI: <uri>
 *   7  Version: 1
 *   8  Chain ID: <chain>
 *   9  Nonce: <nonce>
 *   10 Issued At: <iso>
 *   11 Expiration Time: <iso>
 */
function buildSiwsMessage(input: {
  domain: string;
  wallet: string;
  uri: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
}): string {
  const cfg = mockConfig();
  return [
    `${input.domain} wants you to sign in with your Solana account:`,
    input.wallet,
    '',
    cfg.siwsStatement,
    '',
    `URI: ${input.uri}`,
    'Version: 1',
    `Chain ID: ${cfg.siwsChainId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expiration Time: ${input.expirationTime}`,
  ].join('\n');
}

/** Pasangan ketat dari builder. null kalau teksnya bukan satu-satunya bentuk yang diterima. */
function parseSiwsMessage(message: unknown) {
  if (typeof message !== 'string' || message.includes('\r')) return null;
  const lines = message.split('\n');
  if (lines.length !== 11) return null;
  const head = ' wants you to sign in with your Solana account:';
  if (!lines[0].endsWith(head)) return null;
  if (lines[2] !== '' || lines[4] !== '') return null;
  const field = (line: string, label: string) =>
    line.startsWith(label + ': ') ? line.slice(label.length + 2) : null;
  const uri = field(lines[5], 'URI');
  const version = field(lines[6], 'Version');
  const chainId = field(lines[7], 'Chain ID');
  const nonce = field(lines[8], 'Nonce');
  const issuedAt = field(lines[9], 'Issued At');
  const expirationTime = field(lines[10], 'Expiration Time');
  if (
    [uri, version, chainId, nonce, issuedAt, expirationTime].some(
      (v) => v === null,
    )
  ) {
    return null;
  }
  return {
    domain: lines[0].slice(0, -head.length),
    wallet: lines[1],
    statement: lines[3],
    uri: uri as string,
    version: version as string,
    chainId: chainId as string,
    nonce: nonce as string,
    issuedAt: issuedAt as string,
    expirationTime: expirationTime as string,
  };
}

/* ═══════════════════════════════ handlers ═══════════════════════════════ */

export interface MockRequest {
  method: string;
  /** Path SUDAH tanpa prefix mount, mis. "/auth/wallet/nonce". */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Body JSON yang sudah di-parse (objek). */
  body: Record<string, unknown>;
}

export interface MockResponse {
  status: number;
  /** null/undefined => body benar-benar kosong (bukan "null" JSON). */
  body: unknown;
  headers?: Record<string, string>;
}

interface Ctx {
  body: Record<string, unknown>;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  user: MockUser | null;
  credential: 'public' | 'session' | 'key';
}

/* ── auth (public) ───────────────────────────────────────────────────────── */

function postNonce(ctx: Ctx): MockResponse {
  const cfg = mockConfig();
  const body = ctx.body;
  checkExtraFields(body, ['wallet', 'partnerAppId', 'domain', 'uri']);
  const { wallet, partnerAppId, domain, uri } = body as Record<string, string>;
  if (!isStr(wallet) || !isStr(partnerAppId) || !isStr(domain) || !isStr(uri)) {
    throw invalidRequest();
  }

  // doc: "Any unrecognised value returns 400 Unknown partner."
  if (partnerAppId !== cfg.partnerAppId) throw bad('Unknown partner');

  // doc: "Bare hostname — no scheme, no port, no path."
  if (/[:/]/.test(domain)) {
    throw validation([
      'domain must be a bare hostname — no scheme, no port, no path',
    ]);
  }
  // doc: "Must be on your allowlist." (wording pesannya DOC-SILENT)
  if (!cfg.allowedDomains.includes(domain.toLowerCase())) {
    throw bad('Domain not allowed for this partner');
  }

  // doc: "uri — Absolute URL, echoed into the signed message."
  try {
    new URL(uri);
  } catch {
    throw validation(['uri must be an absolute URL']);
  }

  let walletBytes: Uint8Array;
  try {
    walletBytes = bs58.decode(wallet);
  } catch {
    throw validation(['wallet must be a base58 Solana address']);
  }
  if (walletBytes.length !== 32) {
    throw validation(['wallet must be a base58 Solana address']);
  }

  // doc: "Sign-in requests are rate limited per wallet ... On a 429, read retryAfter."
  if (cfg.nonceRateLimit > 0) {
    const now = Date.now();
    const hits = (state.nonceHits.get(wallet) || []).filter(
      (t) => now - t < 60_000,
    );
    if (hits.length >= cfg.nonceRateLimit) {
      state.nonceHits.set(wallet, hits);
      throw tooManyRequests(
        'Too many requests — nonce requests for this wallet. Retry in 60s.',
        60,
      );
    }
    hits.push(now);
    state.nonceHits.set(wallet, hits);
  }

  const nonce = uuid();
  const issuedAtMs = Date.now();
  const message = buildSiwsMessage({
    domain, wallet, uri, nonce,
    issuedAt: new Date(issuedAtMs).toISOString(),
    // doc: "The Expiration Time line inside the message shows a longer window; the 5-minute nonce governs."
    expirationTime: new Date(issuedAtMs + MESSAGE_EXP_MS).toISOString(),
  });
  const expiresAt = issuedAtMs + NONCE_TTL_MS;
  state.nonces.set(nonce, {
    wallet, domain, uri, message, expiresAt, used: false,
  });
  return { status: 200, body: { nonce, expiresAt, message } };
}

function postVerify(ctx: Ctx): MockResponse {
  checkExtraFields(ctx.body, ['message', 'signature']);
  const { message, signature } = ctx.body as Record<string, string>;
  if (!isStr(message) || !isStr(signature)) throw invalidRequest();

  const parsed = parseSiwsMessage(message);
  if (!parsed) throw invalidRequest(); // DOC-SILENT status: teks rusak = input buruk

  const record = state.nonces.get(parsed.nonce);
  if (!record || record.used) {
    throw unauthorized('Nonce not found or already used'); // DOC-SILENT wording
  }
  if (Date.now() > record.expiresAt) {
    state.nonces.delete(parsed.nonce);
    throw unauthorized('Nonce expired'); // DOC-SILENT wording
  }
  // Teksnya harus byte-demi-byte yang kami terbitkan: nonce saja tidak cukup.
  if (message !== record.message) throw invalidRequest();

  let sigBytes: Uint8Array;
  let pubkeyBytes: Uint8Array;
  try {
    sigBytes = bs58.decode(signature);
    pubkeyBytes = bs58.decode(parsed.wallet);
  } catch {
    throw validation(['signature must be base58']);
  }
  if (sigBytes.length !== 64) throw validation(['signature must be 64 bytes']);
  if (
    !verifyEd25519(
      Buffer.from(message, 'utf8'),
      Buffer.from(sigBytes),
      Buffer.from(pubkeyBytes),
    )
  ) {
    throw unauthorized('Invalid signature'); // DOC-SILENT wording; status ikut "401 Token invalid".
  }

  record.used = true; // doc: "The nonce is single-use"
  state.nonces.delete(parsed.nonce);
  const user = userForWallet(parsed.wallet);
  return { status: 200, body: issueSession(user.id) };
}

function issueSession(userId: string) {
  const accessToken = 'cca_' + uuid();
  const refreshToken = 'ccr_' + uuid();
  const expiresAt = Date.now() + ACCESS_TTL_MS;
  state.accessTokens.set(accessToken, { userId, expiresAt });
  state.refreshTokens.set(refreshToken, {
    userId,
    expiresAt: Date.now() + REFRESH_TTL_MS,
    used: false,
  });
  return { accessToken, refreshToken, expiresAt };
}

function postRefresh(ctx: Ctx): MockResponse {
  checkExtraFields(ctx.body, ['refreshToken']);
  const { refreshToken } = ctx.body as Record<string, string>;
  if (!isStr(refreshToken)) throw invalidRequest();
  const record = state.refreshTokens.get(refreshToken);
  // doc: "The old refresh token dies immediately, so a replay returns
  //       401 Refresh token not found or already used."
  if (!record || record.used || Date.now() > record.expiresAt) {
    throw unauthorized('Refresh token not found or already used');
  }
  record.used = true;
  state.refreshTokens.delete(refreshToken);
  return { status: 200, body: issueSession(record.userId) };
}

function postLogout(ctx: Ctx): MockResponse {
  checkExtraFields(ctx.body, ['refreshToken']);
  const { refreshToken } = ctx.body as Record<string, string>;
  if (!isStr(refreshToken)) throw invalidRequest();
  state.refreshTokens.delete(refreshToken);
  // doc: "Send the access token in the Authorization header too, or it stays valid for the rest
  //       of its 15 minutes." -> hormati kalau ada, abaikan kalau tidak.
  const bearer = /^Bearer\s+(.+)$/i.exec(ctx.headers.authorization || '');
  if (bearer && bearer[1].startsWith('cca_')) {
    state.accessTokens.delete(bearer[1].trim());
  }
  return { status: 200, body: { success: true } }; // DOC-SILENT body
}

/* ── shipping addresses ──────────────────────────────────────────────────── */

const ADDRESS_REQUIRED = ['streetAddress', 'city', 'state', 'country'];
const ADDRESS_OPTIONAL = ['fullName', 'apartment', 'zip', 'phoneNumber', 'isDefault'];

function requireUser(ctx: Ctx): MockUser {
  if (!ctx.user) throw unauthorized('Unauthorized');
  return ctx.user;
}

function postAddressCreate(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  const body = ctx.body;
  // doc: "Any field not on this list returns a 400."  <- menangkap `email` nyasar milik kita
  checkExtraFields(body, [...ADDRESS_REQUIRED, ...ADDRESS_OPTIONAL]);
  // doc: "400 Invalid request. when a required field is missing — the message does not name the field."
  if (!ADDRESS_REQUIRED.every((f) => isStr(body[f]))) throw invalidRequest();
  for (const f of ['fullName', 'apartment', 'zip', 'phoneNumber']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') {
      throw invalidRequest();
    }
  }
  if (body.isDefault !== undefined && !isBool(body.isDefault)) {
    throw invalidRequest();
  }

  const country = resolveCountry(body.country);
  if (!country) {
    throw bad(`Sorry, we do not ship to ${String(body.country)} at this time`);
  }

  const mine = [...state.addresses.values()].filter((a) => a.userId === user.id);
  // doc: "Your first address is always the default."
  const isDefault = mine.length === 0 ? true : body.isDefault === true;
  if (isDefault) mine.forEach((a) => { a.isDefault = false; });

  const row: MockAddress = {
    id: 'ccaddr_' + uuid(),
    userId: user.id,
    fullName: (body.fullName as string) ?? null,
    streetAddress: body.streetAddress as string,
    apartment: (body.apartment as string) ?? null,
    city: body.city as string,
    state: normaliseState(body.state), // doc: "CA" jadi "California"
    country: country.name, // DOC-SILENT: disimpan sebagai nama negara lengkap
    zip: (body.zip as string) ?? null,
    phoneNumber: (body.phoneNumber as string) ?? null,
    isDefault,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.addresses.set(row.id, row);
  return { status: 201, body: serializeAddress(row) };
}

function getAddresses(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  const mine = [...state.addresses.values()]
    .filter((a) => a.userId === user.id)
    .map(serializeAddress);
  return { status: 200, body: mine };
}

function ownedAddress(ctx: Ctx, id: string): MockAddress {
  const user = requireUser(ctx);
  const row = state.addresses.get(id);
  if (!row || row.userId !== user.id) {
    throw notFound('Shipping address not found for this user');
  }
  return row;
}

function getAddressById(ctx: Ctx): MockResponse {
  return { status: 200, body: serializeAddress(ownedAddress(ctx, ctx.params.id)) };
}

function patchAddressById(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  const row = ownedAddress(ctx, ctx.params.id);
  checkExtraFields(ctx.body, [...ADDRESS_REQUIRED, ...ADDRESS_OPTIONAL]);
  for (const [k, v] of Object.entries(ctx.body)) {
    if (k === 'isDefault') {
      if (!isBool(v)) throw invalidRequest();
      if (v) {
        [...state.addresses.values()].forEach((a) => {
          if (a.userId === user.id) a.isDefault = false;
        });
      }
      row.isDefault = v;
    } else if (k === 'country') {
      const c = resolveCountry(v);
      if (!c) throw bad(`Sorry, we do not ship to ${String(v)} at this time`);
      row.country = c.name;
    } else if (k === 'state') {
      if (!isStr(v)) throw invalidRequest();
      row.state = normaliseState(v);
    } else {
      if (v !== null && typeof v !== 'string') throw invalidRequest();
      row[k] = v;
    }
  }
  row.updatedAt = nowIso();
  return { status: 200, body: serializeAddress(row) };
}

function deleteAddressById(ctx: Ctx): MockResponse {
  const row = ownedAddress(ctx, ctx.params.id);
  state.addresses.delete(row.id);
  return { status: 200, body: { success: true } }; // DOC-SILENT body
}

/* ── redeem: estimate / prepare / complete ───────────────────────────────── */

function resolveCards(nftAddresses: string[]): (CatalogueCard & { nftAddress: string })[] {
  const missing = nftAddresses.filter((a) => !lookupCard(a));
  // doc: "404 Cards not found: <addresses>"
  if (missing.length) throw notFound(`Cards not found: ${missing.join(', ')}`);
  const cards = nftAddresses.map((a) => ({
    nftAddress: a,
    ...(lookupCard(a) as CatalogueCard),
  }));
  // doc: "400 with a per-card array as a JSON string in message"
  const rejected = cards.filter((c) => c.notRedeemable);
  if (rejected.length) {
    throw validation(
      rejected.map((c) => ({
        nftAddress: c.nftAddress,
        cardId: c.cardId,
        reason: c.rejectReason || 'Card cannot be redeemed',
      })),
    );
  }
  return cards;
}

function resolveAddressForRedeem(ctx: Ctx, shippingAddressId: string): MockAddress {
  const user = requireUser(ctx);
  const status = mockConfig().addressMissingStatus;
  const row = state.addresses.get(shippingAddressId);
  if (!row || row.userId !== user.id) {
    throw new ApiError(status, {
      statusCode: status,
      message: 'Shipping address not found for this user',
      error: status === 404 ? 'Not Found' : 'Bad Request',
    });
  }
  return row;
}

const ESTIMATE_FIELDS = ['nftAddresses', 'shippingAddressId', 'deliveryCompany', 'payCustomsDuties'];

function postEstimate(ctx: Ctx): MockResponse {
  const body = ctx.body;
  // doc: "This endpoint accepts only these four fields. Reposting a /redeem/prepare body returns a 400."
  checkExtraFields(body, ESTIMATE_FIELDS);
  const errs: string[] = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  if (!isStr(body.shippingAddressId)) errs.push('shippingAddressId must be a string');
  if (body.deliveryCompany !== undefined && !isStr(body.deliveryCompany)) errs.push('deliveryCompany must be a string');
  if (body.payCustomsDuties !== undefined && !isBool(body.payCustomsDuties)) errs.push('payCustomsDuties must be a boolean');
  if (errs.length) throw validation(errs);

  const address = resolveAddressForRedeem(ctx, body.shippingAddressId as string);
  const cards = resolveCards(body.nftAddresses as string[]);
  const quote = quoteFor({
    cards, address,
    payCustomsDuties: body.payCustomsDuties === true,
    paymentMethod: 'crypto',
    deliveryCompany: (body.deliveryCompany as string) || 'ups',
  });
  return { status: 200, body: quote };
}

const PREPARE_FIELDS = [
  'nftAddresses', 'shippingAddressId', 'coin', 'paymentMethod', 'deliveryCompany',
  'comment', 'email', 'payCustomsDuties',
];

function postPrepare(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  const body = ctx.body;
  // doc: "There is no insurance field ... sending the field returns 400 ["property insurance should not exist"]"
  checkExtraFields(body, PREPARE_FIELDS);
  const errs: string[] = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  if (!isStr(body.shippingAddressId)) errs.push('shippingAddressId must be a string');
  if (body.coin !== undefined && !['USDC', 'USDT'].includes(body.coin as string)) errs.push('coin must be one of USDC, USDT');
  if (body.paymentMethod !== undefined && !['crypto', 'card'].includes(body.paymentMethod as string)) {
    errs.push('paymentMethod must be one of crypto, card');
  }
  for (const f of ['deliveryCompany', 'comment', 'email']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') errs.push(`${f} must be a string`);
  }
  if (body.payCustomsDuties !== undefined && !isBool(body.payCustomsDuties)) errs.push('payCustomsDuties must be a boolean');
  if (errs.length) throw validation(errs);

  const coin = (body.coin as string) || 'USDC';
  const paymentMethod = (body.paymentMethod as string) || 'crypto';
  const deliveryCompany = (body.deliveryCompany as string) || 'ups';
  const payCustomsDuties = body.payCustomsDuties === true;

  const address = resolveAddressForRedeem(ctx, body.shippingAddressId as string);
  const cards = resolveCards(body.nftAddresses as string[]);

  // doc: "400 Card payment requires a contact email. Send `email` with this request."
  if (paymentMethod === 'card' && !isStr(body.email) && !isStr(user.email)) {
    throw bad('Card payment requires a contact email. Send `email` with this request.');
  }
  // doc: "400 Crypto payment requires a Solana wallet. Use card payment."
  if (paymentMethod === 'crypto' && !isStr(user.wallet)) {
    throw bad('Crypto payment requires a Solana wallet. Use card payment.');
  }
  if (isStr(body.email)) user.email = body.email;

  const quote = quoteFor({ cards, address, payCustomsDuties, paymentMethod, deliveryCompany });

  // doc: "Calling prepare again with identical input returns the same shipment with fresh
  //       transactions ... Changing the address or toggling payCustomsDuties deliberately
  //       creates a new shipment."
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        u: user.id,
        n: [...(body.nftAddresses as string[])].sort(),
        a: body.shippingAddressId, coin, paymentMethod, deliveryCompany, payCustomsDuties,
        c: body.comment ?? null,
      }),
    )
    .digest('hex');

  let shipment = state.shipments.get(state.prepareKeys.get(key) || '');
  if (!shipment) {
    state.counters.shipment += 1;
    const seq = String(state.counters.shipment).padStart(5, '0');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    shipment = {
      id: 'ccos_' + uuid(),
      customId: `${stamp}42S${seq}`,
      userId: user.id,
      status: 'Pending',
      nftAddresses: [...(body.nftAddresses as string[])],
      cardIds: cards.map((c) => c.cardId),
      shippingAddressId: address.id,
      deliveryCompany, coin, paymentMethod, payCustomsDuties,
      comment: (body.comment as string) ?? null,
      quote,
      trackingIds: [],
      trackingUrls: [],
      recordedLegs: new Map(),
      burned: new Set(),
      paid: false,
      cardPaymentConfirmed: false,
      batch: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    state.shipments.set(shipment.id, shipment);
    state.prepareKeys.set(key, shipment.id);
  } else {
    shipment.quote = quote;
    shipment.updatedAt = nowIso();
  }

  const remaining = shipment.nftAddresses.filter((a) => !shipment!.burned.has(a));
  const batch = issueBatch(shipment, remaining.length ? remaining : shipment.nftAddresses);

  return { status: 200, body: prepareResponse(shipment, batch) };
}

function prepareResponse(shipment: MockShipment, batch: MockBatch) {
  // doc: "totalCost — 0 for card payment, and 0 for a shipment that is already paid."
  const totalCost =
    shipment.paymentMethod === 'card' || shipment.paid ? 0 : shipment.quote.total;
  return {
    outboundShipmentId: shipment.id,
    transactions: batch.burnLegs.map((l) => l.b64),
    delistTransactions: batch.delistLegs.map((l) => l.b64),
    totalCost,
    submitUrl: `/blockchain/${shipment.id}/burn`,
    breakdown: shipment.quote.breakdown,
  };
}

/** doc: "If a burn leg fails, call POST /redeem/complete/:shipmentId — it rebuilds legs for only
 *  the cards not yet burned. If that returns 409, contact support@collectorcrypt.com." */
function postComplete(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  const shipment = state.shipments.get(ctx.params.id);
  if (!shipment || shipment.userId !== user.id) throw notFound('The shipment is not yours.');
  const remaining = shipment.nftAddresses.filter((a) => !shipment.burned.has(a));
  if (!remaining.length) throw conflict('Nothing left to complete for this shipment'); // DOC-SILENT wording
  const batch = issueBatch(shipment, remaining);
  shipment.updatedAt = nowIso();
  return { status: 200, body: prepareResponse(shipment, batch) };
}

/* ── burn ────────────────────────────────────────────────────────────────── */

function postBurn(ctx: Ctx): MockResponse {
  const shipment = state.shipments.get(ctx.params.id);
  // doc: "404 The shipment is not yours."
  if (!shipment || !ctx.user || shipment.userId !== ctx.user.id) {
    throw notFound('The shipment is not yours.');
  }

  /* doc: sebuah API key "may report EVM transaction hashes only — { evmTransactions: [{chain, txHash}] }.
     Sending Solana transactions on a key is refused." */
  if (ctx.credential === 'key') {
    if (ctx.body.transactions !== undefined || ctx.body.delistTransactions !== undefined) {
      // DOC-SILENT status: 403 ("out of scope for this credential") adalah bucket terdekat.
      throw forbidden('Solana transactions cannot be submitted with an API key. Solana redemptions need a wallet sign-in session.');
    }
    checkExtraFields(ctx.body, ['evmTransactions']);
    const legs = Array.isArray(ctx.body.evmTransactions)
      ? (ctx.body.evmTransactions as Record<string, unknown>[])
      : null;
    if (!legs || !legs.length) throw forbidden('Transaction was not issued by this server');
    const results = legs.map((leg) => {
      const legKey = `evm:${String(leg?.chain)}:${String(leg?.txHash)}`;
      const seen = shipment.recordedLegs.get(legKey);
      if (seen) return { error: 'Duplicate transaction result', ...seen };
      const rec = {
        transactionId: String(leg?.txHash),
        transactionUrl: `https://etherscan.io/tx/${String(leg?.txHash)}`,
      };
      shipment.recordedLegs.set(legKey, rec);
      return { error: null, ...rec };
    });
    shipment.updatedAt = nowIso();
    return { status: 200, body: sortFailuresFirst(results) };
  }

  // doc: "409 shipment <id> is awaiting card payment confirmation"
  if (shipment.paymentMethod === 'card' && !shipment.cardPaymentConfirmed) {
    throw conflict(`shipment ${shipment.id} is awaiting card payment confirmation`);
  }

  const txs = ctx.body.transactions;
  const dtxs = ctx.body.delistTransactions;
  if (txs !== undefined && !Array.isArray(txs)) throw validation(['transactions must be an array']);
  if (dtxs !== undefined && !Array.isArray(dtxs)) throw validation(['delistTransactions must be an array']);
  checkExtraFields(ctx.body, ['transactions', 'delistTransactions']);

  const submittedBurn = ((txs as string[]) || []).map(decodeLeg);
  const submittedDelist = ((dtxs as string[]) || []).map(decodeLeg);
  const recognised = [...submittedBurn, ...submittedDelist].filter(
    (l): l is MockLegMarker => l !== null,
  );

  // doc: "403 Transaction was not issued by this server — Nothing recognised — you sent nothing,
  //       only de-list legs, or an expired batch."
  if (
    !recognised.length ||
    !submittedBurn.filter(Boolean).length ||
    !batchLive(shipment)
  ) {
    throw forbidden('Transaction was not issued by this server');
  }
  const batch = shipment.batch as MockBatch;
  // doc: "403 These transactions were not issued for this shipment — Wrong outboundShipmentId."
  if (recognised.some((l) => l.s !== shipment.id)) {
    throw forbidden('These transactions were not issued for this shipment');
  }
  // doc: "403 The transactions submitted are not the complete set this server issued —
  //       A leg is missing, duplicated, or from another prepare call."
  const sameSet = (
    submitted: (MockLegMarker | null)[],
    legs: MockLeg[],
    kind: string,
  ) => {
    const got = submitted
      .filter((l): l is MockLegMarker => l !== null)
      .filter((l) => l.k === kind);
    if (got.length !== legs.length) return false;
    if (got.some((l) => l.b !== batch.id)) return false;
    const want = new Set(legs.map((l) => l.index));
    const seen = new Set<number>();
    for (const l of got) {
      if (!want.has(l.i) || seen.has(l.i)) return false;
      seen.add(l.i);
    }
    return true;
  };
  if (submittedBurn.some((l) => l === null) || submittedDelist.some((l) => l === null)) {
    throw forbidden('The transactions submitted are not the complete set this server issued');
  }
  if (
    !sameSet(submittedBurn, batch.burnLegs, 'burn') ||
    !sameSet(submittedDelist, batch.delistLegs, 'delist')
  ) {
    throw forbidden('The transactions submitted are not the complete set this server issued');
  }

  // doc: "409 with delistErrors — A de-list leg failed. Nothing was burned."
  const delistErrors = batch.delistLegs
    .filter((l) => lookupCard(l.nftAddress)?.delistFails)
    .map((l) => ({ nftAddress: l.nftAddress, error: 'De-list transaction failed to land' }));
  if (delistErrors.length) {
    // DOC-SILENT bentuk body
    throw conflict('De-list failed for one or more cards. Nothing was burned.', { delistErrors });
  }

  const results: { error: string | null; transactionId: string | null; transactionUrl: string | null }[] = [];
  for (const leg of [...batch.delistLegs, ...batch.burnLegs]) {
    const legKey = `${leg.kind}:${leg.index}:${leg.nftAddress}`;
    // doc: "legs already recorded come back as { "error": "Duplicate transaction result", ... }"
    const seen = shipment.recordedLegs.get(legKey);
    if (seen) {
      results.push({ error: 'Duplicate transaction result', ...seen });
      continue;
    }
    if (leg.kind === 'burn' && lookupCard(leg.nftAddress)?.burnFails) {
      // doc: "a 200 with a non-null error on any element means that leg did not land."
      results.push({ error: 'Transaction failed to land', transactionId: null, transactionUrl: null });
      continue;
    }
    const sig = fakeSignature();
    const rec = { transactionId: sig, transactionUrl: `https://solscan.io/tx/${sig}` };
    shipment.recordedLegs.set(legKey, rec);
    if (leg.kind === 'burn') shipment.burned.add(leg.nftAddress);
    results.push({ error: null, ...rec });
  }

  shipment.paid = true;
  shipment.updatedAt = nowIso();
  // doc: "The response is HTTP 200 with a bare JSON array, failures first"
  return { status: 200, body: sortFailuresFirst(results) };
}

/** doc: "failures first". Duplikat juga membawa error non-null, jadi ikut terurut bersamanya. */
function sortFailuresFirst<T extends { error: string | null }>(results: T[]): T[] {
  return [...results].sort((a, b) => (a.error === null ? 1 : 0) - (b.error === null ? 1 : 0));
}

/* ── outbound shipments ──────────────────────────────────────────────────── */

const ACTIVE_STATUSES = ['Pending', 'Shipped', 'Delivered'];
const PAST_STATUSES = ['Delivered', 'Cancelled'];

function getShipments(ctx: Ctx): MockResponse {
  const user = requireUser(ctx);
  let rows = [...state.shipments.values()].filter((s) => s.userId === user.id);
  const status = ctx.query.get('status');
  if (status === 'Active') rows = rows.filter((s) => ACTIVE_STATUSES.includes(s.status));
  else if (status === 'Past') rows = rows.filter((s) => PAST_STATUSES.includes(s.status));
  else if (status) throw validation(['status must be one of Active, Past']);
  const search = ctx.query.get('search');
  if (isStr(search)) {
    const q = search.toLowerCase();
    rows = rows.filter(
      (s) =>
        s.id.toLowerCase().includes(q) ||
        s.customId.toLowerCase().includes(q) ||
        s.cardIds.some((c) => c.toLowerCase().includes(q)) ||
        s.nftAddresses.some((a) => a.toLowerCase().includes(q)),
    );
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // doc: "newest first"
  return { status: 200, body: rows.map(serializeShipment) }; // DOC-SILENT: envelope array telanjang
}

function getShipmentById(ctx: Ctx): MockResponse {
  const s = state.shipments.get(ctx.params.id);
  // doc: "An unknown id returns 200 with an empty body ... does not return 404."
  if (!s || !ctx.user || s.userId !== ctx.user.id) return { status: 200, body: null };
  return { status: 200, body: serializeShipment(s) };
}

/* ── partner: customers + inbound shipments ──────────────────────────────── */

function postPartnerCustomers(ctx: Ctx): MockResponse {
  checkExtraFields(ctx.body, ['externalId']);
  const { externalId } = ctx.body as Record<string, string>;
  if (!isStr(externalId)) throw invalidRequest();
  const existing = state.byExternalId.get(externalId);
  // doc: "idempotent"
  if (existing) return { status: 200, body: { userId: existing, created: false } };
  const id = 'ccu_' + uuid();
  state.users.set(id, { id, wallet: null, externalId, email: null });
  state.byExternalId.set(externalId, id);
  return { status: 200, body: { userId: id, created: true } };
}

const INBOUND_FIELDS = ['nftAddresses', 'externalRef', 'trackingId', 'declaredValue'];

function postInbound(ctx: Ctx): MockResponse {
  checkExtraFields(ctx.body, INBOUND_FIELDS);
  const body = ctx.body;
  const errs: string[] = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  else if (new Set(body.nftAddresses).size > 2000) errs.push('nftAddresses must contain no more than 2000 elements');
  for (const f of ['externalRef', 'trackingId']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') errs.push(`${f} must be a string`);
  }
  if (body.declaredValue !== undefined && typeof body.declaredValue !== 'number') errs.push('declaredValue must be a number');
  if (errs.length) throw validation(errs);

  const addresses = [...new Set(body.nftAddresses as string[])]; // doc: "Deduplicated for you."
  state.counters.inbound += 1;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `${stamp}42S${String(state.counters.inbound).padStart(5, '0')}`;
  const declaredLines: MockInboundLine[] = addresses.map((addr) => {
    const card = getCatalogue().get(addr);
    if (!card) {
      // doc: "An address we do not hold comes back as a rejected line, not an error."
      return {
        kind: 'CardRaw', state: 'Rejected', externalRef: addr,
        note: 'not found in the CollectorCrypt catalogue',
      };
    }
    const line: MockInboundLine = { kind: card.kind, state: 'Declared', externalRef: addr };
    if (card.kind === 'Cert') {
      line.vaultItem = { status: 'Vaulted', gradingId: card.gradingId, gemrateCardName: card.name };
    }
    return line;
  });
  const record: MockInbound = {
    id,
    ownerKeyUserId: ctx.user?.id ?? 'partner',
    status: 'Processing',
    externalRef: (body.externalRef as string) ?? null,
    trackingId: (body.trackingId as string) ?? null,
    declaredValue: (body.declaredValue as number) ?? null,
    declaredLines,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.inbound.set(id, record);
  return { status: 200, body: serializeInbound(record) };
}

function serializeInbound(r: MockInbound) {
  const counts = {
    declared: r.declaredLines.length,
    received: r.declaredLines.filter((l) => l.state === 'Received').length,
    rejected: r.declaredLines.filter((l) => l.state === 'Rejected').length,
  };
  return {
    id: r.id, status: r.status, externalRef: r.externalRef, trackingId: r.trackingId,
    declaredValue: r.declaredValue, counts, declaredLines: r.declaredLines,
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

function getInbound(ctx: Ctx): MockResponse {
  const page = Math.max(1, Number(ctx.query.get('page') || 1));
  const step = Math.min(200, Math.max(1, Number(ctx.query.get('step') || 50))); // doc: "step (max 200)"
  const status = ctx.query.get('status');
  let rows = [...state.inbound.values()];
  if (isStr(status)) rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const slice = rows.slice((page - 1) * step, (page - 1) * step + step);
  return { status: 200, body: slice.map(serializeInbound) }; // DOC-SILENT: envelope array telanjang
}

function getInboundById(ctx: Ctx): MockResponse {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Inbound shipment not found'); // DOC-SILENT wording
  return { status: 200, body: serializeInbound(r) };
}

function patchInboundById(ctx: Ctx): MockResponse {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Inbound shipment not found');
  checkExtraFields(ctx.body, ['externalRef', 'trackingId', 'declaredValue']);
  if (ctx.body.trackingId !== undefined) r.trackingId = ctx.body.trackingId as string;
  if (ctx.body.externalRef !== undefined) r.externalRef = ctx.body.externalRef as string;
  if (ctx.body.declaredValue !== undefined) r.declaredValue = ctx.body.declaredValue as number;
  r.updatedAt = nowIso();
  return { status: 200, body: serializeInbound(r) };
}

/* ── mock-only helpers (BUKAN bagian dari API CollectorCrypt) ────────────── */

function mockState(): MockResponse {
  const cfg = mockConfig();
  return {
    status: 200,
    body: {
      note: 'MOCK ONLY — these /__mock routes do not exist on the real CollectorCrypt API.',
      partnerAppId: cfg.partnerAppId,
      allowedDomains: cfg.allowedDomains,
      apiKey: cfg.apiKey,
      apiKeyScopes: [...cfg.apiKeyScopes],
      seededNftAddresses: [...getCatalogue().keys()],
      users: state.users.size,
      addresses: [...state.addresses.values()].map(serializeAddress),
      shipments: [...state.shipments.values()].map((s) => ({
        ...serializeShipment(s),
        paid: s.paid,
        burned: [...s.burned],
        batchExpiresAt: s.batch ? new Date(s.batch.expiresAt).toISOString() : null,
      })),
      inbound: [...state.inbound.values()].map(serializeInbound),
    },
  };
}

function mockShipmentPatch(ctx: Ctx): MockResponse {
  const s = state.shipments.get(ctx.params.id);
  if (!s) throw notFound('Unknown shipment');
  const { status, trackingIds, trackingUrls, confirmCardPayment } = ctx.body || {};
  if (status !== undefined) {
    if (!['Pending', 'Shipped', 'Delivered', 'Cancelled'].includes(status as string)) {
      throw validation(['status must be one of Pending, Shipped, Delivered, Cancelled']);
    }
    s.status = status as string;
  }
  if (Array.isArray(trackingIds)) s.trackingIds = trackingIds as string[];
  if (Array.isArray(trackingUrls)) s.trackingUrls = trackingUrls as string[];
  if (confirmCardPayment === true) s.cardPaymentConfirmed = true;
  s.updatedAt = nowIso();
  return { status: 200, body: serializeShipment(s) };
}

function mockInboundReceive(ctx: Ctx): MockResponse {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Unknown inbound shipment');
  r.declaredLines.forEach((l) => { if (l.state === 'Declared') l.state = 'Received'; });
  r.status = 'Received';
  r.updatedAt = nowIso();
  return { status: 200, body: serializeInbound(r) };
}

export function mockReset(): MockResponse {
  state.nonces.clear(); state.accessTokens.clear(); state.refreshTokens.clear();
  state.users.clear(); state.byWallet.clear(); state.byExternalId.clear();
  state.addresses.clear(); state.shipments.clear(); state.prepareKeys.clear();
  state.inbound.clear(); state.nonceHits.clear();
  state.counters.shipment = 0; state.counters.inbound = 0;
  return { status: 200, body: { reset: true } };
}

/* ═══════════════════════════════ routing ═══════════════════════════════ */
/**
 * access:
 *   public        — tanpa kredensial
 *   session       — true kalau access token (cca_) boleh sampai ke rute ini.
 *                   doc: "An access token from this flow reaches the shipping routes below and
 *                   nothing else. Anything else returns a bare 403 with no message."
 *   keyScope      — scope yang dibutuhkan API key (tabel scope dokumen); null = key tak bisa masuk
 *   customer      — rute key yang butuh X-CC-Customer (doc: semua kecuali /partner/customers dan
 *                   /partner/inbound-shipments)
 */
interface Route {
  m: string;
  p: RegExp;
  keys?: string[];
  access?: 'public';
  session?: boolean;
  keyScope?: string;
  customer?: boolean;
  h: (ctx: Ctx) => MockResponse;
}

const ROUTES: Route[] = [
  { m: 'POST', p: /^\/auth\/wallet\/nonce$/, access: 'public', h: postNonce },
  { m: 'POST', p: /^\/auth\/wallet\/verify$/, access: 'public', h: postVerify },
  { m: 'POST', p: /^\/auth\/wallet\/refresh$/, access: 'public', h: postRefresh },
  { m: 'POST', p: /^\/auth\/wallet\/logout$/, access: 'public', h: postLogout },

  { m: 'POST', p: /^\/shipping-address\/create$/, session: true, keyScope: 'shipping-address', customer: true, h: postAddressCreate },
  { m: 'GET', p: /^\/shipping-address$/, session: true, keyScope: 'shipping-address', customer: true, h: getAddresses },
  { m: 'GET', p: /^\/shipping-address\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'shipping-address', customer: true, h: getAddressById },
  { m: 'PATCH', p: /^\/shipping-address\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'shipping-address', customer: true, h: patchAddressById },
  { m: 'DELETE', p: /^\/shipping-address\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'shipping-address', customer: true, h: deleteAddressById },

  { m: 'POST', p: /^\/redeem\/estimate$/, session: true, keyScope: 'redeem', customer: true, h: postEstimate },
  { m: 'POST', p: /^\/redeem\/prepare$/, session: true, keyScope: 'redeem', customer: true, h: postPrepare },
  { m: 'POST', p: /^\/redeem\/complete\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'redeem', customer: true, h: postComplete },

  // doc: burn "is reachable with an API key, but a key may report EVM transaction hashes only".
  // DOC-SILENT: dokumen tidak menyebut scope untuk rute ini, jadi key valid mana pun diterima.
  { m: 'POST', p: /^\/blockchain\/([^/]+)\/burn$/, keys: ['id'], session: true, keyScope: '*', customer: true, h: postBurn },

  { m: 'GET', p: /^\/outbound-shipment$/, session: true, keyScope: 'outbound-shipment', customer: true, h: getShipments },
  { m: 'GET', p: /^\/outbound-shipment\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'outbound-shipment', customer: true, h: getShipmentById },

  { m: 'POST', p: /^\/partner\/customers$/, session: false, keyScope: 'customers:provision', customer: false, h: postPartnerCustomers },
  { m: 'POST', p: /^\/partner\/inbound-shipments$/, session: false, keyScope: 'inbound-shipment', customer: false, h: postInbound },
  { m: 'GET', p: /^\/partner\/inbound-shipments$/, session: false, keyScope: 'inbound-shipment', customer: false, h: getInbound },
  { m: 'GET', p: /^\/partner\/inbound-shipments\/([^/]+)$/, keys: ['id'], session: false, keyScope: 'inbound-shipment', customer: false, h: getInboundById },
  { m: 'PATCH', p: /^\/partner\/inbound-shipments\/([^/]+)$/, keys: ['id'], session: false, keyScope: 'inbound-shipment', customer: false, h: patchInboundById },

  // hook test khusus mock — jelas ber-namespace, tidak pernah ada di permukaan CC
  { m: 'GET', p: /^\/__mock\/state$/, access: 'public', h: mockState },
  { m: 'POST', p: /^\/__mock\/reset$/, access: 'public', h: mockReset },
  { m: 'PATCH', p: /^\/__mock\/shipment\/([^/]+)$/, keys: ['id'], access: 'public', h: mockShipmentPatch },
  { m: 'POST', p: /^\/__mock\/inbound\/([^/]+)\/receive$/, keys: ['id'], access: 'public', h: mockInboundReceive },
];

function authenticate(
  headers: Record<string, string | undefined>,
  route: Route,
): { credential: 'session' | 'key'; user: MockUser | null } {
  const cfg = mockConfig();
  const auth = headers.authorization || '';
  /* doc: "This API does not read an x-api-key header. Use Authorization: Bearer."
     Jadi x-api-key tidak pernah jadi kredensial; dikirim sendirian, request tetap tanpa auth. */
  const strayKeyHeader = isStr(headers['x-api-key']);
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (!bearer) {
    if (strayKeyHeader) throw unauthorized('Invalid API key');
    throw unauthorized('Unauthorized'); // DOC-SILENT wording; dokumen hanya menetapkan status (401)
  }
  const token = bearer[1].trim();

  if (token.startsWith('cca_')) {
    const session = state.accessTokens.get(token);
    if (!session || Date.now() > session.expiresAt) {
      state.accessTokens.delete(token);
      throw unauthorized('Access token invalid or expired'); // DOC-SILENT wording
    }
    if (route.session !== true) throw bareForbidden(); // doc: "a bare 403 with no message"
    return { credential: 'session', user: getUser(session.userId) };
  }

  if (token.startsWith('ccsk_')) {
    // doc: "401 Invalid API key for every key failure — unknown, wrong, revoked, expired or disabled."
    if (token !== cfg.apiKey) throw unauthorized('Invalid API key');
    if (!route.keyScope) throw forbidden('This API key does not carry the required scope');
    if (route.keyScope !== '*' && !cfg.apiKeyScopes.has(route.keyScope)) {
      throw forbidden(`This API key does not carry the '${route.keyScope}' scope`);
    }
    if (route.customer) {
      const externalId = headers['x-cc-customer'];
      // doc: "400 x-cc-customer header is required on this route, which you also get for a
      //       customer id that does not exist."
      if (!isStr(externalId)) throw bad('x-cc-customer header is required on this route');
      const userId = state.byExternalId.get(String(externalId));
      if (!userId) throw bad('x-cc-customer header is required on this route');
      return { credential: 'key', user: getUser(userId) };
    }
    return { credential: 'key', user: null };
  }

  throw unauthorized('Invalid API key');
}

/**
 * SATU pintu masuk kontrak. Melempar ApiError untuk setiap kegagalan yang didokumenkan —
 * pemanggil (controller Nest / server standalone) yang menerjemahkannya ke respons HTTP.
 */
export function handleMockRequest(req: MockRequest): MockResponse {
  const pathname = req.path.replace(/\/+$/, '') || '/';

  /* doc: "Send a non-empty User-Agent. A request without one is refused at the edge and never
     reaches the API." DOC-SILENT status — 400 mewakili penolakan di edge. */
  if (!isStr(req.headers['user-agent']) && !pathname.startsWith('/__mock')) {
    throw new ApiError(400, {
      statusCode: 400,
      message: 'A non-empty User-Agent header is required.',
    });
  }

  const route = ROUTES.find((r) => r.m === req.method && r.p.test(pathname));
  if (!route) {
    const pathExists = ROUTES.some((r) => r.p.test(pathname));
    throw new ApiError(pathExists ? 405 : 404, {
      statusCode: pathExists ? 405 : 404,
      message: pathExists ? 'Method not allowed' : 'Cannot ' + req.method + ' ' + pathname,
      error: pathExists ? 'Method Not Allowed' : 'Not Found',
    });
  }

  const body = req.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest();
  }

  const match = route.p.exec(pathname) as RegExpExecArray;
  const params: Record<string, string> = {};
  (route.keys || []).forEach((k, i) => {
    params[k] = decodeURIComponent(match[i + 1]);
  });

  let credential: 'public' | 'session' | 'key' = 'public';
  let user: MockUser | null = null;
  if (route.access !== 'public') {
    const auth = authenticate(req.headers, route);
    credential = auth.credential;
    user = auth.user;
  }

  return route.h({ body, params, query: req.query, headers: req.headers, user, credential });
}
