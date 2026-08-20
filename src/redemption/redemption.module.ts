import { Module } from '@nestjs/common';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { PaymentsModule } from '../payments/payments.module';
import { RedemptionController } from './redemption.controller';
import { RedemptionService } from './redemption.service';

// PrismaModule @Global → tak perlu di-import. Record-only (request/listMine) tetap mandiri; jalur
// REAL CC Vault Shipping butuh CcShippingService (dari CollectorCryptModule) + quoteRupiah (dari
// PaymentsModule). Arah import satu jalur: RedemptionModule → PaymentsModule → CollectorCryptModule
// (tidak melingkar).
@Module({
  imports: [CollectorCryptModule, PaymentsModule],
  controllers: [RedemptionController],
  providers: [RedemptionService],
})
export class RedemptionModule {}
