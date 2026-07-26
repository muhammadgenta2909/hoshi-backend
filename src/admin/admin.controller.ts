import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { MarketSyncService } from '../collectorcrypt/market-sync.service';
import { AdminService } from './admin.service';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { CcSyncDto } from './dto/cc-sync.dto';
import { AdminLoginDto } from './dto/admin-login.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { SetListingStatusDto } from './dto/set-listing-status.dto';
import {
  CreateContactMessageDto,
  MarkMessageReadDto,
  QueryAdminMessagesDto,
} from './dto/contact-message.dto';
import { ImportListingsDto } from './dto/import-listings.dto';
import { UpdateVaultItemDto } from './dto/update-vault-item.dto';
import {
  QueryAdminActivityDto,
  QueryAdminCardsDto,
  QueryAdminListingsDto,
} from './dto/query-admin.dto';

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly ccSync: MarketSyncService,
  ) {}

  @Post('login')
  @ApiOperation({ summary: 'Admin login with email + password' })
  login(@Body() dto: AdminLoginDto) {
    return this.admin.login(dto.email, dto.password);
  }

  @Get('stats')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Statistik dashboard admin' })
  stats() {
    return this.admin.stats();
  }

  @Get('listings')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'All listings with pagination, search, filter' })
  listListings(@Query() query: QueryAdminListingsDto) {
    return this.admin.listListings(query);
  }

  @Get('listings/:id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Detail listing' })
  getListing(@Param('id') id: string) {
    return this.admin.getListing(id);
  }

  @Post('listings')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Buat listing baru oleh admin' })
  createListing(@Body() dto: AdminCreateListingDto) {
    return this.admin.createListing(dto);
  }

  @Put('listings/:id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Update listing' })
  updateListing(@Param('id') id: string, @Body() dto: AdminUpdateListingDto) {
    return this.admin.updateListing(id, dto);
  }

  @Patch('listings/:id/status')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Aktif/nonaktifkan listing (ACTIVE ⇄ CANCELLED)' })
  setListingStatus(@Param('id') id: string, @Body() dto: SetListingStatusDto) {
    return this.admin.setListingStatus(id, dto.status);
  }

  @Delete('listings/:id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Hapus listing' })
  deleteListing(@Param('id') id: string) {
    return this.admin.deleteListing(id);
  }

  @Post('listings/import')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Import listings from JSON array' })
  importListings(@Body() dto: ImportListingsDto) {
    return this.admin.importListings(dto);
  }

  @Post('cc-sync')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary:
      'Sync katalog CollectorCrypt → listings (source=COLLECTORCRYPT); ' +
      're-sync me-refresh metadata tanpa menyentuh harga yang diedit admin',
  })
  ccSyncListings(@Body() dto: CcSyncDto) {
    return this.ccSync.sync(dto);
  }

  @Get('cards')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'All cards with pagination' })
  listCards(@Query() query: QueryAdminCardsDto) {
    return this.admin.listCards(query);
  }

  @Get('users')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Daftar user terdaftar (paginated). Field aman saja.',
  })
  listUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
  ) {
    return this.admin.listUsers({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      role,
    });
  }

  @Get('activity')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Activity log (listings that changed status)' })
  listActivity(@Query() query: QueryAdminActivityDto) {
    return this.admin.listActivity(query);
  }

  @Get('stats/daily')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Daily stats for charts (listings, revenue, status dist)',
  })
  dailyStats(@Query('days') days?: string) {
    return this.admin.dailyStats(days ? parseInt(days, 10) : 365);
  }

  /* ---------- Messages ---------- */

  @Post('contact-messages')
  @ApiOperation({ summary: 'Submit contact message (public)' })
  createMessage(@Body() dto: CreateContactMessageDto) {
    return this.admin.createMessage(dto);
  }

  @Get('contact-messages')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'List all contact messages (admin)' })
  listMessages(@Query() query: QueryAdminMessagesDto) {
    return this.admin.listMessages(query);
  }

  @Put('contact-messages/:id/read')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Mark message as read/unread' })
  markMessageRead(@Param('id') id: string, @Body() dto: MarkMessageReadDto) {
    return this.admin.markMessageRead(id, dto.isRead);
  }

  /* ---------- Offers ---------- */

  @Get('offers')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'All offers paginated' })
  listOffers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('listingId') listingId?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
  ) {
    return this.admin.listOffers({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      listingId,
      search,
      status,
    });
  }

  @Post('offers/:id/accept')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Accept an offer' })
  acceptOffer(@Param('id') id: string) {
    return this.admin.acceptOffer(id);
  }

  @Post('offers/:id/reject')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Reject an offer' })
  rejectOffer(@Param('id') id: string) {
    return this.admin.rejectOffer(id);
  }

  /* ---------- Vault / Inventory (custody location) ---------- */

  @Get('vault-items')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Daftar item vault (filter status/provider/search)',
  })
  listVaultItems(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('provider') provider?: string,
    @Query('search') search?: string,
  ) {
    return this.admin.listVaultItems({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      provider,
      search,
    });
  }

  @Put('vault-items/:id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Ubah lokasi/provider custody item vault' })
  updateVaultItem(@Param('id') id: string, @Body() dto: UpdateVaultItemDto) {
    return this.admin.updateVaultItem(id, dto);
  }

  /* ---------- Image Upload ---------- */

  @Post('upload')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @UseInterceptors(
    FileInterceptor('file', {
      // Batasi ukuran (8MB) + hanya terima MIME image/* — FileInterceptor default
      // tidak punya batas apa pun, jadi admin bisa saja mengunggah file raksasa
      // atau non-gambar. Guard di sini + di service (uploadImage).
      limits: { fileSize: 8 * 1024 * 1024 },
      fileFilter: (_req, file, cb) => {
        if (file.mimetype?.startsWith('image/')) cb(null, true);
        else
          cb(
            new BadRequestException('Hanya file gambar yang diperbolehkan'),
            false,
          );
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({ summary: 'Upload image for listing' })
  uploadImage(@UploadedFile() file: Express.Multer.File) {
    return this.admin.uploadImage(file);
  }

  // Dulu endpoint ini benar-benar publik: siapa pun bisa membuat akun ADMIN
  // hanya dengan tahu URL-nya. Sekarang wajib menyertakan header x-admin-secret
  // yang cocok dengan env ADMIN_SECRET (dan kalau env-nya tidak di-set, seed
  // ditolak selalu — fail closed).
  @Post('seed')
  @ApiOperation({ summary: 'Seed admin user (butuh header x-admin-secret)' })
  seedAdmin(
    @Body() dto: AdminLoginDto,
    @Headers('x-admin-secret') secret?: string,
  ) {
    return this.admin.seedAdmin(dto.email, dto.password, secret);
  }

  @Post('seed/charts')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Seed 90 days of chart demo data (dev only)' })
  seedChartData() {
    return this.admin.seedChartData();
  }
}
