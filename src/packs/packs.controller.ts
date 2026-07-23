import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
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
  // `source` DIHAPUS dari sini dengan sengaja. Dulu klien boleh menimpa
  // INVENTORY_PROVIDER lewat query param — termasuk memilih 'hoshi-vault', yaitu
  // custody kartu SUNGGUHAN, alih-alih 'mock' yang dikonfigurasi server. Sumber
  // inventory adalah keputusan server; klien tidak pernah berhak memilihnya.
  // ValidationPipe global tidak bisa menyaringnya karena InventorySource cuma tipe.
  open(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.packs.open({
      userId: user.id,
      ownerAddress: user.walletAddress,
      packId: id,
    });
  }
}
