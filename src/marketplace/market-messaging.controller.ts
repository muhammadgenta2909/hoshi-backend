import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { MarketMessageDto } from './dto/market-message.dto';
import { MarketMessagingService } from './market-messaging.service';

/**
 * Pesan pembeli ↔ penjual. Prefix 'marketplace' (sama dgn MarketplaceController,
 * path berbeda jadi tidak bentrok). Semua wallet-authed (JWT).
 *   POST /marketplace/:id/message          buyer buka/lanjut percakapan pd listing
 *   GET  /marketplace/me/threads           daftar percakapanku (sbg buyer & seller)
 *   GET  /marketplace/me/unread-count       badge
 *   GET  /marketplace/threads/:threadId     detail + pesan (tandai dibaca)
 *   POST /marketplace/threads/:threadId/message  balas
 */
@ApiTags('marketplace-messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('marketplace')
export class MarketMessagingController {
  constructor(private readonly svc: MarketMessagingService) {}

  @Post(':id/message')
  @ApiOperation({ summary: 'Kirim pesan ke penjual sebuah listing' })
  postToListing(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: MarketMessageDto,
  ) {
    return this.svc.postToListing(id, user, dto.body);
  }

  @Get('me/threads')
  @ApiOperation({ summary: 'Percakapan marketplace milik user (buyer & seller)' })
  myThreads(@CurrentUser() user: AuthUser) {
    return this.svc.listMyThreads(user);
  }

  @Get('me/unread-count')
  @ApiOperation({ summary: 'Jumlah percakapan dengan pesan belum dibaca' })
  unread(@CurrentUser() user: AuthUser) {
    return this.svc.unreadCount(user);
  }

  @Get('threads/:threadId')
  @ApiOperation({ summary: 'Detail percakapan + pesan (menandai dibaca)' })
  thread(@Param('threadId') threadId: string, @CurrentUser() user: AuthUser) {
    return this.svc.getThread(threadId, user);
  }

  @Post('threads/:threadId/message')
  @ApiOperation({ summary: 'Balas dalam percakapan' })
  reply(
    @Param('threadId') threadId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: MarketMessageDto,
  ) {
    return this.svc.reply(threadId, user, dto.body);
  }
}
