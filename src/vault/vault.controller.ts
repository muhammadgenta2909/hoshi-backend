import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
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

  // WAJIB AdminGuard: endpoint ini MEMBUAT inventory vault. Dengan JwtAuthGuard
  // saja, siapa pun yang punya wallet (identitas gratis lewat /auth/nonce) bisa
  // menyuntik VaultItem palsu — muncul sebagai custody "asli" di dashboard admin,
  // lalu diklaim lewat /vault/:id/claim sehingga PLATFORM yang membayar mint NFT-nya.
  @Post()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Simpan kartu fisik ke vault (ADMIN ONLY)' })
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
