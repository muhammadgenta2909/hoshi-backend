import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { shippingErrorBody } from '../collectorcrypt/cc-shipping.errors';
import { ShippingExceptionFilter } from './shipping-exception.filter';

/**
 * B1 (2) — JARING PENGAMAN: tidak ada kegagalan di jalur kirim fisik yang boleh keluar tanpa
 * `code` yang bisa dibaca mesin, dan filter ini TIDAK PERNAH menaikkan sesuatu jadi retryable.
 */
describe('ShippingExceptionFilter', () => {
  const run = (exception: unknown) => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    new ShippingExceptionFilter().catch(exception, host);

    const statusCalls = status.mock.calls as unknown as Array<[number]>;
    const jsonCalls = json.mock.calls as unknown as Array<
      [Record<string, unknown>]
    >;
    return { status: statusCalls[0][0], body: jsonCalls[0][0] };
  };

  it('passes a contract body through UNCHANGED (never rewrites a throw-site’s classification)', () => {
    const body = shippingErrorBody({
      status: HttpStatus.UNPROCESSABLE_ENTITY,
      code: 'SHIPPING_POST_FUND_INDETERMINATE',
      message: 'money moved, outcome unknown',
      stage: 'POST_FUND',
      redemptionId: 'red-1',
    });

    const res = run(new HttpException(body, HttpStatus.UNPROCESSABLE_ENTITY));

    expect(res.status).toBe(422);
    expect(res.body).toEqual(body);
    expect(res.body.retryable).toBe(false);
  });

  it('stamps an UNCLASSIFIED code on a plain Nest exception, keeping its status and message shape', () => {
    // Bentuk khas kegagalan validasi class-validator: message berupa ARRAY.
    const res = run(
      new BadRequestException(['signedTransactions should not be empty']),
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toEqual([
      'signedTransactions should not be empty',
    ]);
    expect(res.body.code).toBe('SHIPPING_UNCLASSIFIED_ERROR');
    expect(res.body.stage).toBe('UNKNOWN');
    // Tidak pernah mengaku aman untuk sesuatu yang tidak ia klasifikasikan.
    expect(res.body.retryable).toBe(false);
  });

  it('handles an HttpException whose response is a bare string', () => {
    const res = run(new HttpException('plain text failure', 409));

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('plain text failure');
    expect(res.body.code).toBe('SHIPPING_UNCLASSIFIED_ERROR');
    expect(res.body.retryable).toBe(false);
  });

  it('turns a BARE Error into a 500 that still carries a code — and never claims the card is safe', () => {
    const res = run(new Error('boom'));

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('SHIPPING_UNEXPECTED_ERROR');
    expect(res.body.stage).toBe('UNKNOWN');
    expect(res.body.retryable).toBe(false);
    // Detail internal tidak bocor; pesannya justru melarang tanda tangan ulang.
    expect(String(res.body.message)).not.toContain('boom');
    expect(String(res.body.message)).toContain('JANGAN');
  });

  it('still delegates Prisma errors to the Prisma mapping (a controller filter replaces the global one)', () => {
    const res = run(
      new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'x',
        meta: { target: ['nftAddress'] },
      }),
    );

    expect(res.status).toBe(409);
    expect(String(res.body.message)).toContain('already exists');
  });

  it('a ConflictException carrying our contract keeps stage FUNDED (retryable) untouched', () => {
    const body = shippingErrorBody({
      status: HttpStatus.CONFLICT,
      code: 'SHIPPING_BURN_STALE_SESSION',
      message: 'sesi lain lebih baru',
      stage: 'FUNDED',
      redemptionId: 'red-1',
    });

    const res = run(new ConflictException(body));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SHIPPING_BURN_STALE_SESSION');
    expect(res.body.retryable).toBe(true);
  });
});
