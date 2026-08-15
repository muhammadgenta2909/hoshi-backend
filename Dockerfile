# Hoshi backend (NestJS + Prisma) — multi-stage image untuk produksi.
# Build sekali (dep + nest build + prisma generate), lalu jalankan hasilnya.

# ---------- build ----------
FROM node:20-slim AS build
WORKDIR /app
# Prisma butuh openssl untuk query engine-nya.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
# `npm ci` menjalankan postinstall = `prisma generate` (butuh folder prisma di atas).
RUN npm ci
COPY . .
RUN npm run build

# ---------- run ----------
FROM node:20-slim AS run
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Bawa node_modules dari build (sudah termasuk prisma CLI + client ter-generate) +
# hasil build + skema. `npm run prisma:deploy` butuh prisma CLI, jadi node_modules penuh dibawa.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
EXPOSE 3001
# Saat container start: jalankan migrasi DB dulu (aman & idempoten), lalu boot server.
CMD ["sh", "-c", "npm run prisma:deploy && node dist/main"]
