import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module';
import { PacksController } from './packs.controller';
import { PacksService } from './packs.service';

@Module({
  imports: [InventoryModule],
  controllers: [PacksController],
  providers: [PacksService],
})
export class PacksModule {}
