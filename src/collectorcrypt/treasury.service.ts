import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Keypair,
  Transaction,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset, mplCore, transferV1 } from '@metaplex-foundation/mpl-core';
import { keypairIdentity, publicKey, type Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';

/** Menunggu NFT benar-benar mendarat di treasury setelah broadcast beli CC (broadcast =
 *  "terkirim", belum tentu final) sebelum meneruskannya ke pembeli. ~30 detik total. */
const TRANSFER_OWNERSHIP_RETRIES = 10;
const TRANSFER_POLL_MS = 3_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Dompet TREASURY Hoshi — pemegang USDC yang MEMBAYAR setiap pack.
 *
 * User Indonesia bayar rupiah dan tidak punya USDC/SOL, jadi merekalah yang
 * TIDAK menandatangani apa pun: treasury yang jadi `playerAddress` (pembayar +
 * penanda tangan), sementara wallet user dikirim sebagai `altPlayerAddress`
 * (penerima kartu). Service ini adalah satu-satunya tempat di backend yang
 * memegang private key dan membubuhkan tanda tangan.
 *
 * Key dibaca LAZY (bukan saat boot) supaya aplikasi tetap bisa start tanpa
 * treasury — pola yang sama dipakai UmiService (PLATFORM_SECRET_KEY) dan
 * CcGachaClient.credentials(). Formatnya pun sengaja disamakan dengan
 * PLATFORM_SECRET_KEY: JSON byte array, bukan base58. Satu format saja di repo ini.
 *
 * RAHASIA: secret key tidak boleh muncul di log, di pesan error, atau di response —
 * levelnya sama dengan uang tunai. Alamat publiknya boleh (memang publik).
 */
@Injectable()
export class TreasuryService {
  private readonly logger = new Logger(TreasuryService.name);
  private keypair: Keypair | null = null;
  private treasuryUmi: Umi | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Apakah treasury sudah dikonfigurasi. Cek keberadaan saja — tidak pernah melempar. */
  isConfigured(): boolean {
    const raw = this.config.get<string>('HOSHI_TREASURY_SECRET_KEY');
    return typeof raw === 'string' && raw.trim().length > 0;
  }

  /** Alamat base58 treasury. Inilah yang dikirim ke CC sebagai `playerAddress`. */
  get publicKey(): string {
    return this.getKeypair().publicKey.toBase58();
  }

  /**
   * Tanda tangani transaksi yang DIBUAT CollectorCrypt: base64 masuk, base64
   * ber-tanda tangan keluar.
   *
   * Menangani legacy `Transaction` DAN `VersionedTransaction`: CC tidak
   * mendokumentasikan yang mana yang mereka kembalikan, dan menebak salah berarti
   * SEMUA pembelian gagal di produksi.
   *
   * Semantiknya PARTIAL SIGN — tanda tangan yang sudah ada dipertahankan, dan
   * transaksi yang belum lengkap tanda tangannya tetap boleh diserialisasi.
   */
  sign(base64Tx: string): string {
    const keypair = this.getKeypair();
    const raw = this.decodeBase64(base64Tx);
    const tx = this.deserialize(raw);

    if (tx instanceof VersionedTransaction) {
      this.signOrExplain(() => tx.sign([keypair]));
      return Buffer.from(tx.serialize()).toString('base64');
    }

    this.signOrExplain(() => tx.partialSign(keypair));
    // WAJIB kedua flag: default serialize() legacy menuntut SEMUA signature sudah
    // terisi dan akan melempar untuk transaksi yang baru ditandatangani treasury.
    return tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64');
  }

  /**
   * Transfer aset Metaplex Core yang SEDANG dimiliki treasury ke wallet pembeli.
   *
   * Dipakai jalur RESELLER: setelah treasury membeli kartu di CC (USDC keluar, NFT mendarat
   * di treasury), kartu WAJIB diteruskan ke pembeli. Berbeda dari sign() yang mendelegasikan
   * broadcast ke CC, transfer ini DISIARKAN via RPC Hoshi sendiri (umi.sendAndConfirm) — CC
   * broadcast punya allow-list program dan akan menolak transfer Core kita (403).
   *
   * broadcast CC = "terkirim", belum tentu final: kita POLL sampai NFT benar-benar dimiliki
   * treasury dulu. Kalau tak kunjung sampai → LEMPAR (jangan transfer aset yang belum ada;
   * itu hanya akan gagal setengah jalan). Mengembalikan signature transfer (base58).
   */
  async transferCoreAssetToBuyer(params: {
    assetAddress: string;
    newOwner: string;
  }): Promise<string> {
    const umi = this.getTreasuryUmi();
    const treasuryPk = String(umi.identity.publicKey);
    const asset = publicKey(params.assetAddress);

    let newOwnerPk: ReturnType<typeof publicKey>;
    try {
      newOwnerPk = publicKey(params.newOwner);
    } catch {
      throw new BadRequestException('Alamat pembeli tidak valid untuk transfer NFT.');
    }

    // Tunggu NFT mendarat di treasury (buy CC masih mengonfirmasi) sambil membaca collection-nya
    // (transferV1 WAJIB menyertakan collection kalau asset bagian dari koleksi).
    let collection: ReturnType<typeof publicKey> | undefined;
    let owned = false;
    for (let i = 0; i < TRANSFER_OWNERSHIP_RETRIES; i++) {
      try {
        const fetched = await fetchAsset(umi, asset);
        if (String(fetched.owner) === treasuryPk) {
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
      await sleep(TRANSFER_POLL_MS);
    }
    if (!owned) {
      throw new Error(
        `NFT ${params.assetAddress} belum dimiliki treasury setelah pembelian — transfer ditunda.`,
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

  /** Umi ber-identitas TREASURY (untuk transfer Core asset). Lazy, dimemoisasi. Kunci treasury
   *  tetap terkurung di service ini — hanya SIGNER-nya yang dipasang ke umi. */
  private getTreasuryUmi(): Umi {
    if (this.treasuryUmi) return this.treasuryUmi;
    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    const umi = createUmi(endpoint).use(mplCore());
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(
      this.getKeypair().secretKey,
    );
    umi.use(keypairIdentity(umiKeypair));
    this.treasuryUmi = umi;
    return umi;
  }

  /**
   * Key dibaca sekali lalu dimemoisasi. Tanpa key, fitur gacha treasury memang
   * tidak tersedia — bukan crash saat boot, tapi error jelas saat dipakai.
   */
  private getKeypair(): Keypair {
    if (this.keypair) return this.keypair;

    const secretRaw = this.config.get<string>('HOSHI_TREASURY_SECRET_KEY');
    if (!secretRaw || secretRaw.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Treasury Hoshi belum dikonfigurasi. Set HOSHI_TREASURY_SECRET_KEY ' +
          '(JSON byte array, lihat .env.example) di environment.',
      );
    }

    let secret: Uint8Array;
    try {
      secret = Uint8Array.from(JSON.parse(secretRaw) as number[]);
    } catch {
      // Sengaja TIDAK menyertakan error asli maupun potongan nilainya: apa pun yang
      // berasal dari secret ini tidak boleh mampir ke log atau ke response.
      throw new InternalServerErrorException(
        'HOSHI_TREASURY_SECRET_KEY harus JSON byte array (isi treasury.json), bukan base58.',
      );
    }

    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecretKey(secret);
    } catch {
      throw new InternalServerErrorException(
        'HOSHI_TREASURY_SECRET_KEY bukan secret key Solana yang sah ' +
          '(harus 64 byte dari solana-keygen).',
      );
    }

    // Konsistensi WAJIB: PaymentsService memakai HOSHI_TREASURY_ADDRESS sebagai tujuan
    // mint IDRX (ke mana rupiah user berubah jadi USDC), sedangkan pembayaran pack
    // ditandatangani oleh key INI. Kalau keduanya berbeda wallet — mis. env belum
    // di-update setelah rotasi key — IDRX mencetak ke wallet A tapi treasury bayar dari
    // wallet B: rugi diam-diam tiap pack. Ditegakkan di sini, bukan cuma di komentar.
    const address = keypair.publicKey.toBase58();
    const configured = this.config
      .get<string>('HOSHI_TREASURY_ADDRESS')
      ?.trim();
    if (configured && configured !== address) {
      throw new InternalServerErrorException(
        'HOSHI_TREASURY_ADDRESS tidak cocok dengan alamat dari HOSHI_TREASURY_SECRET_KEY. ' +
          'Tujuan mint IDRX dan penanda tangan pack HARUS wallet yang sama.',
      );
    }

    this.keypair = keypair;
    // Alamat publik boleh dicatat — justru berguna untuk memastikan environment
    // menunjuk ke treasury yang benar sebelum uang bergerak.
    this.logger.log(`Treasury siap (payer: ${address})`);
    return keypair;
  }

  private decodeBase64(base64Tx: string): Buffer {
    const raw = Buffer.from(base64Tx, 'base64');
    if (raw.length === 0) {
      throw new BadRequestException(
        'Transaksi yang akan ditandatangani bukan base64 yang sah.',
      );
    }
    return raw;
  }

  /**
   * `VersionedTransaction.deserialize()` menangani KEDUA format: untuk transaksi
   * legacy ia tidak melempar, melainkan sukses dengan `version: 'legacy'`.
   * Diverifikasi terhadap @solana/web3.js 1.98.4: menandatangani transaksi legacy
   * lewat jalur versioned menghasilkan byte yang IDENTIK dengan jalur legacy
   * (partialSign + serialize), tetap terbaca `Transaction.from()`, dan tanda
   * tangannya valid terhadap message legacy. Jadi satu jalur ini sudah benar.
   *
   * JANGAN diskriminasi lewat byte pertama: pada transaksi terserialisasi, byte 0
   * adalah JUMLAH SIGNATURE (compact-u16), bukan penanda versi — penanda versi ada
   * di awal MESSAGE, setelah array signature. Untuk legacy MAUPUN v0 yang belum
   * ditandatangani, byte 0 sama-sama bernilai 1. Menebaknya sebagai penanda versi
   * akan melempar SEMUA transaksi v0 ke cabang legacy, dan `Transaction.from()`
   * menolaknya ("Versioned messages must be deserialized with ...") → setiap
   * pembelian gagal di produksi.
   *
   * `Transaction.from()` di bawah hanyalah JARING PENGAMAN kalau suatu saat CC
   * mengembalikan format yang tidak terbaca sebagai versioned.
   */
  private deserialize(raw: Buffer): Transaction | VersionedTransaction {
    try {
      return VersionedTransaction.deserialize(raw);
    } catch {
      // sengaja lanjut ke fallback legacy di bawah
    }

    try {
      return Transaction.from(raw);
    } catch {
      throw new BadRequestException(
        'Transaksi dari CollectorCrypt tidak bisa dibaca sebagai transaksi Solana ' +
          '(legacy maupun versioned).',
      );
    }
  }

  /**
   * Kalau treasury bukan signer yang diminta transaksi ini, web3.js melempar
   * "Cannot sign with non signer key" / "unknown signer". Itu BUKAN noise: artinya
   * transaksi yang dikembalikan CC tidak mendebit treasury sama sekali — menandatanganinya
   * tidak ada gunanya, dan diam-diam meneruskannya jauh lebih berbahaya daripada gagal.
   */
  private signOrExplain(doSign: () => void): void {
    try {
      doSign();
    } catch {
      throw new BadRequestException(
        `Transaksi dari CollectorCrypt tidak menuntut tanda tangan treasury ` +
          `(${this.getKeypair().publicKey.toBase58()}). Pembelian dibatalkan.`,
      );
    }
  }
}
