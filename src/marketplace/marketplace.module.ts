import { Module } from '@nestjs/common';
import { NftModule } from '../nft/nft.module';
import { MarketMessagingController } from './market-messaging.controller';
import { MarketMessagingService } from './market-messaging.service';
import { MarketplaceController } from './marketplace.controller';
import { MarketplaceService } from './marketplace.service';

@Module({
  imports: [NftModule],
  controllers: [MarketplaceController, MarketMessagingController],
  providers: [MarketplaceService, MarketMessagingService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
