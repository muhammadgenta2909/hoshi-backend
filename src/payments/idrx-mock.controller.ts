import {
  Controller,
  Get,
  Logger,
  NotFoundException,
  Query,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { detectProductionSignal } from '../common/demo-mode';
import { IdrxMockStore } from './idrx-mock.store';
import { PaymentsService } from './payments.service';

/**
 * Halaman bayar PALSU untuk IDRX MOCK (staging/devnet). Meniru pengalaman redirect ke
 * halaman hosted asli (Duitku): user KELUAR dari web → "bayar" → di-redirect balik ke
 * returnUrl (frontend /open-packs), di mana resume mengambil alih dan memutar animasi.
 *
 * TIDAK PERNAH aktif di produksi. Setiap endpoint memanggil assertMockActive() yang
 * melempar 404 kecuali IDRX_MOCK=1 DAN detectProductionSignal() === null (devnet). Jadi
 * walau flag-nya kepencet di mainnet, halaman ini tetap tak terlihat.
 */
@Controller('idrx-mock')
export class IdrxMockController {
  private readonly logger = new Logger(IdrxMockController.name);

  constructor(
    private readonly store: IdrxMockStore,
    private readonly config: ConfigService,
    private readonly payments: PaymentsService,
  ) {}

  private assertMockActive(): void {
    const enabled = this.config.get<string>('IDRX_MOCK') === '1';
    if (!enabled || detectProductionSignal() !== null) {
      throw new NotFoundException();
    }
  }

  /** Halaman "bayar" — dituju oleh paymentUrl yang dikembalikan mock mint-request. */
  @Get('pay')
  payPage(@Query('order') order: string, @Res() res: Response): void {
    this.assertMockActive();
    const rec = order ? this.store.get(order) : undefined;
    if (!rec) {
      res.status(404).type('html').send(missingHtml(order));
      return;
    }
    res.type('html').send(payPageHtml(order, rec.toBeMinted));
  }

  /** Tombol "Bayar" mengarah ke sini → tandai lunas → fulfil segera → redirect balik. */
  @Get('pay/complete')
  async complete(
    @Query('order') order: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertMockActive();
    const rec = order ? this.store.get(order) : undefined;
    if (!rec) {
      res.status(404).type('html').send(missingHtml(order));
      return;
    }
    this.store.markPaid(order);
    // Mock tak punya webhook IDRX, dan reconciler menyapu tiap ~2 menit. Panggil jalur
    // fulfilment yang SAMA dengan callback asli SEKARANG supaya order sudah FULFILLED saat
    // user tiba kembali di /open-packs → animasi langsung main, bukan spinner 2 menit.
    // handleCallback tidak pernah throw; try/catch cuma pengaman ekstra (reconciler backup).
    try {
      await this.payments.handleCallback({ merchantOrderId: order });
    } catch (err) {
      this.logger.warn(
        `IDRX MOCK: fulfil segera gagal untuk ${order} (${
          err instanceof Error ? err.message : 'unknown'
        }) — reconciler akan menyusul.`,
      );
    }
    this.logger.warn(
      `IDRX MOCK: order ${order} → PAID+MINTED + fulfilled (simulasi). Redirect ke ${rec.returnUrl}`,
    );
    res.redirect(302, rec.returnUrl);
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&'
      ? '&amp;'
      : c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '"'
            ? '&quot;'
            : '&#39;',
  );
}

function rupiah(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `Rp ${n.toLocaleString('id-ID')}` : `Rp ${esc(v)}`;
}

function shell(body: string): string {
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Pembayaran (Demo) — Hoshi</title>
<style>
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  background:linear-gradient(160deg,#1e1b4b,#0f172a);color:#e2e8f0;padding:20px}
.card{width:100%;max-width:380px;background:#fff;color:#0f172a;border-radius:16px;
  box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden}
.banner{background:#f59e0b;color:#111;font-weight:700;font-size:12px;letter-spacing:.08em;
  text-align:center;padding:6px}
.body{padding:24px}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#64748b;font-size:13px;margin:0 0 20px}
.row{display:flex;justify-content:space-between;font-size:13px;padding:8px 0;border-top:1px solid #f1f5f9}
.row b{font-weight:600}
.amt{font-size:26px;font-weight:800;margin:12px 0 20px;color:#0f172a}
.btn{display:block;width:100%;text-align:center;text-decoration:none;
  background:#16a34a;color:#fff;font-weight:700;padding:14px;border-radius:12px;font-size:15px}
.btn:active{background:#15803d}
.hint{font-size:12px;color:#94a3b8;text-align:center;margin-top:14px;line-height:1.5}
.qr{width:120px;height:120px;margin:0 auto 8px;border-radius:8px;
  background:repeating-conic-gradient(#0f172a 0 25%,#fff 0 50%) 50%/16px 16px}
.center{text-align:center}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function payPageHtml(order: string, toBeMinted: string): string {
  const o = esc(order);
  return shell(`
<div class="banner">MODE DEMO · SANDBOX · TANPA UANG ASLI</div>
<div class="body">
  <h1>DUITKU QRIS <span style="color:#16a34a">(Demo)</span></h1>
  <p class="sub">Scan / bayar untuk menyelesaikan pesanan Hoshi</p>
  <div class="center"><div class="qr"></div></div>
  <div class="amt center">${rupiah(toBeMinted)}</div>
  <div class="row"><span>Merchant Order ID</span><b>${o}</b></div>
  <div class="row"><span>Metode</span><b>DUITKU QRIS (demo)</b></div>
  <a class="btn" href="/api/idrx-mock/pay/complete?order=${encodeURIComponent(order)}">💳 Bayar (Simulasi Sukses)</a>
  <p class="hint">Ini halaman palsu untuk testing. Pencet tombol di atas untuk
  mensimulasikan pembayaran berhasil — kamu akan diarahkan kembali ke Hoshi dan
  animasi pack akan diputar. Tidak ada rupiah atau USDC asli yang bergerak.</p>
</div>`);
}

function missingHtml(order: string): string {
  return shell(`
<div class="banner">MODE DEMO · SANDBOX</div>
<div class="body">
  <h1>Transaksi tidak ditemukan</h1>
  <p class="sub">Order <b>${esc(order || '(kosong)')}</b> tidak dikenal mock.
  Kemungkinan server sempat restart. Kembali ke Hoshi dan buat pesanan lagi.</p>
</div>`);
}
