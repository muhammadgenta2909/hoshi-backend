import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentsService } from './payments.service';

/**
 * Penyapu berkala untuk order pembayaran yang tersangkut.
 *
 * KENAPA INI HARUS ADA: callback mint IDRX dikirim TEPAT SEKALI dan TIDAK PERNAH di-retry
 * (lihat IdrxMintCallbackPayload). Backend ini berjalan di host yang bisa cold-start, jadi
 * satu callback yang datang saat proses belum siap HILANG SELAMANYA. Callback yang hilang
 * berarti user SUDAH BAYAR tetapi packnya tidak pernah ditebus — dan tanpa penyapu ini tidak
 * ada apa pun yang menyadarinya: order duduk PENDING sampai ada manusia yang ingat memanggil
 * POST /payments/reconcile. Dengan penyapu ini, kehilangan permanen berubah menjadi
 * keterlambatan paling lama satu interval.
 *
 * Sengaja memakai setInterval + lifecycle hook Nest, BUKAN @nestjs/schedule: tidak ada alasan
 * menambah dependensi untuk satu timer, dan intervalnya jadi bisa diatur lewat env.
 *
 * Aman dijalankan di banyak instance sekaligus: penebusan memakai klaim atomik di
 * verifyAndFulfil, jadi dua penyapu tidak bisa menebus order yang sama dua kali.
 */
@Injectable()
export class PaymentsReconcileScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PaymentsReconcileScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  /** Penjaga tumpang-tindih: satu sapuan lambat tidak boleh menumpuk sapuan berikutnya. */
  private running = false;

  constructor(
    private readonly payments: PaymentsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // Kill-switch. Dimatikan HANYA untuk debugging — konsekuensinya dinyatakan terang-terangan
    // di log supaya tidak ada yang mematikannya lalu lupa.
    if (this.config.get<string>('PAYMENTS_RECONCILE_ENABLED') === '0') {
      this.logger.warn(
        'Reconciler DIMATIKAN (PAYMENTS_RECONCILE_ENABLED=0). Callback IDRX yang meleset ' +
          'TIDAK akan pulih sendiri — order yang sudah dibayar bisa tersangkut selamanya.',
      );
      return;
    }

    const raw = Number(
      this.config.get<string>('PAYMENTS_RECONCILE_INTERVAL_MS'),
    );
    const ms =
      Number.isFinite(raw) && raw >= MIN_INTERVAL_MS
        ? raw
        : DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => void this.sweep(), ms);
    // unref: timer tidak boleh menahan proses tetap hidup saat shutdown.
    this.timer.unref?.();
    this.logger.log(
      `Reconciler aktif — menyapu tiap ${Math.round(ms / 1000)} detik.`,
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
      await this.payments.reconcile();
    } catch (e) {
      // Sapuan yang gagal TIDAK boleh menjatuhkan proses — ia akan dicoba lagi interval depan.
      this.logger.error(
        `Sapuan reconcile gagal: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/** Default 2 menit: cukup cepat agar user tidak menunggu lama, cukup jarang agar murah. */
const DEFAULT_INTERVAL_MS = 120_000;
/** Lantai keras — interval terlalu rapat hanya membanjiri IDRX dan DB tanpa manfaat. */
const MIN_INTERVAL_MS = 30_000;
