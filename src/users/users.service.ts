import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ShippingAddress, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';

/**
 * Batas alamat pengiriman per user. Alamat itu murah ditulis dan tidak pernah
 * kedaluwarsa — tanpa plafon, satu akun iseng bisa menimbun baris tanpa batas.
 */
const MAX_ADDRESSES = 5;

/** Bentuk publik satu alamat pengiriman — tanpa userId (redundan di endpoint /me). */
export interface ShippingAddressDto {
  id: string;
  fullName: string;
  country: string;
  street: string;
  apt: string | null;
  state: string | null;
  city: string;
  phoneCountryCode: string | null;
  phoneNumber: string | null;
  zip: string;
  isDefault: boolean;
  createdAt: Date;
}

/** String kosong = perintah "hapus nilainya" → simpan null, bukan "". */
const emptyToNull = (value: string): string | null =>
  value === '' ? null : value;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Profil user + jumlah NFT & item vault. Tidak membocorkan nonce/passwordHash. */
  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { _count: { select: { nfts: true, vaultItems: true } } },
    });
    if (!user) throw new NotFoundException('User not found.');
    return {
      ...toProfileDto(user),
      counts: user._count,
    };
  }

  /**
   * Ubah profil sendiri. Semua field opsional — hanya field yang DIKIRIM yang
   * disentuh; string kosong pada field nullable berarti "hapus" (disimpan null).
   * displayName tetap wajib 1-32 karakter (nama inilah yang tampil di feed From/To).
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const data: Prisma.UserUpdateInput = {};
    if (dto.displayName !== undefined) data.displayName = dto.displayName;
    if (dto.bio !== undefined) data.bio = emptyToNull(dto.bio);
    if (dto.twitter !== undefined) data.twitter = emptyToNull(dto.twitter);
    if (dto.website !== undefined) data.website = emptyToNull(dto.website);
    if (dto.phoneCountryCode !== undefined)
      data.phoneCountryCode = emptyToNull(dto.phoneCountryCode);
    if (dto.phoneNumber !== undefined)
      data.phoneNumber = emptyToNull(dto.phoneNumber);

    if (Object.keys(data).length === 0) {
      throw new BadRequestException('Nothing to update.');
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    return toProfileDto(user);
  }

  /* --- Alamat pengiriman (redeem kartu fisik) --- */

  /** Alamat milik user login: default dulu, lalu terbaru. */
  async listAddresses(userId: string): Promise<ShippingAddressDto[]> {
    const rows = await this.prisma.shippingAddress.findMany({
      where: { userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(toShippingAddressDto);
  }

  /**
   * Tambah alamat. Dalam SATU transaksi SERIALIZABLE: cek plafon, lepas default lama
   * (bila alamat baru default), lalu tulis.
   *
   * Serializable itu WAJIB, bukan hiasan: default Postgres (READ COMMITTED) tidak
   * melihat baris yang belum di-commit transaksi lain, jadi dua POST bersamaan bisa
   * (a) sama-sama membaca count<5 lalu sama-sama insert (plafon jebol jadi 6), atau
   * (b) sama-sama menjalankan clear-defaults tanpa melihat baris satu sama lain
   * (berakhir dua isDefault=true → urutan default-first di listAddresses rusak).
   * Serializable membuat Postgres mendeteksi write-skew/phantom itu dan MEMBATALKAN
   * salah satu transaksi (Prisma memunculkan P2034). Untuk POC ini P2034 langka pada
   * double-submit asli bisa diterima — frontend menonaktifkan tombol Add saat submit.
   */
  async createAddress(
    userId: string,
    dto: CreateAddressDto,
  ): Promise<ShippingAddressDto> {
    const created = await this.prisma.$transaction(
      async (tx) => {
        const count = await tx.shippingAddress.count({ where: { userId } });
        if (count >= MAX_ADDRESSES) {
          throw new BadRequestException(
            `Maksimal ${MAX_ADDRESSES} alamat. Hapus salah satu alamat lama dulu.`,
          );
        }
        if (dto.isDefault) {
          await tx.shippingAddress.updateMany({
            where: { userId, isDefault: true },
            data: { isDefault: false },
          });
        }
        return tx.shippingAddress.create({
          data: {
            userId,
            fullName: dto.fullName,
            country: dto.country,
            street: dto.street,
            apt: dto.apt ?? null,
            state: dto.state ?? null,
            city: dto.city,
            phoneCountryCode: dto.phoneCountryCode ?? null,
            phoneNumber: dto.phoneNumber ?? null,
            zip: dto.zip,
            isDefault: dto.isDefault ?? false,
          },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return toShippingAddressDto(created);
  }

  /**
   * Hapus alamat MILIK SENDIRI. id alamat bukan kapabilitas — tanpa filter userId,
   * siapa pun yang tahu (atau menebak) sebuah id bisa menghapus alamat orang lain.
   * Alamat orang lain dijawab NotFound (bukan Forbidden) supaya id yang ada/tidak
   * ada tak bisa dibedakan dari luar.
   */
  async deleteAddress(
    userId: string,
    addressId: string,
  ): Promise<ShippingAddressDto> {
    const row = await this.prisma.shippingAddress.findFirst({
      where: { id: addressId, userId },
    });
    if (!row) throw new NotFoundException('Alamat tidak ditemukan.');
    // P2025 (sudah keburu dihapus request lain) → 404 lewat PrismaExceptionFilter.
    await this.prisma.shippingAddress.delete({ where: { id: row.id } });
    return toShippingAddressDto(row);
  }
}

/** Bentuk profil publik — SATU sumber untuk GET & PATCH /users/me (tanpa nonce dkk). */
function toProfileDto(user: User) {
  return {
    id: user.id,
    walletAddress: user.walletAddress,
    displayName: user.displayName,
    email: user.email,
    bio: user.bio,
    twitter: user.twitter,
    website: user.website,
    phoneCountryCode: user.phoneCountryCode,
    phoneNumber: user.phoneNumber,
    createdAt: user.createdAt,
  };
}

/** Baris DB → bentuk publik (buang userId & updatedAt). */
function toShippingAddressDto(row: ShippingAddress): ShippingAddressDto {
  return {
    id: row.id,
    fullName: row.fullName,
    country: row.country,
    street: row.street,
    apt: row.apt,
    state: row.state,
    city: row.city,
    phoneCountryCode: row.phoneCountryCode,
    phoneNumber: row.phoneNumber,
    zip: row.zip,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
  };
}
