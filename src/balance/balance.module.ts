import { Module } from '@nestjs/common';
import { BalanceController } from './balance.controller';
import { BalanceService } from './balance.service';
import { WithdrawalService } from './withdrawal.service';

/**
 * Saldo in-app (Rupiah) user. BalanceService di-export supaya PaymentsModule bisa mengkredit
 * penjual saat kartunya terjual (Flow B); WithdrawalService di-export supaya AdminModule bisa
 * memproses (approve/reject) penarikan. PrismaService sudah global.
 */
@Module({
  controllers: [BalanceController],
  providers: [BalanceService, WithdrawalService],
  exports: [BalanceService, WithdrawalService],
})
export class BalanceModule {}
