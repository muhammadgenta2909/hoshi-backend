import { Module } from '@nestjs/common';
import { BalanceController } from './balance.controller';
import { BalanceService } from './balance.service';

/**
 * Saldo in-app (Rupiah) user. BalanceService di-export supaya PaymentsModule bisa mengkredit
 * penjual saat kartunya terjual (Flow B). PrismaService sudah global.
 */
@Module({
  controllers: [BalanceController],
  providers: [BalanceService],
  exports: [BalanceService],
})
export class BalanceModule {}
