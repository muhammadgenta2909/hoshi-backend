import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CcPackStatus } from '@prisma/client';
import type { CcPackPurchase } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcGachaClient } from './cc-gacha.client';
import { toCcRarity } from './cc-gacha.types';
import type {
  CcBuybackResponse,
  CcConfirmationStatus,
  CcMachinesNormalizedResponse,
  CcOpenPackResponse,
  CcPackStatusResponse,
  CcRarity,
  CcRecentWinnerRaw,
  CcRecentWinnersResponse,
  CcStockResponse,
  CcSubmitTransactionResponse,
  CcVrfVerifyResponse,
} from './cc-gacha.types';
import { BuybackDto } from './dto/buyback.dto';
import { GeneratePackDto } from './dto/generate-pack.dto';
import { PurchasePackDto } from './dto/purchase-pack.dto';
import { SubmitPackDto } from './dto/submit-pack.dto';
import { TreasuryService } from './treasury.service';

/** Mesin default CollectorCrypt bila klien tidak menyebut packType. */
const DEFAULT_PACK_TYPE = 'pokemon_50';

/**
 * Mesin yang di-agregasi untuk ticker "Live Card Won" bila klien TIDAK menyebut packType.
 * Tiap mesin cuma menyimpan 5 winner terakhir, jadi kita gabung beberapa mesin supaya
 * feed-nya ramai. getRecentWinners tetap mengembalikan winner historis walau mesinnya
 * sedang "empty/off", jadi daftar ini aman walau sebagian mesin sedang tidak aktif.
 */
const DEFAULT_WINNER_PACKS: readonly string[] = [
  'pokemon_250',
  'pokemon_50',
  'pokemon_25',
  'onepiece_250',
  'pokemon_1000',
  'pokemon_cnft',
];

/** Batas item ticker: cukup ramai untuk marquee, tidak membanjiri payload. */
const MAX_WINNERS = 20;

/** Batas panjang pesan error yang disimpan di ledger. */
const ERROR_MAX = 500;

/**
 * Plafon harga SATU pack yang treasury bersedia tandatangani (USDC base unit).
 * Default $100 — dua kali harga pokemon_50, cukup longgar untuk mesin baru.
 *
 * Harga di-snapshot dari /api/machines, artinya nominal yang kita bayar ditentukan
 * oleh RESPONS MEREKA. Tanpa plafon, satu respons /api/machines yang jahat atau salah
 * (harga $50.000) langsung jadi tanda tangan treasury senilai $50.000 — tidak ada lagi
 * popup wallet yang menahannya, karena user sudah tidak menandatangani apa pun.
 * Override lewat GACHA_MAX_PACK_PRICE_USDC.
 *
 * DI-EXPORT supaya PaymentsService memakai ANGKA YANG SAMA saat menolak order di depan.
 * Kalau keduanya punya salinan sendiri, keduanya bisa melenceng — dan melencengnya dibayar
 * user: order lolos dibuat, rupiah masuk, lalu treasury menolak di fulfillment.
 */
export const TREASURY_MAX_PACK_PRICE_USDC = 100_000_000;

/**
 * Plafon belanja treasury dalam 24 jam berjalan (USDC base unit). Default $500.
 *
 * SELAMA BELUM ADA GERBANG PEMBAYARAN RUPIAH, inilah SATU-SATUNYA batas nominal antara
 * seorang user login dan isi treasury kita: identitas itu gratis (auth/nonce meng-upsert
 * user untuk alamat Solana APA PUN), jadi rate-limit per-user bisa dikalahkan Sybil,
 * tapi plafon ini berlaku untuk SELURUH treasury. Override lewat
 * GACHA_TREASURY_DAILY_CAP_USDC — turunkan, jangan naikkan, sampai gerbang bayar ada.
 */
const TREASURY_DAILY_CAP_USDC = 500_000_000;

const TREASURY_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Status yang berarti "uang treasury MUNGKIN atau SUDAH keluar" — dasar hitung plafon.
 * GENERATED sengaja TIDAK dihitung: baris itu belum pernah ditandatangani (tanda tangan
 * baru terjadi setelah klaim GENERATED→SUBMITTING), jadi pasti nol dana. FAILED juga
 * tidak: enum-nya hanya ditulis kalau kita YAKIN tidak ada uang bergerak.
 */
const TREASURY_SPENT_STATUSES: CcPackStatus[] = [
  CcPackStatus.SUBMITTING,
  CcPackStatus.SUBMITTED,
  CcPackStatus.OPENED,
  CcPackStatus.BOUGHT_BACK,
];

/**
 * Pesan untuk keadaan "SUDAH DIBAYAR, BELUM TERKIRIM". Tidak boleh terdengar seperti
 * kegagalan: uangnya benar-benar sudah keluar dan pack-nya milik user.
 */
const PAID_NOT_DELIVERED =
  'Pack Anda SUDAH DIBAYAR, tapi kartunya belum selesai dikirim CollectorCrypt. ' +
  'Tidak ada yang perlu dibayar ulang — buka lagi pack ini beberapa saat lagi untuk mengambil kartunya.';

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

/**
 * Baris ledger yang aman dikirim ke klien.
 * `priceUsdc`/`buybackAmountUsdc` = USDC base unit (6 desimal) — $50 = 50_000_000.
 * JANGAN pernah diperlakukan sebagai rupiah atau dibulatkan lewat float.
 */
export interface CcPackDto {
  memo: string;
  packType: string;
  status: CcPackStatus;
  turbo: boolean;
  playerAddress: string;
  priceUsdc: number | null;
  purchaseSignature: string | null;
  openSignature: string | null;
  rarity: CcRarity | null;
  nftAddress: string | null;
  nftName: string | null;
  /** URL gambar kartu: links.image ?? files[0].cdn_uri ?? files[0].uri. */
  nftImage: string | null;
  roll: string | null;
  points: number | null;
  buybackAmountUsdc: number | null;
  error: string | null;
  createdAt: Date;
  openedAt: Date | null;
}

/**
 * Bentuk DOMAIN BERSIH satu pemenang untuk ticker "Live Card Won" di frontend.
 *
 * Sengaja RATA & minimal: gambar + nama kartu ASLI dari getRecentWinners, plus wallet
 * pemenangnya untuk subtitle "won by <wallet>". TIDAK ADA nilai USD di sini — payload
 * getRecentWinners tidak menjamin harga, jadi kita tidak pernah mengarang nominal.
 */
export interface GachaWinner {
  /** Alamat NFT — juga kunci dedupe antar mesin. */
  nftAddress: string;
  /** Nama kartu asli (nft.content.metadata.name). */
  name: string;
  /** URL gambar: links.image ?? files[0].cdn_uri ?? files[0].uri. */
  image: string;
  /** Wallet pemenang (dipotong di frontend jadi mis. 4Th3…VtyT). */
  winner: string;
  /** prize_tier numerik apa adanya dari CC. */
  tier: number;
}

export interface CcGeneratedPackDto {
  memo: string;
  /** Base64 UNSIGNED — hanya wallet user yang boleh menandatanganinya. */
  transaction: string;
  packType: string;
  /** Snapshot harga mesin saat generate (USDC base unit). */
  priceUsdc: number;
}

export interface CcSubmittedPackDto extends CcPackDto {
  confirmationStatus: CcConfirmationStatus;
}

export interface CcPackStatusDto {
  pack: CcPackDto;
  /** Respons mentah GET /api/pack/status?memo= — oracle rekonsiliasi mereka. */
  collectorcrypt: CcPackStatusResponse;
}

export interface CcBuybackQuoteDto {
  /** Memo pack kita (kunci ledger). */
  packMemo: string;
  /** Memo buyback milik CollectorCrypt — beda dari packMemo. */
  buybackMemo: string;
  nftAddress: string;
  /** USDC base unit, angka MEREKA. Kita tidak pernah mengarang nominal buyback. */
  refundAmountUsdc: number;
  /** Base64 UNSIGNED — user yang menandatangani, bukan kita. */
  serializedTransaction: string;
}

/**
 * Orkestrasi gacha CollectorCrypt + ledger atribusi kita.
 *
 * Alur pack mereka WAJIB melewati wallet user di tengah jalan:
 *   generatePack (kita) → TANDA TANGAN USER (browser) → submitTransaction (kita) → openPack (kita)
 * Tidak ada primitif reserve/hold/release, dan tidak ada cara membalikkan pembayaran.
 * Karena itu ledger ditulis WRITE-AHEAD di langkah pertama (satu-satunya langkah yang
 * belum memindahkan dana) dan sesudah itu hanya ROLL FORWARD — tidak pernah rollback.
 */
@Injectable()
export class GachaService {
  private readonly logger = new Logger(GachaService.name);

  /**
   * `treasury` & `config` sengaja @Optional(): jalur user-bayar (generate/submit/open)
   * tidak butuh keduanya dan harus tetap hidup di deployment yang belum punya treasury.
   * Kalau treasury belum terpasang, purchase() menolak dengan pesan jelas — bukan boot
   * yang gagal, dan bukan pula diam-diam membelanjakan sesuatu.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CcGachaClient,
    @Optional() private readonly treasury?: TreasuryService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /* --- Read-only: SUMBER KEBENARAN harga/odds/EV ada di sisi mereka, bukan di sini. --- */

  machines(): Promise<CcMachinesNormalizedResponse> {
    return this.client.machines();
  }

  stock(): Promise<CcStockResponse> {
    return this.client.stock();
  }

  recentWinners(packType?: string): Promise<CcRecentWinnersResponse> {
    return this.client.recentWinners(packType ?? DEFAULT_PACK_TYPE);
  }

  /**
   * Feed "Live Card Won" — bentuk domain BERSIH untuk ticker frontend.
   *
   * - packType diberikan → ambil winner mesin itu saja.
   * - packType kosong → agregasi DEFAULT_WINNER_PACKS secara PARALEL. Dipakai
   *   Promise.allSettled: satu mesin yang gagal (empty/off/timeout) TIDAK boleh
   *   menjatuhkan seluruh feed — mesin lain tetap tampil.
   *
   * Pemetaan winner mentah → GachaWinner bersifat DEFENSIF: getRecentWinners tidak
   * didokumentasikan dan bentuknya bersarang, jadi item yang tak punya nama/gambar/alamat
   * dibuang diam-diam, bukan bikin throw. Hasilnya di-dedupe per nftAddress dan dibatasi
   * MAX_WINNERS. Metode ini TIDAK PERNAH melempar ke caller hanya karena satu item jelek.
   */
  async winners(packType?: string): Promise<GachaWinner[]> {
    const packs = packType ? [packType] : DEFAULT_WINNER_PACKS;

    const settled = await Promise.allSettled(
      packs.map((pack) => this.client.recentWinners(pack)),
    );

    const winners: GachaWinner[] = [];
    const seen = new Set<string>();

    for (const result of settled) {
      if (result.status !== 'fulfilled') {
        // Satu mesin gagal → catat, lanjut. Bukan alasan menjatuhkan seluruh feed.
        this.logger.warn(
          `getRecentWinners gagal untuk satu mesin: ${errorMessage(result.reason)}`,
        );
        continue;
      }
      for (const raw of extractWinnerArray(result.value)) {
        const mapped = toGachaWinner(raw);
        if (!mapped || seen.has(mapped.nftAddress)) continue;
        seen.add(mapped.nftAddress);
        winners.push(mapped);
        if (winners.length >= MAX_WINNERS) return winners;
      }
    }

    return winners;
  }

  /**
   * Bukti VRF sebuah memo. SENGAJA tanpa cek kepemilikan: undian ini tercatat on-chain
   * dan memang dirancang untuk bisa diaudit siapa pun — memaksa login justru mengubah
   * bukti publik jadi klaim sepihak kita. Respons CC di sini tidak memuat wallet/nominal.
   */
  vrfVerify(memo: string): Promise<CcVrfVerifyResponse> {
    return this.client.vrfVerify(memo);
  }

  /* --- Pack --- */

  /**
   * Langkah 1: terbitkan memo + transaksi UNSIGNED, lalu CATAT DULU sebelum dikembalikan.
   *
   * Urutannya tidak boleh dibalik. generatePack belum memindahkan dana, tapi begitu
   * transaksi ada di tangan user, ia bisa ditandatangani kapan saja — bahkan tanpa
   * melewati endpoint submit kita. Kalau baris ledger belum ada saat itu terjadi, user
   * membayar ~$50 tanpa jejak di sistem kita: kartunya tak bisa kita tampilkan, dan
   * bagi hasil 50% atas pack itu tak bisa kita tagih maupun buktikan.
   */
  async generate(
    dto: GeneratePackDto,
    user: AuthUser,
  ): Promise<CcGeneratedPackDto> {
    const packType = dto.packType ?? DEFAULT_PACK_TYPE;

    // Harga di-snapshot dari /api/machines tiap kali generate — jangan pernah di-hardcode:
    // harga & odds mereka bisa berubah sewaktu-waktu, dan angka inilah yang nanti dipakai
    // memverifikasi jumlah on-chain sebelum revenue dibukukan.
    const machines = await this.client.machines();
    const machine = machines.find((m) => m.code === packType);
    if (!machine) {
      throw new BadRequestException(
        `Mesin "${packType}" tidak tersedia di CollectorCrypt.`,
      );
    }

    // Pembayar SELALU wallet dari JWT. Tidak ada jalan bagi body request untuk mengubahnya.
    const playerAddress = user.walletAddress;
    const turbo = dto.turbo ?? false;

    const pack = await this.client.generatePack({
      playerAddress,
      packType,
      turbo,
    });

    try {
      await this.prisma.ccPackPurchase.create({
        data: {
          memo: pack.memo,
          userId: user.id,
          playerAddress,
          packType,
          turbo,
          priceUsdc: machine.priceUsdcBaseUnits,
          status: CcPackStatus.GENERATED,
        },
      });
    } catch (err) {
      // Ledger gagal ditulis → transaksinya TIDAK boleh sampai ke user. Lebih baik
      // pembelian batal daripada uang bergerak tanpa catatan yang bisa kita pegang.
      this.logger.error(
        `Ledger gagal ditulis untuk memo ${pack.memo} (user ${user.id}): ${errorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Gagal mencatat pembelian. Transaksi tidak diterbitkan — tidak ada dana yang berpindah.',
      );
    }

    return {
      memo: pack.memo,
      transaction: pack.transaction,
      packType,
      priceUsdc: machine.priceUsdcBaseUnits,
    };
  }

  /**
   * Langkah 3: teruskan transaksi yang sudah ditandatangani user.
   *
   * submitTransaction TIDAK idempoten → satu memo hanya boleh diteruskan SEKALI seumur
   * hidupnya. Dua penjaga menegakkan itu:
   *
   * 1. Klaim ATOMIK GENERATED→SUBMITTING (updateMany, pola yang sama dipakai
   *    MarketplaceService.buy). Cek-lalu-tulis biasa tidak cukup: dua request bersamaan
   *    untuk memo yang sama sama-sama lolos `if`, lalu sama-sama menembak CC → user
   *    ditagih 2×. `count !== 1` = ada yang sudah menang duluan.
   * 2. Kegagalan TIDAK mengembalikan status ke GENERATED. Baris berhenti di SUBMITTING,
   *    yang artinya "hasilnya tidak diketahui" — bukan "gagal". Timeout kita bukan bukti
   *    transaksinya tidak tayang on-chain. Jalan keluarnya cuma packStatus(memo), bukan
   *    submit ulang.
   */
  async submit(
    memo: string,
    dto: SubmitPackDto,
    user: AuthUser,
  ): Promise<CcSubmittedPackDto> {
    const row = await this.ownedRow(memo, user);
    assertTransactionCarriesMemo(dto.signedTransaction, memo);

    const claimed = await this.prisma.ccPackPurchase.updateMany({
      where: { memo, userId: user.id, status: CcPackStatus.GENERATED },
      data: { status: CcPackStatus.SUBMITTING },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        row.status === CcPackStatus.SUBMITTING
          ? 'Transaksi pack ini sedang/sudah diproses dan hasilnya belum pasti. ' +
              'Cek status pack ini — jangan submit ulang, berisiko terbayar dua kali.'
          : 'Transaksi untuk pack ini sudah pernah disubmit.',
      );
    }

    let res: CcSubmitTransactionResponse;
    try {
      res = await this.client.submitTransaction({
        signedTransaction: dto.signedTransaction,
      });
    } catch (err) {
      // Status SENGAJA dibiarkan SUBMITTING: transaksinya mungkin sudah tayang.
      await this.flagError(memo, err);
      throw err;
    }

    const updated = await this.prisma.ccPackPurchase.update({
      where: { memo },
      data: {
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: res.signature,
        error: null,
      },
    });
    return {
      ...toCcPackDto(updated),
      confirmationStatus: res.confirmationStatus,
    };
  }

  /**
   * Langkah 4: buka pack.
   *
   * rarity/roll/points datang UTUH dari VRF on-chain mereka dan disimpan apa adanya.
   * Dilarang mengocok ulang secara lokal: user bisa memverifikasi sendiri lewat
   * /api/vrf/verify?memo=, jadi angka versi kita yang berbeda = kebohongan yang
   * bisa dibuktikan siapa pun.
   */
  async open(memo: string, user: AuthUser): Promise<CcPackDto> {
    const row = await this.ownedRow(memo, user);
    // Sudah dibuka → kembalikan hasil tersimpan; jangan panggil mereka lagi.
    if (row.status === CcPackStatus.OPENED && row.nftAddress) {
      return toCcPackDto(row);
    }

    let res: CcOpenPackResponse;
    try {
      res = await this.client.openPack({ memo });
    } catch (err) {
      // JANGAN turunkan status. Baris SUBMITTED = user SUDAH bayar, dan gagalnya
      // panggilan BUKA bukan gagalnya pembelian. Menuliskan FAILED di sini akan
      // (a) membuat pack berbayar terbaca "dibatalkan" saat rekonsiliasi komisi, dan
      // (b) membuka lagi jalur submit ulang. Cukup catat errornya; openPack idempoten,
      // jadi memanggil ulang nanti aman.
      await this.flagError(memo, err);
      throw err;
    }

    if (!res.success) {
      const err = new ServiceUnavailableException(
        'CollectorCrypt tidak dapat membuka pack ini. Coba lagi sebentar.',
      );
      await this.flagError(memo, err);
      throw err;
    }

    // rarity CC bisa datang dengan casing apa pun — wire /api/machines huruf-kecil, contoh
    // openPack di dokumentasi kapital, bahkan getRecentWinners numerik — jadi normalkan ke
    // bentuk KANONIK kapital lewat toCcRarity supaya DB kita seragam dengan dirinya sendiri.
    // Kalau TIDAK dikenali: pack SUDAH terbuka on-chain (ireversibel), jadi JANGAN gagalkan
    // hanya karena beda casing — simpan rarity null dan catat nilai mentahnya di `error`,
    // bukan menyimpan sampah diam-diam.
    const rarity = toCcRarity(res.rarity);
    if (rarity === null) {
      this.logger.warn(
        `Rarity openPack tak dikenal untuk memo ${memo}: "${res.rarity}".`,
      );
    }
    const updated = await this.prisma.ccPackPurchase.update({
      where: { memo },
      data: {
        status: CcPackStatus.OPENED,
        rarity,
        nftAddress: res.nft_address,
        // Opsional-aman: pack turbo menjual-otomatis hadiahnya, jadi bisa saja tidak
        // ada NFT untuk dinamai. Melakukan deref buta di sini berarti sebuah pack yang
        // SUDAH terbuka on-chain (ireversibel) gagal tercatat, lalu tersangkut selamanya.
        nftName: res.nftWon?.content?.metadata?.name ?? null,
        nftImage: resolveNftImage(res.nftWon?.content),
        openSignature: res.transactionSignature,
        roll: res.roll == null ? null : String(res.roll),
        points: res.points ?? null,
        openedAt: new Date(),
        error: rarity === null ? unrecognisedRarityNote(res.rarity) : null,
      },
    });
    return toCcPackDto(updated);
  }

  /* ══════════════════════════════════════════════════════════════════════════════
     PACK DIBAYAR TREASURY — user tidak menandatangani apa pun.

     ╔══════════════════════════════════════════════════════════════════════════╗
     ║  TODO(payment): ENDPOINT INI MEMBELANJAKAN USDC TREASURY ASLI SETIAP     ║
     ║  DIPANGGIL, DAN BELUM ADA GERBANG PEMBAYARAN RUPIAH SAMA SEKALI.         ║
     ║                                                                          ║
     ║  Saat ini SATU-SATUNYA syarat membelanjakan ~$50 milik Hoshi adalah      ║
     ║  "punya JWT yang sah". Padahal JWT itu GRATIS dan TAK TERBATAS:          ║
     ║  /auth/nonce meng-upsert user untuk alamat Solana APA PUN, jadi siapa    ║
     ║  pun bisa membuat ribuan akun dengan generator keypair dalam hitungan    ║
     ║  detik. Rate-limit per-user TIDAK menutup lubang ini — Sybil             ║
     ║  mengalahkannya. Yang menahan hanyalah plafon treasury di bawah.         ║
     ║                                                                          ║
     ║  SEBELUM PRODUKSI, WAJIB: purchase() harus MENGKLAIM SECARA ATOMIK       ║
     ║  sebuah baris pembayaran rupiah yang SUDAH SETTLED (IDRX/PSP) —          ║
     ║  entitlement HELD → CONSUMED, pola updateMany berpredikat status yang    ║
     ║  sama seperti klaim GENERATED→SUBMITTING di bawah — SEBELUM memanggil    ║
     ║  CollectorCrypt. Tidak ada entitlement, tidak ada panggilan CC.          ║
     ║  Itu butuh model baru di prisma/schema.prisma (di luar cakupan patch     ║
     ║  ini, yang dilarang menyentuh schema).                                   ║
     ║                                                                          ║
     ║  Sampai itu ada: JANGAN buka route ini ke publik. Batasi ke akun uji     ║
     ║  (AuthUser.role) dan isi treasury seperlunya saja.                       ║
     ╚══════════════════════════════════════════════════════════════════════════╝
     ════════════════════════════════════════════════════════════════════════════ */

  /**
   * Beli pack END-TO-END dengan uang TREASURY: generate → tanda tangan (server) →
   * submit → open, semuanya dalam satu request. User TIDAK menandatangani apa pun.
   *
   * Alasannya bukan kenyamanan, tapi kenyataan: user Indonesia membayar rupiah dan
   * TIDAK memegang USDC maupun SOL. Maka pembayarnya treasury:
   *
   *   playerAddress    = treasury  (memegang USDC, membayar, DAN menandatangani)
   *   altPlayerAddress = wallet user dari JWT  (menerima kartunya)
   *
   * URUTAN LANGKAH DI BAWAH ADALAH PROPERTI KEAMANANNYA — jangan ditukar:
   *   1. snapshot harga  → nominal tidak pernah datang dari klien
   *   2. plafon harga & plafon harian  → menolak SEBELUM apa pun bergerak itu gratis
   *   3. WRITE-AHEAD baris ledger  → tanda tangan hanya boleh terjadi kalau sudah tercatat
   *   4. klaim ATOMIK GENERATED→SUBMITTING  → dua request bersamaan tidak bisa dua kali bayar
   *   5. tanda tangan treasury
   *   6. submitTransaction  → sejak titik ini uang MUNGKIN sudah keluar; roll forward saja
   *   7. openPack (idempoten)  → aman diulang nanti
   */
  async purchase(dto: PurchasePackDto, user: AuthUser): Promise<CcPackDto> {
    const treasury = this.treasuryOrRefuse();

    const packType = dto.packType ?? DEFAULT_PACK_TYPE;
    const turbo = dto.turbo ?? false;

    // Turbo DILARANG di jalur treasury. Turbo menjual-otomatis kartu menang jadi USDC dan
    // mengirimnya ke PENERIMA KARTU — yang di sini adalah wallet user. Artinya: user menekan
    // satu tombol, dan USDC TREASURY keluar sebagai USDC MILIK USER di wallet non-kustodian,
    // ireversibel, tanpa KYC. Itu pipa penguangan (dan pencucian) rupiah→USDC yang membayar
    // di harga EV mesin, bukan sebuah fitur gacha.
    //
    // Mengarahkan altFundsRecipient ke treasury pun tidak menolong SEKARANG: user jadi tidak
    // menerima apa-apa, dan mengkreditkannya balik butuh ledger saldo internal yang belum ada.
    // Jadi: tolak keras, dan hidupkan lagi hanya bersama ledger saldo itu.
    if (turbo) {
      throw new BadRequestException(
        'Pack turbo belum tersedia untuk pembelian rupiah. Beli pack biasa — kartunya dikirim ke wallet Anda.',
      );
    }

    // Harga SELALU di-snapshot dari mesin mereka, tidak pernah di-hardcode dan tidak pernah
    // dari klien. Angka inilah yang dibukukan ke ledger dan dipakai menghitung plafon.
    const machines = await this.client.machines();
    const machine = machines.find((m) => m.code === packType);
    if (!machine) {
      throw new BadRequestException(
        `Mesin "${packType}" tidak tersedia di CollectorCrypt.`,
      );
    }

    this.assertPriceWithinCeiling(machine.code, machine.priceUsdcBaseUnits);
    await this.assertDailyCapNotExceeded(
      treasury.publicKey,
      machine.priceUsdcBaseUnits,
    );

    // Penerima kartu SELALU dari JWT. Tidak ada field di PurchasePackDto yang bisa
    // menyebut wallet — kartu yang dibayar treasury tidak boleh bisa dibelokkan.
    const recipient = user.walletAddress;
    const payer = treasury.publicKey;

    const pack = await this.client.generatePack({
      playerAddress: payer,
      packType,
      turbo,
      altPlayerAddress: recipient,
    });
    const memo = pack.memo;

    // WRITE-AHEAD. generatePack belum memindahkan dana, tapi begitu kita MENANDATANGANI,
    // treasury sudah terikat. Jadi baris ledger harus ada LEBIH DULU: baris inilah
    // satu-satunya bukti kita atas bagi hasil 50% dan satu-satunya cara menghubungkan
    // pack ini ke user yang membayarnya. Gagal menulis = pembelian dibatalkan, dan
    // tidak ada satu pun rupiah/USDC yang bergerak.
    try {
      await this.prisma.ccPackPurchase.create({
        data: {
          memo,
          userId: user.id,
          // Pembayarnya treasury — BUKAN wallet user. Kolom ini juga yang membedakan
          // baris "dibayar treasury" dari baris user-bayar saat menghitung plafon harian.
          playerAddress: payer,
          packType,
          turbo,
          priceUsdc: machine.priceUsdcBaseUnits,
          status: CcPackStatus.GENERATED,
        },
      });
    } catch (err) {
      this.logger.error(
        `Ledger gagal ditulis untuk memo ${memo} (user ${user.id}): ${errorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        'Gagal mencatat pembelian. Transaksi TIDAK ditandatangani — tidak ada dana treasury yang berpindah.',
      );
    }

    // Ikat apa yang akan kita TANDATANGANI ke baris yang barusan kita tulis. Di jalur
    // user-bayar cek ini menjaga kita dari blob kiriman user; di sini ia menjaga kita dari
    // CollectorCrypt sendiri (atau MITM / base URL salah) yang mengembalikan transaksi
    // milik memo lain. Kita menandatangani dengan hot key: yang kita teken harus benar-benar
    // pack ini. Sengaja SEBELUM klaim di bawah — transaksi asing tidak boleh membakar klaim
    // GENERATED→SUBMITTING dan meninggalkan baris di status "hasil tidak diketahui" padahal
    // jelas-jelas tidak ada uang yang bergerak.
    assertTransactionCarriesMemo(pack.transaction, memo);

    // Klaim ATOMIK. Di jalur user-bayar ini mencegah user ditagih 2×; di sini yang
    // terancam bayar 2× adalah TREASURY KITA — dan tidak ada lagi wallet user yang bisa
    // menolak tanda tangan kedua. `count !== 1` = ada request lain yang menang duluan.
    const claimed = await this.prisma.ccPackPurchase.updateMany({
      where: { memo, userId: user.id, status: CcPackStatus.GENERATED },
      data: { status: CcPackStatus.SUBMITTING },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        'Pack ini sedang diproses dan hasilnya belum pasti. Cek status pack ini — ' +
          'jangan ulangi pembelian, berisiko terbayar dua kali.',
      );
    }

    // Tanda tangan treasury. Gagal di sini = TIDAK ADA APA PUN yang pernah dikirim ke
    // CollectorCrypt maupun ke chain → ini satu-satunya titik di alur ini yang boleh
    // ditulis FAILED, karena hanya di sini kita YAKIN tidak ada uang yang bergerak.
    let signedTransaction: string;
    try {
      signedTransaction = this.treasurySign(treasury, pack.transaction);
    } catch (err) {
      await this.flagError(memo, err, CcPackStatus.FAILED);
      throw err;
    }

    let submitted: CcSubmitTransactionResponse;
    try {
      submitted = await this.client.submitTransaction({ signedTransaction });
    } catch (err) {
      // Status SENGAJA dibiarkan SUBMITTING. submitTransaction TIDAK idempoten dan
      // timeout kita BUKAN bukti transaksinya tidak tayang on-chain. "Tidak diketahui"
      // bukan "gagal": menulis FAILED di sini membuka jalan submit ulang → treasury
      // membayar dua kali untuk satu pack. Jalan keluarnya cuma packStatus(memo).
      await this.flagError(memo, err);
      throw err;
    }

    if (!submitted.success) {
      // Sama persis: CC bilang tidak sukses, tapi kita tetap tidak PUNYA BUKTI bahwa
      // transaksinya tidak tayang. Tetap SUBMITTING, tetap rekonsiliasi lewat packStatus.
      const err = new ServiceUnavailableException(
        'CollectorCrypt tidak mengonfirmasi pembayaran pack ini. Cek status pack — jangan ulangi pembelian.',
      );
      await this.flagError(memo, err);
      throw err;
    }

    await this.prisma.ccPackPurchase.update({
      where: { memo },
      data: {
        status: CcPackStatus.SUBMITTED,
        purchaseSignature: submitted.signature,
        error: null,
      },
    });

    // Sejak titik ini pack SUDAH DIBAYAR. Apa pun yang gagal setelah ini TIDAK BOLEH
    // menurunkan status: openPack idempoten, jadi baris SUBMITTED selalu bisa
    // diselesaikan belakangan lewat open(memo) tanpa membayar lagi.
    let opened: CcOpenPackResponse;
    try {
      opened = await this.client.openPack({ memo });
    } catch (err) {
      await this.flagError(memo, err);
      throw new ServiceUnavailableException(PAID_NOT_DELIVERED);
    }

    const hold = openPackHoldReason(opened);
    if (hold) {
      // Keadaan NON-TERMINAL (mis. WAITING_FOR_PAYMENT, atau nft_address belum terbit).
      // Menulis OPENED di sini adalah korupsi ledger: statusnya akan berbunyi "kartu sudah
      // diberikan" padahal nftAddress NULL — pack berbayar yang tak terkirim itu lalu jadi
      // TAK TERLIHAT oleh query "cari pack yang belum terkirim" dan tak bisa di-buyback.
      // Jadi: tetap SUBMITTED (= sudah bayar, belum terkirim), catat alasannya, dan minta
      // user mengambilnya lagi nanti.
      await this.flagError(memo, new Error(`openPack belum final: ${hold}`));
      throw new ServiceUnavailableException(PAID_NOT_DELIVERED);
    }

    // Sama seperti open(): normalkan rarity ke kanonik kapital, dan JANGAN gagalkan pack yang
    // sudah terbuka on-chain hanya karena casing/format rarity tak dikenal — catat mentahnya.
    const rarity = toCcRarity(opened.rarity);
    if (rarity === null) {
      this.logger.warn(
        `Rarity openPack tak dikenal untuk memo ${memo}: "${opened.rarity}".`,
      );
    }
    const done = await this.prisma.ccPackPurchase.update({
      where: { memo },
      data: {
        status: CcPackStatus.OPENED,
        rarity,
        nftAddress: opened.nft_address,
        // Opsional-aman walau turbo ditolak di atas: bentuk ini cerminan dokumentasi CC,
        // bukan kontrak yang mereka jamin. Deref buta atas pack yang SUDAH terbuka
        // on-chain (ireversibel) = pack itu gagal tercatat dan tersangkut selamanya.
        nftName: opened.nftWon?.content?.metadata?.name ?? null,
        nftImage: resolveNftImage(opened.nftWon?.content),
        openSignature: opened.transactionSignature,
        roll: opened.roll == null ? null : String(opened.roll),
        points: opened.points ?? null,
        openedAt: new Date(),
        error: rarity === null ? unrecognisedRarityNote(opened.rarity) : null,
      },
    });
    return toCcPackDto(done);
  }

  /**
   * Baris kita + lifecycle versi mereka, untuk memo milik user ini.
   * Kegagalan panggilan ini TIDAK menandai baris FAILED: ini operasi baca, dan
   * menurunkan status baris OPENED gara-gara error baca justru merusak ledger.
   */
  async packStatus(memo: string, user: AuthUser): Promise<CcPackStatusDto> {
    const row = await this.ownedRow(memo, user);
    const remote = await this.client.packStatus(memo);
    return { pack: toCcPackDto(row), collectorcrypt: remote };
  }

  /** Ledger milik user login, terbaru dulu. */
  async myPacks(userId: string): Promise<CcPackDto[]> {
    const rows = await this.prisma.ccPackPurchase.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toCcPackDto);
  }

  /* --- Buyback (jendela 72 jam milik mereka) --- */

  /**
   * Minta transaksi jual-balik. Nominalnya (`refundAmount`) MURNI dari mereka —
   * kuotasi lokal atas kartu nyata = janji yang belum tentu bisa kita tepati.
   *
   * Status baris tetap OPENED: transaksinya baru BOUGHT_BACK setelah user
   * menandatangani dan dana benar-benar berpindah — hal yang hanya bisa dipastikan
   * dengan membaca sisi mereka, bukan dengan menerbitkan kuotasi ini.
   */
  async buyback(dto: BuybackDto, user: AuthUser): Promise<CcBuybackQuoteDto> {
    // Kepemilikan diverifikasi lewat ledger, bukan lewat klaim klien: nftAddress
    // (seperti memo) bersifat publik dan tidak boleh dipercaya sebagai kapabilitas.
    const row = await this.prisma.ccPackPurchase.findFirst({
      where: {
        userId: user.id,
        nftAddress: dto.nftAddress,
        status: CcPackStatus.OPENED,
      },
    });
    if (!row) {
      this.logger.warn(
        `Buyback ditolak: NFT ${dto.nftAddress} bukan hasil pack user ${user.id}.`,
      );
      throw new ForbiddenException(
        'NFT ini bukan hasil pack yang Anda buka di Hoshi.',
      );
    }

    let res: CcBuybackResponse;
    try {
      res = await this.client.buyback({
        playerAddress: user.walletAddress,
        nftAddress: dto.nftAddress,
      });
    } catch (err) {
      // Catat errornya, TAPI status tetap OPENED: buyback yang gagal tidak
      // menghapus fakta bahwa pack-nya sudah dibuka dan kartunya milik user.
      await this.flagError(row.memo, err);
      throw err;
    }

    await this.prisma.ccPackPurchase.update({
      where: { memo: row.memo },
      data: { buybackAmountUsdc: res.refundAmount, error: null },
    });

    return {
      packMemo: row.memo,
      buybackMemo: res.memo,
      nftAddress: dto.nftAddress,
      refundAmountUsdc: res.refundAmount,
      serializedTransaction: res.serializedTransaction,
    };
  }

  /* --- Internal: treasury --- */

  /**
   * Treasury siap dipakai — atau tolak SEBELUM apa pun bergerak. Menolak lebih awal
   * itu gratis; menandatangani dengan konfigurasi setengah jadi tidak bisa ditarik lagi.
   */
  private treasuryOrRefuse(): TreasuryService {
    const treasury = this.treasury;
    if (!treasury || !treasury.isConfigured()) {
      throw new ServiceUnavailableException(
        'Pembelian pack lewat treasury Hoshi belum aktif. ' +
          'Set HOSHI_TREASURY_SECRET_KEY (lihat .env.example) di environment.',
      );
    }
    return treasury;
  }

  /**
   * Pembungkus tanda tangan. TreasuryService sudah melempar error yang bersih, tapi
   * error TAK DIKENAL dari jalur ini lahir sejengkal dari private key — dan pesannya
   * akan mendarat di kolom `error` ledger DAN di response HTTP. Jadi apa pun yang bukan
   * HttpException kita ganti dengan pesan kita sendiri, dan detailnya tidak dicatat.
   */
  private treasurySign(treasury: TreasuryService, transaction: string): string {
    try {
      return treasury.sign(transaction);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(
        'Penandatanganan treasury gagal karena error tak dikenal (detail sengaja tidak dicatat).',
      );
      throw new InternalServerErrorException(
        'Gagal menandatangani transaksi pembelian pack. Tidak ada dana yang berpindah.',
      );
    }
  }

  /**
   * Plafon HARGA SATU PACK. Nominal yang kita bayar sepenuhnya ditentukan respons
   * /api/machines mereka, dan tidak ada lagi popup wallet yang bisa menahannya.
   */
  private assertPriceWithinCeiling(code: string, price: number): void {
    const ceiling = this.positiveIntConfig(
      'GACHA_MAX_PACK_PRICE_USDC',
      TREASURY_MAX_PACK_PRICE_USDC,
    );
    if (!Number.isSafeInteger(price) || price <= 0 || price > ceiling) {
      this.logger.error(
        `Harga mesin ${code} = ${price} di luar plafon ${ceiling} (USDC base unit). Menolak menandatangani.`,
      );
      throw new ServiceUnavailableException(
        'Harga pack dari CollectorCrypt di luar batas wajar. Pembelian dibatalkan — tidak ada dana yang berpindah.',
      );
    }
  }

  /**
   * Circuit breaker belanja treasury 24 jam berjalan. Dihitung dari LEDGER (bukan dari
   * memori proses) supaya restart, banyak instance, dan deploy tidak mereset plafon.
   * `playerAddress = treasury` yang memisahkan baris treasury dari baris user-bayar.
   */
  private async assertDailyCapNotExceeded(
    treasuryAddress: string,
    price: number,
  ): Promise<void> {
    const cap = this.positiveIntConfig(
      'GACHA_TREASURY_DAILY_CAP_USDC',
      TREASURY_DAILY_CAP_USDC,
    );
    const spent = await this.prisma.ccPackPurchase.aggregate({
      _sum: { priceUsdc: true },
      where: {
        playerAddress: treasuryAddress,
        status: { in: TREASURY_SPENT_STATUSES },
        createdAt: { gte: new Date(Date.now() - TREASURY_SPEND_WINDOW_MS) },
      },
    });
    const alreadySpent = spent._sum.priceUsdc ?? 0;
    if (alreadySpent + price > cap) {
      this.logger.error(
        `Plafon treasury 24 jam tercapai: ${alreadySpent} + ${price} > ${cap} (USDC base unit). Pembelian ditolak.`,
      );
      throw new ServiceUnavailableException(
        'Kuota pembelian pack sedang penuh. Coba lagi nanti — tidak ada dana Anda yang terpotong.',
      );
    }
  }

  /**
   * Batas nominal yang salah ketik TIDAK boleh diam-diam dilewati → fail closed.
   * `config` bisa tidak ada (unit test): pakai default yang sudah aman.
   */
  private positiveIntConfig(key: string, fallback: number): number {
    const raw = this.config?.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new InternalServerErrorException(
        `${key} harus bilangan bulat positif (USDC base unit, 6 desimal).`,
      );
    }
    return value;
  }

  /* --- Internal --- */

  /**
   * Memo ditulis ke transaksi on-chain → PUBLIK, jadi ia kunci join internal, bukan
   * kapabilitas. Tanpa cek pemilik ini, siapa pun yang tahu sebuah memo bisa membuka
   * pack orang lain (openPack idempoten & mengembalikan hasil lengkap) atau mengintip
   * wallet & nominal milik user lain.
   */
  private async ownedRow(
    memo: string,
    user: AuthUser,
  ): Promise<CcPackPurchase> {
    const row = await this.prisma.ccPackPurchase.findUnique({
      where: { memo },
    });
    if (!row) throw new NotFoundException('Pack tidak ditemukan.');
    if (row.userId !== user.id) {
      this.logger.warn(
        `Akses memo ${memo} ditolak untuk user ${user.id} (pemilik: ${row.userId}).`,
      );
      throw new ForbiddenException('Pack ini bukan milik Anda.');
    }
    return row;
  }

  /**
   * Rekam kegagalan ke ledger, lalu biarkan exception-nya naik (tidak pernah ditelan).
   * Kegagalan menulis error TIDAK boleh menutupi error aslinya → cukup di-log.
   */
  private async flagError(
    memo: string,
    err: unknown,
    status?: CcPackStatus,
  ): Promise<void> {
    const message = errorMessage(err);
    try {
      await this.prisma.ccPackPurchase.update({
        where: { memo },
        data: { error: message, ...(status ? { status } : {}) },
      });
    } catch (dbErr) {
      this.logger.error(
        `Gagal menandai error pada memo ${memo}: ${errorMessage(dbErr)} (error asli: ${message})`,
      );
    }
  }
}

/**
 * Ikat transaksi yang di-submit ke memo di path — tanpa ini, `signedTransaction` cuma
 * blob base64 sembarang yang kita teruskan ke CC, lalu signature hasilnya kita tempelkan
 * ke baris memo tsb sebagai `purchaseSignature` + status SUBMITTED. Artinya user bisa
 * menandatangani transfer 1 lamport ke dirinya sendiri dan ledger kita mencatatnya
 * sebagai "pack terbayar" — meracuni satu-satunya bukti independen atas komisi 50% kita.
 *
 * CollectorCrypt menuliskan memo (`slug-uuid`) ke instruksi Memo sebagai UTF-8, jadi
 * string-nya pasti ada apa adanya di dalam byte transaksi. Memindai byte lebih tahan
 * banting daripada mendeserialisasi (transaksi legacy vs versioned punya layout beda),
 * dan ini pemeriksaan defensif — bukan pengganti validasi di sisi mereka.
 */
function assertTransactionCarriesMemo(
  signedTransaction: string,
  memo: string,
): void {
  let raw: Buffer;
  try {
    raw = Buffer.from(signedTransaction, 'base64');
  } catch {
    throw new BadRequestException('signedTransaction bukan base64 yang sah.');
  }
  if (raw.length === 0 || !raw.includes(Buffer.from(memo, 'utf8'))) {
    throw new BadRequestException(
      'Transaksi yang dikirim tidak memuat memo pack ini. ' +
        'Tandatangani transaksi yang dikembalikan generatePack, jangan yang lain.',
    );
  }
}

/**
 * Alasan sebuah respons openPack BELUM final — atau null kalau benar-benar final.
 *
 * OPENED WAJIB terminal-only. Kontrak CC juga mengenal respons non-terminal bergaya
 * `{ success: true, code: 'WAITING_FOR_PAYMENT' }`, dan `nft_address` yang mereka ketik
 * "selalu ada" justru TIDAK ada pada keadaan itu. Menulis OPENED untuk respons semacam itu
 * bukan sekadar tidak rapi — itu KORUPSI LEDGER: barisnya berbunyi "kartu sudah diberikan"
 * padahal nftAddress NULL. Pack berbayar yang tak terkirim itu lalu (a) tampil sebagai pack
 * terbuka tanpa kartu di myPacks, (b) tak terlihat oleh query "cari pack belum terkirim",
 * dan (c) tak pernah bisa di-buyback (buyback menyaring status OPENED + nftAddress).
 *
 * Baris SUBMITTED jauh lebih jujur: "sudah dibayar, belum terkirim" — dan openPack idempoten,
 * jadi memanggilnya lagi nanti aman dan gratis.
 */
function openPackHoldReason(res: CcOpenPackResponse): string | null {
  if (!res.success) return 'success=false';
  // Sengaja dilebarkan dari tipe wire: mereka mengetiknya wajib, kenyataannya bisa hilang.
  const nftAddress: string | null | undefined = res.nft_address;
  if (typeof nftAddress !== 'string' || nftAddress.length === 0) {
    return res.code ? `code=${res.code}` : 'nft_address kosong';
  }
  return null;
}

/**
 * Catatan untuk rarity openPack yang tak bisa dinormalkan ke 4-tier CC. Pack-nya SUDAH
 * terbuka on-chain (ireversibel), jadi nilai mentah dicatat di `error` — BUKAN dilempar —
 * dan rarity disimpan null supaya tak ada nilai sampah yang menyusup ke DB.
 */
function unrecognisedRarityNote(raw: string): string {
  return `Rarity CollectorCrypt tak dikenal: "${raw}". Disimpan null; kartu tetap terbuka.`.slice(
    0,
    ERROR_MAX,
  );
}

/**
 * Ekstrak array winner mentah dari amplop getRecentWinners.
 *
 * Bentuk terverifikasi ke API devnet: `{ success: true, data: [ ... ] }`. Tetap toleran
 * kalau suatu saat CC mengirim array telanjang — sama pola-nya dengan machines(). Apa pun
 * yang bukan array (null, objek tanpa data, dsb) → array kosong, BUKAN throw.
 */
function extractWinnerArray(response: unknown): CcRecentWinnerRaw[] {
  if (Array.isArray(response)) {
    return response as CcRecentWinnerRaw[];
  }
  if (response && typeof response === 'object') {
    const data = (response as { data?: unknown }).data;
    if (Array.isArray(data)) {
      return data as CcRecentWinnerRaw[];
    }
  }
  return [];
}

/**
 * Bentuk MINIMAL content NFT yang memuat gambar — irisan bersama antara payload
 * getRecentWinners (CcRecentWinnerRaw.nft.content) dan openPack (CcNftWon.content).
 */
interface NftImageContent {
  links?: { image?: string };
  files?: { uri?: string; cdn_uri?: string }[];
}

/**
 * URL gambar sebuah NFT dari content mentah CC, atau null bila tidak ada.
 *
 * SATU-SATUNYA tempat urutan resolusi gambar didefinisikan — dipakai winners()
 * (via toGachaWinner) DAN persist hasil open/purchase, supaya kartu yang tampil
 * di ticker dan kartu milik user tidak pernah beda sumber gambar.
 *
 * `??` tidak cukup: feed CC kadang mengirim links.image = "" (string kosong), dan `??`
 * hanya jatuh pada null/undefined — string kosong akan lolos padahal ada cdn_uri/uri
 * valid. Pilih yang PERTAMA yang tidak kosong: links.image → files[0].cdn_uri →
 * files[0].uri.
 */
function resolveNftImage(
  content: NftImageContent | null | undefined,
): string | null {
  const files = content?.files;
  const firstFile = Array.isArray(files) ? files[0] : undefined;
  return (
    [content?.links?.image, firstFile?.cdn_uri, firstFile?.uri].find(
      (u): u is string => typeof u === 'string' && u.length > 0,
    ) ?? null
  );
}

/**
 * Winner mentah CC → GachaWinner bersih, atau null bila item tak layak tampil.
 *
 * DEFENSIF sepenuhnya: bentuk item tidak dijamin kontrak, jadi tiap lapis dibaca lewat
 * optional chaining dan divalidasi tipenya. nftAddress (kunci dedupe), name, dan image
 * WAJIB ada & non-kosong — item tanpa salah satunya dibuang (return null), tidak dipaksakan.
 * Gambar di-resolve lewat resolveNftImage (logika tunggal bersama persist open/purchase).
 * Tidak ada nilai USD yang disentuh: payload ini tidak menjamin harga, jadi kita tidak
 * mengarangnya.
 */
function toGachaWinner(raw: CcRecentWinnerRaw): GachaWinner | null {
  const content = raw?.nft?.content;
  const nftAddress = raw?.nft?.id;
  const name = content?.metadata?.name;
  const winner = raw?.winner;
  const image = resolveNftImage(content);

  if (
    typeof nftAddress !== 'string' ||
    nftAddress.length === 0 ||
    typeof name !== 'string' ||
    name.length === 0 ||
    image === null ||
    typeof winner !== 'string' ||
    winner.length === 0
  ) {
    return null;
  }

  return {
    nftAddress,
    name,
    image,
    winner,
    tier: typeof raw?.prize_tier === 'number' ? raw.prize_tier : 0,
  };
}

/** Baris ledger → bentuk publik. `rarity` tetap 4-tier CollectorCrypt, bukan tier Hoshi. */
function toCcPackDto(row: CcPackPurchase): CcPackDto {
  return {
    memo: row.memo,
    packType: row.packType,
    status: row.status,
    turbo: row.turbo,
    playerAddress: row.playerAddress,
    priceUsdc: row.priceUsdc,
    purchaseSignature: row.purchaseSignature,
    openSignature: row.openSignature,
    rarity: row.rarity as CcRarity | null,
    nftAddress: row.nftAddress,
    nftName: row.nftName,
    nftImage: row.nftImage,
    roll: row.roll,
    points: row.points,
    buybackAmountUsdc: row.buybackAmountUsdc,
    error: row.error,
    createdAt: row.createdAt,
    openedAt: row.openedAt,
  };
}
