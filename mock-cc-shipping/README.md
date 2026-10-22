# Mock CollectorCrypt Vault Shipping API

A mock of the real **Shipping API | Collector Crypt** so the Hoshi redeem flow (Track A/B) can be
dry-run with **no CC credentials and no real money**.

It mirrors the published doc as literally as possible: same routes, same request whitelists, same
error messages and statuses, same response shapes (including the ones that bite — string cost
fields, the bare JSON array from `burn`, the empty-200 for an unknown shipment id).

## Where the contract lives — ONE implementation, two ways to serve it

The rules live in exactly one place and are never copied:

| File | Role |
| --- | --- |
| `../src/collectorcrypt/cc-shipping-mock.core.ts` | **the contract.** Framework-free: a pure `handleMockRequest(request) -> response`. No Nest, no Express, no `node:http`. |
| `../src/collectorcrypt/cc-shipping-mock.tx.ts` | builds the burn / de-list legs as **real Solana transactions** (see *Signing*). |
| `../src/collectorcrypt/cc-shipping-mock.controller.ts` | serves the core **inside the backend** at `/api/cc-shipping-mock`, behind a double gate. |
| `standalone.ts` | serves the same core as a `node:http` process on `:4010` for local dry-runs. Contains **no contract logic** — just an adapter. |
| `smoke.mjs` | a 56-assertion walk of the happy path and every documented error case. Zero dependencies; point it at either server. |

Because both servers call the same core, `smoke.mjs` is a real regression net wherever the mock is
served. It calls `POST /__mock/reset` first, so do not run it against a server holding a dry-run you
still need.

**Why the in-backend mount exists.** Staging runs on Render, and a Render service cannot reach
anybody's `localhost:4010`. For the product owner to walk the whole physical-card flow in a browser,
the backend has to be able to point `COLLECTORCRYPT_SHIPPING_BASE_URL` at *itself*.

**It is never active in production.** Every request re-checks the gate inside the handler — the route
is not merely hidden — and answers `404` unless **`CC_SHIPPING_MOCK=1` AND `detectProductionSignal()
=== null`** (`src/common/demo-mode.ts`), the same pattern as `src/payments/idrx-mock.controller.ts`.
A third layer sits in front of both: `assertMainnetConsistency` (`src/config/env.validation.ts`)
**refuses to boot** if `SOLANA_CLUSTER=mainnet-beta` while `CC_SHIPPING_MOCK=1`, or while
`COLLECTORCRYPT_SHIPPING_BASE_URL` still points at `/cc-shipping-mock`.

---

## Run it

### A. Local dry-run (standalone process)

```bash
# from hoshi-backend/
npm run mock:cc-shipping
# -> listening http://localhost:4010

# in another terminal, prove it works:
npm run mock:cc-shipping:smoke
# -> 56 passed, 0 failed
```

(= `ts-node mock-cc-shipping/standalone.ts` and `node mock-cc-shipping/smoke.mjs`.)

### B. Served by the backend (what staging uses)

Set `CC_SHIPPING_MOCK=1` on a **devnet** backend and it appears at `/api/cc-shipping-mock`:

```bash
COLLECTORCRYPT_SHIPPING_BASE_URL=https://<your-backend-host>/api/cc-shipping-mock
```

The same smoke test proves it:

```bash
MOCK_BASE_URL=https://<your-backend-host>/api/cc-shipping-mock npm run mock:cc-shipping:smoke
# -> 56 passed, 0 failed
```

With the flag unset — or set while the deployment looks like production — every path under that
prefix returns `404`, at every depth.

### Env knobs (all optional)

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4010` | listen port |
| `MOCK_PARTNER_APP_ID` | `hoshi-mock-partner` | the issued `partnerAppId`; anything else → `400 Unknown partner` |
| `MOCK_ALLOWED_DOMAINS` | `localhost,127.0.0.1` | csv allowlist for the SIWS `domain` (bare hostnames) |
| `MOCK_API_KEY` | `ccsk_mock_key_do_not_use_in_prod` | the one accepted `ccsk_` key |
| `MOCK_API_KEY_SCOPES` | all five | csv subset to exercise `403 This API key does not carry the '<scope>' scope` |
| `MOCK_NFT_ADDRESSES` | – | csv of extra mints to add to the fake vault catalogue |
| `MOCK_ACCEPT_ANY_NFT` | `false` | accept any mint (otherwise unknown mints give `404 Cards not found: …`) |
| `MOCK_NONCE_RATE_LIMIT` | `10` | nonce requests per wallet per minute; `off` disables the 429 |
| `MOCK_ADDRESS_NOT_FOUND_STATUS` | `404` | the doc contradicts itself here (see *Doc conflicts*); set `400` to flip |
| `MOCK_SIWS_STATEMENT` / `MOCK_SIWS_CHAIN_ID` | `Sign in to Collector Crypt.` / `mainnet` | lines 4 and 8 of the signed message |
| `MOCK_LOG` | `true` | per-request log line (standalone only) |

Every knob above also answers to a `CC_SHIPPING_MOCK_`-prefixed name (`CC_SHIPPING_MOCK_PARTNER_APP_ID`,
`CC_SHIPPING_MOCK_ACCEPT_ANY_NFT`, …). Use that form in a deployed `backend.env`, where a bare
`MOCK_*` name is too easy to collide with. `PORT` and `MOCK_LOG` apply to the standalone process only.

---

## Point the backend at it

Add to `hoshi-backend/.env` (or the droplet `backend.env` for a staging dry-run):

```bash
# standalone process; for the in-backend mount use https://<backend-host>/api/cc-shipping-mock
COLLECTORCRYPT_SHIPPING_BASE_URL=http://localhost:4010
COLLECTORCRYPT_SHIPPING_USER_AGENT=hoshi-backend-dryrun   # must be NON-EMPTY, the mock refuses blank UA
COLLECTORCRYPT_PARTNER_APP_ID=hoshi-mock-partner
COLLECTORCRYPT_SIWS_DOMAIN=localhost                      # BARE hostname: no scheme, no port, no path
COLLECTORCRYPT_SIWS_URI=http://localhost:3000             # absolute URL, echoed into the signed text
HOSHI_CC_SHIPPING_ENABLED=true                            # our own gate; the real paths stay dark without it
```

If you also want the API-key credential path, set whatever your key env is to
`ccsk_mock_key_do_not_use_in_prod` and send `X-CC-Customer: <externalId>` after provisioning that
customer (see the walkthrough).

> `COLLECTORCRYPT_SIWS_DOMAIN=https://localhost` is rejected by the mock exactly as CC would reject
> it (`400`, bare hostname only) — that is one of the bugs this mock exists to catch.

---

## Happy path with curl

```bash
BASE=http://localhost:4010   # or https://<backend-host>/api/cc-shipping-mock
UA='-H User-Agent:hoshi-dryrun'   # every route needs a non-empty User-Agent

# 1. nonce  (public)
curl -s $BASE/auth/wallet/nonce -H 'User-Agent: hoshi-dryrun' -H 'Content-Type: application/json' \
  -d '{"wallet":"<base58 wallet>","partnerAppId":"hoshi-mock-partner","domain":"localhost","uri":"http://localhost:3000"}'
# -> { "nonce":"<uuid>", "expiresAt": 1787…, "message":"localhost wants you to sign in…" }

# 2. sign message BYTE FOR BYTE (LF, 11 lines) with the wallet key, base58 the 64-byte signature,
#    then exchange it. The mock really verifies ed25519 — a fake signature returns 401.
curl -s $BASE/auth/wallet/verify -H 'User-Agent: hoshi-dryrun' -H 'Content-Type: application/json' \
  -d '{"message":"<the exact text>","signature":"<base58 sig>"}'
# -> { "accessToken":"cca_…", "refreshToken":"ccr_…", "expiresAt": … }

TOKEN=cca_…

# 3. address  (only the documented fields — an extra one, e.g. email, is a 400)
curl -s $BASE/shipping-address/create -H "Authorization: Bearer $TOKEN" -H 'User-Agent: hoshi-dryrun' \
  -H 'Content-Type: application/json' \
  -d '{"fullName":"Ada L","streetAddress":"1 Main St","city":"San Francisco","state":"CA","country":"US","zip":"94103"}'
# -> { "id":"ccaddr_…", "state":"California", "country":"United States", "isDefault":true, … }

# 4. estimate  (optional; only these four fields)
curl -s $BASE/redeem/estimate -H "Authorization: Bearer $TOKEN" -H 'User-Agent: hoshi-dryrun' \
  -H 'Content-Type: application/json' \
  -d '{"nftAddresses":["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],"shippingAddressId":"ccaddr_…","deliveryCompany":"ups","payCustomsDuties":false}'

# 5. prepare
curl -s $BASE/redeem/prepare -H "Authorization: Bearer $TOKEN" -H 'User-Agent: hoshi-dryrun' \
  -H 'Content-Type: application/json' \
  -d '{"nftAddresses":["7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"],"shippingAddressId":"ccaddr_…"}'
# -> { "outboundShipmentId":"ccos_…", "transactions":["<base64>"], "delistTransactions":[],
#      "totalCost":5.99, "submitUrl":"/blockchain/ccos_…/burn", "breakdown":{…} }

# 6. burn — post the SIGNED copies back, transactions and delistTransactions as SEPARATE arrays
curl -s $BASE/blockchain/ccos_…/burn -H "Authorization: Bearer $TOKEN" -H 'User-Agent: hoshi-dryrun' \
  -H 'Content-Type: application/json' \
  -d '{"transactions":["<base64>"],"delistTransactions":[]}'
# -> 200 [ { "error": null, "transactionId":"…", "transactionUrl":"https://solscan.io/tx/…" } ]

# 7. track
curl -s $BASE/outbound-shipment/ccos_… -H "Authorization: Bearer $TOKEN" -H 'User-Agent: hoshi-dryrun'
# -> { "numberOfCards":"1", "shippingCost":"5.99", "totalCost":"5.99", "status":"Pending", … }  (STRINGS)
```

### API-key credential

```bash
KEY=ccsk_mock_key_do_not_use_in_prod
# the ONE key route that takes no X-CC-Customer:
curl -s $BASE/partner/customers -H "Authorization: Bearer $KEY" -H 'User-Agent: hoshi-dryrun' \
  -H 'Content-Type: application/json' -d '{"externalId":"hoshi-user-1"}'
# -> { "userId":"ccu_…", "created":true }   (idempotent)

curl -s $BASE/shipping-address -H "Authorization: Bearer $KEY" -H 'X-CC-Customer: hoshi-user-1' -H 'User-Agent: hoshi-dryrun'
```

A key posting `transactions`/`delistTransactions` to `/blockchain/:id/burn` is **refused** — a key may
report EVM hashes only (`{"evmTransactions":[{"chain":"ethereum","txHash":"0x…"}]}`). Solana
redemptions need a wallet sign-in session. That rule is what keeps the dry-run honest.

---

## Signing the mock's transactions

`transactions` and `delistTransactions` are **real Solana transactions** — base64 wire format, not
placeholders. A wallet can deserialise, sign and return them, which is the whole point: the frontend
signs through `useSignSerializedTransaction`, which calls `VersionedTransaction.deserialize` with a
`Transaction.from` fallback. Both throw on a JSON blob, so the earlier placeholder form killed a
browser dry-run at the signature step — the single step most worth rehearsing.

**They cannot move value.** Three independent reasons, any one of them sufficient:

1. **The instruction has no authority over anything.** The only instruction targets the SPL Memo
   program (`MemoSq4g…`) with **zero accounts**. Memo writes its data to the transaction log; it has
   no CPI, holds no account, and cannot move a lamport or a token. There is no System, SPL-Token,
   Metaplex or burn instruction anywhere in it.
2. **The blockhash never existed.** `recentBlockhash` is a synthetic sha256 derived from the leg's
   identity, not a hash any cluster ever issued. A validator rejects it (`BlockhashNotFound`), so the
   transaction cannot be processed at all — and it cannot "ripen" later either.
3. **The fee payer is the user's own wallet.** If both layers above somehow failed, the only value
   that could change is that wallet's own transaction fee. There is no recipient in the transaction.

Phantom will warn that simulation failed. That is correct and intended — these must not be landable.

The leg marker (`shipment / batch / leg kind / leg index / mint`) rides in the **memo data**, so it is
part of the message bytes. Signing fills signature slots and does not touch the message, so the mock
recognises a signed copy as the same leg. Everything else about the leg accounting is real:
completeness, batch identity, the 15-minute hold, duplicates.

**Deliberate side effect on our side.** `burnTxSetIdentity` (`src/collectorcrypt/cc-shipping.txset.ts`)
hashes *message bytes*; against the old JSON blobs it returned `null` and the stale-batch guard was
skipped (fail-open). With real transactions it returns a stable hash, so a dry-run now genuinely
exercises that guard — a superseded batch is refused locally, with the row left `FUNDED` and CC never
called. Covered by `src/collectorcrypt/cc-shipping-mock.spec.ts`.

## Seeded vault catalogue

| Mint | Behaviour |
| --- | --- |
| `7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU` | normal, declaredValue 80 (matches the doc's sample) |
| `9aBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dE3fGhJkM` | normal, declaredValue 260 |
| `3mQzXyW9vU8tS7rQ6pN5mK4jH3gF2eD1cB9aZ8yX7wVt` | normal, declaredValue 1200 (non-zero insurance) |
| `ESCRWaBcDeFgHkJmN4pQ5rS6tU7vW8xY9zA1bC2dEfGh` | escrowed → `prepare` returns a `delistTransactions` leg |
| `ESCRWFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE` | escrowed **and** the de-list leg fails → `409` with `delistErrors` |
| `BURNFaiLbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dEf` | burn leg does not land → `200` with a non-null `error`, then `/redeem/complete/:id` |
| `NOTREDEEMbCdEfGhkJmN4pQ5rS6tU7vW8xY9zA1bC2dE` | rejected per-card → `400` whose `message` is a JSON string |

`GET /__mock/state` lists everything the server currently holds.

---

## Routes

| Route | Credential | Notes |
| --- | --- | --- |
| `POST /auth/wallet/nonce` | public | `wallet`, `partnerAppId`, `domain`, `uri`; 11-line LF SIWS text; nonce single-use, 5 min |
| `POST /auth/wallet/verify` | public | real ed25519 verify over the raw UTF-8 bytes; `cca_`/`ccr_`, 15 min / 7 days |
| `POST /auth/wallet/refresh` | public | rotates both; replay → `401 Refresh token not found or already used` |
| `POST /auth/wallet/logout` | public (+ optional access token) | kills the refresh token, and the access token when sent |
| `POST /shipping-address/create` | session · key `shipping-address` | documented fields only; `state` normalised (`CA` → `California`) |
| `GET /shipping-address` | session · key `shipping-address` | list |
| `GET/PATCH/DELETE /shipping-address/:id` | session · key `shipping-address` | from the doc's scope table |
| `POST /redeem/estimate` | session · key `redeem` | exactly four fields |
| `POST /redeem/prepare` | session · key `redeem` | documented fields only; `insurance` → `400` |
| `POST /redeem/complete/:shipmentId` | session · key `redeem` | rebuilds legs for cards not yet burned |
| `POST /blockchain/:outboundShipmentId/burn` | session (Solana) · key (EVM only) | `200` **bare array**, failures first |
| `GET /outbound-shipment` | session · key `outbound-shipment` | `status=Active\|Past`, `search`, newest first |
| `GET /outbound-shipment/:id` | session · key `outbound-shipment` | unknown id → **200 with an empty body** |
| `POST /partner/customers` | key `customers:provision` | `{externalId}` → `{userId, created}`, idempotent, **no** `X-CC-Customer` |
| `POST/GET /partner/inbound-shipments` | key `inbound-shipment` | consignments, **no** `X-CC-Customer`; unknown mints → rejected lines |
| `GET/PATCH /partner/inbound-shipments/:id` | key `inbound-shipment` | lines with `Cert` / `Bulk` / `CardRaw`, `counts` |

Mock-only test hooks (**not** part of the CC API, clearly namespaced):
`GET /__mock/state`, `POST /__mock/reset`, `PATCH /__mock/shipment/:id`
(`{status, trackingIds, trackingUrls, confirmCardPayment}`), `POST /__mock/inbound/:id/receive`.

## Enforced error cases

Credentials / edge

* empty or missing `User-Agent` → refused before routing
* `x-api-key` header is never read as a credential → `401 Invalid API key`
* access token outside the shipping routes → **bare `403`, empty body**
* unknown/wrong key → `401 Invalid API key`; missing scope → `403 This API key does not carry the '<scope>' scope`
* key route without (or with an unknown) `X-CC-Customer` → `400 x-cc-customer header is required on this route`
* key submitting Solana `transactions` to `burn` → `403` (EVM hashes only)

Sign-in

* unknown `partnerAppId` → `400 Unknown partner`
* `domain` with scheme/port/path → `400`; domain off the allowlist → `400`
* nonce replay / expiry → `401`; wrong-key or tampered signature → `401` (real ed25519)
* message that is not the one accepted form (CRLF, wrong line count, wrong order) → `400`
* `> MOCK_NONCE_RATE_LIMIT` nonce requests per wallet per minute → `429` with `retryAfter`
* refresh replay → `401 Refresh token not found or already used`

Addresses

* any undeclared field (e.g. `email`) → `400` whose `message` is `["property email should not exist"]`
* missing required field → `400 Invalid request.` (does not name the field)
* unshippable country → `400 Sorry, we do not ship to <country> at this time`

Estimate / prepare

* a fifth field on estimate (e.g. reposting a prepare body) → `400`
* `insurance` on prepare → `400 ["property insurance should not exist"]`
* unknown mints → `404 Cards not found: <addresses>`
* per-card rejection → `400` whose `message` is a JSON **string** containing an array
* unknown/foreign `shippingAddressId` → `Shipping address not found for this user`
* `paymentMethod: card` with no email → ``400 Card payment requires a contact email. Send `email` with this request.``
* `paymentMethod: crypto` without a Solana wallet (i.e. on a key) → `400 Crypto payment requires a Solana wallet. Use card payment.`

Burn

* nothing recognised / only de-list legs / expired or superseded batch → `403 Transaction was not issued by this server`
* missing, duplicated, or foreign-prepare leg → `403 The transactions submitted are not the complete set this server issued`
* legs belonging to a different shipment → `403 These transactions were not issued for this shipment`
* unconfirmed card payment → `409 shipment <id> is awaiting card payment confirmation`
* failing de-list leg → `409` carrying `delistErrors` (nothing burned)
* unknown or foreign shipment → `404 The shipment is not yours.`
* identical re-post → `200` with `{ "error": "Duplicate transaction result", … }` per already-recorded leg
* a leg that does not land → `200` with a non-null `error` on that element (failures sorted first)

## Doc conflicts, and what is deliberately NOT simulated

**Conflict.** The doc gives `404 Shipping address not found for this user` in the estimate error list
but shows the same message as `statusCode: 400` in the generic error sample. The mock uses **404**;
set `MOCK_ADDRESS_NOT_FOUND_STATUS=400` to see the other reading.

Deliberately not simulated:

* **Real Solana** — no blockchain, no co-sign, no broadcast. The transactions are genuine wire-format
  and genuinely signable, but deliberately unlandable (see *Signing*), and burn results are fabricated
  signatures. The doc's on-chain consequences ("omit the de-list legs and the burn legs fail on
  chain") cannot happen here; the mock refuses an incomplete set up front instead.
* **EVM redemptions** — the doc says "Only Solana assets are covered by this document", so the key's
  `evmTransactions` branch only records what you send and echoes an `etherscan.io` URL.
* **Real prices / real carriers** — the price table is invented (regions and line shapes follow the
  doc; amounts do not). Insurance is free at or below a declared value of 100 so the doc's sample
  (`declaredValue 80`, `insurancePrice 0`) reproduces exactly. `breakdown.lines` is intentionally
  varied (`qty`/`unitPrice` appear on one line) to force generic rendering.
* **Status progression and tracking** — CC advances `Pending → Shipped → Delivered` in its own vault;
  there are no webhooks and no documented route to move it, so the mock leaves shipments at `Pending`
  and exposes `PATCH /__mock/shipment/:id` to move them by hand.
* **Inbound line state progression** — `state` is "derived from where the physical item actually is",
  so lines stay `Declared` (or `Rejected`) until you call `POST /__mock/inbound/:id/receive`.
* **Per-network-address rate limiting, revoked/expired/disabled keys, real allowlist provisioning** —
  only the per-wallet nonce limit and a single static key are modelled.
* **Undocumented shapes** are marked `DOC-SILENT:` in `../src/collectorcrypt/cc-shipping-mock.core.ts`. The main ones: the list envelopes
  for `GET /outbound-shipment` and `GET /partner/inbound-shipments` are bare arrays; `logout` and
  `DELETE /shipping-address/:id` return `{"success":true}`; the `409` de-list body is
  `{statusCode, message, error, delistErrors}`; wording of the 401s around sign-in; the status used
  for a blank `User-Agent` (`400`) and for a key sending Solana legs (`403`).
