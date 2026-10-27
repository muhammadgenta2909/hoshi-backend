import { Module } from '@nestjs/common';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { MailModule } from '../mail/mail.module';
import { PaymentsModule } from '../payments/payments.module';
import { RedemptionDeliveryScheduler } from './redemption-delivery.scheduler';
import { RedemptionController } from './redemption.controller';
import { RedemptionService } from './redemption.service';

// PrismaModule @Global → tak perlu di-import. Record-only (request/listMine) tetap mandiri; jalur
// REAL CC Vault Shipping butuh CcShippingService (dari CollectorCryptModule) + quoteRupiah (dari
// PaymentsModule). Arah import satu jalur: RedemptionModule → PaymentsModule → CollectorCryptModule
// (tidak melingkar). MailModule = email "paket diterima" (ShipmentNotifyService).
@Module({
  imports: [CollectorCryptModule, PaymentsModule, MailModule],
  controllers: [RedemptionController],
  providers: [RedemptionService, RedemptionDeliveryScheduler],
})
export class RedemptionModule {}
