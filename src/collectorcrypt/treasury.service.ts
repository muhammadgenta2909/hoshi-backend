import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset, mplCore, transferV1 } from '@metaplex-foundation/mpl-core';
import { keypairIdentity, publicKey, type Umi } from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { PrismaService } from '../prisma/prisma.service';
import {
  SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  USDC_DECIMALS,
  resolveUsdcMintAddress,
} from './usdc.constants';

/** Menunggu NFT benar-benar mendarat di treasury setelah broadcast beli CC (broadcast =
 *  "terkirim", belum tentu final) sebelum meneruskannya ke pembeli. ~30 detik total. */
const TRANSFER_OWNERSHIP_RETRIES = 10;
const TRANSFER_POLL_MS = 3_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Plafon USDC untuk SATU pendanaan ongkir (base unit, 6 desimal; $2000 = 2_000_000_000).
 * Nominal yang didanai berasal dari `totalCost` /redeem/prepare CC — angka MEREKA — dan tidak
 * ada popup wallet user yang menahannya (treasury yang menandatangani transfer). Plafon ini yang
 * memastikan satu respons prepare yang jahat/salah tidak berubah jadi transfer treasury raksasa.
 * DI-EXPORT supaya PaymentsService memakai ANGKA YANG SAMA saat menolak order ongkir di depan.
 */
export const SHIPPING_FUND_MAX_PER_TX_USDC = 2_000_000_000;

/** Default plafon pendanaan ongkir 24 jam berjalan (base unit; $5000). Override: HOSHI_SHIPPING_FUND_DAILY_CAP_USDC. */
const SHIPPING_FUND_DEFAULT_DAILY_CAP_USDC = 5_000_000_000;
const SHIPPING_FUND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * SOL yang di-top-up ke wallet user supaya ia bisa MENANDATANGANI + membayar fee transaksi burn CC
 * (user Indonesia bayar Rupiah, tidak memegang SOL). Bounded: hanya ditambal sampai MIN, dan maksimal
 * TOPUP_MAX per pendanaan — jadi ini biaya gas kecil yang terikat, bukan pipa penguangan.
 */
const USER_MIN_SOL_LAMPORTS = 5_000_000; // 0,005 SOL
const USER_SOL_TOPUP_MAX_LAMPORTS = 5_000_000; // 0,005 SOL
/** Sisa SOL yang harus tetap dipegang treasury (fee tx + rent ATA user bila perlu). */
const TREASURY_FUND_MIN_GAS_LAMPORTS = 10_000_000; // 0,01 SOL
/** Cadangan rent untuk membuat ATA USDC user (idempoten — cuma terpakai kalau ATA belum ada). */
const ATA_RENT_LAMPORTS = 2_100_000;

/**
 * Kegagalan fundUsdc yang INDETERMINATE: transaksi transfer USDC MUNGKIN sudah tayang on-chain
 * (kita sudah menyiarkannya, lalu konfirmasinya hilang/timeout). Ditangani KHUSUS oleh pemanggil:
 * USDC treasury MUNGKIN sudah pindah ke wallet user → JANGAN auto-refund Rupiah (rugi dobel);
 * selesaikan lewat cek on-chain + reclaim. Sepadan dengan ResellerPostBuyError / GachaPostSpendError.
 */
export class TreasuryFundIndeterminateError extends Error {
  constructor(
    message: string,
    readonly signature: string,
    readonly toWallet: string,
  ) {
    super(message);
    this.name = 'TreasuryFundIndeterminateError';
  }
}

const TOKEN_PROGRAM_PK = new PublicKey(SPL_TOKEN_PROGRAM_ID);
const ASSOCIATED_TOKEN_PROGRAM_PK = new PublicKey(
  SPL_ASSOCIATED_TOKEN_PROGRAM_ID,
);

/** Alamat Associated Token Account (PDA) untuk (owner, mint) di SPL Token program. */
function deriveAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_PK.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_PK,
  )[0];
}

/**
 * Instruksi CreateIdempotent Associated Token Account. Idempoten SENGAJA: kalau ATA user sudah
 * ada, instruksi ini no-op (tak error), jadi tak ada race "cek-lalu-buat" yang bisa gagal ganda.
 * Treasury (payer) yang membayar rent bila ATA memang belum ada.
 */
function createAtaIdempotentIx(p: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_PK,
    keys: [
      { pubkey: p.payer, isSigner: true, isWritable: true },
      { pubkey: p.ata, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: false, isWritable: false },
      { pubkey: p.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_PK, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // 1 = CreateIdempotent
  });
}

/**
 * Instruksi SPL TransferChecked (opcode 12). "Checked" karena ia memverifikasi mint + desimal
 * on-chain: kalau kita salah mint/desimal, transaksi DITOLAK jaringan alih-alih diam-diam mengirim
 * token yang salah. Layout data: [u8 opcode=12][u64 amount LE][u8 decimals].
 */
function transferCheckedIx(p: {
  source: PublicKey;
  mint: PublicKey;
  dest: PublicKey;
  owner: PublicKey;
  amount: number;
  decimals: number;
}): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(p.amount), 1);
  data.writeUInt8(p.decimals, 9);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_PK,
    keys: [
      { pubkey: p.source, isSigner: false, isWritable: true },
      { pubkey: p.mint, isSigner: false, isWritable: false },
      { pubkey: p.dest, isSigner: false, isWritable: true },
      { pubkey: p.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/**
 * Jumlahkan saldo semua token account milik satu mint (defensif: account tak terbaca DILEWATI,
 * bukan dianggap nol keseluruhan). Sama semantik dengan sumTokenAccounts di gacha.service.
 */
function sumUsdcAccounts(
  accounts: readonly { account: { data: unknown } }[],
): number {
  let total = 0;
  for (const acc of accounts) {
    const parsed = acc.account.data as
      | { parsed?: { info?: { tokenAmount?: { amount?: string } } } }
      | undefined;
    const amount = parsed?.parsed?.info?.tokenAmount?.amount;
    if (typeof amount === 'string' && Number.isFinite(Number(amount))) {
      total += Number(amount);
    }
  }
  return total;
}

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
  private fundingConn: Connection | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

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

  /**
   * Danai wallet USER dengan USDC treasury (base unit), just-in-time sebelum ia menandatangani
   * burn+ship CC. Primitif TRANSFER SPL yang baru: sebelum ini treasury cuma bisa transfer NFT
   * Core + menandatangani tx CC, TIDAK ada transfer USDC sama sekali. Dibangun MANUAL dengan
   * @solana/web3.js (repo tidak memasang @solana/spl-token) — instruksi CreateIdempotent ATA +
   * TransferChecked, disiarkan lewat RPC Hoshi sendiri (SOLANA_RPC_URL).
   *
   * Juga menambal SOL user seperlunya (bounded) supaya ia bisa membayar fee tx burn — semuanya
   * dalam SATU transaksi, SATU signature, SATU titik broadcast.
   *
   * BATAS KEGAGALAN KRITIS (menentukan refundSafe di pemanggil):
   *  - throw SEBELUM broadcast (guard konfigurasi/nominal/plafon/saldo, build, sign, SIMULASI) →
   *    BELUM ada USDC keluar → aman; pemanggil boleh melepas klaim & menjaga refundSafe=true.
   *  - throw DI/SESUDAH broadcast (send/confirm) → transfer MUNGKIN sudah tayang → INDETERMINATE:
   *    TreasuryFundIndeterminateError; pemanggil set refundSafe=false, JANGAN auto-refund.
   */
  async fundUsdc(params: {
    toWallet: string;
    amountBaseUnits: number;
  }): Promise<{ signature: string }> {
    // ── 1. Guard konfigurasi & nominal (SEMUA pra-broadcast) ─────────────────────────────────
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Treasury Hoshi belum dikonfigurasi — tidak bisa mendanai USDC ongkir.',
      );
    }
    const amount = params.amountBaseUnits;
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BadRequestException(
        'Nominal pendanaan USDC ongkir tidak valid.',
      );
    }
    if (amount > SHIPPING_FUND_MAX_PER_TX_USDC) {
      this.logger.error(
        `fundUsdc TOLAK: nominal ${amount} > plafon per-transfer ${SHIPPING_FUND_MAX_PER_TX_USDC} (USDC base unit).`,
      );
      throw new ServiceUnavailableException(
        'Ongkir kirim di luar batas wajar. Pendanaan dibatalkan — tidak ada dana yang berpindah.',
      );
    }

    let toPk: PublicKey;
    try {
      toPk = new PublicKey(params.toWallet);
    } catch {
      throw new BadRequestException(
        'Alamat wallet penerima USDC tidak valid.',
      );
    }

    const keypair = this.getKeypair();
    const treasuryPk = keypair.publicKey;
    const conn = this.getFundingConnection();
    const mint = new PublicKey(this.usdcMintAddress());

    // ── 2. Plafon pendanaan 24 jam berjalan — dihitung dari LEDGER (bukan memori proses) ─────
    //     supaya restart / multi-instance tidak mereset plafon. Baris yang SUDAH punya
    //     fundingSignature = USDC pernah keluar untuknya. Pra-broadcast → aman ditolak.
    const cap = this.positiveIntConfig(
      'HOSHI_SHIPPING_FUND_DAILY_CAP_USDC',
      SHIPPING_FUND_DEFAULT_DAILY_CAP_USDC,
    );
    const fundedAgg = await this.prisma.cardRedemption.aggregate({
      _sum: { totalCostUsdc: true },
      where: {
        fundingSignature: { not: null },
        updatedAt: { gte: new Date(Date.now() - SHIPPING_FUND_WINDOW_MS) },
      },
    });
    const alreadyFunded = fundedAgg._sum.totalCostUsdc ?? 0;
    if (alreadyFunded + amount > cap) {
      this.logger.error(
        `fundUsdc TOLAK: plafon 24 jam tercapai ${alreadyFunded} + ${amount} > ${cap} (USDC base unit).`,
      );
      throw new ServiceUnavailableException(
        'Kuota pendanaan ongkir sedang penuh. Coba lagi nanti — tidak ada dana yang berpindah.',
      );
    }

    // ── 3. Preflight saldo ON-CHAIN treasury (pra-broadcast) ─────────────────────────────────
    const treasuryUsdcAtas = await conn.getParsedTokenAccountsByOwner(
      treasuryPk,
      { mint },
    );
    const treasuryUsdc = sumUsdcAccounts(treasuryUsdcAtas.value);
    if (treasuryUsdc < amount) {
      this.logger.error(
        `fundUsdc TOLAK: saldo USDC treasury ${treasuryUsdc} < ${amount} (base unit).`,
      );
      throw new ServiceUnavailableException(
        'Saldo USDC treasury tidak cukup untuk mendanai ongkir. Coba lagi nanti — tidak ada dana yang berpindah.',
      );
    }

    // SOL: tambal user seperlunya (bounded) + pastikan treasury sisa gas + rent ATA.
    const [treasurySol, userSol] = await Promise.all([
      conn.getBalance(treasuryPk),
      conn.getBalance(toPk),
    ]);
    const solTopup =
      userSol >= USER_MIN_SOL_LAMPORTS
        ? 0
        : Math.min(
            USER_MIN_SOL_LAMPORTS - userSol,
            USER_SOL_TOPUP_MAX_LAMPORTS,
          );
    if (
      treasurySol <
      TREASURY_FUND_MIN_GAS_LAMPORTS + solTopup + ATA_RENT_LAMPORTS
    ) {
      this.logger.error(
        `fundUsdc TOLAK: SOL treasury ${treasurySol} lamports kurang untuk gas + topup ${solTopup} + rent.`,
      );
      throw new ServiceUnavailableException(
        'SOL treasury tidak cukup untuk gas pendanaan. Coba lagi nanti — tidak ada dana yang berpindah.',
      );
    }

    // ── 4. Bangun transaksi (pra-broadcast): CreateIdempotent ATA + TransferChecked + topup SOL ─
    const userAta = deriveAta(toPk, mint);
    const treasuryAta = deriveAta(treasuryPk, mint);
    const ixs: TransactionInstruction[] = [
      createAtaIdempotentIx({
        payer: treasuryPk,
        ata: userAta,
        owner: toPk,
        mint,
      }),
      transferCheckedIx({
        source: treasuryAta,
        mint,
        dest: userAta,
        owner: treasuryPk,
        amount,
        decimals: USDC_DECIMALS,
      }),
    ];
    if (solTopup > 0) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: treasuryPk,
          toPubkey: toPk,
          lamports: solTopup,
        }),
      );
    }

    const { blockhash, lastValidBlockHeight } =
      await conn.getLatestBlockhash('confirmed');
    const tx = new Transaction({
      feePayer: treasuryPk,
      blockhash,
      lastValidBlockHeight,
    });
    tx.add(...ixs);
    tx.sign(keypair);
    const raw = tx.serialize();

    // ── 5. SIMULASI (masih pra-broadcast) ────────────────────────────────────────────────────
    //     Titik pemisah aman/tak-aman: kegagalan simulasi = transaksi ditolak SEBELUM disiarkan,
    //     jadi TIDAK ada USDC keluar → lempar exception biasa (pemanggil boleh lepas klaim).
    try {
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        this.logger.error(
          `fundUsdc simulasi GAGAL (pra-broadcast, tidak ada dana keluar): ${JSON.stringify(sim.value.err)}`,
        );
        throw new ServiceUnavailableException(
          'Pendanaan USDC ongkir gagal disiapkan. Tidak ada dana yang berpindah — coba lagi.',
        );
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      // Simulasi tak bisa dijalankan (RPC error) → tetap pra-broadcast (belum disiarkan) → aman.
      this.logger.error(
        `fundUsdc simulasi tak terjalankan (pra-broadcast): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        'Pendanaan USDC ongkir gagal disiapkan. Tidak ada dana yang berpindah — coba lagi.',
      );
    }

    // ── 6. BROADCAST — BATAS INDETERMINATE ───────────────────────────────────────────────────
    //     Simulasi sudah lolos = transaksi valid. sendRawTransaction dengan skipPreflight (kita
    //     sudah simulasi) adalah momen siar. Kegagalan DI SINI ATAU SESUDAHNYA (confirm) WAJIB
    //     diperlakukan INDETERMINATE: CC/RPC bisa saja SUDAH menyiarkan tx lalu responsnya hilang.
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(raw, {
        skipPreflight: true,
        maxRetries: 3,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `fundUsdc KRITIS: broadcast transfer USDC ke ${params.toWallet} GAGAL/INDETERMINATE: ${msg}. ` +
          'USDC MUNGKIN sudah pindah — CEK ON-CHAIN sebelum refund. JANGAN auto-refund.',
      );
      throw new TreasuryFundIndeterminateError(
        `broadcast indeterminate: ${msg}`,
        'CEK_ON_CHAIN',
        params.toWallet,
      );
    }

    // ── 7. Konfirmasi. Gagal konfirmasi = tx sudah tayang, hanya finalitasnya belum pasti → tetap INDETERMINATE.
    try {
      const res = await conn.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed',
      );
      if (res.value.err) {
        throw new Error(JSON.stringify(res.value.err));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `fundUsdc KRITIS: transfer USDC ${signature} ke ${params.toWallet} disiarkan tapi konfirmasi ` +
          `gagal/indeterminate: ${msg}. CEK ON-CHAIN. JANGAN auto-refund.`,
      );
      throw new TreasuryFundIndeterminateError(msg, signature, params.toWallet);
    }

    this.logger.warn(
      `fundUsdc: treasury mendanai ${amount} USDC base unit ke ${params.toWallet} (sig ${signature}).`,
    );
    return { signature };
  }

  /* --- internal --- */

  /** Connection RPC untuk broadcast fundUsdc. Lazy + dimemoisasi. */
  private getFundingConnection(): Connection {
    if (this.fundingConn) return this.fundingConn;
    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    this.fundingConn = new Connection(endpoint, 'confirmed');
    return this.fundingConn;
  }

  /** Mint USDC yang sah untuk cluster ini (override lewat env USDC_MINT). */
  private usdcMintAddress(): string {
    return resolveUsdcMintAddress(
      this.config.get<string>('SOLANA_CLUSTER'),
      this.config.get<string>('USDC_MINT'),
    );
  }

  /** Batas nominal yang salah ketik TIDAK boleh diam-diam dilewati → fail closed. */
  private positiveIntConfig(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InternalServerErrorException(
        `${key} harus bilangan bulat positif (USDC base unit, 6 desimal).`,
      );
    }
    return value;
  }

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
