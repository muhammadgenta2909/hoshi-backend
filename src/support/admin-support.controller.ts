import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { PostMessageDto, SetThreadStatusDto } from './dto/support.dto';
import { SupportService } from './support.service';

@ApiTags('admin-support')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/support')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get('threads')
  @ApiOperation({ summary: 'Semua thread support (filter status/unread/search)' })
  listThreads(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('unread') unread?: string,
    @Query('search') search?: string,
  ) {
    return this.support.listAdminThreads({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      unread: unread === 'true' || unread === '1',
      search,
    });
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Jumlah thread dengan pesan belum dibaca admin' })
  unread() {
    return this.support.adminUnreadCount();
  }

  @Get('threads/:id')
  @ApiOperation({ summary: 'Detail thread + pesan (menandai dibaca admin)' })
  getThread(@Param('id') id: string) {
    return this.support.getAdminThread(id);
  }

  @Post('threads/:id/reply')
  @ApiOperation({ summary: 'Balas thread sebagai admin' })
  reply(@Param('id') id: string, @Body() dto: PostMessageDto) {
    return this.support.adminReply(id, dto.body);
  }

  @Put('threads/:id/status')
  @ApiOperation({ summary: 'Ubah status thread (OPEN/CLOSED)' })
  setStatus(@Param('id') id: string, @Body() dto: SetThreadStatusDto) {
    return this.support.setStatus(id, dto.status);
  }
}
