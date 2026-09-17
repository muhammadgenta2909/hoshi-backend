import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CcShippingClient } from './cc-shipping.client';
import { readCcShippingErrorMeta } from './cc-shipping.types';

/**
 * LAPISAN TRANSPORT MURNI CC Vault Shipping. Yang diuji di sini: header WAJIB (User-Agent +
 * `Authorization: Bearer cca_...`, access token sesi wallet sign-in CC — satu-satunya kredensial
 * yang bisa menuntaskan redemption Solana) benar-benar terkirim, pemetaan status HTTP CC →
 * exception kita (401/403→Unauthorized, 404→NotFound, 5xx/timeout→ServiceUnavailable), dan
 * parsing body: JSON sukses, ARRAY TELANJANG pada burn, serta "200 + body kosong = tidak
 * ditemukan" yang KHUSUS berlaku untuk GET /outbound-shipment/:id.
 * Pola fetch-mock mengikuti cc-gacha.client.spec.ts.
 */

const BASE_URL = 'https://dev-api.collectorcrypt.com';
const USER_AGENT = 'hoshi-test-ua';
const CC_TOKEN = 'cca_access-token-abc';

/** Respons fetch sukses (ok:true) dengan body JSON. */
function mockFetchJson(payload: unknown, status = 200): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status,
    text: () => Promise.resolve(JSON.stringify(payload)),
  });
}

/** Respons fetch gagal (ok:false) dengan body mentah (JSON atau bukan). */
function mockFetchError(status: number, body = ''): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    text: () => Promise.resolve(body),
  });
}

/** Argumen init dari panggilan fetch ke-`i`. */
function fetchInit(i = 0): { headers: Record<string, string>; method: string; body?: string } {
  const call = (global.fetch as jest.Mock).mock.calls[i] as [
    string,
    { headers: Record<string, string>; method: string; body?: string },
  ];
  return call[1];
}

function fetchUrl(i = 0): string {
  const call = (global.fetch as jest.Mock).mock.calls[i] as [string, unknown];
  return call[0];
}

describe('CcShippingClient', () => {
  let client: CcShippingClient;

  beforeEach(async () => {
    const config = {
      get: (k: string) =>
        k === 'COLLECTORCRYPT_SHIPPING_BASE_URL'
          ? BASE_URL
          : k === 'COLLECTORCRYPT_SHIPPING_USER_AGENT'
            ? USER_AGENT
            : undefined,
    };
    const moduleRef = await Test.createTestingModule({
      providers: [CcShippingClient, { provide: ConfigService, useValue: config }],
    }).compile();
    client = moduleRef.get(CcShippingClient);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('headers + request shape', () => {
    it('sends User-Agent and Authorization: Bearer <ccAccessToken> on a POST, to the right URL', async () => {
      mockFetchJson({ total: 25 });

      // Kontrak CC: /redeem/estimate HANYA menerima 4 field — objek alamat ditolak 400.
      await client.estimate(CC_TOKEN, {
        nftAddresses: ['Nft1'],
        shippingAddressId: 'cc-addr-1',
        deliveryCompany: 'ups',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(fetchUrl()).toBe(`${BASE_URL}/redeem/estimate`);
      const init = fetchInit();
      expect(init.method).toBe('POST');
      // Kontrak: token identitas user diteruskan sebagai Bearer, TIDAK pernah dipersist di klien.
      expect(init.headers.Authorization).toBe(`Bearer ${CC_TOKEN}`);
      // Kontrak: User-Agent WAJIB non-kosong (CC menolak sebagian request tanpa UA).
      expect(init.headers['User-Agent']).toBe(USER_AGENT);
      expect(init.headers['content-type']).toBe('application/json');
      // Body POST diserialisasi ke JSON, dengan shippingAddressId (bukan objek alamat).
      expect(JSON.parse(init.body ?? '{}')).toEqual({
        nftAddresses: ['Nft1'],
        shippingAddressId: 'cc-addr-1',
        deliveryCompany: 'ups',
      });
    });

    // KONTRAK BURN: dua array TERPISAH di body — kalau digabung, CC menolak 403 "not the complete
    // set this server issued", dan leg de-list yang hilang membuat burn gagal on-chain.
    it('burn POSTs transactions and delistTransactions as SEPARATE arrays to /blockchain/:id/burn', async () => {
      mockFetchJson([
        { error: null, transactionId: 'TX1', transactionUrl: 'https://x/1' },
      ]);

      const res = await client.burn(CC_TOKEN, 'ship 1', {
        transactions: ['SIGNED_BURN'],
        delistTransactions: ['SIGNED_DELIST'],
      });

      expect(fetchUrl()).toBe(
        `${BASE_URL}/blockchain/${encodeURIComponent('ship 1')}/burn`,
      );
      expect(JSON.parse(fetchInit().body ?? '{}')).toEqual({
        transactions: ['SIGNED_BURN'],
        delistTransactions: ['SIGNED_DELIST'],
      });
      // Respons burn = ARRAY TELANJANG, diteruskan apa adanya (klien tidak menilai isinya).
      expect(Array.isArray(res)).toBe(true);
      expect(res[0].error).toBeNull();
      expect(res[0].transactionId).toBe('TX1');
    });

    it('burn parses a bare array with FAILURES FIRST without throwing (200 is not success)', async () => {
      mockFetchJson([
        { error: 'blockhash expired', transactionId: null },
        { error: null, transactionId: 'TX2' },
      ]);

      const res = await client.burn(CC_TOKEN, 'ship-1', {
        transactions: ['A', 'B'],
        delistTransactions: [],
      });

      expect(res).toHaveLength(2);
      expect(res[0].error).toBe('blockhash expired');
    });

    it('trims the ccAccessToken into the Bearer header', async () => {
      mockFetchJson({ status: 'Shipped' });

      await client.getShipment(`  ${CC_TOKEN}  `, 'ship-1');

      expect(fetchInit().headers.Authorization).toBe(`Bearer ${CC_TOKEN}`);
    });

    it('GET request carries no body and URL-encodes the shipment id', async () => {
      mockFetchJson({ status: 'Delivered' });

      await client.getShipment(CC_TOKEN, 'ship/with space');

      expect(fetchUrl()).toBe(
        `${BASE_URL}/outbound-shipment/${encodeURIComponent('ship/with space')}`,
      );
      expect(fetchInit().method).toBe('GET');
      expect(fetchInit().body).toBeUndefined();
    });

    it('rejects a missing ccAccessToken with Unauthorized WITHOUT calling fetch', async () => {
      global.fetch = jest.fn();

      await expect(
        client.getShipment('   ', 'ship-1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  // SIWS (Track B) memakai jalur PRA-AUTH: nonce/verify/refresh MENGHASILKAN token, jadi TIDAK
  // mengirim Authorization — tapi tetap mengirim User-Agent + content-type (kontrak "selalu UA").
  describe('SIWS (no-auth path)', () => {
    it('siwsNonce POSTs to /auth/wallet/nonce with User-Agent + content-type and NO Authorization', async () => {
      mockFetchJson({ nonce: 'N', expiresAt: 1, message: 'MSG' });

      const res = await client.siwsNonce({
        wallet: 'Wallet1',
        partnerAppId: 'app-1',
        domain: 'hoshimarket.xyz',
        uri: 'https://hoshimarket.xyz',
      });

      expect(fetchUrl()).toBe(`${BASE_URL}/auth/wallet/nonce`);
      const init = fetchInit();
      expect(init.method).toBe('POST');
      expect(init.headers['User-Agent']).toBe(USER_AGENT);
      expect(init.headers['content-type']).toBe('application/json');
      // KONTRAK INTI Track B: tidak ada bearer pada handshake pra-auth.
      expect(init.headers.Authorization).toBeUndefined();
      expect(JSON.parse(init.body ?? '{}')).toMatchObject({
        wallet: 'Wallet1',
        partnerAppId: 'app-1',
      });
      expect(res.message).toBe('MSG');
    });

    it('siwsVerify / siwsRefresh also send no Authorization header', async () => {
      mockFetchJson({ accessToken: 'cca_x', refreshToken: 'ccr_x', expiresAt: 2 });
      await client.siwsVerify({ message: 'MSG', signature: 'SIG' });
      expect(fetchUrl()).toBe(`${BASE_URL}/auth/wallet/verify`);
      expect(fetchInit().headers.Authorization).toBeUndefined();

      mockFetchJson({ accessToken: 'cca_y', refreshToken: 'ccr_y', expiresAt: 3 });
      await client.siwsRefresh({ refreshToken: 'ccr_x' });
      expect(fetchUrl()).toBe(`${BASE_URL}/auth/wallet/refresh`);
      expect(fetchInit().headers.Authorization).toBeUndefined();
    });

    it('maps a CC error on the no-auth path the same way (400 → BadRequest, surfacing the message)', async () => {
      mockFetchError(400, JSON.stringify({ message: 'bad nonce request' }));

      const err = await client
        .siwsNonce({
          wallet: 'Wallet1',
          partnerAppId: 'app-1',
          domain: 'hoshimarket.xyz',
          uri: 'https://hoshimarket.xyz',
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toContain('bad nonce request');
    });
  });

  describe('status mapping', () => {
    it('maps 401 → Unauthorized', async () => {
      mockFetchError(401, JSON.stringify({ message: 'bad token' }));
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps 403 → Unauthorized', async () => {
      mockFetchError(403, JSON.stringify({ message: 'not registered' }));
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps 404 → NotFound', async () => {
      mockFetchError(404, JSON.stringify({ message: 'no shipment' }));
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps 409 → Conflict', async () => {
      mockFetchError(409, JSON.stringify({ message: 'already prepared' }));
      await expect(
        client.prepare(CC_TOKEN, {
          nftAddresses: ['Nft1'],
          shippingAddressId: 'addr-1',
          coin: 'USDC',
          deliveryCompany: 'ups',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    /* SINYAL TERSTRUKTUR — fakta mentah body error dilampirkan ke exception supaya keputusan
       uang di service tidak perlu menebak dari prosa yang sudah lossy (lihat
       documentedNothingBurned di cc-shipping.service.ts). */

    it('attaches structured error meta: a Nest-shaped 409 keeps the delistErrors key even though the message drops it', async () => {
      mockFetchError(
        409,
        JSON.stringify({
          statusCode: 409,
          message: 'De-list failed',
          error: 'Conflict',
          delistErrors: [{ nftAddress: 'Nft1', error: 'listing not found' }],
        }),
      );
      const err = await client
        .burn(CC_TOKEN, 'ship-1', {
          transactions: ['TX'],
          delistTransactions: [],
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictException);
      // Prosa KEHILANGAN nama kuncinya — itulah alasan meta ini ada.
      expect((err as Error).message).toContain('De-list failed');
      expect((err as Error).message).not.toContain('delistErrors');

      const meta = readCcShippingErrorMeta(err);
      expect(meta).not.toBeNull();
      expect(meta?.status).toBe(409);
      expect(meta?.jsonBody).toBe(true);
      expect(meta?.delistErrorsPresent).toBe(true);
      expect(meta?.delistErrors).toEqual([
        { nftAddress: 'Nft1', error: 'listing not found' },
      ]);
    });

    it('structured meta keeps delistErrors even when it sits past the 300-char message truncation', async () => {
      // Tanpa message/error/details → prosa = teks mentah DIPOTONG 300 char.
      const body = JSON.stringify({
        statusCode: 409,
        reason: 'x'.repeat(400),
        delistErrors: ['boom'],
      });
      mockFetchError(409, body);
      const err = await client
        .burn(CC_TOKEN, 'ship-1', {
          transactions: ['TX'],
          delistTransactions: [],
        })
        .catch((e: unknown) => e);

      expect((err as Error).message).not.toContain('delistErrors');
      expect(readCcShippingErrorMeta(err)?.delistErrorsPresent).toBe(true);
      expect(readCcShippingErrorMeta(err)?.delistErrors).toEqual(['boom']);
    });

    it('structured meta is FAIL-CLOSED for a non-JSON body, an array body, and a missing key', async () => {
      // (i) bukan JSON — walau prosanya menyebut kata itu.
      mockFetchError(409, 'Conflict: delistErrors encountered');
      let err = await client
        .burn(CC_TOKEN, 'ship-1', {
          transactions: ['TX'],
          delistTransactions: [],
        })
        .catch((e: unknown) => e);
      expect(readCcShippingErrorMeta(err)?.jsonBody).toBe(false);
      expect(readCcShippingErrorMeta(err)?.delistErrorsPresent).toBe(false);

      // (ii) JSON tapi ARRAY, bukan objek.
      mockFetchError(409, JSON.stringify([{ delistErrors: ['boom'] }]));
      err = await client
        .burn(CC_TOKEN, 'ship-1', {
          transactions: ['TX'],
          delistTransactions: [],
        })
        .catch((e: unknown) => e);
      expect(readCcShippingErrorMeta(err)?.jsonBody).toBe(false);
      expect(readCcShippingErrorMeta(err)?.delistErrorsPresent).toBe(false);

      // (iii) objek JSON tanpa kunci itu.
      mockFetchError(
        409,
        JSON.stringify({
          statusCode: 409,
          message: 'awaiting card payment confirmation',
        }),
      );
      err = await client
        .burn(CC_TOKEN, 'ship-1', {
          transactions: ['TX'],
          delistTransactions: [],
        })
        .catch((e: unknown) => e);
      expect(readCcShippingErrorMeta(err)?.jsonBody).toBe(true);
      expect(readCcShippingErrorMeta(err)?.delistErrorsPresent).toBe(false);
      expect(readCcShippingErrorMeta(err)?.delistErrors).toBeUndefined();
    });

    it('maps 400 → BadRequest and surfaces the remote message from a NON-JSON body', async () => {
      mockFetchError(400, 'plain text failure detail');
      const err = await client
        .getShipment(CC_TOKEN, 'ship-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      // Body error yang bukan JSON tetap dibaca sebagai teks dan disurfacekan (dipotong).
      expect((err as Error).message).toContain('plain text failure detail');
    });

    it('maps 500 → ServiceUnavailable (never leaks their raw 5xx)', async () => {
      mockFetchError(500, JSON.stringify({ error: 'Internal server error' }));
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps 429 (rate limit) → ServiceUnavailable', async () => {
      mockFetchError(429, '');
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps a network/timeout rejection → ServiceUnavailable', async () => {
      // fetch reject = network error atau abort timeout; keduanya transien di sisi kita.
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('body parsing', () => {
    it('parses a JSON success body and returns the typed object', async () => {
      mockFetchJson({ outboundShipmentId: 'ship-9', transactions: ['tx'], totalCost: 12.5 });

      const res = await client.prepare(CC_TOKEN, {
        nftAddresses: ['Nft1'],
        shippingAddressId: 'addr-1',
        coin: 'USDC',
        deliveryCompany: 'ups',
      });

      expect(res.outboundShipmentId).toBe('ship-9');
      expect(res.totalCost).toBe(12.5);
    });

    // Kontrak CC: GET /outbound-shipment/:id TIDAK pernah 404 — id tak dikenal dijawab 200 dengan
    // body kosong. Itu "tidak ditemukan" (null), BUKAN CC rusak.
    it('turns a 200 with an EMPTY body into null on GET /outbound-shipment/:id', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await expect(
        client.getShipment(CC_TOKEN, 'ship-unknown'),
      ).resolves.toBeNull();
    });

    it('treats a whitespace-only 200 body on that route as not-found too', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('   \n '),
      });

      await expect(
        client.getShipment(CC_TOKEN, 'ship-unknown'),
      ).resolves.toBeNull();
    });

    // Pemetaan "kosong = null" HANYA untuk rute shipment. Rute lain tetap menganggap body kosong
    // sebagai kegagalan — prepare/burn tanpa body bukan "tidak ada", tapi CC yang tidak beres.
    it('still turns a 200 with an EMPTY body into ServiceUnavailable on OTHER routes', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });

      await expect(
        client.prepare(CC_TOKEN, {
          nftAddresses: ['Nft1'],
          shippingAddressId: 'addr-1',
          coin: 'USDC',
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        client.burn(CC_TOKEN, 'ship-1', {
          transactions: ['A'],
          delistTransactions: [],
        }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('turns a 200 with a NON-JSON body into ServiceUnavailable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html>not json</html>'),
      });
      await expect(
        client.getShipment(CC_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
