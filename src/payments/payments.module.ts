import { Module } from '@nestjs/common';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { IdrxClient } from './idrx.client';
import { PaymentsController } from './payments.controller';
import { PaymentsReconcileScheduler } from './payments-reconcile.scheduler';
import { PaymentsService } from './payments.service';

/**
 * Rail pembayaran IDRX (on-ramp rupiah → pack CollectorCrypt).
 *
 * `imports: [CollectorCryptModule]` HANYA untuk mendapat GachaService (satu-satunya yang
 * boleh membelanjakan treasury). CollectorCryptModule sengaja TIDAK meng-export TreasuryService,
 * jadi kita menuju penandatangan lewat GachaService.purchase() dan seluruh pengaman di jalannya
 * (plafon harga, cap harian, ledger write-ahead) tetap di jalur. Jangan pernah menembus itu.
 *
 * Tanpa `imports` lain: PrismaService & ConfigService sudah global (prisma.module @Global,
 * ConfigModule.forRoot({ isGlobal: true })), dan JwtAuthGuard/AdminGuard cuma butuh strategy
 * 'jwt' yang sudah didaftarkan AuthModule secara global lewat Passport.
 *
 * IdrxClient di-provide di sini (transport murni ke IDRX; ia yang meminjam penandatanganan
 * dari src/idrx/idrx.signature.ts). Tidak ada yang di-`exports`: PaymentsService cuma dipakai
 * oleh PaymentsController di modul ini.
 *
 * PaymentsReconcileScheduler WAJIB terdaftar di sini: callback IDRX tidak pernah di-retry, jadi
 * penyapu berkala inilah satu-satunya yang menyelamatkan order berbayar yang callbacknya hilang.
 */
@Module({
  imports: [CollectorCryptModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, IdrxClient, PaymentsReconcileScheduler],
})
export class PaymentsModule {}
