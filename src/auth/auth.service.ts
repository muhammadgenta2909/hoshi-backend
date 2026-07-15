import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PublicKey } from '@solana/web3.js';
import { randomBytes } from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /** Message yang ditandatangani user. WAJIB identik dengan yang dibangun frontend. */
  private buildLoginMessage(walletAddress: string, nonce: string): string {
    return `Login ke Hoshi\nWallet: ${walletAddress}\nNonce: ${nonce}`;
  }

  /** Langkah 1: terbitkan nonce + message untuk wallet ini. */
  async requestNonce(walletAddress: string) {
    this.assertValidAddress(walletAddress);
    const nonce = randomBytes(16).toString('hex');
    await this.prisma.user.upsert({
      where: { walletAddress },
      update: { nonce },
      create: { walletAddress, nonce },
    });
    return { message: this.buildLoginMessage(walletAddress, nonce), nonce };
  }

  /** Langkah 2: verifikasi signature → terbitkan JWT. */
  async login(walletAddress: string, signature: string) {
    this.assertValidAddress(walletAddress);
    const user = await this.prisma.user.findUnique({
      where: { walletAddress },
    });
    if (!user || !user.nonce) {
      throw new UnauthorizedException('Minta nonce dulu via POST /auth/nonce.');
    }

    const message = this.buildLoginMessage(walletAddress, user.nonce);
    if (!this.verifySignature(walletAddress, message, signature)) {
      throw new UnauthorizedException('Invalid signature.');
    }

    // Konsumsi nonce ATOMIK: updateMany dengan predikat nonce → hanya SATU request
    // yang berhasil mengosongkan nonce. Mencegah replay & double-issue saat balapan.
    const consumed = await this.prisma.user.updateMany({
      where: { id: user.id, nonce: user.nonce },
      data: { nonce: null },
    });
    if (consumed.count !== 1) {
      throw new UnauthorizedException('Nonce already used. Request a new nonce.');
    }

    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      wallet: user.walletAddress,
    });

    return {
      accessToken,
      user: {
        id: user.id,
        walletAddress: user.walletAddress,
        displayName: user.displayName,
        // WAJIB: frontend memakai user.role untuk isAdmin (mis. membuka tombol
        // tarik pack devnet). Tanpa baris ini role selalu undefined di klien →
        // admin yang sah pun terkunci walau role-nya sudah ADMIN di DB.
        role: user.role,
      },
    };
  }

  private verifySignature(
    walletAddress: string,
    message: string,
    signature: string,
  ): boolean {
    try {
      const pubkey = new PublicKey(walletAddress).toBytes();
      const sig = bs58.decode(signature);
      const msg = new TextEncoder().encode(message);
      return nacl.sign.detached.verify(msg, sig, pubkey);
    } catch {
      return false;
    }
  }

  private assertValidAddress(walletAddress: string): PublicKey {
    try {
      return new PublicKey(walletAddress);
    } catch {
      throw new BadRequestException(
        'walletAddress bukan alamat Solana yang valid.',
      );
    }
  }
}
