# Hoshi Backend — Phase 3 (Backend Foundation)

## 📍 Status proyek (PATOKAN — update terakhir: 2026-06-27)

> Sumber kebenaran progress. Baca bagian ini dulu tiap sesi baru. Update kalau ada perubahan signifikan.

**Phase 3 (Backend Foundation) SELESAI & terverifikasi (build + lint lolos), sudah di-hardening
via review adversarial.** Backend ini kelanjutan dari POC Solana (Phase 1 & 2 yang ada di repo
`../hoshi-poc-solana`). Deliverable "backend bisa dipanggil frontend" tercapai.

Sudah jadi & jalan:
- ✅ Auth wallet-login: `/auth/nonce` → verifikasi signature (tweetnacl) → `/auth/login` keluarkan JWT
- ✅ Cards API (CRUD katalog), Users (`/users/me`)
- ✅ NFT API `/nft/mint` — logika mint POC dipindah ke `UmiService` (platform bayar, owner = user)
- ✅ Vault API: `store → /vault/:id/claim → mint NFT ke user` (inti alur Hoshi)
- ✅ Swagger `/docs`, prefix `/api`, port 3001

### Cara resume / jalanin (lihat README.md untuk detail)
1. `npm install`
2. Isi `DATABASE_URL` (Neon) di `.env`. `.env` & `platform.json` **gitignored**.
   `.env` sudah berisi JWT secret + keypair platform devnet (reuse dari POC, sudah didanai) + RPC + metadata.
3. `npm run prisma:migrate` (nama: `init`) → `npm run db:seed` → `npm run start:dev`
4. http://localhost:3001/docs

## Konteks bisnis (ringkas)
Platform Hoshi menyimpan kartu fisik (**vault**) → user **klaim** → platform **mint NFT**
(Metaplex Core) ke wallet user (platform yang bayar). Marketplace & redeem menyusul (roadmap).

## Stack & keputusan (JANGAN diganti tanpa alasan)
- **NestJS 11** (App-style modules) · TypeScript strict
- **Prisma 6** + PostgreSQL (**Neon**). ⚠️ JANGAN upgrade ke Prisma 7 — breaking: `url` di schema
  pindah ke `prisma.config.ts` + driver adapter. Tetap di v6.
- **JWT** (`@nestjs/jwt` + `passport-jwt`), wallet signature via **tweetnacl + bs58 + @solana/web3.js v1**
- **Umi + Metaplex Core** (`@metaplex-foundation/mpl-core`) — port dari POC, JANGAN pakai `@metaplex-foundation/js`
- `class-validator` + `class-transformer`, `@nestjs/swagger`, `@nestjs/throttler`

## Peta modul
```
src/
  main.ts                       # prefix /api, CORS, ValidationPipe, PrismaExceptionFilter, shutdownHooks, Swagger
  app.module.ts                 # rakit modul + ThrottlerModule (rate-limit global)
  config/env.validation.ts      # validasi env saat boot (fail fast)
  common/prisma-exception.filter.ts # P2002/P2003/P2025 → 409/404 (bukan 500)
  prisma/                       # PrismaService (global, connect/disconnect)
  solana/umi.service.ts         # Umi + keypair platform → mintCoreAsset()
  auth/                         # nonce(atomik)→verify→JWT, JwtAuthGuard, @CurrentUser, @Throttle ketat
  users/ cards/ nft/ vault/     # domain modules
prisma/schema.prisma            # User, Card, Nft, VaultItem  (+ VaultStatus: STORED/MINTING/MINTED/REDEEMED)
prisma/seed.ts                  # 2 card + 2 vault item contoh
```

## Gotchas (penting)
- ⚠️ **Hook `rtk` mencegat `npx prisma ...`** (error `[rtk: No such file]`). Jalankan via binary:
  `node node_modules/prisma/build/index.js generate|migrate`. Lewat `npm run prisma:*` aman di terminal user.
- Build: nest output `dist/main.js` (tsconfig.build.json `rootDir:src` + exclude `prisma`). `start:prod` = `node dist/main`.
- `.env` JANGAN commit. `JWT_SECRET` min 32 char. `JWT_EXPIRES_IN` wajib bersatuan (mis. `7d`).
- Warning `package.json#prisma deprecated` saat migrate → abaikan (urusan Prisma 7).

## Sudah di-hardening (review adversarial)
Klaim vault atomik (anti double-mint) + kompensasi · konsumsi nonce atomik (anti-replay) ·
global Prisma exception filter · `onDelete: Restrict` relasi Card · throttler · graceful shutdown ·
validasi env JWT. Detail + sisa roadmap di **README.md**.

## Roadmap (di luar scope foundation)
Idempotency key + write-ahead/outbox reconciliation mint (asset yatim saat confirm-timeout),
KMS untuk secrets, nonce store ber-TTL (Redis), RBAC admin, redeem, storage mainnet, RPC berbayar, test otomatis.

## Catatan
User berbahasa **Indonesia**. Frontend (Next.js POC) ada di `../hoshi-poc-solana` — kontrak wallet-login
untuk integrasi FE ada di README.md bagian "Kontrak Wallet Login".
