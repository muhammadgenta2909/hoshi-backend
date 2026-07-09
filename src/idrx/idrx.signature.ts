/**
 * IDRX API request signing — prepared seam (NOT yet wired into any controller).
 *
 * Per https://docs.idrx.co/api/generating-a-signature: each request is signed
 * with HMAC-SHA256 over the concatenation `timestamp + method + url + body`,
 * using the base64-decoded secret key; the digest is base64url-encoded and sent
 * alongside the api key + timestamp in headers.
 *
 * Live use requires a business account + KYC + issued API key/secret (see the
 * onboarding API). Those, plus the exact API base URL, come from IDRX onboarding
 * — keep them in env (IDRX_API_KEY / IDRX_API_SECRET / IDRX_API_BASE), never in
 * source, and only ever call this from the backend.
 */
import * as crypto from 'crypto';

export function createIdrxSignature(
  method: string,
  url: string,
  body: unknown,
  timestamp: string,
  secretKeyBase64: string,
): string {
  const secret = Buffer.from(secretKeyBase64, 'base64').toString('binary');
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(timestamp);
  hmac.update(method);
  hmac.update(url);
  if (body != null) hmac.update(Buffer.from(JSON.stringify(body)));
  return hmac.digest('base64url');
}

export type IdrxSignedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
};

/**
 * Build a ready-to-send signed request. `timestamp` is passed in (ms epoch as a
 * string) rather than read from the clock here, so callers control it and it
 * stays testable.
 */
export function buildIdrxRequest(params: {
  apiBase: string;
  path: string; // e.g. '/api/transaction/rates'
  method: string; // 'GET' | 'POST'
  apiKey: string;
  secretKeyBase64: string;
  timestamp: string;
  body?: unknown;
}): IdrxSignedRequest {
  const { apiBase, path, method, apiKey, secretKeyBase64, timestamp, body } =
    params;
  const sig = createIdrxSignature(
    method,
    path,
    body,
    timestamp,
    secretKeyBase64,
  );
  return {
    url: `${apiBase}${path}`,
    method,
    headers: {
      'Content-Type': 'application/json',
      'idrx-api-key': apiKey,
      'idrx-api-sig': sig,
      'idrx-api-ts': timestamp,
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  };
}
