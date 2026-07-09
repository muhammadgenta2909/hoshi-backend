import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsInt, IsString, Min } from 'class-validator';

class SubmitOfferDto {
  @ApiProperty() @IsString() user!: string;
  @ApiProperty() @IsInt() @Min(1) amount!: number;
}
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreateListingDto } from './dto/create-listing.dto';
import { QueryListingDto } from './dto/query-listing.dto';
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
  @ApiOperation({ summary: 'Cards purchased by logged-in user (Vault/collection)' })
  listPurchases(@CurrentUser() user: AuthUser) {
    return this.marketplace.listPurchases(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail satu listing (bundel Figma) — publik, read-only' })
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
  @ApiOperation({ summary: 'Submit offer by buyer (publik)' })
  submitOffer(@Param('id') id: string, @Body() dto: SubmitOfferDto) {
    return this.marketplace.submitOffer(id, dto.user, dto.amount);
  }

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List card on marketplace (login required)' })
  create(@Body() dto: CreateListingDto, @CurrentUser() user: AuthUser) {
    return this.marketplace.create(dto, user);
  }

  @Post(':id/buy')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Beli listing (ACTIVE→SOLD) lalu mint NFT ke buyer' })
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
}
