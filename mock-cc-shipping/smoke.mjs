/**
 * Smoke test for the mock CollectorCrypt Vault Shipping API.
 *
 *   node mock-cc-shipping/server.mjs &      # terminal 1
 *   node mock-cc-shipping/smoke.mjs         # terminal 2
 *
 * It walks the whole documented happy path (SIWS sign-in with a REAL ed25519 signature ->
 * address -> estimate -> prepare -> burn -> track) and asserts every documented error case.
 * Zero dependencies, like the server.
 */
import crypto from 'node:crypto';

const BASE = process.env.MOCK_BASE_URL || 'http://localhost:4010';
const PARTNER_APP_ID = process.env.MOCK_PARTNER_APP_ID || 'hoshi-mock-partner';
const DOMAIN = process.env.MOCK_DOMAIN || 'localhost';
const URI = process.env.MOCK_URI || 'http://localhost:3000';
const API_KEY = process.env.MOCK_API_KEY || 'ccsk_mock_key_do_not_use_in_prod';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
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

const NFT_A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const NFT_B = '9aBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dE3fGhJkM';
const NFT_ESCROW_FAIL = 'ESCRWFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE';
const NFT_BURN_FAIL = 'BURNFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dEf';
const NFT_NOT_REDEEMABLE = 'NOTREDEEMbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE';

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + label); }
  else { fail += 1; console.log('  FAIL ' + label + (detail !== undefined ? ' :: ' + JSON.stringify(detail) : '')); }
}

async function call(method, path, { body, token, key, customer, headers } = {}) {
  const h = { 'User-Agent': 'hoshi-mock-smoke/1.0', ...(headers || {}) };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h.Authorization = 'Bearer ' + token;
  if (key) h.Authorization = 'Bearer ' + key;
  if (customer) h['X-CC-Customer'] = customer;
  const res = await fetch(BASE + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  if (text.length) { try { json = JSON.parse(text); } catch { json = text; } }
  return { status: res.status, body: json, raw: text };
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const rawPub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
const WALLET = base58Encode(rawPub);
const sign = (msg) => base58Encode(crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey));

async function main() {
  // Start from a clean slate so the run is repeatable against a long-lived server.
  const reset = await call('POST', '/__mock/reset');
  check('mock state reset', reset.status === 200, reset);

  console.log('\n== edge / credentials ==');
  const noUa = await fetch(BASE + '/shipping-address', { headers: { 'User-Agent': '' } });
  check('missing User-Agent is refused', noUa.status === 400, noUa.status);

  const strayKey = await call('GET', '/shipping-address', { headers: { 'x-api-key': API_KEY } });
  check('x-api-key header is not read -> 401 Invalid API key',
    strayKey.status === 401 && strayKey.body.message === 'Invalid API key', strayKey);

  console.log('\n== auth/wallet/nonce ==');
  const badPartner = await call('POST', '/auth/wallet/nonce', {
    body: { wallet: WALLET, partnerAppId: 'nope', domain: DOMAIN, uri: URI },
  });
  check('unknown partnerAppId -> 400 Unknown partner',
    badPartner.status === 400 && badPartner.body.message === 'Unknown partner', badPartner);

  const badDomain = await call('POST', '/auth/wallet/nonce', {
    body: { wallet: WALLET, partnerAppId: PARTNER_APP_ID, domain: 'evil.example', uri: URI },
  });
  check('domain off the allowlist -> 400', badDomain.status === 400, badDomain);

  const schemeDomain = await call('POST', '/auth/wallet/nonce', {
    body: { wallet: WALLET, partnerAppId: PARTNER_APP_ID, domain: 'https://localhost', uri: URI },
  });
  check('domain with a scheme -> 400 (bare hostname only)', schemeDomain.status === 400, schemeDomain);

  const nonce = await call('POST', '/auth/wallet/nonce', {
    body: { wallet: WALLET, partnerAppId: PARTNER_APP_ID, domain: DOMAIN, uri: URI },
  });
  check('nonce 200 with { nonce, expiresAt, message }',
    nonce.status === 200 && !!nonce.body.nonce && !!nonce.body.expiresAt && !!nonce.body.message, nonce);
  const msg = nonce.body.message;
  check('message has exactly 11 LF lines, no CR',
    msg.split('\n').length === 11 && !msg.includes('\r'), msg.split('\n').length);
  check('message line order is canonical SIWS', (() => {
    const l = msg.split('\n');
    return l[0].endsWith(' wants you to sign in with your Solana account:')
      && l[1] === WALLET && l[2] === '' && l[4] === ''
      && l[5].startsWith('URI: ') && l[6] === 'Version: 1' && l[7].startsWith('Chain ID: ')
      && l[8] === 'Nonce: ' + nonce.body.nonce
      && l[9].startsWith('Issued At: ') && l[10].startsWith('Expiration Time: ');
  })(), msg);

  console.log('\n== auth/wallet/verify ==');
  const otherKp = crypto.generateKeyPairSync('ed25519');
  const wrongSig = base58Encode(crypto.sign(null, Buffer.from(msg, 'utf8'), otherKp.privateKey));
  const badSig = await call('POST', '/auth/wallet/verify', { body: { message: msg, signature: wrongSig } });
  check('signature from the wrong key -> 401 (ed25519 really verified)', badSig.status === 401, badSig);

  const tampered = await call('POST', '/auth/wallet/verify', {
    body: { message: msg.replace('Version: 1', 'Version: 2'), signature: sign(msg) },
  });
  check('tampered message -> 400', tampered.status === 400, tampered);

  const verify = await call('POST', '/auth/wallet/verify', { body: { message: msg, signature: sign(msg) } });
  check('verify -> cca_/ccr_ tokens',
    verify.status === 200 && verify.body.accessToken.startsWith('cca_') && verify.body.refreshToken.startsWith('ccr_'),
    verify);
  const token = verify.body.accessToken;

  const replay = await call('POST', '/auth/wallet/verify', { body: { message: msg, signature: sign(msg) } });
  check('nonce is single-use -> 401 on replay', replay.status === 401, replay);

  console.log('\n== auth/wallet/refresh + logout ==');
  const refreshed = await call('POST', '/auth/wallet/refresh', { body: { refreshToken: verify.body.refreshToken } });
  check('refresh rotates both tokens',
    refreshed.status === 200 && refreshed.body.accessToken !== token
    && refreshed.body.refreshToken !== verify.body.refreshToken, refreshed);
  const refreshReplay = await call('POST', '/auth/wallet/refresh', { body: { refreshToken: verify.body.refreshToken } });
  check('refresh replay -> 401 Refresh token not found or already used',
    refreshReplay.status === 401 && refreshReplay.body.message === 'Refresh token not found or already used',
    refreshReplay);

  console.log('\n== session scope ==');
  const outOfScope = await call('POST', '/partner/customers', { token, body: { externalId: 'x' } });
  check('session token outside the shipping routes -> bare 403, empty body',
    outOfScope.status === 403 && outOfScope.raw === '', outOfScope);

  console.log('\n== shipping-address/create ==');
  const withEmail = await call('POST', '/shipping-address/create', {
    token,
    body: { fullName: 'Ada L', streetAddress: '1 Main St', city: 'San Francisco', state: 'CA', country: 'US', zip: '94103', email: 'ada@example.com' },
  });
  check('undeclared field (email) -> 400 property email should not exist',
    withEmail.status === 400 && withEmail.body.message === JSON.stringify(['property email should not exist']),
    withEmail);

  const missing = await call('POST', '/shipping-address/create', {
    token, body: { streetAddress: '1 Main St', state: 'CA', country: 'US' },
  });
  check('missing required field -> 400 Invalid request.',
    missing.status === 400 && missing.body.message === 'Invalid request.', missing);

  const blocked = await call('POST', '/shipping-address/create', {
    token, body: { streetAddress: '1 Main St', city: 'Nowhere', state: 'NA', country: 'Atlantis' },
  });
  check('unsupported country -> 400 Sorry, we do not ship to ...',
    blocked.status === 400 && /^Sorry, we do not ship to Atlantis at this time$/.test(blocked.body.message), blocked);

  const created = await call('POST', '/shipping-address/create', {
    token,
    body: { fullName: 'Ada L', streetAddress: '1 Main St', apartment: '4B', city: 'San Francisco', state: 'CA', country: 'US', zip: '94103', phoneNumber: '+15550100' },
  });
  check('create -> row with id, state normalised CA -> California, first is default',
    created.status === 201 && !!created.body.id && created.body.state === 'California'
    && created.body.country === 'United States' && created.body.isDefault === true, created);
  const addressId = created.body.id;

  const list = await call('GET', '/shipping-address', { token });
  check('GET /shipping-address lists it', list.status === 200 && list.body.length === 1, list);

  console.log('\n== redeem/estimate ==');
  const prepareBodyReposted = await call('POST', '/redeem/estimate', {
    token, body: { nftAddresses: [NFT_A], shippingAddressId: addressId, coin: 'USDC', paymentMethod: 'crypto' },
  });
  check('prepare body reposted to estimate -> 400',
    prepareBodyReposted.status === 400
    && JSON.parse(prepareBodyReposted.body.message).includes('property coin should not exist'), prepareBodyReposted);

  const badAddr = await call('POST', '/redeem/estimate', {
    token, body: { nftAddresses: [NFT_A], shippingAddressId: 'ccaddr_nope' },
  });
  check('unknown shippingAddressId -> Shipping address not found for this user',
    badAddr.body.message === 'Shipping address not found for this user', badAddr);

  const badCards = await call('POST', '/redeem/estimate', {
    token, body: { nftAddresses: ['NotAVaultedMint111111111111111111111111111'], shippingAddressId: addressId },
  });
  check('unknown card -> 404 Cards not found: <addresses>',
    badCards.status === 404 && badCards.body.message.startsWith('Cards not found: '), badCards);

  const perCard = await call('POST', '/redeem/estimate', {
    token, body: { nftAddresses: [NFT_NOT_REDEEMABLE], shippingAddressId: addressId },
  });
  check('rejected card -> 400 with a per-card array as a JSON string in message',
    perCard.status === 400 && Array.isArray(JSON.parse(perCard.body.message)), perCard);

  const estimate = await call('POST', '/redeem/estimate', {
    token, body: { nftAddresses: [NFT_A], shippingAddressId: addressId, deliveryCompany: 'ups', payCustomsDuties: false },
  });
  check('estimate shape',
    estimate.status === 200
    && typeof estimate.body.price === 'number' && typeof estimate.body.total === 'number'
    && typeof estimate.body.customsDutiesEstimate === 'number'
    && estimate.body.numberOfCards === 1
    && ['USA', 'Canada', 'Europe', 'AustraliaNewZealand', 'RestOfWorld'].includes(estimate.body.breakdown.region)
    && Array.isArray(estimate.body.breakdown.lines)
    && estimate.body.breakdown.lines.every((l) => 'code' in l && 'label' in l && 'amount' in l),
    estimate.body);

  console.log('\n== redeem/prepare ==');
  const withInsurance = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_A], shippingAddressId: addressId, insurance: true },
  });
  check('insurance field -> 400 ["property insurance should not exist"]',
    withInsurance.status === 400
    && withInsurance.body.message === JSON.stringify(['property insurance should not exist']), withInsurance);

  const prep = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_A, NFT_B], shippingAddressId: addressId },
  });
  check('prepare shape',
    prep.status === 200 && !!prep.body.outboundShipmentId
    && prep.body.transactions.length === 2 && Array.isArray(prep.body.delistTransactions)
    && prep.body.submitUrl === '/blockchain/' + prep.body.outboundShipmentId + '/burn'
    && typeof prep.body.totalCost === 'number' && !!prep.body.breakdown, prep.body);

  const prep2 = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_A, NFT_B], shippingAddressId: addressId },
  });
  check('identical prepare -> same shipment, fresh transactions',
    prep2.body.outboundShipmentId === prep.body.outboundShipmentId
    && prep2.body.transactions[0] !== prep.body.transactions[0], {
      a: prep.body.outboundShipmentId, b: prep2.body.outboundShipmentId,
    });

  console.log('\n== blockchain/:id/burn ==');
  const shipmentId = prep2.body.outboundShipmentId;

  const stale = await call('POST', `/blockchain/${shipmentId}/burn`, {
    token, body: { transactions: prep.body.transactions, delistTransactions: [] },
  });
  check('legs from a superseded prepare -> 403 not the complete set',
    stale.status === 403 && stale.body.message === 'The transactions submitted are not the complete set this server issued',
    stale);

  const empty = await call('POST', `/blockchain/${shipmentId}/burn`, {
    token, body: { transactions: [], delistTransactions: [] },
  });
  check('nothing recognised -> 403 Transaction was not issued by this server',
    empty.status === 403 && empty.body.message === 'Transaction was not issued by this server', empty);

  const partial = await call('POST', `/blockchain/${shipmentId}/burn`, {
    token, body: { transactions: [prep2.body.transactions[0]], delistTransactions: [] },
  });
  check('incomplete set -> 403 not the complete set',
    partial.status === 403 && partial.body.message === 'The transactions submitted are not the complete set this server issued',
    partial);

  const otherPrep = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_A], shippingAddressId: addressId, comment: 'second shipment' },
  });
  const wrongShipment = await call('POST', `/blockchain/${otherPrep.body.outboundShipmentId}/burn`, {
    token, body: { transactions: prep2.body.transactions, delistTransactions: [] },
  });
  check('legs for another shipment -> 403 These transactions were not issued for this shipment',
    wrongShipment.status === 403
    && wrongShipment.body.message === 'These transactions were not issued for this shipment', wrongShipment);

  const notMine = await call('POST', '/blockchain/ccos_does-not-exist/burn', {
    token, body: { transactions: prep2.body.transactions, delistTransactions: [] },
  });
  check('unknown shipment -> 404 The shipment is not yours.',
    notMine.status === 404 && notMine.body.message === 'The shipment is not yours.', notMine);

  const burn = await call('POST', `/blockchain/${shipmentId}/burn`, {
    token, body: { transactions: prep2.body.transactions, delistTransactions: [] },
  });
  check('burn -> 200 bare array, every leg error null',
    burn.status === 200 && Array.isArray(burn.body) && burn.body.length === 2
    && burn.body.every((r) => r.error === null && !!r.transactionId && !!r.transactionUrl), burn.body);

  const reburn = await call('POST', `/blockchain/${shipmentId}/burn`, {
    token, body: { transactions: prep2.body.transactions, delistTransactions: [] },
  });
  check('re-posting the identical body -> Duplicate transaction result',
    reburn.status === 200 && reburn.body.every((r) => r.error === 'Duplicate transaction result'), reburn.body);

  console.log('\n== de-list + failed burn legs ==');
  const escrow = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_ESCROW_FAIL], shippingAddressId: addressId },
  });
  check('escrowed card -> delistTransactions non-empty', escrow.body.delistTransactions.length === 1, escrow.body);
  const delistFail = await call('POST', `/blockchain/${escrow.body.outboundShipmentId}/burn`, {
    token, body: { transactions: escrow.body.transactions, delistTransactions: escrow.body.delistTransactions },
  });
  check('failing de-list leg -> 409 with delistErrors, nothing burned',
    delistFail.status === 409 && Array.isArray(delistFail.body.delistErrors), delistFail.body);

  const burnFail = await call('POST', '/redeem/prepare', {
    token, body: { nftAddresses: [NFT_BURN_FAIL, NFT_A], shippingAddressId: addressId, comment: 'burn-fail case' },
  });
  const burnFailRes = await call('POST', `/blockchain/${burnFail.body.outboundShipmentId}/burn`, {
    token, body: { transactions: burnFail.body.transactions, delistTransactions: [] },
  });
  check('a leg that does not land -> 200 with a non-null error, failures first',
    burnFailRes.status === 200 && burnFailRes.body[0].error !== null && burnFailRes.body[1].error === null,
    burnFailRes.body);
  const complete = await call('POST', `/redeem/complete/${burnFail.body.outboundShipmentId}`, { token, body: {} });
  check('/redeem/complete/:id rebuilds legs for only the unburned card',
    complete.status === 200 && complete.body.transactions.length === 1, complete.body);

  console.log('\n== outbound-shipment ==');
  const one = await call('GET', '/outbound-shipment/' + shipmentId, { token });
  check('GET /outbound-shipment/:id -> costs and numberOfCards are STRINGS',
    one.status === 200 && typeof one.body.numberOfCards === 'string'
    && typeof one.body.shippingCost === 'string' && typeof one.body.insuranceCost === 'string'
    && typeof one.body.feesCost === 'string' && typeof one.body.totalCost === 'string'
    && ['Pending', 'Shipped', 'Delivered', 'Cancelled'].includes(one.body.status), one.body);
  check('documented field set present', (() => {
    const want = ['id', 'customId', 'status', 'numberOfCards', 'cardIds', 'deliveryCompany', 'trackingIds',
      'trackingUrls', 'shippingCost', 'insuranceCost', 'feesCost', 'totalCost', 'typeCurrency',
      'createdAt', 'updatedAt'];
    return want.every((k) => k in one.body);
  })(), Object.keys(one.body || {}));

  const unknown = await call('GET', '/outbound-shipment/ccos_nope', { token });
  check('unknown shipment id -> 200 with an EMPTY body',
    unknown.status === 200 && unknown.raw === '', unknown);

  const listShipments = await call('GET', '/outbound-shipment?status=Active', { token });
  check('list filters by status=Active', listShipments.status === 200 && listShipments.body.length >= 1, listShipments.status);

  console.log('\n== API key ==');
  const provision = await call('POST', '/partner/customers', { key: API_KEY, body: { externalId: 'hoshi-user-1' } });
  check('POST /partner/customers -> { userId, created } and needs no X-CC-Customer',
    provision.status === 200 && !!provision.body.userId && provision.body.created === true, provision);
  const again = await call('POST', '/partner/customers', { key: API_KEY, body: { externalId: 'hoshi-user-1' } });
  check('POST /partner/customers is idempotent',
    again.body.userId === provision.body.userId && again.body.created === false, again);

  const noCustomer = await call('GET', '/shipping-address', { key: API_KEY });
  check('key route without X-CC-Customer -> 400 x-cc-customer header is required on this route',
    noCustomer.status === 400 && noCustomer.body.message === 'x-cc-customer header is required on this route',
    noCustomer);

  const unknownCustomer = await call('GET', '/shipping-address', { key: API_KEY, customer: 'nope' });
  check('unknown customer id -> same 400',
    unknownCustomer.status === 400
    && unknownCustomer.body.message === 'x-cc-customer header is required on this route', unknownCustomer);

  const badKey = await call('GET', '/shipping-address', { key: 'ccsk_wrong', customer: 'hoshi-user-1' });
  check('wrong key -> 401 Invalid API key',
    badKey.status === 401 && badKey.body.message === 'Invalid API key', badKey);

  const keyAddress = await call('POST', '/shipping-address/create', {
    key: API_KEY, customer: 'hoshi-user-1',
    body: { fullName: 'Key Customer', streetAddress: '9 Partner Rd', city: 'Jakarta', state: 'JK', country: 'IDN' },
  });
  check('key + X-CC-Customer can create an address for that customer',
    keyAddress.status === 201 && keyAddress.body.state === 'Jakarta' && keyAddress.body.country === 'Indonesia',
    keyAddress.body);

  const keyPrepare = await call('POST', '/redeem/prepare', {
    key: API_KEY, customer: 'hoshi-user-1',
    body: { nftAddresses: [NFT_A], shippingAddressId: keyAddress.body.id },
  });
  check('key + crypto payment -> 400 Crypto payment requires a Solana wallet. Use card payment.',
    keyPrepare.status === 400
    && keyPrepare.body.message === 'Crypto payment requires a Solana wallet. Use card payment.', keyPrepare);

  const keyCardNoEmail = await call('POST', '/redeem/prepare', {
    key: API_KEY, customer: 'hoshi-user-1',
    body: { nftAddresses: [NFT_A], shippingAddressId: keyAddress.body.id, paymentMethod: 'card' },
  });
  check('card payment without an email -> 400 Card payment requires a contact email.',
    keyCardNoEmail.status === 400
    && keyCardNoEmail.body.message === 'Card payment requires a contact email. Send `email` with this request.',
    keyCardNoEmail);

  const keyCard = await call('POST', '/redeem/prepare', {
    key: API_KEY, customer: 'hoshi-user-1',
    body: { nftAddresses: [NFT_A], shippingAddressId: keyAddress.body.id, paymentMethod: 'card', email: 'ops@hoshi.test' },
  });
  check('card payment -> totalCost 0', keyCard.status === 200 && keyCard.body.totalCost === 0, keyCard.body);

  const keySolanaBurn = await call('POST', `/blockchain/${keyCard.body.outboundShipmentId}/burn`, {
    key: API_KEY, customer: 'hoshi-user-1',
    body: { transactions: keyCard.body.transactions, delistTransactions: [] },
  });
  check('API key submitting SOLANA transactions -> refused (403)', keySolanaBurn.status === 403, keySolanaBurn);

  const sessionCardPending = await call('POST', `/blockchain/${keyCard.body.outboundShipmentId}/burn`, {
    key: API_KEY, customer: 'hoshi-user-1', body: { evmTransactions: [{ chain: 'ethereum', txHash: '0xabc' }] },
  });
  check('key reporting EVM hashes -> 200 bare array',
    sessionCardPending.status === 200 && Array.isArray(sessionCardPending.body), sessionCardPending.body);

  console.log('\n== partner/inbound-shipments ==');
  const inbound = await call('POST', '/partner/inbound-shipments', {
    key: API_KEY,
    body: { nftAddresses: [NFT_A, NFT_A, 'UnknownMint1111111111111111111111111111111'], externalRef: 'TRUCK-1' },
  });
  check('consignment dedupes and rejects unknown mints per line',
    inbound.status === 200 && inbound.body.counts.declared === 2 && inbound.body.counts.rejected === 1,
    inbound.body);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
