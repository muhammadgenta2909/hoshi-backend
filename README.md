# Hoshi Backend — Phase 3 (Backend Foundation)

Backend NestJS untuk Hoshi. Kelanjutan dari POC Solana (Phase 2). Menyediakan API yang
bisa dipanggil frontend: **Auth (wallet login)**, **Cards**, **NFT (mint)**, dan **Vault**.

> Alur bisnis Hoshi: platform menyimpan kartu fisik (**vault**) → user **klaim** → platform
> **mint NFT** (Metaplex Core) ke wallet user (platform yang bayar). Logika mint di-port
> langsung dari POC (`app/api/mint/route.ts` + `lib/umi.ts`).

## Stack

NestJS 11 · Prisma 6 + PostgreSQL (Neon) · JWT (passport-jwt) · `@solana/web3.js` v1 ·
Metaplex Core via Umi · `tweetnacl` + `bs58` (verifikasi signature) · Swagger.

## Peta modul

```
src/
  main.ts                  # bootstrap: prefix /api, CORS, ValidationPipe, Swagger /docs
  app.module.ts            # rakit semua module
  config/env.validation.ts # validasi env saat boot (fail fast)
  prisma/                  # PrismaService (global)
  solana/umi.service.ts    # Umi + keypair platform → mintCoreAsset()  (port POC)
  auth/                    # nonce → verifikasi signature → JWT, JwtAuthGuard, @CurrentUser
  users/                   # GET /users/me
  cards/                   # CRUD katalog kartu
  nft/                     # POST /nft/mint, list NFT user
  vault/                   # store → claim (klaim = mint NFT ke user)
prisma/schema.prisma       # User, Card, Nft, VaultItem
prisma/seed.ts             # 2 card + 2 vault item contoh
```

## Setup

### 1. Install
```bash
npm install
```

### 2. Database (Neon)
Buat Postgres gratis di https://neon.tech, copy connection string, lalu isi `.env`:
```
DATABASE_URL="postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require"
```
`.env` sudah berisi `JWT_SECRET`, keypair platform devnet (reuse dari POC, sudah didanai),
RPC, dan metadata URI. Lihat `.env.example` untuk template.

### 3. Migrate + seed
```bash
npm run prisma:migrate      # buat tabel di Neon (sekali di awal: namai "init")
npm run db:seed             # isi card + vault item contoh
```

### 4. Run
```bash
npm run start:dev           # http://localhost:3001
```
- Swagger UI: **http://localhost:3001/docs**
- Health: **GET http://localhost:3001/api/health**

## Endpoint (semua diawali `/api`)

| Method | Path | Auth | Fungsi |
|---|---|---|---|
| GET | `/health` | — | Health check |
| POST | `/auth/nonce` | — | Langkah 1: minta message untuk ditandatangani |
| POST | `/auth/login` | — | Langkah 2: kirim signature → dapat JWT |
| GET | `/auth/me` | JWT | User dari token |
| GET | `/users/me` | JWT | Profil + jumlah NFT/vault |
| GET | `/cards` | — | List katalog kartu |
| GET | `/cards/:id` | — | Detail kartu |
| POST | `/cards` | JWT | Buat kartu |
| PATCH | `/cards/:id` | JWT | Update kartu |
| DELETE | `/cards/:id` | JWT | Hapus kartu |
| POST | `/nft/mint` | JWT | Mint card jadi NFT ke wallet user |
| GET | `/nft` | JWT | List NFT user |
| GET | `/nft/:id` | JWT | Detail NFT user |
| POST | `/vault` | JWT | (admin) simpan kartu fisik ke vault |
| GET | `/vault/available` | JWT | Item vault yang bisa diklaim |
| GET | `/vault/me` | JWT | Vault item milik user |
| GET | `/vault/:id` | JWT | Detail vault item |
| POST | `/vault/:id/claim` | JWT | **Klaim → mint NFT ke user** |

## Kontrak Wallet Login (untuk frontend)

Backend yang menentukan nonce (lebih aman dari POC yang pakai `Date.now()` di client):

1. `POST /api/auth/nonce { walletAddress }` → `{ message, nonce }`
2. Frontend menandatangani **`message`** persis apa adanya dengan wallet:
   ```ts
   const { message } = await (await fetch('/api/auth/nonce', { ... })).json();
   const sig = await signMessage(new TextEncoder().encode(message)); // dari wallet-adapter
   const signature = bs58.encode(sig);
   ```
3. `POST /api/auth/login { walletAddress, signature }` → `{ accessToken, user }`
4. Panggil endpoint ber-`JWT` dengan header `Authorization: Bearer <accessToken>`.

Nonce dirotasi tiap login (anti-replay): satu signature hanya bisa dipakai sekali.

## Contoh alur cepat (curl)

```bash
# 1. minta nonce
curl -s -X POST localhost:3001/api/auth/nonce \
  -H 'content-type: application/json' \
  -d '{"walletAddress":"<WALLET>"}'
# 2. (frontend tanda tangani message, hasilkan signature base58)
# 3. login
curl -s -X POST localhost:3001/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"walletAddress":"<WALLET>","signature":"<SIG_BASE58>"}'
# 4. lihat item vault yang bisa diklaim
curl -s localhost:3001/api/vault/available -H "authorization: Bearer <JWT>"
# 5. klaim → mint NFT ke wallet user (platform bayar)
curl -s -X POST localhost:3001/api/vault/<ID>/claim -H "authorization: Bearer <JWT>"
```

## Sudah di-harden (hasil review adversarial)

- **Anti double-mint:** klaim vault bersifat atomik (`STORED → MINTING → MINTED`), mint cuma
  jalan untuk pemenang race; gagal mint → item dikembalikan ke `STORED` (kompensasi).
- **Anti-replay login:** konsumsi nonce atomik — satu signature hanya bisa dipakai sekali.
- **Integritas data:** `onDelete: Restrict` pada relasi Card; error Prisma (P2002/P2003/P2025)
  dipetakan ke 409/404 lewat global exception filter (bukan 500 bocor detail).
- **Rate-limit:** throttler global (60/menit) + ketat di endpoint auth (10/menit).
- **Graceful shutdown:** `enableShutdownHooks` + `PrismaService.onModuleDestroy`.
- **Validasi env:** `JWT_SECRET` min 32 char, `JWT_EXPIRES_IN` wajib bersatuan.

## Masih roadmap (di luar scope foundation)

- **Idempotency & reconciliation mint:** kalau RPC timeout SETELAH transaksi mendarat on-chain,
  asset bisa yatim (tanpa baris DB). Solusi penuh: write-ahead row `PENDING` + outbox/reconcile
  by asset address. Saat ini di-cover sebagian (kompensasi klaim) — belum idempotency key penuh.
- **Secrets:** pindah `PLATFORM_SECRET_KEY`/`JWT_SECRET` ke KMS/secrets manager (bukan `.env`).
- **Nonce store ber-TTL** (Redis) supaya `/auth/nonce` tak membuat baris user permanen.
- **RBAC admin sungguhan** (saat ini endpoint admin cukup JWT), redeem (NFT → kartu fisik),
  storage permanen (Irys/Arweave mainnet), RPC berbayar, dan test otomatis.
