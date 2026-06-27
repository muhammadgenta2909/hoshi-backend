import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { MintNftDto } from './dto/mint-nft.dto';
import { NftService } from './nft.service';

@ApiTags('nft')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('nft')
export class NftController {
  constructor(private readonly nft: NftService) {}

  @Post('mint')
  @ApiOperation({
    summary: 'Mint card jadi NFT ke wallet user yang login (platform bayar)',
  })
  mint(@CurrentUser() user: AuthUser, @Body() dto: MintNftDto) {
    return this.nft.mintForUser({
      userId: user.id,
      ownerAddress: user.walletAddress,
      cardId: dto.cardId,
    });
  }

  @Get()
  @ApiOperation({ summary: 'List NFT milik user yang login' })
  list(@CurrentUser() user: AuthUser) {
    return this.nft.findForUser(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail satu NFT milik user' })
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.nft.findOne(user.id, id);
  }
}
