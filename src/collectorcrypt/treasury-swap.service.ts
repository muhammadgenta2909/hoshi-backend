import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TreasurySwapStatus } from '@prisma/client';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { randomUUID } from 'crypto';
import bs58 from 'bs58';
import { PrismaService } from '../prisma/prisma.service';
import {
  IDRX_DECIMALS,
  IDRX_MINT_SOLANA,
  JupiterClient,
  USDC_MINT_MAINNET_STR,
} from './jupiter.client';
import type { JupQuote } from './jupiter.client';
import { TreasuryService } from './treasury.service';

/**
 * PENUTUP LINGKARAN MODAL KERJA: IDRX → USDC.
 *
 * Masalah yang diselesaikannya, dinyatakan terang-terangan karena ia tidak menimbulkan
 * error apa pun: user Indonesia membayar rupiah, IDRX mencetak IDRX ke treasury, tapi pack
 * dibayar dengan USDC. Dua saldo BERBEDA di dompet yang SAMA. Tanpa jalur ini, USDC turun
 * $25 tiap penjualan dan tidak pernah naik — sampai preflight mulai menolak order dan user
 * melihat "stok tidak mencukupi", padahal di wallet yang sama menumpuk IDRX senilai hampir
 * sebesar USDC yang habis.
 *
 * INI ROBOT YANG MEMBELANJAKAN UANG ASLI. Semua pengaman di bawah ada karena alasan spesifik,
 * bukan karena kehati-hatian umum:
 *
 *  1. KLAIM ATOMIK (TreasurySwapLock) — dua instance yang menyapu bersamaan akan menguotasi
 *     saldo IDRX yang SAMA dan mengirim DUA transaksi. Yang kedua kemungkinan gagal on-chain,
 *     tapi "kemungkinan" bukan invariant.
 *  2. GERBANG IN-FLIGHT — selama ada swap SUBMITTED/NEEDS_CHECK yang belum tuntas, kita TIDAK
 *     memulai yang baru. Saldo IDRX yang terbaca saat itu belum tentu masih ada.
 *  3. WRITE-AHEAD + SIGNATURE SEBELUM BROADCAST — signature diambil dari transaksi yang SUDAH
 *     ditandatangani dan DISIMPAN sebelum dikirim. Kalau proses mati tepat saat mengirim, masih
 *     ada satu baris berisi signature yang bisa dilacak on-chain. Tanpa itu, uang bisa berpindah
 *     tanpa jejak sama sekali di sisi kita.
 *  4. ROLL FORWARD — sesudah broadcast, "error" TIDAK berarti "tidak terjadi apa-apa". Tidak
 *     ada retry otomatis; yang ada adalah penyelesaian berdasarkan status on-chain.
 *  5. PLAFON & SANITY KURS — price impact dan kurs efektif diperiksa terhadap batas yang
 *     DIPILIH SESEORANG. Pool IDRX/USDC di Solana tipis (rute hilang di atas ~Rp 50 juta),
 *     jadi swap besar bukan cuma mahal, tapi bisa tidak punya rute sama sekali.
 */

/** Satu-satunya baris kunci. */
const LOCK_ID = 'singleton';

/**
 * Umur kunci sebelum dianggap ditinggalkan pemegangnya. Harus LEBIH LAMA dari satu putaran
 * swap terburuk (kuotasi + build + konfirmasi), kalau tidak instance kedua bisa masuk saat
 * yang pertama masih menunggu konfirmasi.
 */
const LOCK_STALE_MS = 10 * 60_000;

/** Batas menunggu konfirmasi on-chain sebelum status jatuh ke NEEDS_CHECK. */
const CONFIRM_TIMEOUT_MS = 90_000;
const CONFIRM_POLL_MS = 3_000;

/** Rupiah penuh → IDRX base unit (2 desimal). */
const IDR_TO_BASE = 10 ** IDRX_DECIMALS;

/** Di bawah ini, biaya gas & perhatian manusia lebih mahal dari nilai yang diselamatkan. */
const DEFAULT_MIN_IDR = 500_000;

/**
 * Plafon satu swap. Default Rp 10 juta — diukur langsung di pool: price impact 0,158%
 * (vs 0,98% di Rp 50 juta, dan RUTE HILANG di Rp 200 juta). Menaikkan ini berarti membayar
 * lebih mahal per rupiah yang ditukar.
 */
const DEFAULT_MAX_IDR = 10_000_000;

/** Plafon 24 jam — pengaman terhadap kebocoran logika yang menguras treasury lewat swap beruntun. */
const DEFAULT_DAILY_CAP_IDR = 50_000_000;

const DEFAULT_SLIPPAGE_BPS = 100;
const DEFAULT_MAX_PRICE_IMPACT_BPS = 100;

/**
 * Pita kewarasan kurs (rupiah per USDC). BUKAN tuning — ini pemutus arus terhadap pool yang
 * dimanipulasi atau kuotasi yang salah satuan. Kurs pasar saat ditulis ~Rp 18.000; pita
 * 12.000–25.000 memberi ruang gerak tahunan yang lebar sambil tetap menolak yang absurd.
 */
const DEFAULT_MIN_RATE = 12_000;
const DEFAULT_MAX_RATE = 25_000;

/** SOL minimum yang harus tersisa untuk fee. Cermin TREASURY_MIN_GAS_LAMPORTS di PaymentsService. */
const MIN_GAS_LAMPORTS = 10_000_000;

const ERROR_MAX = 500;

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

export type SwapOutcome =
  | 'SWAPPED' // USDC benar-benar masuk, terkonfirmasi on-chain
  | 'NOTHING_TO_DO' // saldo IDRX di bawah ambang minimum
  | 'DISABLED' // kill-switch aktif
  | 'NOT_MAINNET' // IDRX tidak ada di luar mainnet
  | 'LOCKED' // instance lain sedang menyapu
  | 'BLOCKED_IN_FLIGHT' // ada swap yang belum tuntas — tidak boleh menumpuk
  | 'DAILY_CAP' // plafon 24 jam tercapai
  | 'REJECTED_PRICE' // impact/kurs di luar batas yang dipilih
  | 'UNAVAILABLE' // treasury/RPC/Jupiter tidak siap — transien, coba lagi
  | 'NEEDS_CHECK' // sudah broadcast tapi hasilnya tidak terbaca → periksa manual
  | 'FAILED'; // gagal dan TERBUKTI tidak ada dana yang berpindah

export interface SwapResult {
  outcome: SwapOutcome;
  /** Rupiah penuh yang ditukar (0 bila tidak jadi). */
  idr: number;
  /** USDC base unit yang diterima, bila sudah pasti. */
  usdcBaseUnits: number | null;
  rateIdrPerUsdc: number | null;
  priceImpactBps: number | null;
  signature: string | null;
  reason: string | null;
}

const nothing = (
  outcome: SwapOutcome,
  reason: string | null = null,
): SwapResult => ({
  outcome,
  idr: 0,
  usdcBaseUnits: null,
  rateIdrPerUsdc: null,
  priceImpactBps: null,
  signature: null,
  reason,
});

@Injectable()
export class TreasurySwapService {
  private readonly logger = new Logger(TreasurySwapService.name);
  /** Identitas proses ini — hanya pemegang yang sama yang boleh melepas kunci. */
  private readonly instanceId = randomUUID();
  private conn: Connection | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jupiter: JupiterClient,
    @Optional() private readonly treasury?: TreasuryService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /* ─────────────────────────── Entry point ─────────────────────────── */

  /**
   * Satu putaran: baca saldo IDRX, tukar sebanyak yang diizinkan plafon, catat hasilnya.
   * TIDAK PERNAH melempar — dipanggil dari timer, dan sebuah exception di sini akan
   * menghentikan seluruh penyapuan berikutnya.
   */
  async sweep(): Promise<SwapResult> {
    try {
      return await this.sweepInner();
    } catch (err) {
      // Sampai sini seharusnya tidak pernah: setiap jalur di dalam sudah menelan errornya.
      this.logger.error(
        `Sapuan swap gagal tak terduga: ${errorMessage(err)}. Tidak ada perubahan status.`,
      );
      return nothing('UNAVAILABLE', errorMessage(err));
    }
  }

  private async sweepInner(): Promise<SwapResult> {
    if (this.str('TREASURY_SWAP_ENABLED') === '0') {
      return nothing('DISABLED', 'TREASURY_SWAP_ENABLED=0');
    }
    if (this.cluster() !== 'mainnet-beta') {
      // Bukan error: di devnet IDRX memang tidak ada, jadi tidak ada yang perlu ditukar.
      return nothing('NOT_MAINNET', `SOLANA_CLUSTER=${this.cluster()}`);
    }
    if (!this.treasury?.isConfigured()) {
      return nothing('UNAVAILABLE', 'HOSHI_TREASURY_SECRET_KEY belum di-set');
    }
    const conn = this.connection();
    if (!conn) return nothing('UNAVAILABLE', 'SOLANA_RPC_URL belum di-set');

    // Kunci diambil SEBELUM apa pun dibaca: saldo yang dibaca tanpa kunci bisa sudah
    // ditukar instance lain sebelum kita sempat memakainya.
    if (!(await this.acquireLock())) {
      return nothing('LOCKED', 'instance lain sedang menyapu');
    }

    try {
      // Swap yang belum tuntas berarti saldo IDRX yang kita baca mungkin sudah "terjanji"
      // ke transaksi yang sedang melayang. Menumpuk swap di atasnya = menukar dua kali.
      const inFlight = await this.prisma.treasurySwap.findFirst({
        where: {
          status: {
            in: [TreasurySwapStatus.SUBMITTED, TreasurySwapStatus.NEEDS_CHECK],
          },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (inFlight) {
        // NEEDS_CHECK sengaja MEMBLOKIR, bukan sekadar dilaporkan: selama ada satu swap yang
        // hasilnya tidak diketahui, tidak ada angka saldo yang bisa dipercaya.
        this.logger.error(
          `Swap ${inFlight.id} masih ${inFlight.status} (signature: ${inFlight.signature ?? '—'}). ` +
            'Swap baru DITAHAN sampai statusnya tuntas — butuh pemeriksaan manual bila menetap.',
        );
        return nothing(
          'BLOCKED_IN_FLIGHT',
          `swap ${inFlight.id} berstatus ${inFlight.status}`,
        );
      }

      const owner = new PublicKey(this.treasury.publicKey);

      // Gas dicek DULU: swap tanpa SOL akan gagal setelah kita menandatangani, dan itu
      // menyisakan baris SUBMITTED yang harus diperiksa manusia tanpa alasan.
      const lamports = await conn.getBalance(owner);
      if (lamports < MIN_GAS_LAMPORTS) {
        this.logger.error(
          `ALARM SOL: treasury ${lamports} lamports < minimum ${MIN_GAS_LAMPORTS}. ` +
            'Swap DITUNDA — isi SOL treasury, kalau tidak pembelian pack juga akan berhenti.',
        );
        return nothing('UNAVAILABLE', 'SOL treasury di bawah minimum gas');
      }

      const idrxBaseUnits = await this.readIdrx(conn, owner);
      if (idrxBaseUnits === null) {
        return nothing('UNAVAILABLE', 'saldo IDRX tidak terbaca');
      }

      const minIdr = this.int('TREASURY_SWAP_MIN_IDR', DEFAULT_MIN_IDR, 0);
      const availableIdr = Math.floor(idrxBaseUnits / IDR_TO_BASE);
      if (availableIdr < minIdr) {
        return nothing(
          'NOTHING_TO_DO',
          `IDRX Rp ${availableIdr.toLocaleString('id-ID')} < ambang Rp ${minIdr.toLocaleString('id-ID')}`,
        );
      }

      // Plafon per-swap DAN plafon harian, keduanya memotong nominal — bukan menolaknya.
      // Menolak berarti IDRX menumpuk lebih banyak lagi; memotong tetap memajukan keadaan.
      const maxIdr = this.int('TREASURY_SWAP_MAX_IDR', DEFAULT_MAX_IDR, 1);
      const remainingToday = await this.remainingDailyIdr();
      if (remainingToday < minIdr) {
        this.logger.warn(
          `Plafon swap 24 jam tercapai (sisa Rp ${remainingToday.toLocaleString('id-ID')}). ` +
            'IDRX akan menumpuk sampai jendela bergeser.',
        );
        return nothing('DAILY_CAP', `sisa plafon Rp ${remainingToday}`);
      }

      const swapIdr = Math.min(availableIdr, maxIdr, remainingToday);
      const amountBase = BigInt(swapIdr) * BigInt(IDR_TO_BASE);

      return await this.executeSwap(conn, owner, amountBase, swapIdr);
    } finally {
      await this.releaseLock();
    }
  }

  /**
   * Riwayat swap terakhir untuk endpoint admin.
   *
   * Kolom nominalnya BigInt di Prisma, dan `JSON.stringify` MELEMPAR pada BigInt —
   * sebuah endpoint yang mengembalikan baris mentah akan 500 di produksi dan lolos di
   * unit test yang tidak pernah menyerialisasinya. Konversinya karena itu dilakukan
   * di sini, eksplisit, bukan diserahkan ke serializer.
   */
  async recentSwaps(take = 5): Promise<
    {
      id: string;
      status: TreasurySwapStatus;
      idr: number;
      usdc: string;
      rateIdrPerUsdc: number | null;
      priceImpactBps: number | null;
      signature: string | null;
      error: string | null;
      createdAt: Date;
    }[]
  > {
    const rows = await this.prisma.treasurySwap.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(take, 1), 50),
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      idr: Number(r.idrxBaseUnits) / IDR_TO_BASE,
      // Yang DITERIMA bila sudah pasti; kalau belum, yang DIKUOTASI — dan bedanya
      // terbaca dari `status`, bukan disamarkan jadi satu angka.
      usdc: (
        Number(r.receivedUsdcBaseUnits ?? r.quotedUsdcBaseUnits) / 1e6
      ).toFixed(2),
      rateIdrPerUsdc: r.rateIdrPerUsdc,
      priceImpactBps: r.priceImpactBps,
      signature: r.signature,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }

  /* ─────────────────────────── Eksekusi ─────────────────────────── */

  private async executeSwap(
    conn: Connection,
    owner: PublicKey,
    amountBase: bigint,
    swapIdr: number,
  ): Promise<SwapResult> {
    const slippageBps = this.int(
      'TREASURY_SWAP_SLIPPAGE_BPS',
      DEFAULT_SLIPPAGE_BPS,
      1,
    );

    // 1. Kuotasi. Kegagalan di sini MURAH — belum ada apa pun yang ditandatangani.
    let quote: JupQuote;
    try {
      quote = await this.jupiter.quoteIdrxToUsdc(amountBase, slippageBps);
    } catch (err) {
      this.logger.warn(
        `Kuotasi swap gagal: ${errorMessage(err)}. Dicoba lagi nanti.`,
      );
      return nothing('UNAVAILABLE', errorMessage(err));
    }

    // 2. Gerbang harga. SEBELUM tanda tangan, sesudah kuotasi.
    const usdc = Number(quote.outAmount) / 1e6;
    const rate = usdc > 0 ? Math.round(swapIdr / usdc) : Number.NaN;
    const impactBps = Number.isFinite(quote.priceImpactPct)
      ? Math.round(quote.priceImpactPct * 10_000)
      : null;
    const rejection = this.rejectPrice(rate, impactBps);
    if (rejection) {
      this.logger.error(
        `Swap Rp ${swapIdr.toLocaleString('id-ID')} DITOLAK: ${rejection}. ` +
          'Tidak ada transaksi yang dikirim.',
      );
      return {
        ...nothing('REJECTED_PRICE', rejection),
        idr: swapIdr,
        rateIdrPerUsdc: Number.isFinite(rate) ? rate : null,
        priceImpactBps: impactBps,
      };
    }

    // 3. WRITE-AHEAD. Baris ini lahir SEBELUM ada tanda tangan, dengan alasan yang sama
    //    seperti ledger CcPackPurchase: ini langkah terakhir yang belum memindahkan dana.
    const row = await this.prisma.treasurySwap.create({
      data: {
        idrxBaseUnits: amountBase,
        quotedUsdcBaseUnits: quote.outAmount,
        minUsdcBaseUnits: quote.minOutAmount,
        rateIdrPerUsdc: Number.isFinite(rate) ? rate : null,
        priceImpactBps: impactBps,
        slippageBps,
        status: TreasurySwapStatus.QUOTED,
      },
    });

    // 4. Bangun + tandatangani. Masih aman digagalkan: belum ada broadcast.
    let signedBase64: string;
    let signature: string;
    try {
      const built = await this.jupiter.buildSwapTransaction(
        quote,
        owner.toBase58(),
      );
      signedBase64 = this.treasury!.sign(built.swapTransactionBase64);
      signature = signatureOf(signedBase64);
    } catch (err) {
      // Belum dikirim → FAILED itu JUJUR di sini (beda dari kegagalan pasca-broadcast).
      await this.finish(row.id, TreasurySwapStatus.FAILED, {
        error: errorMessage(err),
      });
      this.logger.warn(
        `Swap ${row.id} batal sebelum dikirim: ${errorMessage(err)}. Tidak ada dana bergerak.`,
      );
      return { ...nothing('FAILED', errorMessage(err)), idr: swapIdr };
    }

    // 5. SIGNATURE DISIMPAN SEBELUM BROADCAST. Kalau proses mati di baris berikutnya, inilah
    //    satu-satunya benang yang menghubungkan kita ke uang yang mungkin sudah berpindah.
    await this.prisma.treasurySwap.update({
      where: { id: row.id },
      data: {
        status: TreasurySwapStatus.SUBMITTED,
        signature,
        submittedAt: new Date(),
      },
    });

    // 6. Broadcast. Mulai dari sini, TIDAK ADA RETRY OTOMATIS.
    try {
      await conn.sendRawTransaction(Buffer.from(signedBase64, 'base64'), {
        // Preflight dibiarkan menyala: simulasi yang gagal menolak transaksi SEBELUM
        // ia masuk jaringan, dan itu jauh lebih murah daripada gagal di dalam blok.
        skipPreflight: false,
        maxRetries: 3,
      });
    } catch (err) {
      // DUA JENIS KEGAGALAN PENGIRIMAN YANG SANGAT BERBEDA — membedakannya itu penting,
      // bukan kerapian:
      //
      //  (a) PREFLIGHT DITOLAK — node mensimulasikan transaksinya dan menolak SEBELUM
      //      menyebarkannya. Terbukti tidak masuk jaringan, jadi FAILED itu jujur dan
      //      putaran berikutnya boleh mencoba lagi. Ini kasus yang WAJAR terjadi (blockhash
      //      basi, saldo bergeser karena pembelian pack yang barusan jalan).
      //  (b) SISANYA — timeout, socket putus, 5xx dari RPC. Node BISA SAJA sudah menerima
      //      transaksinya. Satu-satunya yang berhak memutuskan adalah rantai.
      //
      // Tanpa pemisahan ini, satu preflight gagal yang tidak berbahaya akan berakhir
      // NEEDS_CHECK — dan NEEDS_CHECK MEMBLOKIR semua swap berikutnya sampai ada manusia
      // yang membereskannya. Pengaman yang benar tidak boleh macet oleh kejadian rutin.
      if (isPreflightRejection(err)) {
        await this.finish(row.id, TreasurySwapStatus.FAILED, {
          error: `Preflight ditolak (tidak disiarkan): ${errorMessage(err)}`,
        });
        this.logger.warn(
          `Swap ${row.id} ditolak preflight: ${errorMessage(err)}. ` +
            'Transaksi TIDAK disiarkan — tidak ada dana bergerak, akan dicoba lagi.',
        );
        return { ...nothing('FAILED', errorMessage(err)), idr: swapIdr };
      }
      this.logger.warn(
        `Swap ${row.id} (${signature}): pengiriman melempar ${errorMessage(err)}. ` +
          'Status ditentukan dari rantai, bukan dari error ini.',
      );
    }

    // 7. Penyelesaian berbasis rantai — satu-satunya sumber kebenaran.
    return this.settle(
      conn,
      owner,
      row.id,
      signature,
      swapIdr,
      quote,
      rate,
      impactBps,
    );
  }

  /**
   * Tentukan nasib swap dari RANTAI, bukan dari hasil pemanggilan RPC.
   *
   * Tiga kemungkinan, dan ketiganya ditangani berbeda:
   *  - terkonfirmasi tanpa err  → CONFIRMED, USDC dibaca dari meta transaksi
   *  - terkonfirmasi DENGAN err → FAILED. Transaksi Solana ATOMIK: yang gagal tidak
   *    memindahkan token sama sekali, jadi menyatakan FAILED di sini aman.
   *  - tidak pernah terlihat    → NEEDS_CHECK. TIDAK diasumsikan gagal: menganggapnya
   *    gagal lalu menukar ulang adalah cara paling rapi untuk menukar dua kali.
   */
  private async settle(
    conn: Connection,
    owner: PublicKey,
    id: string,
    signature: string,
    swapIdr: number,
    quote: JupQuote,
    rate: number,
    impactBps: number | null,
  ): Promise<SwapResult> {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let onChainError: string | null = null;
    let seen = false;

    while (Date.now() < deadline) {
      try {
        const res = await conn.getSignatureStatuses([signature]);
        const st = res.value[0];
        if (st) {
          const level = st.confirmationStatus;
          if (level === 'confirmed' || level === 'finalized') {
            seen = true;
            onChainError = st.err ? JSON.stringify(st.err).slice(0, 200) : null;
            break;
          }
        }
      } catch {
        // RPC berkedip. Bukan alasan menyimpulkan apa pun — lanjut polling.
      }
      await sleep(CONFIRM_POLL_MS);
    }

    if (!seen) {
      await this.finish(id, TreasurySwapStatus.NEEDS_CHECK, {
        error:
          'Transaksi tidak terlihat di rantai dalam batas waktu konfirmasi.',
      });
      this.logger.error(
        `SWAP TIDAK PASTI ${id} (${signature}): tidak terkonfirmasi dalam ` +
          `${CONFIRM_TIMEOUT_MS / 1000} detik. Swap berikutnya DITAHAN. Periksa signature ini ` +
          'di explorer; JANGAN menukar ulang sebelum dipastikan.',
      );
      return {
        ...nothing('NEEDS_CHECK', 'konfirmasi tidak terbaca'),
        idr: swapIdr,
        signature,
        rateIdrPerUsdc: Number.isFinite(rate) ? rate : null,
        priceImpactBps: impactBps,
      };
    }

    if (onChainError) {
      // Transaksi mendarat tapi revert. Atomik → tidak ada token yang berpindah.
      await this.finish(id, TreasurySwapStatus.FAILED, {
        error: `Transaksi gagal on-chain: ${onChainError}`,
      });
      this.logger.warn(
        `Swap ${id} (${signature}) gagal on-chain: ${onChainError}. ` +
          'Transaksi Solana atomik — tidak ada dana yang berpindah. Akan dicoba lagi.',
      );
      return {
        ...nothing('FAILED', onChainError),
        idr: swapIdr,
        signature,
      };
    }

    const received = await this.readReceivedUsdc(conn, owner, signature);
    await this.finish(id, TreasurySwapStatus.CONFIRMED, {
      receivedUsdcBaseUnits: received,
      confirmedAt: new Date(),
      error: null,
    });

    const usdcStr = (
      (received !== null ? Number(received) : Number(quote.outAmount)) / 1e6
    ).toFixed(2);
    this.logger.log(
      `Swap ${id} SELESAI: Rp ${swapIdr.toLocaleString('id-ID')} → $${usdcStr} ` +
        `(kurs Rp ${rate}/USDC, impact ${impactBps ?? '?'} bps, ${signature}).`,
    );

    return {
      outcome: 'SWAPPED',
      idr: swapIdr,
      usdcBaseUnits:
        received !== null ? Number(received) : Number(quote.outAmount),
      rateIdrPerUsdc: Number.isFinite(rate) ? rate : null,
      priceImpactBps: impactBps,
      signature,
      reason: null,
    };
  }

  /* ─────────────────────────── Pemeriksaan harga ─────────────────────────── */

  /** Alasan penolakan, atau null bila harga masih layak. */
  private rejectPrice(rate: number, impactBps: number | null): string | null {
    if (!Number.isFinite(rate) || rate <= 0) {
      return 'kurs efektif tidak terbaca';
    }
    const minRate = this.int(
      'TREASURY_SWAP_MIN_RATE_IDR_PER_USDC',
      DEFAULT_MIN_RATE,
      1,
    );
    const maxRate = this.int(
      'TREASURY_SWAP_MAX_RATE_IDR_PER_USDC',
      DEFAULT_MAX_RATE,
      1,
    );
    if (rate < minRate || rate > maxRate) {
      return `kurs Rp ${rate}/USDC di luar pita kewarasan Rp ${minRate}–${maxRate}`;
    }
    // Impact yang TIDAK TERBACA ditolak, bukan diloloskan: satu-satunya alasan ia hilang
    // adalah kontrak Jupiter berubah, dan menukar dengan dampak tak diketahui bukan pilihan.
    if (impactBps === null) return 'price impact tidak terbaca dari kuotasi';
    const maxImpact = this.int(
      'TREASURY_SWAP_MAX_PRICE_IMPACT_BPS',
      DEFAULT_MAX_PRICE_IMPACT_BPS,
      0,
    );
    if (impactBps > maxImpact) {
      return `price impact ${impactBps} bps > plafon ${maxImpact} bps (likuiditas tidak cukup untuk ukuran ini)`;
    }
    return null;
  }

  /* ─────────────────────────── Pembacaan on-chain ─────────────────────────── */

  private async readIdrx(
    conn: Connection,
    owner: PublicKey,
  ): Promise<number | null> {
    try {
      const accts = await conn.getParsedTokenAccountsByOwner(owner, {
        mint: new PublicKey(IDRX_MINT_SOLANA),
      });
      let total = 0;
      for (const acc of accts.value) {
        const amount = (
          acc.account.data as {
            parsed?: { info?: { tokenAmount?: { amount?: string } } };
          }
        ).parsed?.info?.tokenAmount?.amount;
        if (typeof amount === 'string' && Number.isFinite(Number(amount))) {
          total += Number(amount);
        }
      }
      return total;
    } catch (err) {
      this.logger.warn(`Saldo IDRX tidak terbaca: ${errorMessage(err)}`);
      return null;
    }
  }

  /**
   * USDC yang BENAR-BENAR diterima, dihitung dari selisih pre/post token balance di meta
   * transaksi. Dibaca dari transaksinya sendiri, BUKAN dari saldo dompet sesudahnya:
   * saldo dompet bisa berubah karena pembelian pack yang berjalan bersamaan, dan mencatat
   * angka itu sebagai "hasil swap" akan membuat buku besar berbohong.
   *
   * Null = tidak terbaca. Yang tercatat tetap kuotasinya, dan itu ditandai apa adanya.
   */
  private async readReceivedUsdc(
    conn: Connection,
    owner: PublicKey,
    signature: string,
  ): Promise<bigint | null> {
    try {
      const tx = await conn.getTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      const meta = tx?.meta;
      if (!meta) return null;
      const ownerStr = owner.toBase58();
      // preTokenBalances & postTokenBalances bertipe sama — satu parameter cukup.
      const pick = (list: typeof meta.preTokenBalances): bigint => {
        let sum = 0n;
        for (const b of list ?? []) {
          if (b.owner !== ownerStr || b.mint !== USDC_MINT_MAINNET_STR)
            continue;
          const raw = b.uiTokenAmount?.amount;
          if (typeof raw === 'string' && /^\d+$/.test(raw)) sum += BigInt(raw);
        }
        return sum;
      };
      const delta = pick(meta.postTokenBalances) - pick(meta.preTokenBalances);
      return delta > 0n ? delta : null;
    } catch {
      return null;
    }
  }

  /* ─────────────────────────── Plafon harian ─────────────────────────── */

  /**
   * Sisa plafon 24 jam, dalam rupiah penuh.
   *
   * Dihitung dari swap yang SUDAH MENYENTUH JARINGAN (SUBMITTED/CONFIRMED/NEEDS_CHECK).
   * QUOTED dan FAILED tidak dihitung: keduanya terbukti tidak memindahkan dana, dan
   * memasukkannya berarti kegagalan yang tidak berbiaya ikut memakan plafon.
   */
  private async remainingDailyIdr(): Promise<number> {
    const cap = this.int(
      'TREASURY_SWAP_DAILY_CAP_IDR',
      DEFAULT_DAILY_CAP_IDR,
      0,
    );
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const agg = await this.prisma.treasurySwap.aggregate({
      _sum: { idrxBaseUnits: true },
      where: {
        createdAt: { gte: since },
        status: {
          in: [
            TreasurySwapStatus.SUBMITTED,
            TreasurySwapStatus.CONFIRMED,
            TreasurySwapStatus.NEEDS_CHECK,
          ],
        },
      },
    });
    const usedIdr = Number(agg._sum.idrxBaseUnits ?? 0n) / IDR_TO_BASE;
    return Math.max(0, cap - Math.floor(usedIdr));
  }

  /* ─────────────────────────── Kunci ─────────────────────────── */

  private async acquireLock(): Promise<boolean> {
    try {
      // Baris kunci dibuat malas: tidak ada seed yang wajib dijalankan sebelum fitur hidup.
      await this.prisma.treasurySwapLock.upsert({
        where: { id: LOCK_ID },
        create: { id: LOCK_ID },
        update: {},
      });
      const staleCutoff = new Date(Date.now() - LOCK_STALE_MS);
      const claimed = await this.prisma.treasurySwapLock.updateMany({
        where: {
          id: LOCK_ID,
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleCutoff } }],
        },
        data: { lockedAt: new Date(), lockedBy: this.instanceId },
      });
      return claimed.count === 1;
    } catch (err) {
      // Gagal mengambil kunci = JANGAN jalan. Fail closed.
      this.logger.warn(`Kunci swap tidak bisa diambil: ${errorMessage(err)}`);
      return false;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await this.prisma.treasurySwapLock.updateMany({
        // Predikat pemegang: kunci yang sudah basi dan diambil alih instance lain TIDAK
        // boleh dilepas oleh pemegang lama yang baru selesai.
        where: { id: LOCK_ID, lockedBy: this.instanceId },
        data: { lockedAt: null, lockedBy: null },
      });
    } catch (err) {
      // Kunci yang tidak terlepas akan kedaluwarsa sendiri lewat LOCK_STALE_MS.
      this.logger.warn(`Kunci swap gagal dilepas: ${errorMessage(err)}`);
    }
  }

  /* ─────────────────────────── Util ─────────────────────────── */

  private async finish(
    id: string,
    status: TreasurySwapStatus,
    data: {
      error?: string | null;
      receivedUsdcBaseUnits?: bigint | null;
      confirmedAt?: Date;
    },
  ): Promise<void> {
    try {
      await this.prisma.treasurySwap.update({
        where: { id },
        data: { status, ...data },
      });
    } catch (err) {
      // Status yang gagal ditulis tidak boleh menghapus jejaknya — log di atas sudah terbit.
      this.logger.error(
        `Gagal menulis status ${status} untuk swap ${id}: ${errorMessage(err)}`,
      );
    }
  }

  private connection(): Connection | null {
    if (this.conn) return this.conn;
    const rpc = this.config?.get<string>('SOLANA_RPC_URL')?.trim();
    if (!rpc) return null;
    this.conn = new Connection(rpc, 'confirmed');
    return this.conn;
  }

  private cluster(): string {
    return (this.config?.get<string>('SOLANA_CLUSTER') || 'devnet')
      .trim()
      .toLowerCase();
  }

  private str(key: string): string | undefined {
    return this.config?.get<string>(key)?.trim();
  }

  /** Angka konfigurasi yang salah ketik TIDAK boleh diam-diam dilewati → pakai default & teriak. */
  private int(key: string, fallback: number, min: number): number {
    const raw = this.config?.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min) {
      this.logger.error(
        `${key}="${String(raw)}" bukan bilangan bulat >= ${min}. Memakai default ${fallback}.`,
      );
      return fallback;
    }
    return value;
  }
}

/**
 * Signature dari transaksi yang SUDAH ditandatangani, tanpa mengirimnya.
 *
 * Inilah yang memungkinkan write-ahead sejati: kita tahu "nama" transaksinya sebelum ia
 * ada di jaringan, jadi proses yang mati saat broadcast tetap meninggalkan jejak yang bisa
 * dilacak. Signature pertama = signature fee payer = treasury.
 */
function signatureOf(signedBase64: string): string {
  const tx = VersionedTransaction.deserialize(
    Buffer.from(signedBase64, 'base64'),
  );
  const sig = tx.signatures[0];
  if (!sig || sig.every((b) => b === 0)) {
    throw new Error(
      'Transaksi swap tidak membawa tanda tangan treasury — pengiriman dibatalkan.',
    );
  }
  return bs58.encode(sig);
}

/**
 * Apakah error pengiriman ini MEMBUKTIKAN transaksinya tidak pernah disiarkan.
 *
 * Sengaja KONSERVATIF: hanya bentuk yang benar-benar berarti "node menolak setelah
 * simulasi" yang dihitung. Ragu = BUKAN preflight → jatuh ke jalur rantai (NEEDS_CHECK).
 * Salah menebak ke arah sini berarti menukar dua kali; salah menebak ke arah sebaliknya
 * cuma berarti satu putaran tertunda dan seorang manusia melihat log. Asimetri itu yang
 * menentukan default-nya.
 *
 * `SendTransactionError` dicocokkan lewat NAMA, bukan instanceof: satu proses bisa memuat
 * dua salinan @solana/web3.js (dependensi transitif), dan instanceof lintas salinan itu
 * false — persis di jalur yang paling tidak boleh salah.
 */
function isPreflightRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; message?: unknown; logs?: unknown };
  // Logs simulasi hanya ada kalau node BENAR-BENAR menjalankan preflight lalu menolak.
  if (e.name === 'SendTransactionError' && Array.isArray(e.logs)) return true;
  const msg = typeof e.message === 'string' ? e.message : '';
  return (
    /simulation failed/i.test(msg) ||
    /blockhash not found/i.test(msg) ||
    /Transaction precompile verification failure/i.test(msg)
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
