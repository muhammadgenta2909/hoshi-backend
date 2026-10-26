import { Module } from '@nestjs/common';
import { MailService } from './mail.service';
import { ShipmentNotifyService } from './shipment-notify.service';

/**
 * Modul email transaksional. ConfigModule sudah global (app.module) sehingga
 * ConfigService tersedia tanpa import ulang. Ekspor MailService agar modul lain
 * (marketplace, dst) bisa menyuntik dan mengirim notifikasi. ShipmentNotifyService =
 * email pengiriman domestik (dikirim / diterima), dipakai admin & redemption.
 */
@Module({
  providers: [MailService, ShipmentNotifyService],
  exports: [MailService, ShipmentNotifyService],
})
export class MailModule {}
