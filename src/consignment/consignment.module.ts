import { Module } from '@nestjs/common';
import { BalanceModule } from '../balance/balance.module';
import { MailModule } from '../mail/mail.module';
import { ConsignmentAdminController } from './consignment.admin.controller';
import { ConsignmentController } from './consignment.controller';
import { ConsignmentNotifyService } from './consignment-notify.service';
import { ConsignmentService } from './consignment.service';

/**
 * Titipan (konsinyasi): kartu ORANG LAIN yang fisiknya di tangan Hoshi.
 *
 * `BalanceModule` diimpor demi ganti rugi kartu yang hilang — ia memakai ledger saldo yang SUDAH
 * ADA, bukan buku besar kedua. Kredit hasil PENJUALAN tidak terjadi di modul ini melainkan di
 * `PaymentsService.fulfilConsignment`, karena ia harus berada di dalam transaksi settlement yang
 * sama dengan klaim listing dan klaim custody.
 *
 * `MailModule` diimpor demi `ConsignmentNotifyService`: halaman titipan MENJANJIKAN kepada
 * pemiliknya bahwa ia akan diberi tahu, dan sampai service itu ada tidak satu pun jalur titipan
 * memanggil MailService. Ia di-`exports` karena kejadian TERJUAL tidak terjadi di modul ini
 * melainkan di `PaymentsService.fulfilConsignment`, tepat sesudah transaksi settlement commit.
 *
 * Tidak mengimpor EscrowModule, SolanaModule, maupun CollectorCryptModule — DENGAN SENGAJA:
 * jalur ini tidak menyentuh on-chain sama sekali.
 */
@Module({
  imports: [BalanceModule, MailModule],
  controllers: [ConsignmentAdminController, ConsignmentController],
  providers: [ConsignmentService, ConsignmentNotifyService],
  exports: [ConsignmentService, ConsignmentNotifyService],
})
export class ConsignmentModule {}
