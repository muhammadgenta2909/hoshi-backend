import { Module } from '@nestjs/common';
import { NftModule } from '../nft/nft.module';
import { CollectorCryptProvider } from './providers/collectorcrypt.provider';
import { HoshiVaultProvider } from './providers/hoshi-vault.provider';
import { MockInventoryProvider } from './providers/mock.provider';
import { InventoryService } from './inventory.service';

// NftModule → HoshiVaultProvider butuh NftService untuk mint. PrismaService &
// ConfigService sudah global.
@Module({
  imports: [NftModule],
  providers: [
    HoshiVaultProvider,
    MockInventoryProvider,
    CollectorCryptProvider,
    InventoryService,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
