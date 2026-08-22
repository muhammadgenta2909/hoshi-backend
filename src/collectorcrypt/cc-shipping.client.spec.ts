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

/**
 * LAPISAN TRANSPORT MURNI CC Vault Shipping. Yang diuji di sini: header WAJIB (User-Agent +
 * Authorization Bearer <privy-identity-token>) benar-benar terkirim, pemetaan status HTTP CC →
 * exception kita (401/403→Unauthorized, 404→NotFound, 5xx/timeout→ServiceUnavailable), dan
 * parsing body (JSON sukses vs teks error). Pola fetch-mock mengikuti cc-gacha.client.spec.ts.
 */

const BASE_URL = 'https://dev-api.collectorcrypt.com';
const USER_AGENT = 'hoshi-test-ua';
const PRIVY_TOKEN = 'privy-identity-token-abc';

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
    it('sends User-Agent and Authorization: Bearer <privyToken> on a POST, to the right URL', async () => {
      mockFetchJson({ totalCost: 25 });

      await client.estimate(PRIVY_TOKEN, {
        nftAddresses: ['Nft1'],
        shippingAddress: {
          fullName: 'Budi',
          country: 'ID',
          streetAddress: 'Jl. 1',
          city: 'Jakarta',
          zip: '12345',
        },
        deliveryCompany: 'ups',
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(fetchUrl()).toBe(`${BASE_URL}/redeem/estimate`);
      const init = fetchInit();
      expect(init.method).toBe('POST');
      // Kontrak: token identitas user diteruskan sebagai Bearer, TIDAK pernah dipersist di klien.
      expect(init.headers.Authorization).toBe(`Bearer ${PRIVY_TOKEN}`);
      // Kontrak: User-Agent WAJIB non-kosong (CC menolak sebagian request tanpa UA).
      expect(init.headers['User-Agent']).toBe(USER_AGENT);
      expect(init.headers['content-type']).toBe('application/json');
      // Body POST diserialisasi ke JSON.
      expect(JSON.parse(init.body ?? '{}')).toMatchObject({ nftAddresses: ['Nft1'] });
    });

    it('trims the privyToken into the Bearer header', async () => {
      mockFetchJson({ status: 'Shipped' });

      await client.getShipment(`  ${PRIVY_TOKEN}  `, 'ship-1');

      expect(fetchInit().headers.Authorization).toBe(`Bearer ${PRIVY_TOKEN}`);
    });

    it('GET request carries no body and URL-encodes the shipment id', async () => {
      mockFetchJson({ status: 'Delivered' });

      await client.getShipment(PRIVY_TOKEN, 'ship/with space');

      expect(fetchUrl()).toBe(
        `${BASE_URL}/outbound-shipment/${encodeURIComponent('ship/with space')}`,
      );
      expect(fetchInit().method).toBe('GET');
      expect(fetchInit().body).toBeUndefined();
    });

    it('rejects a missing privyToken with Unauthorized WITHOUT calling fetch', async () => {
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
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps 403 → Unauthorized', async () => {
      mockFetchError(403, JSON.stringify({ message: 'not registered' }));
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('maps 404 → NotFound', async () => {
      mockFetchError(404, JSON.stringify({ message: 'no shipment' }));
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('maps 409 → Conflict', async () => {
      mockFetchError(409, JSON.stringify({ message: 'already prepared' }));
      await expect(
        client.prepare(PRIVY_TOKEN, {
          nftAddresses: ['Nft1'],
          shippingAddressId: 'addr-1',
          coin: 'USDC',
          deliveryCompany: 'ups',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('maps 400 → BadRequest and surfaces the remote message from a NON-JSON body', async () => {
      mockFetchError(400, 'plain text failure detail');
      const err = await client
        .getShipment(PRIVY_TOKEN, 'ship-1')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      // Body error yang bukan JSON tetap dibaca sebagai teks dan disurfacekan (dipotong).
      expect((err as Error).message).toContain('plain text failure detail');
    });

    it('maps 500 → ServiceUnavailable (never leaks their raw 5xx)', async () => {
      mockFetchError(500, JSON.stringify({ error: 'Internal server error' }));
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps 429 (rate limit) → ServiceUnavailable', async () => {
      mockFetchError(429, '');
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('maps a network/timeout rejection → ServiceUnavailable', async () => {
      // fetch reject = network error atau abort timeout; keduanya transien di sisi kita.
      global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });

  describe('body parsing', () => {
    it('parses a JSON success body and returns the typed object', async () => {
      mockFetchJson({ outboundShipmentId: 'ship-9', transactions: ['tx'], totalCost: 12.5 });

      const res = await client.prepare(PRIVY_TOKEN, {
        nftAddresses: ['Nft1'],
        shippingAddressId: 'addr-1',
        coin: 'USDC',
        deliveryCompany: 'ups',
      });

      expect(res.outboundShipmentId).toBe('ship-9');
      expect(res.totalCost).toBe(12.5);
    });

    it('turns a 200 with an EMPTY body into ServiceUnavailable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve(''),
      });
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('turns a 200 with a NON-JSON body into ServiceUnavailable', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve('<html>not json</html>'),
      });
      await expect(
        client.getShipment(PRIVY_TOKEN, 'ship-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
