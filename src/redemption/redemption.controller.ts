import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrivyToken } from '../auth/privy-token.decorator';
import { RequestRedemptionDto } from './dto/request-redemption.dto';
import { SubmitBurnDto } from './dto/submit-burn.dto';
import { RedemptionService } from './redemption.service';

/**
 * Kirim kartu fisik ke rumah (redeem). Mount di /api/redemptions.
 *
 * RECORD-ONLY: endpoint ini HANYA mencatat permintaan — TIDAK burn/transfer NFT, TIDAK menyentuh
 * treasury. Pemenuhan fisik manual oleh admin.
 */
@ApiTags('redemptions')
@Controller('redemptions')
export class RedemptionController {
  constructor(private readonly redemption: RedemptionService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Minta kirim kartu fisik ke rumah (record-only: TIDAK burn/transfer NFT, NFT tetap di tempat)',
  })
  request(
    @Body() dto: RequestRedemptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.redemption.request(dto, user);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Riwayat permintaan kirim kartu fisik milik user (terbaru dulu)',
  })
  listMine(@CurrentUser() user: AuthUser) {
    return this.redemption.listMine(user.id);
  }

  /* ---------------- Jalur REAL CC Vault Shipping (digerbang HOSHI_CC_SHIPPING_ENABLED) ----------------
     Semua butuh token identitas Privy user di header x-privy-identity-token (400 bila kosong). */

  @Post(':id/estimate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'Taksir ongkir kirim fisik (USD + USDC + Rupiah) — READ-ONLY, tak menyentuh dana',
  })
  estimate(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @PrivyToken() privyToken: string,
  ) {
    return this.redemption.estimate(id, user, privyToken);
  }

  @Post(':id/fund-and-prepare')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      'Danai USDC ongkir ke wallet user + bangun transaksi burn UNSIGNED (setelah ongkir Rupiah lunas)',
  })
  fundAndPrepare(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @PrivyToken() privyToken: string,
  ) {
    return this.redemption.fundAndPrepare(id, user, privyToken);
  }

  @Post(':id/submit-burn')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Teruskan transaksi burn+ship yang sudah ditandatangani user ke CollectorCrypt',
  })
  submitBurn(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @PrivyToken() privyToken: string,
    @Body() dto: SubmitBurnDto,
  ) {
    return this.redemption.submitBurn(
      id,
      user,
      privyToken,
      dto.signedTransactions,
    );
  }

  @Get(':id/status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Poll status shipment CC → status Hoshi + tracking',
  })
  status(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @PrivyToken() privyToken: string,
  ) {
    return this.redemption.status(id, user, privyToken);
  }
}
