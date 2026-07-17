import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AdminJwtStrategy } from '../auth/admin-jwt.strategy';
import { CollectorCryptModule } from '../collectorcrypt/collectorcrypt.module';
import { MarketplaceModule } from '../marketplace/marketplace.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [
    // Admin accept/reject reuses the seller⇄buyer settlement, never its own copy.
    MarketplaceModule,
    // Sync katalog CollectorCrypt (POST /admin/cc-sync) — logika & klien API CC
    // tetap tinggal di CollectorCryptModule, admin hanya memicunya.
    CollectorCryptModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET'),
        signOptions: {
          expiresIn: (config.get<string>('JWT_EXPIRES_IN') ??
            '7d') as unknown as number,
        },
      }),
    }),
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminJwtStrategy],
})
export class AdminModule {}
