/**
 * Mock CollectorCrypt Vault Shipping API — STANDALONE, zero dependencies, in-memory.
 *
 * Mirrors the real "Shipping API | Collector Crypt" document as literally as possible so our
 * redeem flow can be dry-run locally with no CC credentials. Where the document is silent the
 * behaviour is kept minimal and flagged with a `DOC-SILENT:` comment (README lists every one).
 *
 * Run:  node mock-cc-shipping/server.mjs          (Node 20+, built-ins only)
 *
 * Nothing here is imported by the backend: it is a separate process the backend talks to over
 * HTTP via COLLECTORCRYPT_SHIPPING_BASE_URL.
 */
import http from 'node:http';
import crypto from 'node:crypto';

/* ─────────────────────────────── config (env) ─────────────────────────────── */

const PORT = Number(process.env.PORT || 4010);
const PARTNER_APP_ID = process.env.MOCK_PARTNER_APP_ID || 'hoshi-mock-partner';
const ALLOWED_DOMAINS = (process.env.MOCK_ALLOWED_DOMAINS || 'localhost,127.0.0.1')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const API_KEY = process.env.MOCK_API_KEY || 'ccsk_mock_key_do_not_use_in_prod';
const ALL_SCOPES = ['shipping-address', 'outbound-shipment', 'redeem', 'inbound-shipment', 'customers:provision'];
const API_KEY_SCOPES = new Set(
  (process.env.MOCK_API_KEY_SCOPES || ALL_SCOPES.join(',')).split(',').map((s) => s.trim()).filter(Boolean),
);
const SIWS_STATEMENT = process.env.MOCK_SIWS_STATEMENT || 'Sign in to Collector Crypt.';
const SIWS_CHAIN_ID = process.env.MOCK_SIWS_CHAIN_ID || 'mainnet';
const ACCEPT_ANY_NFT = /^(1|true|yes)$/i.test(process.env.MOCK_ACCEPT_ANY_NFT || '');
const EXTRA_NFTS = (process.env.MOCK_NFT_ADDRESSES || '').split(',').map((s) => s.trim()).filter(Boolean);
/** The doc contradicts itself on this one error (404 in the route table, 400 in the error sample). */
const ADDRESS_MISSING_STATUS = process.env.MOCK_ADDRESS_NOT_FOUND_STATUS === '400' ? 400 : 404;
/** Nonce rate limit, per wallet per minute. `off` disables it (dry-runs that loop a lot). */
const NONCE_RATE_LIMIT = process.env.MOCK_NONCE_RATE_LIMIT === 'off'
  ? 0
  : Number(process.env.MOCK_NONCE_RATE_LIMIT || 10);
const VERBOSE = !/^(0|false|no)$/i.test(process.env.MOCK_LOG || 'true');

const NONCE_TTL_MS = 5 * 60 * 1000;             // doc: nonce single-use, valid 5 minutes
const MESSAGE_EXP_MS = 60 * 60 * 1000;          // doc: the "Expiration Time" line shows a LONGER window
const ACCESS_TTL_MS = 15 * 60 * 1000;           // doc: access token lasts 15 minutes
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // doc: refresh token lasts 7 days
const TX_TTL_MS = 15 * 60 * 1000;               // doc: the issued transaction set is held 15 minutes

/* ─────────────────────────────── tiny utils ─────────────────────────────── */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Map([...B58].map((c, i) => [c, i]));

/** base58 -> Buffer. Inline, no dependency. Throws on any non-base58 character. */
function base58Decode(str) {
  if (typeof str !== 'string' || str.length === 0) throw new Error('empty base58 string');
  const bytes = [0];
  for (const ch of str) {
    const val = B58_MAP.get(ch);
    if (val === undefined) throw new Error('invalid base58 character: ' + ch);
    let carry = val;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (let k = 0; k < str.length && str[k] === '1'; k++) bytes.push(0);
  return Buffer.from(bytes.reverse());
}

/** Buffer -> base58 (used to mint realistic-looking Solana signatures). */
function base58Encode(buf) {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = '';
  for (let k = 0; k < buf.length && buf[k] === 0; k++) out += '1';
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

/**
 * REAL ed25519 verification with node:crypto — a mock that skips this is worthless for a dry-run.
 * A Solana address IS the raw 32-byte ed25519 public key, so the key is rebuilt from a JWK.
 */
function verifyEd25519(messageBuf, signatureBuf, publicKeyBuf) {
  if (publicKeyBuf.length !== 32 || signatureBuf.length !== 64) return false;
  const key = crypto.createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyBuf.toString('base64url') },
    format: 'jwk',
  });
  return crypto.verify(null, messageBuf, key, signatureBuf);
}

const money = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const moneyStr = (n) => money(n).toFixed(2);
const nowIso = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const fakeSignature = () => base58Encode(crypto.randomBytes(64));
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isBool = (v) => typeof v === 'boolean';
const isStrArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isStr);

/* ─────────────────────────────── in-memory state ─────────────────────────────── */

const state = {
  nonces: new Map(),       // nonce        -> { wallet, domain, uri, message, expiresAt, used }
  accessTokens: new Map(), // cca_...      -> { userId, expiresAt }
  refreshTokens: new Map(),// ccr_...      -> { userId, expiresAt, used }
  users: new Map(),        // userId       -> { id, wallet, externalId, email }
  byWallet: new Map(),     // wallet       -> userId
  byExternalId: new Map(), // externalId   -> userId
  addresses: new Map(),    // addressId    -> address row (+ userId)
  shipments: new Map(),    // shipmentId   -> shipment record
  prepareKeys: new Map(),  // identical-input hash -> shipmentId
  inbound: new Map(),      // inboundId    -> consignment
  nonceHits: new Map(),    // wallet       -> number[] (timestamps, for the 429)
  counters: { shipment: 0, inbound: 0 },
};

const getUser = (id) => state.users.get(id);

function userForWallet(wallet) {
  let id = state.byWallet.get(wallet);
  if (!id) {
    id = 'ccu_' + uuid();
    state.users.set(id, { id, wallet, externalId: null, email: null });
    state.byWallet.set(wallet, id);
  }
  return state.users.get(id);
}

/* ─────────────────────────────── seeded catalogue ─────────────────────────────── */
/**
 * Fake vaulted cards. The flags exist so a dry-run can reach the documented sad paths:
 *   escrowed      -> prepare returns delistTransactions
 *   delistFails   -> burn answers 409 with delistErrors (nothing burned)
 *   burnFails     -> burn answers 200 with a non-null error on that leg (then /redeem/complete/:id)
 *   notRedeemable -> estimate/prepare answer 400 with a per-card array as a JSON string in message
 */
const CATALOGUE = new Map(Object.entries({
  '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU': {
    cardId: 'cc-card-0001', name: '1999 Pokemon Base Charizard', declaredValue: 80,
    kind: 'Cert', gradingId: '12345678',
  },
  '9aBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dE3fGhJkM': {
    cardId: 'cc-card-0002', name: '2003 Yu-Gi-Oh Blue-Eyes White Dragon', declaredValue: 260,
    kind: 'Cert', gradingId: '22345678',
  },
  '3mQzXyW9vU8tS7rQ6pN5mK4jH3gF2eD1cB9aZ8yX7wVt': {
    cardId: 'cc-card-0003', name: '2018 Panini Prizm Luka Doncic RC', declaredValue: 1200,
    kind: 'Cert', gradingId: '32345678',
  },
  'ESCRWaBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dEfGh': {
    cardId: 'cc-card-0004', name: '2021 Pokemon Evolving Skies Booster Box', declaredValue: 450,
    kind: 'Bulk', escrowed: true,
  },
  'ESCRWFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE': {
    cardId: 'cc-card-0005', name: '1986 Fleer Michael Jordan RC', declaredValue: 3000,
    kind: 'Cert', gradingId: '42345678', escrowed: true, delistFails: true,
  },
  'BURNFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dEf': {
    cardId: 'cc-card-0006', name: '2020 Topps Chrome Mookie Betts', declaredValue: 45,
    kind: 'CardRaw', burnFails: true,
  },
  'NOTREDEEMbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE': {
    cardId: 'cc-card-0007', name: '2022 Topps Sealed Case', declaredValue: 900,
    kind: 'Bulk', notRedeemable: true,
    rejectReason: 'Card is pending an inbound scan and cannot be redeemed yet',
  },
}));
for (const addr of EXTRA_NFTS) {
  if (!CATALOGUE.has(addr)) {
    CATALOGUE.set(addr, {
      cardId: 'cc-card-env-' + (CATALOGUE.size + 1), name: 'Env-seeded card',
      declaredValue: 100, kind: 'CardRaw',
    });
  }
}
function lookupCard(addr) {
  const hit = CATALOGUE.get(addr);
  if (hit) return hit;
  if (ACCEPT_ANY_NFT) {
    return { cardId: 'cc-card-any-' + addr.slice(0, 6), name: 'Unlisted card', declaredValue: 100, kind: 'CardRaw' };
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
const resolveCountry = (raw) => COUNTRIES.find((c) => c.names.includes(String(raw).trim().toUpperCase())) || null;

/** doc: state is "stored normalised to the subdivision name, so CA becomes California". */
const SUBDIVISIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DC: 'District of Columbia', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', IL: 'Illinois', IN: 'Indiana', MA: 'Massachusetts', MD: 'Maryland', MI: 'Michigan',
  MN: 'Minnesota', NC: 'North Carolina', NJ: 'New Jersey', NV: 'Nevada', NY: 'New York', OH: 'Ohio',
  OR: 'Oregon', PA: 'Pennsylvania', TX: 'Texas', UT: 'Utah', VA: 'Virginia', WA: 'Washington',
  WI: 'Wisconsin',
  ON: 'Ontario', BC: 'British Columbia', QC: 'Quebec', AB: 'Alberta',
  JK: 'Jakarta', JB: 'West Java', BT: 'Banten',
};
const normaliseState = (raw) => SUBDIVISIONS[String(raw).trim().toUpperCase()] || String(raw).trim();

/* ─────────────────────────────── error helpers ─────────────────────────────── */
/** doc: "Error bodies are not uniform — branch on the HTTP status, never on the presence of a field." */

class ApiError extends Error {
  constructor(status, body, headers) {
    super('api-error');
    this.status = status;
    this.body = body;           // null => empty body
    this.headers = headers || {};
  }
}
const bad = (message) => new ApiError(400, { statusCode: 400, message, error: 'Bad Request' });
/** doc sample: { "statusCode": 400, "message": "Invalid request." } — no `error` key. */
const invalidRequest = () => new ApiError(400, { statusCode: 400, message: 'Invalid request.' });
/** doc: "for validation failures and per-card rejections [message] is a string containing JSON." */
const validation = (messages) =>
  new ApiError(400, { statusCode: 400, message: JSON.stringify(messages), error: 'Bad Request' });
const unauthorized = (message) => new ApiError(401, { statusCode: 401, message, error: 'Unauthorized' });
const forbidden = (message) => new ApiError(403, { statusCode: 403, message, error: 'Forbidden' });
/** doc: an access token outside the shipping routes gets "a bare 403 with no message". */
const bareForbidden = () => new ApiError(403, null);
const notFound = (message) => new ApiError(404, { statusCode: 404, message, error: 'Not Found' });
const conflict = (message, extra) =>
  new ApiError(409, { statusCode: 409, message, error: 'Conflict', ...(extra || {}) });
const tooManyRequests = (message, retryAfter) =>
  new ApiError(429, { statusCode: 429, message, retryAfter }, { 'Retry-After': String(retryAfter) });

/**
 * Whitelist validator. `extra` fields are rejected the way class-validator's forbidNonWhitelisted
 * does — that is the behaviour that catches us posting a field CC never declared (e.g. `email`
 * on /shipping-address/create, or an /redeem/prepare body reposted to /redeem/estimate).
 */
function checkExtraFields(body, allowed) {
  const extras = Object.keys(body).filter((k) => !allowed.includes(k));
  if (extras.length) throw validation(extras.map((k) => `property ${k} should not exist`));
}

/* ─────────────────────────────── pricing ─────────────────────────────── */

const REGION_BASE = {
  USA: 5.99, Canada: 14.99, Europe: 19.99, AustraliaNewZealand: 24.99, RestOfWorld: 29.99,
};
const EXTRA_CARD_PRICE = 1.5;

function quoteFor({ cards, address, payCustomsDuties, paymentMethod, deliveryCompany }) {
  const region = resolveCountry(address.country)?.region ?? 'RestOfWorld';
  const numberOfCards = cards.length;
  const declaredValue = money(cards.reduce((sum, c) => sum + c.declaredValue, 0));
  const base = REGION_BASE[region];
  const extra = money(EXTRA_CARD_PRICE * Math.max(0, numberOfCards - 1));
  const shippingPrice = money(base + extra);
  const insurancePrice = declaredValue <= 100 ? 0 : money(declaredValue * 0.01);
  const subtotal = money(shippingPrice + insurancePrice);
  const feesPrice = paymentMethod === 'card' ? money(subtotal * 0.029 + 0.3) : 0;
  const customsDutiesEstimate = region === 'USA' ? 0 : money(declaredValue * 0.08);
  const price = money(shippingPrice + insurancePrice + feesPrice);
  const total = money(price + (payCustomsDuties ? customsDutiesEstimate : 0));

  const lines = [
    { code: 'SHIPPING_BASE', label: `Shipping (${deliveryCompany}, ${region})`, amount: base },
  ];
  if (numberOfCards > 1) {
    lines.push({
      code: 'SHIPPING_EXTRA_CARD', label: 'Additional cards', amount: extra,
      qty: numberOfCards - 1, unitPrice: EXTRA_CARD_PRICE,
    });
  }
  lines.push({ code: 'INSURANCE', label: 'Insurance (automatic)', amount: insurancePrice });
  if (feesPrice > 0) lines.push({ code: 'CARD_PAYMENT_FEE', label: 'Card payment fee', amount: feesPrice });
  if (payCustomsDuties) {
    lines.push({ code: 'CUSTOMS_DUTIES', label: 'Customs duties (prepaid)', amount: customsDutiesEstimate });
  }

  const notes = ['Insurance is automatic and cannot be turned off.'];
  if (!payCustomsDuties && customsDutiesEstimate > 0) {
    notes.push('Customs duties are payable to the carrier on delivery unless you opt in.');
  }

  return {
    price, insurancePrice, feesPrice, shippingPrice, total, numberOfCards, customsDutiesEstimate,
    breakdown: { region, declaredValue, numberOfCards, lines, notes },
  };
}

/* ─────────────────────────── prepared-transaction plumbing ─────────────────────────── */
/**
 * The mock's "unsigned transaction" is a deterministic base64 blob carrying a marker the server
 * recognises again at burn time. A signed copy is allowed to differ — we match on the marker
 * fields (shipment, batch, leg kind, leg index), so a harness may add e.g. a `sig` field.
 */
function encodeLeg({ shipmentId, batchId, kind, index, nftAddress }) {
  const payload = { m: 'cc-mock-tx', s: shipmentId, b: batchId, k: kind, i: index, n: nftAddress };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}
function decodeLeg(b64) {
  try {
    const parsed = JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'));
    if (!parsed || parsed.m !== 'cc-mock-tx') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Issues a fresh batch for `addresses`; supersedes whatever batch the shipment held before. */
function issueBatch(shipment, addresses) {
  const batchId = 'batch_' + uuid();
  const issuedAt = Date.now();
  const burnLegs = addresses.map((nftAddress, index) => ({
    kind: 'burn', index, nftAddress,
    b64: encodeLeg({ shipmentId: shipment.id, batchId, kind: 'burn', index, nftAddress }),
  }));
  const delistLegs = addresses
    .filter((a) => lookupCard(a)?.escrowed)
    .map((nftAddress, index) => ({
      kind: 'delist', index, nftAddress,
      b64: encodeLeg({ shipmentId: shipment.id, batchId, kind: 'delist', index, nftAddress }),
    }));
  shipment.batch = { id: batchId, issuedAt, expiresAt: issuedAt + TX_TTL_MS, burnLegs, delistLegs };
  return shipment.batch;
}
const batchLive = (shipment) => !!shipment.batch && Date.now() < shipment.batch.expiresAt;

/* ─────────────────────────────── serialisers ─────────────────────────────── */

/** doc: "All cost fields and numberOfCards are strings." */
function serializeShipment(s) {
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

function serializeAddress(a) {
  return {
    id: a.id, fullName: a.fullName, streetAddress: a.streetAddress, apartment: a.apartment,
    city: a.city, state: a.state, country: a.country, zip: a.zip, phoneNumber: a.phoneNumber,
    isDefault: a.isDefault, createdAt: a.createdAt, updatedAt: a.updatedAt,
  };
}

/* ─────────────────────────────── SIWS message ─────────────────────────────── */
/**
 * doc: "The parser accepts exactly one form — LF line endings, exactly 11 lines, fixed field
 * order." Canonical Sign-In-With-Solana text:
 *   1  <domain> wants you to sign in with your Solana account:
 *   2  <wallet>
 *   3  (blank)
 *   4  <statement>
 *   5  (blank)
 *   6  URI: <uri>
 *   7  Version: 1
 *   8  Chain ID: <chain>
 *   9  Nonce: <nonce>
 *   10 Issued At: <iso>
 *   11 Expiration Time: <iso>
 */
function buildSiwsMessage({ domain, wallet, uri, nonce, issuedAt, expirationTime }) {
  return [
    `${domain} wants you to sign in with your Solana account:`,
    wallet,
    '',
    SIWS_STATEMENT,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${SIWS_CHAIN_ID}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ].join('\n');
}

/** Strict counterpart of the builder. Returns null when the text is not the one accepted form. */
function parseSiwsMessage(message) {
  if (typeof message !== 'string' || message.includes('\r')) return null;
  const lines = message.split('\n');
  if (lines.length !== 11) return null;
  const head = ' wants you to sign in with your Solana account:';
  if (!lines[0].endsWith(head)) return null;
  if (lines[2] !== '' || lines[4] !== '') return null;
  const field = (line, label) => (line.startsWith(label + ': ') ? line.slice(label.length + 2) : null);
  const uri = field(lines[5], 'URI');
  const version = field(lines[6], 'Version');
  const chainId = field(lines[7], 'Chain ID');
  const nonce = field(lines[8], 'Nonce');
  const issuedAt = field(lines[9], 'Issued At');
  const expirationTime = field(lines[10], 'Expiration Time');
  if ([uri, version, chainId, nonce, issuedAt, expirationTime].some((v) => v === null)) return null;
  return {
    domain: lines[0].slice(0, -head.length),
    wallet: lines[1],
    statement: lines[3],
    uri, version, chainId, nonce, issuedAt, expirationTime,
  };
}

/* ═══════════════════════════════ handlers ═══════════════════════════════ */
/* ── auth (public) ───────────────────────────────────────────────────────── */

function postNonce(ctx) {
  const body = ctx.body;
  checkExtraFields(body, ['wallet', 'partnerAppId', 'domain', 'uri']);
  const { wallet, partnerAppId, domain, uri } = body;
  if (!isStr(wallet) || !isStr(partnerAppId) || !isStr(domain) || !isStr(uri)) throw invalidRequest();

  // doc: "Any unrecognised value returns 400 Unknown partner."
  if (partnerAppId !== PARTNER_APP_ID) throw bad('Unknown partner');

  // doc: "Bare hostname — no scheme, no port, no path."
  if (/[:/]/.test(domain)) throw validation(['domain must be a bare hostname — no scheme, no port, no path']);
  // doc: "Must be on your allowlist." (message wording is DOC-SILENT)
  if (!ALLOWED_DOMAINS.includes(domain.toLowerCase())) throw bad('Domain not allowed for this partner');

  // doc: "uri — Absolute URL, echoed into the signed message."
  try {
    // eslint-disable-next-line no-new
    new URL(uri);
  } catch {
    throw validation(['uri must be an absolute URL']);
  }

  let walletBytes;
  try {
    walletBytes = base58Decode(wallet);
  } catch {
    throw validation(['wallet must be a base58 Solana address']);
  }
  if (walletBytes.length !== 32) throw validation(['wallet must be a base58 Solana address']);

  // doc: "Sign-in requests are rate limited per wallet ... On a 429, read retryAfter."
  if (NONCE_RATE_LIMIT > 0) {
    const now = Date.now();
    const hits = (state.nonceHits.get(wallet) || []).filter((t) => now - t < 60_000);
    if (hits.length >= NONCE_RATE_LIMIT) {
      state.nonceHits.set(wallet, hits);
      throw tooManyRequests('Too many requests — nonce requests for this wallet. Retry in 60s.', 60);
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
  state.nonces.set(nonce, { wallet, domain, uri, message, expiresAt, used: false });
  return { status: 200, body: { nonce, expiresAt, message } };
}

function postVerify(ctx) {
  checkExtraFields(ctx.body, ['message', 'signature']);
  const { message, signature } = ctx.body;
  if (!isStr(message) || !isStr(signature)) throw invalidRequest();

  const parsed = parseSiwsMessage(message);
  if (!parsed) throw invalidRequest(); // DOC-SILENT status: malformed text is simply bad input

  const record = state.nonces.get(parsed.nonce);
  if (!record || record.used) throw unauthorized('Nonce not found or already used'); // DOC-SILENT wording
  if (Date.now() > record.expiresAt) {
    state.nonces.delete(parsed.nonce);
    throw unauthorized('Nonce expired');                                            // DOC-SILENT wording
  }
  // The text must be byte-for-byte what we issued: the nonce alone is not enough.
  if (message !== record.message) throw invalidRequest();

  let sigBytes;
  let pubkeyBytes;
  try {
    sigBytes = base58Decode(signature);
    pubkeyBytes = base58Decode(parsed.wallet);
  } catch {
    throw validation(['signature must be base58']);
  }
  if (sigBytes.length !== 64) throw validation(['signature must be 64 bytes']);
  if (!verifyEd25519(Buffer.from(message, 'utf8'), sigBytes, pubkeyBytes)) {
    throw unauthorized('Invalid signature'); // DOC-SILENT wording; status follows "401 Token invalid".
  }

  record.used = true;                        // doc: "The nonce is single-use"
  state.nonces.delete(parsed.nonce);
  const user = userForWallet(parsed.wallet);
  return { status: 200, body: issueSession(user.id) };
}

function issueSession(userId) {
  const accessToken = 'cca_' + uuid();
  const refreshToken = 'ccr_' + uuid();
  const expiresAt = Date.now() + ACCESS_TTL_MS;
  state.accessTokens.set(accessToken, { userId, expiresAt });
  state.refreshTokens.set(refreshToken, { userId, expiresAt: Date.now() + REFRESH_TTL_MS, used: false });
  return { accessToken, refreshToken, expiresAt };
}

function postRefresh(ctx) {
  checkExtraFields(ctx.body, ['refreshToken']);
  const { refreshToken } = ctx.body;
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

function postLogout(ctx) {
  checkExtraFields(ctx.body, ['refreshToken']);
  const { refreshToken } = ctx.body;
  if (!isStr(refreshToken)) throw invalidRequest();
  state.refreshTokens.delete(refreshToken);
  // doc: "Send the access token in the Authorization header too, or it stays valid for the rest
  //       of its 15 minutes." -> honour it when present, ignore it when absent.
  const bearer = /^Bearer\s+(.+)$/i.exec(ctx.headers.authorization || '');
  if (bearer && bearer[1].startsWith('cca_')) state.accessTokens.delete(bearer[1].trim());
  return { status: 200, body: { success: true } }; // DOC-SILENT body
}

/* ── shipping addresses ──────────────────────────────────────────────────── */

const ADDRESS_REQUIRED = ['streetAddress', 'city', 'state', 'country'];
const ADDRESS_OPTIONAL = ['fullName', 'apartment', 'zip', 'phoneNumber', 'isDefault'];

function postAddressCreate(ctx) {
  const body = ctx.body;
  // doc: "Any field not on this list returns a 400."  <- catches our stray `email`
  checkExtraFields(body, [...ADDRESS_REQUIRED, ...ADDRESS_OPTIONAL]);
  // doc: "400 Invalid request. when a required field is missing — the message does not name the field."
  if (!ADDRESS_REQUIRED.every((f) => isStr(body[f]))) throw invalidRequest();
  for (const f of ['fullName', 'apartment', 'zip', 'phoneNumber']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') throw invalidRequest();
  }
  if (body.isDefault !== undefined && !isBool(body.isDefault)) throw invalidRequest();

  const country = resolveCountry(body.country);
  if (!country) throw bad(`Sorry, we do not ship to ${body.country} at this time`);

  const mine = [...state.addresses.values()].filter((a) => a.userId === ctx.user.id);
  const isDefault = mine.length === 0 ? true : body.isDefault === true; // doc: "Your first address is always the default."
  if (isDefault) mine.forEach((a) => { a.isDefault = false; });

  const row = {
    id: 'ccaddr_' + uuid(),
    userId: ctx.user.id,
    fullName: body.fullName ?? null,
    streetAddress: body.streetAddress,
    apartment: body.apartment ?? null,
    city: body.city,
    state: normaliseState(body.state),   // doc: "CA" becomes "California"
    country: country.name,               // DOC-SILENT: stored as the full country name
    zip: body.zip ?? null,
    phoneNumber: body.phoneNumber ?? null,
    isDefault,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.addresses.set(row.id, row);
  return { status: 201, body: serializeAddress(row) };
}

function getAddresses(ctx) {
  const mine = [...state.addresses.values()]
    .filter((a) => a.userId === ctx.user.id)
    .map(serializeAddress);
  return { status: 200, body: mine };
}

function ownedAddress(ctx, id) {
  const row = state.addresses.get(id);
  if (!row || row.userId !== ctx.user.id) throw notFound('Shipping address not found for this user');
  return row;
}

function getAddressById(ctx) {
  return { status: 200, body: serializeAddress(ownedAddress(ctx, ctx.params.id)) };
}

function patchAddressById(ctx) {
  const row = ownedAddress(ctx, ctx.params.id);
  checkExtraFields(ctx.body, [...ADDRESS_REQUIRED, ...ADDRESS_OPTIONAL]);
  for (const [k, v] of Object.entries(ctx.body)) {
    if (k === 'isDefault') {
      if (!isBool(v)) throw invalidRequest();
      if (v) [...state.addresses.values()].forEach((a) => { if (a.userId === ctx.user.id) a.isDefault = false; });
      row.isDefault = v;
    } else if (k === 'country') {
      const c = resolveCountry(v);
      if (!c) throw bad(`Sorry, we do not ship to ${v} at this time`);
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

function deleteAddressById(ctx) {
  const row = ownedAddress(ctx, ctx.params.id);
  state.addresses.delete(row.id);
  return { status: 200, body: { success: true } }; // DOC-SILENT body
}

/* ── redeem: estimate / prepare / complete ───────────────────────────────── */

function resolveCards(ctx, nftAddresses) {
  const missing = nftAddresses.filter((a) => !lookupCard(a));
  // doc: "404 Cards not found: <addresses>"
  if (missing.length) throw notFound(`Cards not found: ${missing.join(', ')}`);
  const cards = nftAddresses.map((a) => ({ nftAddress: a, ...lookupCard(a) }));
  // doc: "400 with a per-card array as a JSON string in message"
  const rejected = cards.filter((c) => c.notRedeemable);
  if (rejected.length) {
    throw validation(rejected.map((c) => ({
      nftAddress: c.nftAddress,
      cardId: c.cardId,
      reason: c.rejectReason || 'Card cannot be redeemed',
    })));
  }
  return cards;
}

function resolveAddressForRedeem(ctx, shippingAddressId) {
  const row = state.addresses.get(shippingAddressId);
  if (!row || row.userId !== ctx.user.id) {
    throw new ApiError(ADDRESS_MISSING_STATUS, {
      statusCode: ADDRESS_MISSING_STATUS,
      message: 'Shipping address not found for this user',
      error: ADDRESS_MISSING_STATUS === 404 ? 'Not Found' : 'Bad Request',
    });
  }
  return row;
}

const ESTIMATE_FIELDS = ['nftAddresses', 'shippingAddressId', 'deliveryCompany', 'payCustomsDuties'];

function postEstimate(ctx) {
  const body = ctx.body;
  // doc: "This endpoint accepts only these four fields. Reposting a /redeem/prepare body returns a 400."
  checkExtraFields(body, ESTIMATE_FIELDS);
  const errs = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  if (!isStr(body.shippingAddressId)) errs.push('shippingAddressId must be a string');
  if (body.deliveryCompany !== undefined && !isStr(body.deliveryCompany)) errs.push('deliveryCompany must be a string');
  if (body.payCustomsDuties !== undefined && !isBool(body.payCustomsDuties)) errs.push('payCustomsDuties must be a boolean');
  if (errs.length) throw validation(errs);

  const address = resolveAddressForRedeem(ctx, body.shippingAddressId);
  const cards = resolveCards(ctx, body.nftAddresses);
  const quote = quoteFor({
    cards, address,
    payCustomsDuties: body.payCustomsDuties === true,
    paymentMethod: 'crypto',
    deliveryCompany: body.deliveryCompany || 'ups',
  });
  return { status: 200, body: quote };
}

const PREPARE_FIELDS = [
  'nftAddresses', 'shippingAddressId', 'coin', 'paymentMethod', 'deliveryCompany',
  'comment', 'email', 'payCustomsDuties',
];

function postPrepare(ctx) {
  const body = ctx.body;
  // doc: "There is no insurance field ... sending the field returns 400 ["property insurance should not exist"]"
  checkExtraFields(body, PREPARE_FIELDS);
  const errs = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  if (!isStr(body.shippingAddressId)) errs.push('shippingAddressId must be a string');
  if (body.coin !== undefined && !['USDC', 'USDT'].includes(body.coin)) errs.push('coin must be one of USDC, USDT');
  if (body.paymentMethod !== undefined && !['crypto', 'card'].includes(body.paymentMethod)) {
    errs.push('paymentMethod must be one of crypto, card');
  }
  for (const f of ['deliveryCompany', 'comment', 'email']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') errs.push(`${f} must be a string`);
  }
  if (body.payCustomsDuties !== undefined && !isBool(body.payCustomsDuties)) errs.push('payCustomsDuties must be a boolean');
  if (errs.length) throw validation(errs);

  const coin = body.coin || 'USDC';
  const paymentMethod = body.paymentMethod || 'crypto';
  const deliveryCompany = body.deliveryCompany || 'ups';
  const payCustomsDuties = body.payCustomsDuties === true;

  const address = resolveAddressForRedeem(ctx, body.shippingAddressId);
  const cards = resolveCards(ctx, body.nftAddresses);

  // doc: "400 Card payment requires a contact email. Send `email` with this request."
  if (paymentMethod === 'card' && !isStr(body.email) && !isStr(ctx.user.email)) {
    throw bad('Card payment requires a contact email. Send `email` with this request.');
  }
  // doc: "400 Crypto payment requires a Solana wallet. Use card payment."
  if (paymentMethod === 'crypto' && !isStr(ctx.user.wallet)) {
    throw bad('Crypto payment requires a Solana wallet. Use card payment.');
  }
  if (isStr(body.email)) ctx.user.email = body.email;

  const quote = quoteFor({ cards, address, payCustomsDuties, paymentMethod, deliveryCompany });

  // doc: "Calling prepare again with identical input returns the same shipment with fresh
  //       transactions ... Changing the address or toggling payCustomsDuties deliberately
  //       creates a new shipment."
  const key = crypto.createHash('sha256').update(JSON.stringify({
    u: ctx.user.id,
    n: [...body.nftAddresses].sort(),
    a: body.shippingAddressId, coin, paymentMethod, deliveryCompany, payCustomsDuties,
    c: body.comment ?? null,
  })).digest('hex');

  let shipment = state.shipments.get(state.prepareKeys.get(key) || '');
  if (!shipment) {
    state.counters.shipment += 1;
    const seq = String(state.counters.shipment).padStart(5, '0');
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    shipment = {
      id: 'ccos_' + uuid(),
      customId: `${stamp}42S${seq}`,
      userId: ctx.user.id,
      status: 'Pending',
      nftAddresses: [...body.nftAddresses],
      cardIds: cards.map((c) => c.cardId),
      shippingAddressId: address.id,
      deliveryCompany, coin, paymentMethod, payCustomsDuties,
      comment: body.comment ?? null,
      quote,
      trackingIds: [],
      trackingUrls: [],
      recordedLegs: new Map(),   // "kind:index" -> { transactionId, transactionUrl }
      burned: new Set(),         // nft addresses already burned
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

  const remaining = shipment.nftAddresses.filter((a) => !shipment.burned.has(a));
  const batch = issueBatch(shipment, remaining.length ? remaining : shipment.nftAddresses);

  return { status: 200, body: prepareResponse(shipment, batch) };
}

function prepareResponse(shipment, batch) {
  // doc: "totalCost — 0 for card payment, and 0 for a shipment that is already paid."
  const totalCost = shipment.paymentMethod === 'card' || shipment.paid ? 0 : shipment.quote.total;
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
function postComplete(ctx) {
  const shipment = state.shipments.get(ctx.params.id);
  if (!shipment || shipment.userId !== ctx.user.id) throw notFound('The shipment is not yours.');
  const remaining = shipment.nftAddresses.filter((a) => !shipment.burned.has(a));
  if (!remaining.length) throw conflict('Nothing left to complete for this shipment'); // DOC-SILENT wording
  const batch = issueBatch(shipment, remaining);
  shipment.updatedAt = nowIso();
  return { status: 200, body: prepareResponse(shipment, batch) };
}

/* ── burn ────────────────────────────────────────────────────────────────── */

function postBurn(ctx) {
  const shipment = state.shipments.get(ctx.params.id);
  // doc: "404 The shipment is not yours."
  if (!shipment || shipment.userId !== ctx.user.id) throw notFound('The shipment is not yours.');

  /* doc: an API key "may report EVM transaction hashes only — { evmTransactions: [{chain, txHash}] }.
     Sending Solana transactions on a key is refused." */
  if (ctx.credential === 'key') {
    if (ctx.body.transactions !== undefined || ctx.body.delistTransactions !== undefined) {
      // DOC-SILENT status: 403 ("out of scope for this credential") is the closest documented bucket.
      throw forbidden('Solana transactions cannot be submitted with an API key. Solana redemptions need a wallet sign-in session.');
    }
    checkExtraFields(ctx.body, ['evmTransactions']);
    const legs = Array.isArray(ctx.body.evmTransactions) ? ctx.body.evmTransactions : null;
    if (!legs || !legs.length) throw forbidden('Transaction was not issued by this server');
    const results = legs.map((leg) => {
      const legKey = `evm:${leg?.chain}:${leg?.txHash}`;
      if (shipment.recordedLegs.has(legKey)) {
        return { error: 'Duplicate transaction result', ...shipment.recordedLegs.get(legKey) };
      }
      const rec = { transactionId: String(leg?.txHash), transactionUrl: `https://etherscan.io/tx/${leg?.txHash}` };
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

  const submittedBurn = (txs || []).map(decodeLeg);
  const submittedDelist = (dtxs || []).map(decodeLeg);
  const recognised = [...submittedBurn, ...submittedDelist].filter(Boolean);

  // doc: "403 Transaction was not issued by this server — Nothing recognised — you sent nothing,
  //       only de-list legs, or an expired batch."
  if (!recognised.length || !submittedBurn.filter(Boolean).length || !batchLive(shipment)) {
    throw forbidden('Transaction was not issued by this server');
  }
  const batch = shipment.batch;
  // doc: "403 These transactions were not issued for this shipment — Wrong outboundShipmentId."
  if (recognised.some((l) => l.s !== shipment.id)) {
    throw forbidden('These transactions were not issued for this shipment');
  }
  // doc: "403 The transactions submitted are not the complete set this server issued —
  //       A leg is missing, duplicated, or from another prepare call."
  const sameSet = (submitted, legs, kind) => {
    const got = submitted.filter(Boolean).filter((l) => l.k === kind);
    if (got.length !== legs.length) return false;
    if (got.some((l) => l.b !== batch.id)) return false;
    const want = new Set(legs.map((l) => l.index));
    const seen = new Set();
    for (const l of got) {
      if (!want.has(l.i) || seen.has(l.i)) return false;
      seen.add(l.i);
    }
    return true;
  };
  if (submittedBurn.some((l) => l === null) || submittedDelist.some((l) => l === null)) {
    throw forbidden('The transactions submitted are not the complete set this server issued');
  }
  if (!sameSet(submittedBurn, batch.burnLegs, 'burn') || !sameSet(submittedDelist, batch.delistLegs, 'delist')) {
    throw forbidden('The transactions submitted are not the complete set this server issued');
  }

  // doc: "409 with delistErrors — A de-list leg failed. Nothing was burned."
  const delistErrors = batch.delistLegs
    .filter((l) => lookupCard(l.nftAddress)?.delistFails)
    .map((l) => ({ nftAddress: l.nftAddress, error: 'De-list transaction failed to land' }));
  if (delistErrors.length) {
    throw conflict('De-list failed for one or more cards. Nothing was burned.', { delistErrors }); // DOC-SILENT body shape
  }

  const results = [];
  for (const leg of [...batch.delistLegs, ...batch.burnLegs]) {
    const legKey = `${leg.kind}:${leg.index}:${leg.nftAddress}`;
    // doc: "legs already recorded come back as { "error": "Duplicate transaction result", ... }"
    if (shipment.recordedLegs.has(legKey)) {
      results.push({ error: 'Duplicate transaction result', ...shipment.recordedLegs.get(legKey) });
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

/** doc: "failures first". Duplicates carry a non-null error too, so they sort with them. */
function sortFailuresFirst(results) {
  return [...results].sort((a, b) => (a.error === null ? 1 : 0) - (b.error === null ? 1 : 0));
}

/* ── outbound shipments ──────────────────────────────────────────────────── */

const ACTIVE_STATUSES = ['Pending', 'Shipped', 'Delivered'];
const PAST_STATUSES = ['Delivered', 'Cancelled'];

function getShipments(ctx) {
  let rows = [...state.shipments.values()].filter((s) => s.userId === ctx.user.id);
  const status = ctx.query.get('status');
  if (status === 'Active') rows = rows.filter((s) => ACTIVE_STATUSES.includes(s.status));
  else if (status === 'Past') rows = rows.filter((s) => PAST_STATUSES.includes(s.status));
  else if (status) throw validation(['status must be one of Active, Past']);
  const search = ctx.query.get('search');
  if (isStr(search)) {
    const q = search.toLowerCase();
    rows = rows.filter((s) =>
      s.id.toLowerCase().includes(q) ||
      s.customId.toLowerCase().includes(q) ||
      s.cardIds.some((c) => c.toLowerCase().includes(q)) ||
      s.nftAddresses.some((a) => a.toLowerCase().includes(q)));
  }
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)); // doc: "newest first"
  return { status: 200, body: rows.map(serializeShipment) };   // DOC-SILENT: bare array envelope
}

function getShipmentById(ctx) {
  const s = state.shipments.get(ctx.params.id);
  // doc: "An unknown id returns 200 with an empty body ... does not return 404."
  if (!s || s.userId !== ctx.user.id) return { status: 200, body: null };
  return { status: 200, body: serializeShipment(s) };
}

/* ── partner: customers + inbound shipments ──────────────────────────────── */

function postPartnerCustomers(ctx) {
  checkExtraFields(ctx.body, ['externalId']);
  const { externalId } = ctx.body;
  if (!isStr(externalId)) throw invalidRequest();
  const existing = state.byExternalId.get(externalId);
  if (existing) return { status: 200, body: { userId: existing, created: false } }; // doc: "idempotent"
  const id = 'ccu_' + uuid();
  state.users.set(id, { id, wallet: null, externalId, email: null });
  state.byExternalId.set(externalId, id);
  return { status: 200, body: { userId: id, created: true } };
}

const INBOUND_FIELDS = ['nftAddresses', 'externalRef', 'trackingId', 'declaredValue'];

function postInbound(ctx) {
  checkExtraFields(ctx.body, INBOUND_FIELDS);
  const body = ctx.body;
  const errs = [];
  if (!isStrArray(body.nftAddresses)) errs.push('nftAddresses must contain at least 1 element');
  else if (new Set(body.nftAddresses).size > 2000) errs.push('nftAddresses must contain no more than 2000 elements');
  for (const f of ['externalRef', 'trackingId']) {
    if (body[f] !== undefined && typeof body[f] !== 'string') errs.push(`${f} must be a string`);
  }
  if (body.declaredValue !== undefined && typeof body.declaredValue !== 'number') errs.push('declaredValue must be a number');
  if (errs.length) throw validation(errs);

  const addresses = [...new Set(body.nftAddresses)]; // doc: "Deduplicated for you."
  state.counters.inbound += 1;
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const id = `${stamp}42S${String(state.counters.inbound).padStart(5, '0')}`;
  const declaredLines = addresses.map((addr) => {
    const card = CATALOGUE.get(addr);
    if (!card) {
      // doc: "An address we do not hold comes back as a rejected line, not an error."
      return { kind: 'CardRaw', state: 'Rejected', externalRef: addr, note: 'not found in the CollectorCrypt catalogue' };
    }
    const line = { kind: card.kind, state: 'Declared', externalRef: addr };
    if (card.kind === 'Cert') {
      line.vaultItem = { status: 'Vaulted', gradingId: card.gradingId, gemrateCardName: card.name };
    }
    return line;
  });
  const record = {
    id,
    ownerKeyUserId: ctx.user?.id ?? 'partner',
    status: 'Processing',
    externalRef: body.externalRef ?? null,
    trackingId: body.trackingId ?? null,
    declaredValue: body.declaredValue ?? null,
    declaredLines,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.inbound.set(id, record);
  return { status: 200, body: serializeInbound(record) };
}

function serializeInbound(r) {
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

function getInbound(ctx) {
  const page = Math.max(1, Number(ctx.query.get('page') || 1));
  const step = Math.min(200, Math.max(1, Number(ctx.query.get('step') || 50))); // doc: "step (max 200)"
  const status = ctx.query.get('status');
  let rows = [...state.inbound.values()];
  if (isStr(status)) rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const slice = rows.slice((page - 1) * step, (page - 1) * step + step);
  return { status: 200, body: slice.map(serializeInbound) }; // DOC-SILENT: bare array envelope
}

function getInboundById(ctx) {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Inbound shipment not found'); // DOC-SILENT wording
  return { status: 200, body: serializeInbound(r) };
}

function patchInboundById(ctx) {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Inbound shipment not found');
  checkExtraFields(ctx.body, ['externalRef', 'trackingId', 'declaredValue']);
  if (ctx.body.trackingId !== undefined) r.trackingId = ctx.body.trackingId;
  if (ctx.body.externalRef !== undefined) r.externalRef = ctx.body.externalRef;
  if (ctx.body.declaredValue !== undefined) r.declaredValue = ctx.body.declaredValue;
  r.updatedAt = nowIso();
  return { status: 200, body: serializeInbound(r) };
}

/* ── mock-only helpers (NOT part of the CollectorCrypt API) ──────────────── */

function mockState() {
  return {
    status: 200,
    body: {
      note: 'MOCK ONLY — these /__mock routes do not exist on the real CollectorCrypt API.',
      partnerAppId: PARTNER_APP_ID,
      allowedDomains: ALLOWED_DOMAINS,
      apiKey: API_KEY,
      apiKeyScopes: [...API_KEY_SCOPES],
      seededNftAddresses: [...CATALOGUE.keys()],
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

function mockShipmentPatch(ctx) {
  const s = state.shipments.get(ctx.params.id);
  if (!s) throw notFound('Unknown shipment');
  const { status, trackingIds, trackingUrls, confirmCardPayment } = ctx.body || {};
  if (status !== undefined) {
    if (!['Pending', 'Shipped', 'Delivered', 'Cancelled'].includes(status)) {
      throw validation(['status must be one of Pending, Shipped, Delivered, Cancelled']);
    }
    s.status = status;
  }
  if (Array.isArray(trackingIds)) s.trackingIds = trackingIds;
  if (Array.isArray(trackingUrls)) s.trackingUrls = trackingUrls;
  if (confirmCardPayment === true) s.cardPaymentConfirmed = true;
  s.updatedAt = nowIso();
  return { status: 200, body: serializeShipment(s) };
}

function mockInboundReceive(ctx) {
  const r = state.inbound.get(ctx.params.id);
  if (!r) throw notFound('Unknown inbound shipment');
  r.declaredLines.forEach((l) => { if (l.state === 'Declared') l.state = 'Received'; });
  r.status = 'Received';
  r.updatedAt = nowIso();
  return { status: 200, body: serializeInbound(r) };
}

function mockReset() {
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
 *   public        — no credential
 *   session       — true when an access token (cca_) may reach this route.
 *                   doc: "An access token from this flow reaches the shipping routes below and
 *                   nothing else. Anything else returns a bare 403 with no message."
 *   keyScope      — the scope an API key needs (doc's scope table); null = key cannot reach it
 *   customer      — key routes that require X-CC-Customer (doc: all but /partner/customers and
 *                   /partner/inbound-shipments)
 */
const ROUTES = [
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
  // DOC-SILENT: the doc names no scope for this route, so any valid key is accepted here.
  { m: 'POST', p: /^\/blockchain\/([^/]+)\/burn$/, keys: ['id'], session: true, keyScope: '*', customer: true, h: postBurn },

  { m: 'GET', p: /^\/outbound-shipment$/, session: true, keyScope: 'outbound-shipment', customer: true, h: getShipments },
  { m: 'GET', p: /^\/outbound-shipment\/([^/]+)$/, keys: ['id'], session: true, keyScope: 'outbound-shipment', customer: true, h: getShipmentById },

  { m: 'POST', p: /^\/partner\/customers$/, session: false, keyScope: 'customers:provision', customer: false, h: postPartnerCustomers },
  { m: 'POST', p: /^\/partner\/inbound-shipments$/, session: false, keyScope: 'inbound-shipment', customer: false, h: postInbound },
  { m: 'GET', p: /^\/partner\/inbound-shipments$/, session: false, keyScope: 'inbound-shipment', customer: false, h: getInbound },
  { m: 'GET', p: /^\/partner\/inbound-shipments\/([^/]+)$/, keys: ['id'], session: false, keyScope: 'inbound-shipment', customer: false, h: getInboundById },
  { m: 'PATCH', p: /^\/partner\/inbound-shipments\/([^/]+)$/, keys: ['id'], session: false, keyScope: 'inbound-shipment', customer: false, h: patchInboundById },

  // mock-only test hooks — clearly namespaced, never part of CC's surface
  { m: 'GET', p: /^\/__mock\/state$/, access: 'public', h: mockState },
  { m: 'POST', p: /^\/__mock\/reset$/, access: 'public', h: mockReset },
  { m: 'PATCH', p: /^\/__mock\/shipment\/([^/]+)$/, keys: ['id'], access: 'public', h: mockShipmentPatch },
  { m: 'POST', p: /^\/__mock\/inbound\/([^/]+)\/receive$/, keys: ['id'], access: 'public', h: mockInboundReceive },
];

function authenticate(req, route) {
  const auth = req.headers.authorization || '';
  /* doc: "This API does not read an x-api-key header. Use Authorization: Bearer."
     So x-api-key is never a credential; sent on its own it leaves the call unauthenticated. */
  const strayKeyHeader = isStr(req.headers['x-api-key']);
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (!bearer) {
    if (strayKeyHeader) {
      if (VERBOSE) console.warn('  ! x-api-key header ignored — this API reads Authorization: Bearer only');
      throw unauthorized('Invalid API key');
    }
    throw unauthorized('Unauthorized'); // DOC-SILENT wording; doc only fixes the status (401)
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
    if (token !== API_KEY) throw unauthorized('Invalid API key');
    if (!route.keyScope) throw forbidden("This API key does not carry the required scope");
    if (route.keyScope !== '*' && !API_KEY_SCOPES.has(route.keyScope)) {
      throw forbidden(`This API key does not carry the '${route.keyScope}' scope`);
    }
    if (route.customer) {
      const externalId = req.headers['x-cc-customer'];
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) { reject(new ApiError(413, { statusCode: 413, message: 'Payload too large' })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendResponse(res, status, body, headers) {
  const head = { ...(headers || {}) };
  if (body === null || body === undefined) {
    // doc: an unknown shipment id "returns 200 with an empty body" — a truly empty body.
    head['Content-Length'] = '0';
    res.writeHead(status, head);
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  head['Content-Type'] = 'application/json; charset=utf-8';
  head['Content-Length'] = String(payload.length);
  res.writeHead(status, head);
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    sendResponse(res, 400, { statusCode: 400, message: 'Invalid request.' });
    return;
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    /* doc: "Send a non-empty User-Agent. A request without one is refused at the edge and never
       reaches the API." DOC-SILENT status — 400 stands in for the edge refusal. */
    if (!isStr(req.headers['user-agent']) && !pathname.startsWith('/__mock')) {
      throw new ApiError(400, { statusCode: 400, message: 'A non-empty User-Agent header is required.' });
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

    const raw = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : '';
    let body = {};
    if (raw.trim().length) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw invalidRequest();
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest();
    }

    const match = route.p.exec(pathname);
    const params = {};
    (route.keys || []).forEach((k, i) => { params[k] = decodeURIComponent(match[i + 1]); });

    let credential = 'public';
    let user = null;
    if (route.access !== 'public') {
      const auth = authenticate(req, route);
      credential = auth.credential;
      user = auth.user;
    }

    const ctx = { body, params, query: url.searchParams, headers: req.headers, user, credential };
    const out = await route.h(ctx);
    if (VERBOSE) {
      console.log(`  ${req.method} ${pathname} -> ${out.status} (${Date.now() - started}ms)`);
    }
    sendResponse(res, out.status, out.body, out.headers);
  } catch (err) {
    if (err instanceof ApiError) {
      if (VERBOSE) {
        const detail = err.body ? JSON.stringify(err.body.message ?? err.body) : '<empty body>';
        console.log(`  ${req.method} ${pathname} -> ${err.status} ${detail}`);
      }
      sendResponse(res, err.status, err.body, err.headers);
      return;
    }
    console.error('  ! unexpected mock failure:', err);
    sendResponse(res, 500, { statusCode: 500, message: 'Internal server error' });
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  mock CollectorCrypt Vault Shipping API');
  console.log('  ──────────────────────────────────────');
  console.log(`  listening          http://localhost:${PORT}`);
  console.log(`  partnerAppId       ${PARTNER_APP_ID}`);
  console.log(`  allowed domains    ${ALLOWED_DOMAINS.join(', ')}`);
  console.log(`  api key            ${API_KEY}`);
  console.log(`  api key scopes     ${[...API_KEY_SCOPES].join(', ')}`);
  console.log(`  seeded NFTs        ${[...CATALOGUE.keys()].length} (GET /__mock/state to list)`);
  console.log(`  accept any NFT     ${ACCEPT_ANY_NFT}`);
  console.log('');
});
