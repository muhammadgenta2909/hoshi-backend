import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { RequestRedemptionDto } from './dto/request-redemption.dto';
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
}
