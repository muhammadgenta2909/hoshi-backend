/**
 * Mock CollectorCrypt Vault Shipping API — LAUNCHER STANDALONE.
 *
 * File ini TIDAK memuat satu pun aturan kontrak. Kontraknya hidup satu-satunya di
 * `src/collectorcrypt/cc-shipping-mock.core.ts`, yang juga dilayani backend lewat
 * `src/collectorcrypt/cc-shipping-mock.controller.ts` (rute /api/cc-shipping-mock, digerbangi
 * CC_SHIPPING_MOCK=1 + bukan produksi). Yang ada di sini cuma adaptor `node:http` → core, supaya
 * dry-run lokal tidak perlu menyalakan seluruh backend.
 *
 * Konsekuensi yang disengaja: tidak ada dua salinan kontrak yang bisa menyimpang, dan
 * `npm run mock:cc-shipping:smoke` (56 assertion) menguji core yang SAMA di mana pun ia dilayani.
 *
 * Jalankan:  npm run mock:cc-shipping          (= ts-node mock-cc-shipping/standalone.ts)
 */
import http from 'node:http';
import {
  ApiError,
  handleMockRequest,
  mockConfig,
  resetMockConfigCache,
} from '../src/collectorcrypt/cc-shipping-mock.core';

const PORT = Number(process.env.PORT || 4010);
const VERBOSE = !/^(0|false|no)$/i.test(
  process.env.CC_SHIPPING_MOCK_LOG || process.env.MOCK_LOG || 'true',
);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Proses ini memang membaca env-nya sendiri saat start; buang cache supaya urutan import tak penting.
resetMockConfigCache();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, { statusCode: 413, message: 'Payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendResponse(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): void {
  const head: Record<string, string> = { ...(headers || {}) };
  if (body === null || body === undefined) {
    // doc: shipment id tak dikenal "returns 200 with an empty body" — body BENAR-BENAR kosong.
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

const server = http.createServer((req, res) => {
  const started = Date.now();
  void (async () => {
    let url: URL;
    try {
      url = new URL(req.url || '/', `http://localhost:${PORT}`);
    } catch {
      sendResponse(res, 400, { statusCode: 400, message: 'Invalid request.' });
      return;
    }
    const pathname = url.pathname;

    try {
      const raw = ['POST', 'PATCH', 'PUT'].includes(req.method || '')
        ? await readBody(req)
        : '';
      let body: Record<string, unknown> = {};
      if (raw.trim().length) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new ApiError(400, { statusCode: 400, message: 'Invalid request.' });
        }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new ApiError(400, { statusCode: 400, message: 'Invalid request.' });
        }
        body = parsed as Record<string, unknown>;
      }

      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
      }

      const out = handleMockRequest({
        method: req.method || 'GET',
        path: pathname,
        query: url.searchParams,
        headers,
        body,
      });
      if (VERBOSE) {
        console.log(`  ${req.method} ${pathname} -> ${out.status} (${Date.now() - started}ms)`);
      }
      sendResponse(res, out.status, out.body, out.headers);
    } catch (err) {
      if (err instanceof ApiError) {
        if (VERBOSE) {
          const b = err.body as { message?: unknown } | null;
          const detail = b ? JSON.stringify(b.message ?? b) : '<empty body>';
          console.log(`  ${req.method} ${pathname} -> ${err.status} ${detail}`);
        }
        sendResponse(res, err.status, err.body, err.headers);
        return;
      }
      console.error('  ! unexpected mock failure:', err);
      sendResponse(res, 500, { statusCode: 500, message: 'Internal server error' });
    }
  })();
});

server.listen(PORT, () => {
  const cfg = mockConfig();
  console.log('');
  console.log('  mock CollectorCrypt Vault Shipping API (standalone)');
  console.log('  ──────────────────────────────────────────────────');
  console.log(`  listening          http://localhost:${PORT}`);
  console.log(`  contract           src/collectorcrypt/cc-shipping-mock.core.ts (shared)`);
  console.log(`  partnerAppId       ${cfg.partnerAppId}`);
  console.log(`  allowed domains    ${cfg.allowedDomains.join(', ')}`);
  console.log(`  api key            ${cfg.apiKey}`);
  console.log(`  api key scopes     ${[...cfg.apiKeyScopes].join(', ')}`);
  console.log(`  transactions       REAL Solana (memo-only, synthetic blockhash — cannot land)`);
  console.log(`  accept any NFT     ${cfg.acceptAnyNft}`);
  console.log('');
});
