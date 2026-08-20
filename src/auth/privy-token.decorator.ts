import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';

/**
 * Ambil token IDENTITAS Privy user dari header `x-privy-identity-token`.
 *
 * Token ini milik USER (dikirim frontend per-request) dan dipakai sebagai `Authorization: Bearer`
 * ke CC Vault Shipping API — ia MEMBUKTIKAN ke CC bahwa user inilah pemilik kartu di vault. TIDAK
 * PERNAH dipersist di backend. 400 bila kosong: tanpa token tidak ada gunanya memanggil CC (pasti 401).
 */
export const PrivyToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const raw = request.headers['x-privy-identity-token'];
    const token = Array.isArray(raw) ? raw[0] : raw;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new BadRequestException(
        'Header x-privy-identity-token wajib diisi (token identitas Privy user).',
      );
    }
    return token.trim();
  },
);
