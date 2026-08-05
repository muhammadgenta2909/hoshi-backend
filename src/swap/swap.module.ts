import { Module } from '@nestjs/common';
import { SwapController } from './swap.controller';
import { SwapService } from './swap.service';

// PrismaModule @Global → tak perlu di-import. Modul mandiri: ajakan tukar kartu (swap),
// record-only, terpisah dari uang/treasury.
@Module({
  controllers: [SwapController],
  providers: [SwapService],
})
export class SwapModule {}
