import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminGuard } from '../auth/admin.guard';
import { CardsService } from './cards.service';
import { CreateCardDto } from './dto/create-card.dto';
import { UpdateCardDto } from './dto/update-card.dto';

@ApiTags('cards')
@Controller('cards')
export class CardsController {
  constructor(private readonly cards: CardsService) {}

  @Get()
  @ApiOperation({ summary: 'List semua card (katalog) — publik' })
  findAll() {
    return this.cards.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detail satu card — publik' })
  findOne(@Param('id') id: string) {
    return this.cards.findOne(id);
  }

  // Mutasi katalog = ADMIN ONLY. Sebelumnya cukup JwtAuthGuard, artinya user mana
  // pun yang login bisa membuat/mengubah/menghapus kartu katalog — padahal Card
  // dirujuk oleh Nft, VaultItem, dan Listing. Tidak ada UI yang memakai endpoint
  // ini (admin memakai /admin/*), jadi mengetatkannya tidak memutus fitur apa pun.
  @Post()
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Create a new card (ADMIN ONLY)' })
  create(@Body() dto: CreateCardDto) {
    return this.cards.create(dto);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Update card (ADMIN ONLY)' })
  update(@Param('id') id: string, @Body() dto: UpdateCardDto) {
    return this.cards.update(id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  @ApiOperation({ summary: 'Delete card (ADMIN ONLY)' })
  remove(@Param('id') id: string) {
    return this.cards.remove(id);
  }
}
