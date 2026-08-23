import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface SendEmailInput {
  to: string | string[];
  subject: string;
  html: string;
}

/**
 * Pengirim email transaksional via Resend REST API (TANPA SDK — npm rusak di sini,
 * jadi kita panggil HTTP-nya langsung dengan `fetch`).
 *
 * PRINSIP: email adalah efek samping "nice to have" dari aksi bisnis (offer/pesan).
 * Ia TIDAK BOLEH menggagalkan aksi itu. Karena itu sendEmail SELALU membungkus fetch
 * dengan try/catch dan TIDAK PERNAH melempar ke pemanggil — kegagalan hanya di-log.
 *
 * DARK sampai di-provision: kalau RESEND_API_KEY belum di-set, sendEmail jadi no-op
 * (satu debug log saja), sehingga fitur bisa dinyalakan cukup dengan mengisi env,
 * tanpa perlu deploy ulang kode.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly endpoint = 'https://api.resend.com/emails';
  // Jaga agar log "dark" hanya muncul sekali, bukan tiap kali email dicoba dikirim.
  private darkLogged = false;

  constructor(private readonly config: ConfigService) {}

  async sendEmail(input: SendEmailInput): Promise<void> {
    // Dibaca LAZY tiap kirim: mengisi env cukup untuk mengaktifkan tanpa restart argumen
    // konstruktor, dan tetap konsisten dengan pola ConfigService lain di codebase ini.
    const apiKey = (this.config.get<string>('RESEND_API_KEY') ?? '').trim();
    if (!apiKey) {
      if (!this.darkLogged) {
        this.darkLogged = true;
        this.logger.debug(
          'RESEND_API_KEY belum di-set — email notifikasi dimatikan (no-op). Isi RESEND_API_KEY untuk mengaktifkan.',
        );
      }
      return;
    }

    const from =
      (this.config.get<string>('MAIL_FROM') ?? '').trim() ||
      'Hoshi <no-reply@hoshimarket.xyz>';

    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: input.to,
          subject: input.subject,
          html: input.html,
        }),
      });

      if (!res.ok) {
        // Baca body error sebaik mungkin untuk diagnosa, tapi jangan sampai proses baca
        // itu sendiri melempar ke pemanggil.
        let detail = '';
        try {
          detail = await res.text();
        } catch {
          detail = '<gagal membaca body>';
        }
        this.logger.warn(
          `Resend menolak pengiriman email (status ${res.status}): ${detail}`,
        );
      }
    } catch (err) {
      // Jaringan/timeout/dll — cukup di-log, TIDAK PERNAH dilempar (email tak boleh
      // menggagalkan aksi bisnis pemanggil).
      this.logger.warn(
        `Gagal mengirim email lewat Resend: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
