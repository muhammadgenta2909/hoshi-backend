import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { ConsignmentAdminController } from './consignment.admin.controller';
import { ConsignmentController } from './consignment.controller';
import { ConsignmentService } from './consignment.service';

/**
 * Titipan (konsinyasi): kartu ORANG LAIN yang fisiknya di tangan Hoshi.
 *
 * `BalanceModule` diimpor demi ganti rugi kartu yang hilang — ia memakai ledger saldo yang SUDAH
 * ADA, bukan buku besar kedua. Kredit hasil PENJUALAN tidak terjadi di modul ini melainkan di
 * `PaymentsService.fulfilConsignment`, karena ia harus berada di dalam transaksi settlement yang
 * sama dengan klaim listing dan klaim custody.
 *
 * Tidak mengimpor EscrowModule, SolanaModule, maupun CollectorCryptModule — DENGAN SENGAJA:
 * jalur ini tidak menyentuh on-chain sama sekali.
 */
@Module({
  imports: [BalanceModule],
  controllers: [ConsignmentAdminController, ConsignmentController],
  providers: [ConsignmentService],
  exports: [ConsignmentService],
})
export class ConsignmentModule {}
