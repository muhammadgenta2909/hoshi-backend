import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCardDto } from './dto/create-card.dto';
import { UpdateCardDto } from './dto/update-card.dto';

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateCardDto) {
    return this.prisma.card.create({
      data: {
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        set: dto.set,
        rarity: dto.rarity,
        metadataUri: dto.metadataUri,
        attributes: this.toJson(dto.attributes),
      },
    });
  }

  findAll() {
    return this.prisma.card.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('Card tidak ditemukan.');
    return card;
  }

  async update(id: string, dto: UpdateCardDto) {
    await this.findOne(id);
    return this.prisma.card.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        imageUrl: dto.imageUrl,
        set: dto.set,
        rarity: dto.rarity,
        metadataUri: dto.metadataUri,
        attributes: this.toJson(dto.attributes),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.prisma.card.delete({ where: { id } });
    return { deleted: true, id };
  }

  // undefined → field tidak diubah (Prisma skip). Hindari masalah typing null Json.
  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    return value == null ? undefined : value;
  }
}
