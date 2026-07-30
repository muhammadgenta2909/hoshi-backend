import { Module } from '@nestjs/common';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { NftModule } from '../nft/nft.module';
import { MarketMessagingController } from './market-messaging.controller';
import { MarketMessagingService } from './market-messaging.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

/**
 * CollectorCryptModule diimpor demi CcCardFactsService: grade kartu hasil pull
 * ditentukan SERVER dari katalog CC, tidak pernah dari payload klien (klien bisa
 * mengirim "PSA 10" untuk kartu apa pun).
 */
@Module({
  imports: [NftModule, CollectorCryptModule],
  controllers: [MarketplaceController, MarketMessagingController],
  providers: [MarketplaceService, MarketMessagingService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
