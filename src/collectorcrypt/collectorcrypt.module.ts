import { Module } from '@nestjs/common';
import { CcBuyClient } from './cc-buy.client';
import { CcBuyController } from './cc-buy.controller';
import { CcBuyService } from './cc-buy.service';
import { CcCardFactsService } from './cc-card-facts.service';
import { CcGachaClient } from './cc-gacha.client';
import { CcMarketClient } from './cc-market.client';
import { GachaController } from './gacha.controller';
import { GachaService } from './gacha.service';
import { JupiterClient } from './jupiter.client';
import { MarketSyncService } from './market-sync.service';
import { ResellerSettlementService } from './reseller-settlement.service';
import { TreasurySwapScheduler } from './treasury-swap.scheduler';
import { TreasurySwapService } from './treasury-swap.service';
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
 * tiap pack. Yang boleh menyuruhnya menandatangani hanya provider DI MODUL INI, dan
 * saat ini ada TEPAT TIGA:
 *
 *   - GachaService             → menandatangani pembelian pack (USDC keluar)
 *   - TreasurySwapService      → menandatangani swap IDRX→USDC (uang berpindah BENTUK)
 *   - ResellerSettlementService → beli kartu katalog CC (USDC keluar) + transfer NFT ke pembeli
 *
 * Ketiganya di-export (bukan TreasuryService) supaya modul lain menuju penandatangan hanya
 * lewat pintu yang membawa semua pengaman, tanpa private key bocor lintas modul.
 *
 * TreasurySwapService diletakkan di sini justru KARENA batasan itu: menutup lingkaran
 * modal kerja butuh tanda tangan treasury, dan memindahkannya ke modul lain berarti
 * meng-export TreasuryService — yang akan membuat private key tersedia bagi modul mana
 * pun yang mengimpornya. Lebih baik satu file "asing" secara tema di dalam modul ini
 * daripada satu private key yang bocor lintas modul.
 *
 * MarketSyncService (+ CcMarketClient, katalog publik tanpa key) di-export untuk
 * AdminModule: sync katalog adalah aksi admin, tapi pengetahuan tentang API CC
 * tetap terkonsentrasi di modul ini.
 *
 * CcCardFactsService di-export untuk MarketplaceModule dengan alasan yang sama:
 * grade sebuah kartu adalah FAKTA MILIK CC, dan satu-satunya cara membacanya
 * (katalog publik mereka) harus tetap tinggal di modul ini. Yang menyeberang
 * hanyalah jawabannya.
 */
@Module({
  controllers: [GachaController, CcBuyController],
  providers: [
    CcGachaClient,
    CcMarketClient,
    CcCardFactsService,
    // Jalur BELI marketplace CC — dipisah dari CcMarketClient yang read-only
    // karena yang ini memindahkan uang (lihat catatan di cc-buy.client.ts).
    CcBuyClient,
    CcBuyService,
    // Settlement REAL reseller: treasury beli kartu CC (USDC keluar) + kirim NFT ke pembeli.
    ResellerSettlementService,
    GachaService,
    MarketSyncService,
    TreasuryService,
    // Penutup lingkaran modal kerja: IDRX (rupiah user) → USDC (yang membayar pack).
    JupiterClient,
    TreasurySwapService,
    TreasurySwapScheduler,
  ],
  exports: [
    GachaService,
    MarketSyncService,
    TreasurySwapService,
    CcCardFactsService,
    // PaymentsModule memanggilnya dari fulfilListing (settlement reseller saat di-arm).
    ResellerSettlementService,
  ],
})
export class CollectorCryptModule {}
