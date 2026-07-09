import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateVaultItemDto } from './dto/create-vault-item.dto';
import { VaultService } from './vault.service';

@ApiTags('vault')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('vault')
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Post()
  @ApiOperation({ summary: 'Simpan kartu fisik ke vault (admin)' })
  store(@Body() dto: CreateVaultItemDto) {
    return this.vault.store(dto);
  }

  @Get('available')
  @ApiOperation({ summary: 'List claimable vault items' })
  available() {
    return this.vault.findAvailable();
  }

  @Get('me')
  @ApiOperation({ summary: 'Vault item milik user yang login' })
  mine(@CurrentUser() user: AuthUser) {
    return this.vault.findForUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail satu vault item' })
  findOne(@Param('id') id: string) {
    return this.vault.findOne(id);
  }

  @Post(':id/claim')
  @ApiOperation({ summary: 'Klaim item → mint NFT ke wallet user yang login' })
  claim(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.vault.claim({
      userId: user.id,
      ownerAddress: user.walletAddress,
      vaultItemId: id,
    });
  }
}
