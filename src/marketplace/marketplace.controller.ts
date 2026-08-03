import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateListingDto } from './dto/create-listing.dto';
import { QueryActivityDto } from './dto/query-activity.dto';
import { QueryListingDto } from './dto/query-listing.dto';
import { RelistListingDto } from './dto/relist-listing.dto';
import { SubmitEscrowDto } from './dto/submit-escrow.dto';
import { SubmitOfferDto } from './dto/submit-offer.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { MarketplaceService } from './marketplace.service';

@ApiTags('marketplace')
@Controller('marketplace')
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  @ApiOperation({ summary: 'List listing ACTIVE (+ filter & sort) — publik' })
  list(@Query() query: QueryListingDto) {
    return this.marketplace.list(query);
  }

  @Get('me/listings')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Listing milik user login (semua status)' })
  listMine(@CurrentUser() user: AuthUser) {
    return this.marketplace.listMine(user.id);
  }

  @Get('me/purchases')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Cards purchased by logged-in user (Vault/collection)',
  })
  listPurchases(@CurrentUser() user: AuthUser) {
    return this.marketplace.listPurchases(user.id);
  }

  @Get('me/offers-made')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Penawaran yang dibuat user login' })
  offersMade(@CurrentUser() user: AuthUser) {
    return this.marketplace.listOffersMade(user.id);
  }

  @Get('me/offers-received')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Penawaran yang masuk ke listing milik user login' })
  offersReceived(@CurrentUser() user: AuthUser) {
    return this.marketplace.listOffersReceived(user.id);
  }

  @Get('me/activity')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Feed aktivitas profil user login' })
  activity(@CurrentUser() user: AuthUser, @Query() query: QueryActivityDto) {
    return this.marketplace.listActivity(user.id, query);
  }

  /* --- offer actions. Didaftarkan SEBELUM `:id` supaya "offers" tidak
         ditangkap sebagai sebuah listing id. --- */

  @Post('offers/:offerId/accept')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Penjual menerima penawaran → kartu terjual seharga penawaran',
  })
  acceptOffer(
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.acceptOffer(offerId, user);
  }

  @Post('offers/:offerId/reject')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Penjual menolak penawaran' })
  rejectOffer(
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.rejectOffer(offerId, user);
  }

  @Post('offers/:offerId/cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Pembuat penawaran menariknya kembali' })
  cancelOffer(
    @Param('offerId') offerId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.cancelOffer(offerId, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Detail satu listing (bundel Figma) — publik, read-only',
  })
  detail(@Param('id') id: string) {
    return this.marketplace.detail(id);
  }

  @Post(':id/view')
  @ApiOperation({
    summary: 'Tambah 1 view (client dedupe per sesi) — publik',
  })
  view(@Param('id') id: string) {
    return this.marketplace.registerView(id);
  }

  @Post(':id/offer')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Ajukan penawaran (login wajib — offer ditautkan ke wallet pembeli)',
  })
  submitOffer(
    @Param('id') id: string,
    @Body() dto: SubmitOfferDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.submitOffer(id, user, dto.amount);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List card on marketplace (login required)' })
  create(@Body() dto: CreateListingDto, @CurrentUser() user: AuthUser) {
    return this.marketplace.create(dto, user);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Ubah harga listing sendiri yang masih ACTIVE' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateListingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.updateListing(id, dto, user);
  }

  @Post(':id/buy')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Beli listing (ACTIVE→SOLD) lalu mint NFT ke buyer',
  })
  buy(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.marketplace.buy(id, user);
  }

  @Post(':id/cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Tarik listing sendiri (ACTIVE→CANCELLED)' })
  cancel(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.marketplace.cancel(id, user);
  }

  @Post(':id/relist')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Jual ulang kartu milik sendiri (SOLD/CANCELLED → ACTIVE)',
  })
  relist(
    @Param('id') id: string,
    @Body() dto: RelistListingDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.relist(id, dto, user);
  }

  @Post(':id/escrow/prepare')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Escrow langkah 1: bangun tx transfer kartu penjual → escrow (real P2P, PENDING_ESCROW)',
  })
  prepareEscrow(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.marketplace.prepareEscrow(id, user);
  }

  @Post(':id/escrow/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Escrow langkah 2: siarkan transfer bertanda tangan lalu aktifkan listing (→ ACTIVE)',
  })
  submitEscrow(
    @Param('id') id: string,
    @Body() dto: SubmitEscrowDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.marketplace.submitEscrow(id, dto, user);
  }
}
