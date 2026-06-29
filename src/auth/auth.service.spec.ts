import { Test } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';

// @solana/web3.js menarik rantai ESM (rpc-websockets→uuid) yang bikin jest gagal parse.
// Service cuma butuh PublicKey(.toBytes / validasi 32-byte), jadi kita ganti dgn impl mungil
// berbasis bs58. Verifikasi tanda tangan ed25519 yang sebenarnya TETAP jalan via tweetnacl.
jest.mock('@solana/web3.js', () => {
  // require di dalam factory wajib: jest meng-hoist jest.mock di atas import,
  // jadi variabel import (bs58) belum terinisialisasi saat factory dievaluasi.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('bs58') as
    | { decode: (s: string) => Uint8Array }
    | { default: { decode: (s: string) => Uint8Array } };
  const decode = 'decode' in mod ? mod.decode : mod.default.decode;
  return {
    PublicKey: class PublicKey {
      private readonly bytes: Uint8Array;
      constructor(address: string) {
        const decoded = decode(address);
        if (decoded.length !== 32) throw new Error('Invalid public key input');
        this.bytes = decoded;
      }
      toBytes(): Uint8Array {
        return this.bytes;
      }
    },
  };
});

// Bikin wallet + signature base58 valid untuk sebuah nonce — meniru persis frontend
// (wallet.signMessage atas message yang dikembalikan /auth/nonce).
function signWalletFor(nonce: string) {
  const kp = nacl.sign.keyPair();
  const walletAddress = bs58.encode(kp.publicKey);
  const message = `Login ke Hoshi\nWallet: ${walletAddress}\nNonce: ${nonce}`;
  const signature = bs58.encode(
    nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey),
  );
  return { walletAddress, signature };
}

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { upsert: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
  };
  let jwt: { signAsync: jest.Mock };

  beforeEach(async () => {
    prisma = {
      user: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed.jwt.token') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('requestNonce', () => {
    it('menerbitkan message berisi wallet + nonce, lalu meng-upsert user', async () => {
      const { walletAddress } = signWalletFor('x');
      prisma.user.upsert.mockResolvedValue({});

      const res = await service.requestNonce(walletAddress);

      expect(res.nonce).toEqual(expect.any(String));
      expect(res.message).toContain(walletAddress);
      expect(res.message).toContain(res.nonce);
      expect(res.message.startsWith('Login ke Hoshi')).toBe(true);
      expect(prisma.user.upsert).toHaveBeenCalledTimes(1);
    });

    it('menolak wallet address tidak valid (BadRequest)', async () => {
      await expect(service.requestNonce('bukan-address')).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.user.upsert).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    it('sukses: signature valid → konsumsi nonce atomik → terbitkan JWT', async () => {
      const nonce = 'nonce-abc';
      const { walletAddress, signature } = signWalletFor(nonce);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        walletAddress,
        nonce,
        displayName: null,
      });
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      const res = await service.login(walletAddress, signature);

      expect(res.accessToken).toBe('signed.jwt.token');
      expect(res.user).toEqual({
        id: 'user-1',
        walletAddress,
        displayName: null,
      });
      // Konsumsi nonce ATOMIK: updateMany dengan predikat nonce lama → null.
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', nonce },
        data: { nonce: null },
      });
    });

    it('anti-replay: nonce sudah kosong (sudah dipakai) → Unauthorized', async () => {
      const { walletAddress, signature } = signWalletFor('whatever');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        walletAddress,
        nonce: null,
        displayName: null,
      });

      await expect(service.login(walletAddress, signature)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('anti-replay: kalah balapan konsumsi nonce (count=0) → Unauthorized, tanpa JWT', async () => {
      const nonce = 'nonce-race';
      const { walletAddress, signature } = signWalletFor(nonce);
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        walletAddress,
        nonce,
        displayName: null,
      });
      prisma.user.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.login(walletAddress, signature)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(jwt.signAsync).not.toHaveBeenCalled();
    });

    it('signature tidak cocok dengan message/nonce → Unauthorized', async () => {
      const nonce = 'nonce-real';
      const { walletAddress } = signWalletFor(nonce);
      // Signature sah format tapi dari keypair LAIN → verifikasi harus gagal.
      const other = signWalletFor('nonce-lain');
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        walletAddress,
        nonce,
        displayName: null,
      });

      await expect(
        service.login(walletAddress, other.signature),
      ).rejects.toThrow(UnauthorizedException);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('user belum minta nonce / tidak ada → Unauthorized', async () => {
      const { walletAddress, signature } = signWalletFor('x');
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login(walletAddress, signature)).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('wallet address tidak valid → BadRequest', async () => {
      await expect(service.login('bukan-address', 'sig')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
