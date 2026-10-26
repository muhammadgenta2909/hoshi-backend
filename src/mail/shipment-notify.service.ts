import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from './mail.service';

/** Berapa hari sesudah resi diisi sebelum paket DOMESTIK dianggap diterima otomatis. */
export const AUTO_CONFIRM_DAYS = 7;

export type DeliveredBy = 'BUYER' | 'AUTO' | 'ADMIN';

/**
 * Email pengiriman DOMESTIK: "kartumu dikirim" (ke pembeli) dan "kartu sudah diterima" (ke
 * pembeli bila otomatis, ke pemilik kartu titipan, dan ke admin).
 *
 * SELURUHNYA BEST-EFFORT, sama seperti ConsignmentNotifyService: pemanggilnya adalah perubahan
 * status yang SUDAH commit, jadi tidak ada satu pun method publik di sini yang boleh melempar
 * atau ditunggu. Email gagal = satu baris log, bukan PATCH yang 500.
 */
@Injectable()
export class ShipmentNotifyService {
  private readonly logger = new Logger(ShipmentNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Admin menandai SHIPPED (resi diisi) → beri tahu pembeli. */
  shipped(redemptionId: string): void {
    this.fire('SHIPPED', redemptionId, async () => {
      const r = await this.load(redemptionId);
      if (!r) return;
      const email = await this.emailOf(r.userId);
      if (!email) return;
      const resi = r.trackingIds.length
        ? r.trackingIds
            .map((id, i) => {
              const url = r.trackingUrls[i];
              return url
                ? `<a href="${esc(url)}">${esc(id)}</a>`
                : `<strong>${esc(id)}</strong>`;
            })
            .join(', ')
        : '(belum diisi)';
      await this.mail.sendEmail({
        to: email,
        subject: `Kartumu sedang dikirim: ${r.cardName}`,
        html:
          `<p>Halo,</p><p>Kartu <strong>${esc(r.cardName)}</strong> sudah diserahkan ke kurir. ` +
          `Nomor resi: ${resi}.</p>` +
          `<p>Kalau paketnya sudah sampai, tekan <strong>Pesanan Diterima</strong> di halaman ` +
          `pengirimanmu. Kalau tidak ditekan, pesanan dianggap diterima otomatis ` +
          `${AUTO_CONFIRM_DAYS} hari sesudah dikirim.</p>` +
          `<p>Ada masalah dengan paketnya? Rekam video saat membuka paket dan hubungi kami ` +
          `paling lambat 2×24 jam sesudah paket diterima.</p>` +
          this.link('/withdraw', 'Buka halaman pengiriman') +
          '<p>— Hoshi</p>',
      });
    });
  }

  /** Paket dinyatakan DITERIMA → pemilik titipan, admin, dan (bila otomatis) pembeli. */
  delivered(redemptionId: string, by: DeliveredBy): void {
    this.fire(`DELIVERED/${by}`, redemptionId, async () => {
      const r = await this.load(redemptionId);
      if (!r) return;
      const how =
        by === 'BUYER'
          ? 'dikonfirmasi oleh pembeli'
          : by === 'AUTO'
            ? `dianggap diterima otomatis (${AUTO_CONFIRM_DAYS} hari sesudah dikirim tanpa konfirmasi)`
            : 'ditandai diterima oleh admin';

      // 1. Pembeli — hanya untuk konfirmasi otomatis. Kalau ia sendiri yang menekan tombolnya,
      //    email "kamu baru saja menekan tombol" cuma bising.
      if (by === 'AUTO') {
        const buyer = await this.emailOf(r.userId);
        if (buyer) {
          await this.mail.sendEmail({
            to: buyer,
            subject: `Pesanan selesai: ${r.cardName}`,
            html:
              `<p>Halo,</p><p>Pengiriman kartu <strong>${esc(r.cardName)}</strong> kami anggap ` +
              `sudah diterima, karena sudah ${AUTO_CONFIRM_DAYS} hari sejak dikirim.</p>` +
              `<p>Kalau paketnya ternyata belum sampai, segera hubungi kami.</p>` +
              this.link('/withdraw', 'Buka halaman pengiriman') +
              '<p>— Hoshi</p>',
          });
        }
      }

      // 2. Pemilik kartu TITIPAN — kartunya sudah sampai di tangan pembeli.
      const consignorId = await this.consignorOf(r.listingId);
      if (consignorId) {
        const owner = await this.emailOf(consignorId);
        if (owner) {
          await this.mail.sendEmail({
            to: owner,
            subject: `Kartu titipanmu sudah diterima pembeli: ${r.cardName}`,
            html:
              `<p>Halo,</p><p>Kartu titipanmu <strong>${esc(r.cardName)}</strong> sudah sampai ` +
              `di pembelinya (${esc(how)}). Hasil penjualannya sudah masuk ke saldomu sejak ` +
              `kartunya terjual.</p>` +
              this.link('/titipan', 'Buka halaman titipan') +
              '<p>— Hoshi</p>',
          });
        }
      }

      // 3. Admin — opsional, lewat ADMIN_NOTIFY_EMAIL. Tanpa env ini statusnya tetap terlihat
      //    di dashboard admin (kolom diterima-oleh), jadi tidak ada yang hilang.
      const admins = (this.config.get<string>('ADMIN_NOTIFY_EMAIL') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      this.logger.log(
        `Redemption ${redemptionId} ("${r.cardName}") DITERIMA — ${how}.`,
      );
      if (admins.length) {
        await this.mail.sendEmail({
          to: admins,
          subject: `[Hoshi] Paket diterima: ${r.cardName}`,
          html:
            `<p>Paket <strong>${esc(r.cardName)}</strong> untuk ${esc(r.recipientName)} ` +
            `(${esc(r.city)}) ${esc(how)}.</p>` +
            `<p>Resi: ${esc(r.trackingIds.join(', ') || '-')} · redemption ${esc(r.id)}</p>`,
        });
      }
    });
  }

  /* ─────────────────────────────── internal ─────────────────────────────── */

  private fire(event: string, id: string, job: () => Promise<void>): void {
    try {
      void job().catch((err: unknown) => {
        this.logger.warn(
          `Email pengiriman ${id} (${event}) gagal dan SENGAJA diabaikan: ${errText(err)}`,
        );
      });
    } catch (err) {
      this.logger.warn(
        `Email pengiriman ${id} (${event}) gagal disusun: ${errText(err)}`,
      );
    }
  }

  private load(id: string) {
    return this.prisma.cardRedemption.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        listingId: true,
        cardName: true,
        recipientName: true,
        city: true,
        trackingIds: true,
        trackingUrls: true,
      },
    });
  }

  private async consignorOf(listingId: string | null): Promise<string | null> {
    if (!listingId) return null;
    const listing = await this.prisma.listing.findUnique({
      where: { id: listingId },
      select: { consignmentId: true },
    });
    if (!listing?.consignmentId) return null;
    const c = await this.prisma.consignment.findUnique({
      where: { id: listing.consignmentId },
      select: { consignorId: true },
    });
    return c?.consignorId ?? null;
  }

  private async emailOf(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const e = u?.email?.trim();
    return e ? e : null;
  }

  private link(path: string, label: string): string {
    // FRONTEND_ORIGIN bisa CSV multi-origin (lihat main.ts) — pakai origin PERTAMA.
    const site = (this.config.get<string>('FRONTEND_ORIGIN') ?? '')
      .split(',')[0]
      .trim();
    return site ? `<p><a href="${esc(site)}${path}">${esc(label)}</a></p>` : '';
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
