import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Memetakan error Prisma yang umum ke HTTP status yang benar (bukan 500 generik),
 * tanpa membocorkan detail internal ke client.
 */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error';

    switch (exception.code) {
      case 'P2002': {
        status = HttpStatus.CONFLICT;
        const target = exception.meta?.target;
        const fields = Array.isArray(target) ? target.join(', ') : '';
        message = `Data sudah ada${fields ? ` (unik: ${fields})` : ''}.`;
        break;
      }
      case 'P2003':
        status = HttpStatus.CONFLICT;
        message = 'Operasi ditolak: masih ada data lain yang berelasi.';
        break;
      case 'P2025':
        status = HttpStatus.NOT_FOUND;
        message = 'Data tidak ditemukan.';
        break;
      default:
        this.logger.error(`Prisma ${exception.code}: ${exception.message}`);
    }

    res
      .status(status)
      .json({ statusCode: status, error: exception.code, message });
  }
}
