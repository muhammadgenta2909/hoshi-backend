import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import {
  SHIPPING_ERROR_CODE,
  SHIPPING_STAGE,
  isShippingErrorBody,
  shippingErrorBody,
} from '../collectorcrypt/cc-shipping.errors';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * JARING PENGAMAN kontrak error jalur kirim fisik. Dipasang di RedemptionController (bukan global)
 * supaya bentuk error endpoint lain tidak ikut berubah.
 *
 * Tugasnya cuma satu: MEMASTIKAN TIDAK ADA kegagalan di jalur ini yang keluar tanpa `code` yang
 * bisa dibaca mesin — termasuk yang lolos dari throw-site mana pun (validasi DTO, throttler,
 * error Prisma, atau bug yang melempar Error telanjang jadi 500 "Internal server error").
 *
 * YANG TIDAK DILAKUKAN FILTER INI: menilai keamanan uang. Ia tidak pernah menaikkan sesuatu jadi
 * `retryable`. Error yang belum punya kode sendiri dicap `UNCLASSIFIED`/`UNEXPECTED` dengan
 * stage `UNKNOWN` dan `retryable:false` — klasifikasi yang JUJUR dan fail-closed. Penentuan
 * PRE_FUND/FUNDED/POST_FUND tetap milik throw-site yang tahu persis di mana uangnya.
 */
@Catch()
export class ShippingExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ShippingExceptionFilter.name);
  /**
   * Filter cakupan-controller MENGGANTIKAN filter global, jadi pemetaan error Prisma (P2002 → 409
   * dst.) harus diteruskan sendiri ke sana — bukan diduplikasi.
   */
  private readonly prisma = new PrismaExceptionFilter();

  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      this.prisma.catch(exception, host);
      return;
    }

    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();

      // Sudah memakai kontrak (throw-site jalur kirim fisik) → teruskan APA ADANYA.
      if (isShippingErrorBody(body)) {
        res.status(status).json(body);
        return;
      }

      // HttpException sah tapi belum berkode (validasi DTO, throttler, error yang dipetakan
      // CcShippingClient dari CC). Statusnya DIPERTAHANKAN, pesannya DIPERTAHANKAN (termasuk
      // bentuk array dari class-validator); kita hanya MENAMBAH kolom kontrak.
      const base =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : { message: typeof body === 'string' ? body : exception.message };
      res.status(status).json({
        ...base,
        statusCode: status,
        code: SHIPPING_ERROR_CODE.UNCLASSIFIED,
        stage: SHIPPING_STAGE.UNKNOWN,
        retryable: false,
      });
      return;
    }

    // Bukan HttpException sama sekali → bug/kejutan. 500 yang JUJUR, tapi tetap berkode supaya UI
    // tidak perlu menebak, dan TIDAK pernah mengklaim kartunya aman.
    this.logger.error(
      `Kegagalan tak terklasifikasi di jalur kirim fisik: ${
        exception instanceof Error ? exception.stack : String(exception)
      }`,
    );
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(
      shippingErrorBody({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: SHIPPING_ERROR_CODE.UNEXPECTED,
        message:
          'Terjadi kesalahan tak terduga. JANGAN mengulang tanda tangan — cek dulu status ' +
          'redemption ini, lalu hubungi support kalau statusnya tidak bergerak.',
        stage: SHIPPING_STAGE.UNKNOWN,
      }),
    );
  }
}
