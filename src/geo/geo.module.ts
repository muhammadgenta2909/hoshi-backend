import { Module } from '@nestjs/common';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

/**
 * Modul mandiri: PROXY reference-data geo ke countrystatecity.in. Tidak menyentuh
 * database/treasury/on-chain — hanya cache in-memory + fetch upstream. ConfigModule
 * @Global → tak perlu di-import di sini.
 */
@Module({
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
