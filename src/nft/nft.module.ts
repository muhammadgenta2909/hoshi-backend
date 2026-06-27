import { Module } from '@nestjs/common';
import { SolanaModule } from '../solana/solana.module';
import { NftController } from './nft.controller';
import { NftService } from './nft.service';

@Module({
  imports: [SolanaModule],
  controllers: [NftController],
  providers: [NftService],
  exports: [NftService],
})
export class NftModule {}
