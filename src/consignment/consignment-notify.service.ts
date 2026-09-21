import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ MEMBERI TAHU PEMILIK KARTU. Produk sudah MENJANJIKANNYA dua kali; ini yang menepatinya.     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Halaman titipan berbunyi "hasilnya langsung masuk ke saldomu — kami akan memberitahumu", dan
 * salinan untuk kartu HILANG berbunyi "Tim kami akan menghubungimu". Sampai file ini ada, TIDAK
 * ADA satu pun jalur titipan yang memanggil `MailService`: seseorang menyerahkan kartu senilai
 * puluhan juta Rupiah, kartunya dipajang, terjual, atau hilang — dan yang terjadi di sisinya
 * adalah SENYAP. Ia harus membuka aplikasinya dan menebak.
 *
 * TIGA KEJADIAN, dan ketiganya dipilih karena MENGUBAH SESUATU DI SISI PEMILIK:
 *   DIPAJANG  kartunya sekarang publik dengan harga tertentu — kalau harganya salah, SEKARANG
 *             waktunya ia bicara, bukan setelah terjual.
 *   TERJUAL   uangnya SUDAH ada di saldonya, lengkap dengan komisi yang dipotong. Inilah kalimat
 *             yang dijanjikan halaman titipan.
 *   HILANG    kartunya tidak akan kembali. Ia berhak tahu dari kami, bukan dari layar kosong.
 *
 * ┌──────────────────────────────────────────────────────────────────────────────────────────────┐
 * │ EMAIL TIDAK PERNAH BOLEH MENGGAGALKAN JALUR UANG.                                           │
 * │                                                                                              │
 * │ Setiap method di sini MENGEMBALIKAN `void`, bukan Promise: pemanggil TIDAK BISA menunggunya  │
 * │ meski ia mau, dan `await` yang lupa ditulis tidak bisa jadi bug. Di dalamnya semua dibungkus │
 * │ try/catch DAN `.catch(() => {})` — pola yang sama persis dengan `notifyOfferReceived` di     │
 * │ marketplace. `MailService.sendEmail` sendiri sudah tidak pernah melempar dan jadi no-op      │
 * │ selama `RESEND_API_KEY` kosong, jadi fitur ini DARK sampai env-nya diisi.                    │
 * └──────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ── PATH B: BANYAK PEMILIK MEMANG TIDAK PUNYA EMAIL, DAN ITU NORMAL ──────────────────────────
 *
 * Titipan bisa lahir dari orang yang belum punya akun Hoshi sama sekali (`consignorId` null), dan
 * bahkan yang sudah punya akun belum tentu mengisi `User.email` — kolomnya `String?` dan TIDAK
 * PERNAH diverifikasi. Jadi "tidak ada email" BUKAN kegagalan: ia jalur normal, dan yang
 * dilakukan di sini adalah MENULIS LOG YANG BISA DITINDAKLANJUTI MANUSIA — memuat nama dan nomor
 * telepon dari snapshot serah-terima, yaitu satu-satunya cara menghubungi orangnya. Untuk kartu
 * HILANG log-nya sengaja `warn`, karena di sana diam berarti seseorang tidak pernah diberi tahu
 * kartunya lenyap.
 *
 * TIDAK ADA KOLOM PREFERENSI yang dibaca di sini, dan itu disengaja. `notifyOffers` /
 * `notifyMessages` adalah preferensi untuk hal yang bisa BERISIK (tawaran, pesan). Ketiga
 * kejadian di file ini adalah pemberitahuan KUSTODI DAN UANG atas barang milik si penerima
 * sendiri — bukan pemasaran, dan tidak ada nilai jujur untuk "jangan beri tahu saya kalau kartu
 * saya hilang". Menambah preferensi baru juga berarti migrasi kolom; kalau suatu hari memang
 * dibutuhkan, tempatnya di sini, satu tempat.
 */
@Injectable()
export class ConsignmentNotifyService {
  private readonly logger = new Logger(ConsignmentNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  /** Siapa yang diberi tahu, plus cara menghubunginya kalau emailnya tidak ada. */
  static target(c: {
    id: string;
    consignorId: string | null;
    cardName: string;
    consignorNameAtIntake?: string | null;
    consignorPhoneAtIntake?: string | null;
  }): ConsignmentMailTarget {
    return {
      consignmentId: c.id,
      consignorId: c.consignorId,
      cardName: c.cardName,
      consignorNameAtIntake: c.consignorNameAtIntake ?? null,
      consignorPhoneAtIntake: c.consignorPhoneAtIntake ?? null,
    };
  }

  /* ───────────────────────────── KEJADIAN YANG DIKIRIM ───────────────────────────── */

  /** Kartunya DIPAJANG. Kalau harganya salah, sekarang waktunya pemiliknya bicara. */
  notifyListed(t: ConsignmentMailTarget, args: { priceIdr: number }): void {
    this.send(t, 'DIPAJANG', {
      subject: `Kartu titipanmu sudah dipajang: ${t.cardName}`,
      body:
        `<p>Kartu titipanmu <strong>${esc(t.cardName)}</strong> sudah dipajang di Hoshi seharga ` +
        `<strong>Rp ${rupiah(args.priceIdr)}</strong>.</p>` +
        '<p>Kartunya ada di penyimpanan Hoshi dan tetap milikmu sampai terjual — kamu bisa ' +
        'memintanya kembali kapan saja, gratis. Kalau harganya tidak sesuai kesepakatan, ' +
        'hubungi kami sebelum kartunya terjual.</p>',
    });
  }

  /**
   * Kartunya TERJUAL. Angka-angkanya datang dari settlement yang BARU SAJA commit — bukan
   * dihitung ulang di sini, supaya email dan buku besar tidak mungkin menyebut angka berbeda.
   */
  notifySold(
    t: ConsignmentMailTarget,
    args: {
      paidBaseIdr: number;
      commissionIdr: number;
      payoutIdr: number;
      commissionBps: number;
    },
  ): void {
    const pct = (args.commissionBps / 100).toFixed(
      args.commissionBps % 100 === 0 ? 0 : 2,
    );
    this.send(t, 'TERJUAL', {
      subject: `Kartu titipanmu terjual: ${t.cardName}`,
      body:
        `<p>Kabar baik — kartu titipanmu <strong>${esc(t.cardName)}</strong> sudah TERJUAL.</p>` +
        '<table cellpadding="4"><tbody>' +
        `<tr><td>Harga terjual</td><td align="right">Rp ${rupiah(args.paidBaseIdr)}</td></tr>` +
        `<tr><td>Komisi Hoshi (${pct}%)</td><td align="right">− Rp ${rupiah(args.commissionIdr)}</td></tr>` +
        `<tr><td><strong>Masuk ke saldomu</strong></td><td align="right"><strong>Rp ${rupiah(args.payoutIdr)}</strong></td></tr>` +
        '</tbody></table>' +
        '<p>Saldonya sudah masuk dan bisa kamu tarik dari halaman saldo.</p>',
    });
  }

  /** Kartunya HILANG/RUSAK dalam pengawasan Hoshi. Yang paling tidak boleh senyap. */
  notifyLost(t: ConsignmentMailTarget): void {
    this.send(t, 'HILANG', {
      subject: `Penting: kartu titipanmu ${t.cardName}`,
      body:
        `<p>Kartu titipanmu <strong>${esc(t.cardName)}</strong> tercatat HILANG atau RUSAK ` +
        'selama berada dalam pengawasan Hoshi. Kami minta maaf.</p>' +
        '<p>Kartunya sudah kami tarik dari penjualan. Tim kami akan menghubungimu untuk ' +
        'menyelesaikan ganti ruginya — kamu juga bisa membalas email ini.</p>',
      urgent: true,
    });
  }

  /* ──────────────────────────────── internal ──────────────────────────────── */

  /**
   * SATU jalur kirim untuk ketiganya. `void` di luar, Promise ditelan di dalam.
   *
   * Badan method dibungkus try/catch SELURUHNYA: bahkan bug sinkron di penyusunan HTML tidak
   * boleh melempar ke pemanggil, karena pemanggilnya adalah settlement yang sudah commit.
   */
  private send(
    t: ConsignmentMailTarget,
    event: string,
    mail: { subject: string; body: string; urgent?: boolean },
  ): void {
    try {
      void this.deliver(t, event, mail).catch((err: unknown) => {
        this.logger.debug(
          `Notifikasi titipan ${t.consignmentId} (${event}) gagal dan SENGAJA diabaikan: ` +
            errText(err),
        );
      });
    } catch (err) {
      this.logger.debug(
        `Notifikasi titipan ${t.consignmentId} (${event}) gagal disusun dan SENGAJA diabaikan: ` +
          errText(err),
      );
    }
  }

  private async deliver(
    t: ConsignmentMailTarget,
    event: string,
    mail: { subject: string; body: string; urgent?: boolean },
  ): Promise<void> {
    const email = t.consignorId ? await this.emailOf(t.consignorId) : null;
    if (!email) {
      // JALUR NORMAL, bukan kegagalan. Log-nya memuat satu-satunya cara menghubungi orangnya.
      const how =
        `${t.consignorNameAtIntake ?? '(nama tidak tercatat)'} / ` +
        `${t.consignorPhoneAtIntake ?? '(telepon tidak tercatat)'}`;
      const line =
        `Titipan ${t.consignmentId} (${event}, "${t.cardName}") TIDAK bisa diberitahukan lewat ` +
        `email: ${t.consignorId ? 'akun pemiliknya tidak punya email' : 'pemiliknya belum tertaut akun'}. ` +
        `HUBUNGI MANUAL — ${how}.`;
      if (mail.urgent) this.logger.warn(line);
      else this.logger.log(line);
      return;
    }

    // FRONTEND_ORIGIN bisa CSV multi-origin (lihat main.ts) — pakai origin PERTAMA untuk link.
    const site = (this.config.get<string>('FRONTEND_ORIGIN') ?? '')
      .split(',')[0]
      .trim();
    const linkHtml = site
      ? `<p><a href="${esc(site)}/titipan">Buka halaman titipan di Hoshi</a></p>`
      : '';
    await this.mail.sendEmail({
      to: email,
      subject: mail.subject,
      html: `<p>Halo,</p>${mail.body}${linkHtml}<p>— Hoshi</p>`,
    });
  }

  private async emailOf(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return u?.email?.trim() || null;
  }
}

/** Siapa yang diberi tahu — plus cara menghubunginya kalau emailnya tidak ada. */
export interface ConsignmentMailTarget {
  consignmentId: string;
  consignorId: string | null;
  cardName: string;
  consignorNameAtIntake: string | null;
  consignorPhoneAtIntake: string | null;
}

/** Nilai yang masuk HTML datang dari ketikan operator — di-escape, tanpa kecuali. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rupiah(n: number): string {
  return Math.round(n).toLocaleString('id-ID');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
