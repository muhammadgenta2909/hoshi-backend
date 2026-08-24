import {
  BadRequestException,
  Controller,
  Get,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { GeoService } from './geo.service';

/** ISO-3166-1 alpha-2 negara: selalu 2 huruf. */
const CISO_RE = /^[A-Za-z]{2}$/;
/**
 * Kode state CSC bisa alfanumerik (mis. "CA", "AN", angka provinsi) → izinkan pendek
 * alfanumerik. Tujuan validasi ini DEFENSIF (cegah path injection / kunci cache liar),
 * bukan menegakkan format resmi.
 */
const SISO_RE = /^[A-Za-z0-9]{1,10}$/;

/**
 * PROXY reference-data geo → countrystatecity.in. Mount di /api/geo.
 *
 * PUBLIC (tanpa JwtAuthGuard): ini data referensi read-only untuk cascade alamat
 * country→state→city + dial code. Di-throttle sendiri (lebih longgar dari default
 * global) karena cascade wajar memicu beberapa panggilan berturut-turut per user.
 * API key CSC tetap server-side — lihat GeoService.
 */
@ApiTags('geo')
@Controller('geo')
@Throttle({ default: { ttl: 60000, limit: 120 } })
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Get('countries')
  @ApiOperation({
    summary: 'Daftar negara (iso2, name, phonecode, emoji) — untuk dropdown + dial code',
  })
  countries() {
    return this.geo.countries();
  }

  @Get('states/:ciso')
  @ApiParam({ name: 'ciso', example: 'ID', description: 'ISO2 negara' })
  @ApiOperation({ summary: 'Daftar provinsi/state dari sebuah negara (iso2, name)' })
  states(@Param('ciso') ciso: string) {
    return this.geo.states(this.assertCode(ciso, CISO_RE, 'country'));
  }

  @Get('cities/:ciso/:siso')
  @ApiParam({ name: 'ciso', example: 'ID', description: 'ISO2 negara' })
  @ApiParam({ name: 'siso', example: 'JK', description: 'kode state' })
  @ApiOperation({ summary: 'Daftar kota dari sebuah state (name)' })
  cities(@Param('ciso') ciso: string, @Param('siso') siso: string) {
    return this.geo.cities(
      this.assertCode(ciso, CISO_RE, 'country'),
      this.assertCode(siso, SISO_RE, 'state'),
    );
  }

  /** Validasi defensif param path; 400 kalau bentuknya mencurigakan. */
  private assertCode(value: string, re: RegExp, label: string): string {
    if (!re.test(value)) {
      throw new BadRequestException(`Invalid ${label} code`);
    }
    return value;
  }
}
