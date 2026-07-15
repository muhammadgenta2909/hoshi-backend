import { Module } from '@nestjs/common';
import { CcGachaClient } from './cc-gacha.client';
import { GachaController } from './gacha.controller';
import { GachaService } from './gacha.service';
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
 */
@Module({
  controllers: [GachaController],
  providers: [CcGachaClient, GachaService, TreasuryService],
  exports: [GachaService],
})
export class CollectorCryptModule {}
