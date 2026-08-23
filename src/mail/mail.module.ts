import { Module } from '@nestjs/common';
import { MailService } from './mail.service';

/**
 * Modul email transaksional. ConfigModule sudah global (app.module) sehingga
 * ConfigService tersedia tanpa import ulang. Ekspor MailService agar modul lain
 * (marketplace, dst) bisa menyuntik dan mengirim notifikasi.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
