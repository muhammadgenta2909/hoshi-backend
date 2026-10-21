import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ConfigService } from '@nestjs/config';
import { DUITKU_TX_NOT_FOUND, DuitkuClient } from './duitku.client';
import { newDuitkuOrderId } from './payment-gateway';

/**
 * ╔════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ UJI SUNGGUHAN KE SANDBOX DUITKU — OPT-IN, DAN SELALU SANDBOX.                              ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Test unit di duitku.client.spec.ts membuktikan rumus tanda tangan kita SAMA dengan library PHP
 * resmi Duitku. Yang tidak bisa dibuktikannya: bahwa server Duitku memang menerima rumus itu.
 * Port Go yang beredar memakai rumus BERBEDA untuk createInvoice (HMAC), jadi pertanyaan ini
 * nyata — dan jawabannya harus didapat di sandbox, bukan dengan uang pembeli pertama.
 *
 * Jalan HANYA kalau DUITKU_SANDBOX_CHECK=1 DAN berkas .env.duitku-sandbox.local (diabaikan git)
 * berisi DUITKU_MERCHANT_CODE + DUITKU_API_KEY dari project SANDBOX. Tanpa itu: dilewati, jadi
 * suite biasa tidak pernah menyentuh jaringan.
 *
 * DUITKU_ENV DIPAKSA "sandbox" apa pun isi berkasnya. Test ini tidak boleh, dengan cara apa pun,
 * menerbitkan tagihan di produksi.
 *
 *   Langkah 1:  DUITKU_SANDBOX_CHECK=1 node node_modules/jest/bin/jest.js duitku.sandbox
 *               → tagihan sandbox terbit, statusnya "01" (menunggu), link simulasi bayar dicetak.
 *   Langkah 2:  buka link itu, selesaikan pembayaran di simulator sandbox Duitku.
 *   Langkah 3:  DUITKU_SANDBOX_CHECK=1 DUITKU_SANDBOX_EXPECT_PAID=1 node node_modules/jest/bin/jest.js duitku.sandbox
 *               → order yang sama kini "00" (lunas).
 */

const ROOT = join(__dirname, '..', '..');
const CREDS_FILE = join(ROOT, '.env.duitku-sandbox.local');
/** Cocok pola `.env.*.local` di .gitignore — nomor order uji tidak ikut ke repo. */
const LAST_ORDER_FILE = join(ROOT, '.env.duitku-sandbox-order.local');

/** KEY=VALUE per baris; '#' komentar; tanda kutip di ujung dibuang. Nilainya tidak pernah dicetak. */
function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (value) out[key] = value;
  }
  return out;
}

const creds =
  process.env.DUITKU_SANDBOX_CHECK === '1' && existsSync(CREDS_FILE)
    ? readEnvFile(CREDS_FILE)
    : null;
const enabled = !!creds?.DUITKU_MERCHANT_CODE && !!creds?.DUITKU_API_KEY;

(enabled ? describe : describe.skip)(
  'Duitku SANDBOX — uji sungguhan (opt-in)',
  () => {
    jest.setTimeout(30_000);
    const ORIG_ENV = { ...process.env };

    beforeAll(() => {
      // Mesin ini harus terlihat BUKAN produksi, kalau tidak pagar sandbox (benar) menolak.
      process.env.SOLANA_CLUSTER = 'devnet';
      delete process.env.SOLANA_RPC_URL;
      delete process.env.COLLECTORCRYPT_GACHA_BASE_URL;
    });

    afterAll(() => {
      process.env = { ...ORIG_ENV };
    });

    const client = () => {
      const cfg: Record<string, string | undefined> = {
        DUITKU_ENV: 'sandbox', // DIPAKSA. Lihat blok di atas.
        DUITKU_MERCHANT_CODE: creds?.DUITKU_MERCHANT_CODE,
        DUITKU_API_KEY: creds?.DUITKU_API_KEY,
        DUITKU_CALLBACK_URL:
          creds?.DUITKU_CALLBACK_URL ??
          'https://api.hoshimarket.xyz/api/payments/duitku/callback',
        DUITKU_CUSTOMER_EMAIL:
          creds?.DUITKU_CUSTOMER_EMAIL ?? 'hoshimarketxyz@gmail.com',
      };
      return new DuitkuClient({
        get: (k: string) => cfg[k],
      } as unknown as ConfigService);
    };

    if (process.env.DUITKU_SANDBOX_EXPECT_PAID === '1') {
      it('order uji yang sudah dibayar di simulator → status "00" (lunas)', async () => {
        expect(existsSync(LAST_ORDER_FILE)).toBe(true);
        const id = readFileSync(LAST_ORDER_FILE, 'utf8').trim();

        const status = await client().transactionStatus(id);

        expect(status).not.toBeNull();
        expect(status).not.toBe(DUITKU_TX_NOT_FOUND);
        if (!status || status === DUITKU_TX_NOT_FOUND) return;
        expect(status.statusCode).toBe('00');
        expect(status.amount).toMatch(/^20000(\.0+)?$/);
      });
      return;
    }

    it('tagihan diterima (rumus tanda tangan createInvoice benar) dan statusnya bisa dicek (md5 benar)', async () => {
      const id = newDuitkuOrderId();

      const invoice = await client().createInvoice({
        paymentAmount: 20_000,
        merchantOrderId: id,
        productDetails: 'Uji sandbox Hoshimarket',
        returnUrl: 'https://hoshimarket.xyz/vault',
        expiryPeriod: 60,
      });
      expect(invoice.paymentUrl).toMatch(/^https:\/\//);
      expect(invoice.reference).toBeTruthy();

      writeFileSync(LAST_ORDER_FILE, id);

      // Tagihan yang BELUM DIBUKA pembeli belum punya transaksi di Duitku: jawabannya HTTP 400
      // "Transaction not found" (diamati di sandbox), yang klien terjemahkan jadi NOT_FOUND.
      // Kalau sudah dibuka, jawabannya "01" (menunggu).
      const status = await client().transactionStatus(id);
      expect(status).not.toBeNull();
      if (status !== DUITKU_TX_NOT_FOUND) {
        expect(status?.statusCode).toBe('01');
      }
      console.log(
        `\n  Tagihan sandbox terbit: ${id}\n  Buka link ini untuk simulasi bayar:\n  ${invoice.paymentUrl}\n`,
      );
    });
  },
);
