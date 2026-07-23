import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CcBuyService } from './cc-buy.service';
import { CcBuySubmitDto } from './dto/cc-buy.dto';

/**
 * Beli kartu KATALOG CollectorCrypt. Alurnya dua langkah karena yang menandatangani
 * adalah wallet user di browser:
 *
 *   1. POST /marketplace/:id/cc-buy/prepare  → { serializedTransaction, priceUsdc, ... }
 *   2. user menandatangani di wallet
 *   3. POST /marketplace/:id/cc-buy/submit   → { signature }
 *
 * Prefix 'marketplace' sengaja disamakan dengan MarketplaceController supaya URL-nya
 * konsisten; path-nya berbeda sehingga tidak bentrok. Logikanya tetap tinggal di
 * modul CollectorCrypt agar pengetahuan tentang API CC terkonsentrasi di satu tempat.
 */
@ApiTags('marketplace-cc')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketplace')
export class CcBuyController {
  constructor(private readonly ccBuy: CcBuyService) {}

  @Post(':id/cc-buy/prepare')
  @ApiOperation({
    summary:
      'Kutip harga LIVE CollectorCrypt + bangun transaksi beli (belum ditandatangani)',
  })
  prepare(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.ccBuy.prepare(id, user);
  }

  @Post(':id/cc-buy/submit')
  @ApiOperation({ summary: 'Siarkan transaksi beli yang sudah ditandatangani' })
  submit(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CcBuySubmitDto,
  ) {
    return this.ccBuy.submit(id, user, dto.signedTransaction);
  }
}
