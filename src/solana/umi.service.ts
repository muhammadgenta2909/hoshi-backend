import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { create, mplCore } from '@metaplex-foundation/mpl-core';
import {
  generateSigner,
  keypairIdentity,
  publicKey,
  type Umi,
} from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { clusterApiUrl } from '@solana/web3.js';

export interface MintResult {
  assetAddress: string;
  signature: string;
}

/**
 * Helper Umi (port dari POC lib/umi.ts). Identity/payer = keypair platform.
 * Platform yang bayar mint; ownership di-assign ke wallet user saat create().
 */
@Injectable()
export class UmiService {
  private readonly logger = new Logger(UmiService.name);
  private umi: Umi | null = null;

  constructor(private readonly config: ConfigService) {}

  private getUmi(): Umi {
    if (this.umi) return this.umi;

    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    const secretRaw = this.config.get<string>('PLATFORM_SECRET_KEY');
    if (!secretRaw) {
      throw new InternalServerErrorException(
        'PLATFORM_SECRET_KEY belum di-set (lihat .env.example).',
      );
    }

    let secret: Uint8Array;
    try {
      secret = Uint8Array.from(JSON.parse(secretRaw) as number[]);
    } catch {
      throw new InternalServerErrorException(
        'PLATFORM_SECRET_KEY harus JSON byte array (isi platform.json).',
      );
    }

    const umi = createUmi(endpoint).use(mplCore());
    const keypair = umi.eddsa.createKeypairFromSecretKey(secret);
    umi.use(keypairIdentity(keypair));
    this.umi = umi;
    this.logger.log(
      `Umi siap (payer/platform: ${keypair.publicKey.toString()})`,
    );
    return umi;
  }

  /** Alamat platform (payer + update authority). */
  get platformAddress(): string {
    return this.getUmi().identity.publicKey.toString();
  }

  /** Mint Metaplex Core asset; owner = wallet user. */
  async mintCoreAsset(params: {
    ownerAddress: string;
    name: string;
    uri: string;
  }): Promise<MintResult> {
    const umi = this.getUmi();
    const asset = generateSigner(umi);

    const { signature } = await create(umi, {
      asset,
      name: params.name,
      uri: params.uri,
      owner: publicKey(params.ownerAddress),
    }).sendAndConfirm(umi);

    return {
      assetAddress: asset.publicKey.toString(),
      signature: base58.deserialize(signature)[0],
    };
  }
}
