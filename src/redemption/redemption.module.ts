import { Module } from '@nestjs/common';
import { RedemptionController } from './redemption.controller';
import { RedemptionService } from './redemption.service';

// PrismaModule @Global → tak perlu di-import. Modul mandiri: kirim kartu fisik (redeem),
// record-only, terpisah dari uang/treasury.
@Module({
  controllers: [RedemptionController],
  providers: [RedemptionService],
})
export class RedemptionModule {}
