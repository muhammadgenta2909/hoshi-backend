import { Module } from '@nestjs/common';
import { NftModule } from '../nft/nft.module';
import { VaultController } from './vault.controller';
import { VaultService } from './vault.service';

@Module({
  imports: [NftModule],
  controllers: [VaultController],
  providers: [VaultService],
})
export class VaultModule {}
