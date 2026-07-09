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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
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

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create a new card (login required)' })
  create(@Body() dto: CreateCardDto) {
    return this.cards.create(dto);
  }

  @Patch(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Update card (login required)' })
  update(@Param('id') id: string, @Body() dto: UpdateCardDto) {
    return this.cards.update(id, dto);
  }

  @Delete(':id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Delete card (login required)' })
  remove(@Param('id') id: string) {
    return this.cards.remove(id);
  }
}
