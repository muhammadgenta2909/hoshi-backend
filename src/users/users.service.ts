import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Profil user + jumlah NFT & item vault. Tidak membocorkan nonce. */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { nfts: true, vaultItems: true } } },
    });
    if (!user) throw new NotFoundException('User not found.');
    return {
      id: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      createdAt: user.createdAt,
      counts: user._count,
    };
  }

  /** Ubah nama tampilan sendiri. Nama inilah yang tampil di kolom From/To feed. */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    if (dto.displayName === undefined) {
      throw new BadRequestException('Nothing to update.');
    }
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: dto.displayName },
    });
    return {
      id: user.id,
      walletAddress: user.walletAddress,
      displayName: user.displayName,
      createdAt: user.createdAt,
    };
  }
}
