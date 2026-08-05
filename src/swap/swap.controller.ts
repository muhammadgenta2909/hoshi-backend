import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateSwapDto } from './dto/create-swap.dto';
import { SwapService } from './swap.service';

/**
 * Ajakan tukar kartu (swap). Mount di /api/swaps.
 *
 * RECORD-ONLY: mencatat ajakan — TIDAK transfer/burn kartu, TIDAK menyentuh treasury.
 */
@ApiTags('swaps')
@Controller('swaps')
export class SwapController {
  constructor(private readonly swap: SwapService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Ajukan tukar kartu ke kolektor lain (record-only: TIDAK transfer/burn kartu)',
  })
  request(@Body() dto: CreateSwapDto, @CurrentUser() user: AuthUser) {
    return this.swap.request(dto, user);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Riwayat ajakan tukar kartu milik user (terbaru dulu)' })
  listMine(@CurrentUser() user: AuthUser) {
    return this.swap.listMine(user.id);
  }
}
