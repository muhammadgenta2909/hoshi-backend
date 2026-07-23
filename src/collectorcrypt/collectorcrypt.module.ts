import { Module } from '@nestjs/common';
import { CcBuyClient } from './cc-buy.client';
import { CcBuyController } from './cc-buy.controller';
import { CcBuyService } from './cc-buy.service';
import { CcGachaClient } from './cc-gacha.client';
import { CcMarketClient } from './cc-market.client';
import { GachaController } from './gacha.controller';
import { GachaService } from './gacha.service';
import { MarketSyncService } from './market-sync.service';
import { TreasuryService } from './treasury.service';

/**
 * Integrasi gacha CollectorCrypt yang sebenarnya (menggantikan asumsi lama di
 * src/inventory/providers/collectorcrypt.provider.ts — lihat catatan deprecation di sana).
 *
 * Tanpa `imports`: PrismaService & ConfigService sudah global (prisma.module.ts @Global,
 * ConfigModule.forRoot({ isGlobal: true })), dan JwtAuthGuard cuma butuh strategy 'jwt'
 * yang sudah didaftarkan AuthModule secara global lewat Passport.
 *
 * TreasuryService SENGAJA tidak di-`exports`: ia memegang private key yang membayar
 * tiap pack, jadi satu-satunya yang boleh menyuruhnya menandatangani adalah GachaService
 * di modul ini. Modul lain yang butuh gacha cukup lewat GachaService.
 *
 * MarketSyncService (+ CcMarketClient, katalog publik tanpa key) di-export untuk
 * AdminModule: sync katalog adalah aksi admin, tapi pengetahuan tentang API CC
 * tetap terkonsentrasi di modul ini.
 */
@Module({
  controllers: [GachaController, CcBuyController],
  providers: [
    CcGachaClient,
    CcMarketClient,
    // Jalur BELI marketplace CC — dipisah dari CcMarketClient yang read-only
    // karena yang ini memindahkan uang (lihat catatan di cc-buy.client.ts).
    CcBuyClient,
    CcBuyService,
    GachaService,
    MarketSyncService,
    TreasuryService,
  ],
  exports: [GachaService, MarketSyncService],
})
export class CollectorCryptModule {}
