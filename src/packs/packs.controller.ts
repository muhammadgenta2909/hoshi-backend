import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import type { InventorySource } from '../inventory/inventory.types';
import { PacksService } from './packs.service';

@ApiTags('packs')
@Controller('packs')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @Get()
  @ApiOperation({
    summary: 'Katalog pack + expected value & drop rates (publik)',
  })
  list() {
    return this.packs.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail satu pack (publik)' })
  getOne(@Param('id') id: string) {
    return this.packs.getOne(id);
  }

  @Post(':id/open')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Buka pack (gacha) → kartu di-deliver ke wallet user yang login',
  })
  @ApiQuery({
    name: 'source',
    required: false,
    enum: ['hoshi-vault', 'collectorcrypt', 'mock'],
    description: 'Override sumber inventory (default: INVENTORY_PROVIDER).',
  })
  open(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('source') source?: InventorySource,
  ) {
    return this.packs.open({
      userId: user.id,
      ownerAddress: user.walletAddress,
      packId: id,
      source,
    });
  }
}
