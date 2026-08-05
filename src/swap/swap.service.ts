import {
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { CcPackStatus, SwapStatus } from '@prisma/client';
import type { SwapRequest } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSwapDto } from './dto/create-swap.dto';

export type SwapRequestDto = {
  id: string;
  offeredNftAddress: string;
  offeredCardName: string;
  offeredCardImage: string | null;
  recipientMethod: string;
  recipientValue: string;
  status: SwapStatus;
  createdAt: Date;
};

function toDto(r: SwapRequest): SwapRequestDto {
  return {
    id: r.id,
    offeredNftAddress: r.offeredNftAddress,
    offeredCardName: r.offeredCardName,
    offeredCardImage: r.offeredCardImage,
    recipientMethod: r.recipientMethod,
    recipientValue: r.recipientValue,
    status: r.status,
    createdAt: r.createdAt,
  };
}

/**
 * Ajakan tukar kartu (swap) antar kolektor — barter, tanpa uang.
 *
 * RECORD-ONLY (MVP): mencatat ajakan + kartu yang ditawarkan + tujuan kontak. TIDAK transfer/burn
 * kartu, TIDAK menyentuh treasury/on-chain — akseptasi & perpindahan kartu belum ada di fase ini.
 */
@Injectable()
export class SwapService {
  private readonly logger = new Logger(SwapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async request(dto: CreateSwapDto, user: AuthUser): Promise<SwapRequestDto> {
    // Kepemilikan lewat LEDGER: kartu yang ditawarkan harus hasil pack user yang OPENED.
    const pull = await this.prisma.ccPackPurchase.findFirst({
      where: {
        userId: user.id,
        nftAddress: dto.offeredNftAddress,
        status: CcPackStatus.OPENED,
      },
    });
    if (!pull) {
      this.logger.warn(
        `Swap ditolak: NFT ${dto.offeredNftAddress} bukan hasil pack user ${user.id}.`,
      );
      throw new ForbiddenException(
        'Kartu ini bukan hasil pack yang Anda buka di Hoshi.',
      );
    }

    const offeredCardName = pull.ccItemName ?? pull.nftName ?? 'Kartu';
    const offeredCardImage = pull.nftImage ?? null;

    const created = await this.prisma.swapRequest.create({
      data: {
        proposerId: user.id,
        offeredNftAddress: dto.offeredNftAddress,
        offeredCardName,
        offeredCardImage,
        recipientMethod: dto.recipientMethod,
        recipientValue: dto.recipientValue.trim(),
        status: SwapStatus.REQUESTED,
      },
    });

    this.logger.log(
      `SwapRequest ${created.id} REQUESTED: NFT ${dto.offeredNftAddress} → ` +
        `${dto.recipientMethod}:${dto.recipientValue} (user ${user.id}). RECORD-ONLY.`,
    );
    return toDto(created);
  }

  async listMine(userId: string): Promise<SwapRequestDto[]> {
    const rows = await this.prisma.swapRequest.findMany({
      where: { proposerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map(toDto);
  }
}
