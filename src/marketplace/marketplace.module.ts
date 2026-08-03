import { Module } from '@nestjs/common';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { EscrowModule } from '../escrow/escrow.module';
import { NftModule } from '../nft/nft.module';
import { MarketMessagingController } from './market-messaging.controller';
import { MarketMessagingService } from './market-messaging.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

/**
 * CollectorCryptModule diimpor demi CcCardFactsService: grade kartu hasil pull
 * ditentukan SERVER dari katalog CC, tidak pernah dari payload klien (klien bisa
 * mengirim "PSA 10" untuk kartu apa pun). EscrowModule: langkah escrow-saat-listing
 * (transfer kartu penjual → wallet escrow) untuk jalur P2P real.
 */
@Module({
  imports: [NftModule, CollectorCryptModule, EscrowModule],
  controllers: [MarketplaceController, MarketMessagingController],
  providers: [MarketplaceService, MarketMessagingService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
