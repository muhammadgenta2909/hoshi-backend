import { Module } from '@nestjs/common';
import { UmiService } from './umi.service';

@Module({
  providers: [UmiService],
  exports: [UmiService],
})
export class SolanaModule {}
