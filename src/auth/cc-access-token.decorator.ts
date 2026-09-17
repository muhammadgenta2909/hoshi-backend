import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';

/** Header kanonik: token sesi wallet sign-in CollectorCrypt (prefix `cca_`). */
export const CC_ACCESS_TOKEN_HEADER = 'x-cc-access-token';

/**
 * Header LAMA dengan nama yang salah kaprah (integrasi awal dibangun dari ringkasan yang keliru
 * seolah ada jalur "Privy identity token"). Tetap diterima supaya klien lama tidak patah; isinya
 * HARUS tetap token `cca_` — nama header tidak mengubah apa yang CC terima.
 */
export const CC_ACCESS_TOKEN_LEGACY_HEADER = 'x-privy-identity-token';

/**
 * Ambil ACCESS TOKEN SESI CollectorCrypt dari header `x-cc-access-token`
 * (fallback lama: `x-privy-identity-token`).
 *
 * Dokumen CC ("Shipping API") hanya mengenal DUA kredensial: access token hasil wallet sign-in
 * (`Authorization: Bearer cca_...`) dan API key (`Bearer ccsk_...` + `X-CC-Customer`). TIDAK ADA
 * jalur token identitas Privy. Untuk redemption SOLANA, API key pun ditolak untuk leg burn-nya
 * ("Solana redemptions still need a wallet sign-in session") — jadi nilai header ini SELALU token
 * `cca_` hasil /redemptions/siws/verify (atau /siws/refresh).
 *
 * Token ini milik USER, dikirim frontend per-request, diteruskan apa adanya sebagai
 * `Authorization: Bearer` ke CC, dan TIDAK PERNAH dipersist di backend. 400 bila kosong: tanpa
 * token tidak ada gunanya memanggil CC (pasti 401). Umurnya 15 menit — kalau habis, frontend
 * refresh dulu lewat /redemptions/siws/refresh.
 */
export const CcAccessToken = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ headers: Record<string, unknown> }>();
    const raw: unknown =
      request.headers[CC_ACCESS_TOKEN_HEADER] ??
      request.headers[CC_ACCESS_TOKEN_LEGACY_HEADER];
    // Node bisa memberi string[] untuk header yang dikirim berulang — ambil yang pertama.
    const token: unknown = Array.isArray(raw) ? (raw[0] as unknown) : raw;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new BadRequestException(
        `Header ${CC_ACCESS_TOKEN_HEADER} wajib diisi (access token sesi CollectorCrypt, prefix cca_, ` +
          'dari /redemptions/siws/verify).',
      );
    }
    return token.trim();
  },
);
