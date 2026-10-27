import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedemptionService } from './redemption.service';

/**
 * Konfirmasi otomatis paket DOMESTIK: SHIPPED lebih dari AUTO_CONFIRM_DAYS tanpa tombol
 * "Pesanan Diterima" → DELIVERED. Tanpa ini pesanan yang pembelinya lupa menekan tombol
 * menggantung di "Dikirim" selamanya.
 *
 * Pola sama dengan PaymentsReconcileScheduler (setInterval + lifecycle hook, tanpa
 * @nestjs/schedule). Aman di banyak instance: tulisannya berpagar status SHIPPED.
 * Nol uang — hanya status + email.
 */
@Injectable()
export class RedemptionDeliveryScheduler
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(RedemptionDeliveryScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly redemption: RedemptionService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('DELIVERY_AUTO_CONFIRM_ENABLED') === '0') {
      this.logger.warn(
        'Konfirmasi otomatis paket DIMATIKAN (DELIVERY_AUTO_CONFIRM_ENABLED=0) — paket yang ' +
          'tidak dikonfirmasi pembeli akan tetap berstatus Dikirim.',
      );
      return;
    }
    this.timer = setInterval(() => void this.sweep(), INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.redemption.autoConfirmDelivered();
    } catch (e) {
      this.logger.error(
        `Sapuan konfirmasi otomatis gagal: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      this.running = false;
    }
  }
}

/** Sejam sekali: batasnya 7 HARI, jadi ketelitian satu jam lebih dari cukup. */
const INTERVAL_MS = 60 * 60 * 1000;
