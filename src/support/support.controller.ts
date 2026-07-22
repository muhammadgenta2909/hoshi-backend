import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateThreadDto, PostMessageDto } from './dto/support.dto';
import { SupportService } from './support.service';

@ApiTags('support')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('threads')
  @ApiOperation({ summary: 'Thread support milik user yang login' })
  listThreads(@CurrentUser() user: AuthUser) {
    return this.support.listUserThreads(user.id);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Jumlah pesan support belum dibaca user' })
  unread(@CurrentUser() user: AuthUser) {
    return this.support.userUnreadCount(user.id);
  }

  @Post('threads')
  @ApiOperation({ summary: 'Buka thread support baru' })
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateThreadDto) {
    return this.support.createThread(user.id, dto);
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'Detail thread + pesan (menandai dibaca)' })
  getThread(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.support.getUserThread(user.id, id);
  }

  @Post('threads/:id/messages')
  @ApiOperation({ summary: 'Kirim pesan ke thread' })
  postMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: PostMessageDto,
  ) {
    return this.support.addUserMessage(user.id, id, dto.body);
  }
}
