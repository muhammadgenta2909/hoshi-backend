import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GachaService, TREASURY_MAX_PACK_PRICE_USDC } from './gacha.service';
import { TreasurySwapService } from './treasury-swap.service';

/**
 * Penyapu berkala yang MENUTUP LINGKARAN MODAL KERJA, plus alarm saldo treasury.
 *
 * Dua pekerjaan, satu timer, dan keduanya memang saling terkait:
 *
 *  1. SWAP — rupiah user masuk sebagai IDRX, pack dibayar dengan USDC. Tanpa penyapu ini
 *     tidak ada apa pun yang mengubah yang satu jadi yang lain, dan saldo USDC hanya
 *     bergerak satu arah: turun.
 *
 *  2. ALARM — sebelum ini, satu-satunya yang "memberi tahu" bahwa treasury kering adalah
 *     USER, lewat pesan "stok pembelian pack sedang tidak mencukupi" saat mereka mencoba
 *     bayar. Itu bukan monitoring, itu kehilangan penjualan. Alarm di sini berteriak di log
 *     SEBELUM saldo menyentuh nol, dan ia juga berteriak untuk kondisi sebaliknya: IDRX
 *     menumpuk tapi tidak tertukar (kill-switch menyala, plafon habis, harga ditolak) —
 *     kondisi yang sama sekali tidak terlihat dari sisi user sampai USDC-nya habis.
 *
 * Mengikuti pola PaymentsReconcileScheduler: setInterval + lifecycle hook, BUKAN
 * @nestjs/schedule. Tidak ada alasan menambah dependensi untuk satu timer.
 */
@Injectable()
export class TreasurySwapScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TreasurySwapScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  /** Penjaga tumpang-tindih dalam SATU proses. Lintas instance dijaga TreasurySwapLock. */
  private running = false;
  /** Kapan tiap jenis alarm terakhir diteriakkan — supaya log tidak jadi bising. */
  private readonly lastAlarm = new Map<string, number>();

  constructor(
    private readonly swap: TreasurySwapService,
    private readonly gacha: GachaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // DEFAULT MATI (dorman). Penyapu auto-swap HANYA jalan kalau di-set eksplisit
    // TREASURY_SWAP_SCHEDULER_ENABLED=1. Alasan: selama fase awal, float treasury dikelola
    // MANUAL (isi USDC/SOL sendiri, cairkan IDRX sendiri) — meng-auto-swap tanpa diminta bisa
    // menukar IDRX yang justru mau dikirim balik ke user/partner. Nyalakan hanya saat volume
    // sudah rutin dan angka FX-nya sudah terbukti.
    if (this.config.get<string>('TREASURY_SWAP_SCHEDULER_ENABLED') !== '1') {
      this.logger.warn(
        'Penyapu treasury DORMAN (set TREASURY_SWAP_SCHEDULER_ENABLED=1 untuk mengaktifkan). ' +
          'IDRX hasil pembayaran user TIDAK ditukar otomatis, dan tidak ada alarm saldo dari scheduler. ' +
          'Kelola float secara manual sampai auto-swap sengaja dinyalakan.',
      );
      return;
    }

    const raw = Number(this.config.get<string>('TREASURY_SWAP_INTERVAL_MS'));
    const ms =
      Number.isFinite(raw) && raw >= MIN_INTERVAL_MS
        ? raw
        : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => void this.sweep(), ms);
    this.timer.unref?.();
    this.logger.log(
      `Penyapu treasury aktif — swap IDRX→USDC + alarm saldo tiap ${Math.round(ms / 1000)} detik.`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.swap.sweep();

      // Hasil yang PERLU diketahui manusia dilaporkan; sisanya (NOTHING_TO_DO, LOCKED,
      // NOT_MAINNET, DISABLED) adalah keadaan normal dan sengaja tidak membanjiri log.
      if (result.outcome === 'SWAPPED') {
        this.logger.log(
          `Swap treasury: Rp ${result.idr.toLocaleString('id-ID')} → ` +
            `$${((result.usdcBaseUnits ?? 0) / 1e6).toFixed(2)} (kurs Rp ${result.rateIdrPerUsdc}/USDC).`,
        );
      } else if (result.outcome === 'NEEDS_CHECK') {
        this.alarm(
          'swap-needs-check',
          `SWAP TIDAK PASTI — signature ${result.signature}. Swap berikutnya DITAHAN sampai ` +
            'ini dituntaskan manual. Periksa di explorer sebelum menukar ulang.',
        );
      } else if (result.outcome === 'REJECTED_PRICE') {
        this.alarm(
          'swap-rejected-price',
          `Swap DITOLAK karena harga: ${result.reason}. IDRX akan menumpuk sampai pasar membaik ` +
            'atau plafon disesuaikan secara sadar.',
        );
      } else if (result.outcome === 'BLOCKED_IN_FLIGHT') {
        this.alarm(
          'swap-blocked',
          `Swap tertahan: ${result.reason}. Selama ini berlangsung, IDRX tidak bertambah jadi USDC.`,
        );
      } else if (result.outcome === 'DAILY_CAP') {
        this.alarm(
          'swap-daily-cap',
          `Plafon swap 24 jam tercapai (${result.reason}). Naikkan TREASURY_SWAP_DAILY_CAP_IDR ` +
            'bila volume memang sudah setinggi ini.',
        );
      }

      await this.checkBalances(result.outcome);
    } catch (e) {
      this.logger.error(
        `Sapuan treasury gagal: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Alarm saldo. Dijalankan SESUDAH swap supaya angkanya mencerminkan keadaan terbaru.
   *
   * Dua arah yang sama pentingnya:
   *  - USDC menipis → penjualan akan berhenti. Ini yang selama ini cuma ditemukan user.
   *  - IDRX menumpuk padahal ada yang bisa ditukar → lingkaran modal kerjanya macet.
   */
  private async checkBalances(lastOutcome: string): Promise<void> {
    const balances = await this.gacha.treasuryBalances();
    if (!balances) return; // tidak diketahui ≠ nol; jangan mengarang alarm

    const maxPack = TREASURY_MAX_PACK_PRICE_USDC;
    const packs = Number(
      this.config.get<string>('TREASURY_USDC_LOW_PACKS') ?? DEFAULT_LOW_PACKS,
    );
    const lowWater =
      (Number.isSafeInteger(packs) && packs > 0 ? packs : DEFAULT_LOW_PACKS) *
      maxPack;

    if (balances.usdcBaseUnits < lowWater) {
      this.alarm(
        'usdc-low',
        `ALARM USDC: saldo treasury $${(balances.usdcBaseUnits / 1e6).toFixed(2)} di bawah ambang ` +
          `$${(lowWater / 1e6).toFixed(2)}. Order pack akan MULAI DITOLAK sebelum user membayar. ` +
          (balances.idrxBaseUnits && balances.idrxBaseUnits > 0
            ? `Ada Rp ${(balances.idrxBaseUnits / 100).toLocaleString('id-ID')} IDRX yang bisa ditukar.`
            : 'Tidak ada IDRX yang bisa ditukar — treasury harus diisi dari luar.'),
      );
    }

    // IDRX yang menganggur hanya jadi alarm kalau swap-nya memang TIDAK berjalan. Kalau
    // penyebabnya cuma plafon per-swap (sisa akan diambil putaran berikutnya), itu normal.
    const idleIdr =
      balances.idrxBaseUnits !== null ? balances.idrxBaseUnits / 100 : 0;
    const stuck = ['DISABLED', 'NOT_MAINNET', 'UNAVAILABLE'].includes(
      lastOutcome,
    );
    if (idleIdr >= IDLE_IDRX_ALARM_IDR && stuck) {
      this.alarm(
        'idrx-idle',
        `ALARM IDRX: Rp ${idleIdr.toLocaleString('id-ID')} menganggur di treasury dan swap tidak ` +
          `berjalan (${lastOutcome}). Uang ini tidak bisa membeli pack sampai ditukar jadi USDC.`,
      );
    }
  }

  /** Teriak, tapi jangan tiap 5 menit untuk kondisi yang sama. */
  private alarm(key: string, message: string): void {
    const last = this.lastAlarm.get(key) ?? 0;
    if (Date.now() - last < ALARM_REPEAT_MS) return;
    this.lastAlarm.set(key, Date.now());
    this.logger.error(message);
  }
}

/** Default 5 menit: cukup sering agar USDC tidak pernah kering lama, cukup jarang agar murah. */
const DEFAULT_INTERVAL_MS = 300_000;
/** Lantai keras — tiap putaran memanggil RPC + Jupiter; merapatkannya tidak menambah manfaat. */
const MIN_INTERVAL_MS = 60_000;
/** Alarm yang sama diulang paling cepat tiap 30 menit. */
const ALARM_REPEAT_MS = 30 * 60_000;
/** Default ambang USDC rendah: cukup untuk 3 pack termahal. */
const DEFAULT_LOW_PACKS = 3;
/** IDRX menganggur di atas ini dianggap layak diteriakkan (≈ 2 pack). */
const IDLE_IDRX_ALARM_IDR = 1_000_000;
