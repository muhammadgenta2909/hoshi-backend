import { Module } from '@nestjs/common';
import { EscrowService } from './escrow.service';

/**
 * Wallet escrow Hoshi (kartu USER yang sedang dijual). EscrowService di-export supaya
 * MarketplaceModule (listing/cancel) & PaymentsModule (settlement jual) bisa memakainya.
 * Kunci escrow terkurung di service ini — hanya provider yang mengimpor modul ini yang
 * boleh menyuruhnya menandatangani. ConfigService sudah global.
 */
@Module({
  providers: [EscrowService],
  exports: [EscrowService],
})
export class EscrowModule {}
