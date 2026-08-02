import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, clusterApiUrl } from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset, mplCore, transferV1 } from '@metaplex-foundation/mpl-core';
import {
  createNoopSigner,
  keypairIdentity,
  publicKey,
  type Umi,
} from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';

/** Tunggu NFT benar-benar dimiliki escrow sebelum diteruskan keluar (broadcast != final). */
const OWNERSHIP_RETRIES = 10;
const POLL_MS = 3_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wallet ESCROW Hoshi — pemegang sementara kartu USER yang sedang dijual (Flow B P2P).
 *
 * SENGAJA terpisah dari TreasuryService (yang megang USDC): kalau satu key bocor, yang lain
 * aman. Kunci dibaca dari `HOSHI_ESCROW_SECRET_KEY` (JSON byte array, sama format seperti
 * treasury/platform), lazy, dan TIDAK PERNAH muncul di log/error/response.
 *
 * Dua peran:
 *  1. `buildTransferToEscrowTx` — bangun transaksi (BELUM ditandatangani) yang MEMINDAHKAN kartu
 *     dari wallet PENJUAL ke escrow. Penjual yang menandatangani (dia pemilik on-chain-nya);
 *     escrow tidak. Dipakai saat listing.
 *  2. `transferCoreAssetTo` — escrow (pemilik saat kartu sudah dititip) MENGIRIM kartu ke
 *     pembeli (saat terjual) atau balik ke penjual (saat cancel). Escrow yang menandatangani.
 */
@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);
  private keypair: Keypair | null = null;
  private escrowUmi: Umi | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    const raw = this.config.get<string>('HOSHI_ESCROW_SECRET_KEY');
    return typeof raw === 'string' && raw.trim().length > 0;
  }

  /** Alamat publik escrow — ke sinilah kartu penjual dipindahkan saat listing. */
  get publicKey(): string {
    return this.getKeypair().publicKey.toBase58();
  }

  /**
   * Bangun transaksi transfer kartu PENJUAL → ESCROW, BELUM ditandatangani. Penjual (pemilik
   * on-chain) yang jadi authority + fee payer, jadi cuma DIA yang perlu tanda tangan. Kembalikan
   * base64 (web3-compatible) untuk ditandatangani wallet penjual di frontend.
   */
  async buildTransferToEscrowTx(params: {
    assetAddress: string;
    ownerWallet: string;
  }): Promise<string> {
    const umi = this.getEscrowUmi();
    const escrowPk = umi.identity.publicKey;
    const asset = publicKey(params.assetAddress);

    let sellerSigner;
    try {
      sellerSigner = createNoopSigner(publicKey(params.ownerWallet));
    } catch {
      throw new BadRequestException('Alamat pemilik kartu tidak valid.');
    }

    // Baca collection (transferV1 wajib collection kalau asset bagian koleksi) + pastikan
    // kartu memang dimiliki si penjual sebelum membangun transfer.
    const fetched = await fetchAsset(umi, asset);
    if (String(fetched.owner) !== String(sellerSigner.publicKey)) {
      throw new BadRequestException(
        'Kartu ini bukan milik wallet Anda (on-chain) — tidak bisa dilisting.',
      );
    }
    const collection =
      fetched.updateAuthority.type === 'Collection'
        ? (fetched.updateAuthority.address ?? undefined)
        : undefined;

    const builder = transferV1(umi, {
      asset,
      newOwner: escrowPk,
      authority: sellerSigner, // penjual menandatangani pemindahan (dia pemilik)
      collection,
    }).setFeePayer(sellerSigner); // penjual bayar gas → hanya satu penanda tangan
    const tx = await builder.buildWithLatestBlockhash(umi);
    return Buffer.from(umi.transactions.serialize(tx)).toString('base64');
  }

  /**
   * Broadcast transaksi transfer-ke-escrow yang SUDAH ditandatangani penjual, lalu pastikan
   * escrow benar-benar memiliki kartunya. Kembalikan signature (base58).
   */
  async broadcastSignedToEscrow(signedBase64: string): Promise<string> {
    const umi = this.getEscrowUmi();
    let signature: Uint8Array;
    try {
      const tx = umi.transactions.deserialize(
        Buffer.from(signedBase64, 'base64'),
      );
      signature = await umi.rpc.sendTransaction(tx);
      await umi.rpc.confirmTransaction(signature, {
        strategy: {
          type: 'blockhash',
          ...(await umi.rpc.getLatestBlockhash()),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ServiceUnavailableException(
        `Gagal menyiarkan transfer kartu ke escrow: ${msg}`,
      );
    }
    return base58.deserialize(signature)[0];
  }

  /**
   * Transfer kartu yang SEDANG dimiliki escrow ke pemilik baru (pembeli saat terjual, atau
   * balik ke penjual saat cancel). Escrow yang menandatangani. Broadcast via RPC Hoshi sendiri.
   * Tunggu kartu benar-benar di escrow dulu (jaga-jaga belum final). Kembalikan signature base58.
   */
  async transferCoreAssetTo(params: {
    assetAddress: string;
    newOwner: string;
  }): Promise<string> {
    const umi = this.getEscrowUmi();
    const escrowPk = String(umi.identity.publicKey);
    const asset = publicKey(params.assetAddress);

    let newOwnerPk: ReturnType<typeof publicKey>;
    try {
      newOwnerPk = publicKey(params.newOwner);
    } catch {
      throw new BadRequestException('Alamat penerima kartu tidak valid.');
    }

    let collection: ReturnType<typeof publicKey> | undefined;
    let owned = false;
    for (let i = 0; i < OWNERSHIP_RETRIES; i++) {
      try {
        const fetched = await fetchAsset(umi, asset);
        if (String(fetched.owner) === escrowPk) {
          collection =
            fetched.updateAuthority.type === 'Collection'
              ? (fetched.updateAuthority.address ?? undefined)
              : undefined;
          owned = true;
          break;
        }
      } catch {
        /* belum terindeks / belum final — coba lagi */
      }
      await sleep(POLL_MS);
    }
    if (!owned) {
      throw new Error(
        `Kartu ${params.assetAddress} belum dimiliki escrow — transfer ditunda.`,
      );
    }

    const { signature } = await transferV1(umi, {
      asset,
      newOwner: newOwnerPk,
      collection,
    }).sendAndConfirm(umi);
    return base58.deserialize(signature)[0];
  }

  /* --- internal --- */

  private getKeypair(): Keypair {
    if (this.keypair) return this.keypair;
    const secretRaw = this.config.get<string>('HOSHI_ESCROW_SECRET_KEY');
    if (!secretRaw || secretRaw.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Wallet escrow Hoshi belum dikonfigurasi. Set HOSHI_ESCROW_SECRET_KEY ' +
          '(JSON byte array, lihat .env.example).',
      );
    }
    let secret: Uint8Array;
    try {
      secret = Uint8Array.from(JSON.parse(secretRaw) as number[]);
    } catch {
      throw new InternalServerErrorException(
        'HOSHI_ESCROW_SECRET_KEY harus JSON byte array (bukan base58).',
      );
    }
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecretKey(secret);
    } catch {
      throw new InternalServerErrorException(
        'HOSHI_ESCROW_SECRET_KEY bukan secret key Solana yang sah (harus 64 byte).',
      );
    }
    this.keypair = keypair;
    this.logger.log(`Escrow siap (${keypair.publicKey.toBase58()})`);
    return keypair;
  }

  private getEscrowUmi(): Umi {
    if (this.escrowUmi) return this.escrowUmi;
    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    const umi = createUmi(endpoint).use(mplCore());
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(
      this.getKeypair().secretKey,
    );
    umi.use(keypairIdentity(umiKeypair));
    this.escrowUmi = umi;
    return umi;
  }
}
