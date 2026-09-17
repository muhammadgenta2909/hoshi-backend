import { All, Controller, Logger, NotFoundException, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { detectProductionSignal } from '../common/demo-mode';
import { ApiError, handleMockRequest } from './cc-shipping-mock.core';
import { CC_SHIPPING_MOCK_MOUNT } from './cc-shipping-mock.mount';

export { CC_SHIPPING_MOCK_MOUNT };

/**
 * Mock CollectorCrypt Vault Shipping API DI DALAM backend (staging/devnet).
 *
 * KENAPA ADA DI SINI DAN BUKAN SEBAGAI PROSES TERPISAH. Mock-nya dulu hanya hidup sebagai
 * `node mock-cc-shipping/standalone.ts` di localhost:4010 — dan sebuah service Render TIDAK BISA
 * menjangkau localhost mesin siapa pun. Supaya product owner bisa menelusuri seluruh alur kirim
 * kartu fisik LEWAT BROWSER di staging, tanpa kredensial CC dan tanpa uang asli, backend harus
 * bisa menunjuk COLLECTORCRYPT_SHIPPING_BASE_URL ke dirinya sendiri.
 *
 * TIDAK PERNAH AKTIF DI PRODUKSI. Persis pola IdrxMockController: SETIAP endpoint memanggil
 * assertMockActive() yang melempar 404 kecuali CC_SHIPPING_MOCK=1 DAN detectProductionSignal()
 * === null (devnet). Jadi walau flag-nya kepencet di mainnet, seluruh permukaan ini tetap 404 —
 * gerbangnya diperiksa DI DALAM handler, bukan sekadar rute yang tidak didaftarkan. Lapis ketiga:
 * assertMainnetConsistency (src/config/env.validation.ts) MENOLAK BOOT kalau SOLANA_CLUSTER=
 * mainnet-beta sementara flag ini menyala, jadi kesalahan itu ketahuan saat deploy, bukan nanti.
 *
 * Kontraknya sendiri TIDAK ada di file ini — ia ada satu-satunya di cc-shipping-mock.core.ts, yang
 * juga dipakai server standalone. Tidak ada salinan kedua yang bisa menyimpang.
 *
 * @SkipThrottle: gerbang throttle global 60 req/menit/IP. Mock ini dipanggil SERVER-SIDE oleh
 * backend yang sama (satu IP) dan oleh smoke test yang menembak ~90 request beruntun; tanpa ini
 * dry-run-nya akan gagal karena 429 yang tidak ada hubungannya dengan kontrak CC. Rute ini tidak
 * menyentuh uang, database, maupun treasury — dan mati total di produksi.
 */
@SkipThrottle()
@Controller(CC_SHIPPING_MOCK_MOUNT)
export class CcShippingMockController {
  private readonly logger = new Logger(CcShippingMockController.name);

  constructor(private readonly config: ConfigService) {}

  private assertMockActive(): void {
    const enabled = this.config.get<string>('CC_SHIPPING_MOCK') === '1';
    if (!enabled || detectProductionSignal() !== null) {
      throw new NotFoundException();
    }
  }

  /**
   * Satu handler untuk semua kedalaman path. Pola `:p1/:p2/...` DISENGAJA menggantikan wildcard:
   * Express 5 (yang dipakai Nest 11) tidak lagi menerima `'*'` telanjang, dan path CC terdalam
   * cuma 4 segmen (`/__mock/inbound/:id/receive`). Path sebenarnya dibaca dari URL, bukan dari
   * params, supaya prefix mount boleh berubah tanpa menyentuh apa pun di sini.
   */
  @All()
  root(@Req() req: Request, @Res() res: Response): void {
    this.dispatch(req, res);
  }

  @All(':p1')
  depth1(@Req() req: Request, @Res() res: Response): void {
    this.dispatch(req, res);
  }

  @All(':p1/:p2')
  depth2(@Req() req: Request, @Res() res: Response): void {
    this.dispatch(req, res);
  }

  @All(':p1/:p2/:p3')
  depth3(@Req() req: Request, @Res() res: Response): void {
    this.dispatch(req, res);
  }

  @All(':p1/:p2/:p3/:p4')
  depth4(@Req() req: Request, @Res() res: Response): void {
    this.dispatch(req, res);
  }

  private dispatch(req: Request, res: Response): void {
    this.assertMockActive();

    const url = req.originalUrl || req.url || '';
    const queryStart = url.indexOf('?');
    const rawPath = queryStart >= 0 ? url.slice(0, queryStart) : url;
    const rawQuery = queryStart >= 0 ? url.slice(queryStart + 1) : '';
    const mount = `/${CC_SHIPPING_MOCK_MOUNT}`;
    const at = rawPath.indexOf(mount);
    // Path yang diberikan ke core SELALU tanpa prefix mount (dan tanpa prefix global /api).
    const path = at >= 0 ? rawPath.slice(at + mount.length) : rawPath;

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    }

    const body =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};

    try {
      const out = handleMockRequest({
        method: req.method,
        path: path || '/',
        query: new URLSearchParams(rawQuery),
        headers,
        body,
      });
      send(res, out.status, out.body, out.headers);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, err.body, err.headers);
        return;
      }
      this.logger.error(
        `CC SHIPPING MOCK: kegagalan tak terduga di ${req.method} ${path} — ` +
          (err instanceof Error ? err.message : 'unknown'),
      );
      send(res, 500, { statusCode: 500, message: 'Internal server error' });
    }
  }
}

/**
 * Ditulis dengan writeHead/end, BUKAN res.json: kontrak CC punya dua respons yang express akan
 * rusakkan kalau dibiarkan — `GET /outbound-shipment/<id tak dikenal>` harus 200 dengan body
 * BENAR-BENAR KOSONG (bukan "null"), dan access token di luar rute shipping harus 403 tanpa body.
 */
function send(
  res: Response,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const head: Record<string, string> = { ...(headers || {}) };
  if (body === null || body === undefined) {
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
