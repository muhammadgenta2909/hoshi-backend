import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { SolanaModule } from './solana/solana.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CardsModule } from './cards/cards.module';
import { NftModule } from './nft/nft.module';
import { VaultModule } from './vault/vault.module';
import { InventoryModule } from './inventory/inventory.module';
import { PacksModule } from './packs/packs.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    // Rate-limit global default: 60 request / menit / IP.
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 60 }]),
    PrismaModule,
    SolanaModule,
    AuthModule,
    UsersModule,
    CardsModule,
    NftModule,
    VaultModule,
    InventoryModule,
    PacksModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Aktifkan ThrottlerGuard secara global.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
