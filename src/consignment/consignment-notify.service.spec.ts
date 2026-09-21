import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ConsignmentNotifyService } from './consignment-notify.service';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ HALAMAN TITIPAN MENJANJIKANNYA DUA KALI — dan sampai service ini ada, TIDAK ADA satu pun    ║
 * ║ jalur titipan yang memanggil MailService.                                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * "hasilnya langsung masuk ke saldomu — kami akan memberitahumu" (app/titipan/page.tsx) dan
 * "Tim kami akan menghubungimu" untuk kartu HILANG. Yang dijaga file ini ada dua, dan keduanya
 * lebih penting daripada isi emailnya:
 *
 *   1. EMAIL TIDAK PERNAH BOLEH MENYENTUH JALUR UANG. Pemanggilnya adalah settlement yang SUDAH
 *      commit; satu rejection yang lolos berarti saldo sudah dikredit tapi pemanggilnya meledak.
 *   2. PEMILIK TANPA EMAIL ADALAH JALUR NORMAL, bukan kegagalan — dan yang harus terjadi di sana
 *      adalah LOG YANG BISA DITINDAKLANJUTI MANUSIA: nama + telepon dari snapshot serah-terima,
 *      satu-satunya cara menghubungi orang yang belum punya akun Hoshi.
 */
describe('ConsignmentNotifyService', () => {
  const target = ConsignmentNotifyService.target({
    id: 'consign-1',
    consignorId: 'user-7',
    cardName: 'Charizard VMAX',
    consignorNameAtIntake: 'Budi',
    consignorPhoneAtIntake: '+62811',
  });

  const SOLD = {
    paidBaseIdr: 24_000_000,
    commissionIdr: 1_200_000,
    payoutIdr: 22_800_000,
    commissionBps: 500,
  };

  /** Method-nya `void`; pekerjaannya di microtask. Kuras dulu sebelum mengecek. */
  const flush = () => new Promise((r) => setImmediate(r));

  type Mock = jest.Mock;
  let prisma: { user: { findUnique: Mock } };
  let mail: { sendEmail: Mock };
  let service: ConsignmentNotifyService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ email: 'budi@example.com' }),
      },
    };
    mail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    service = new ConsignmentNotifyService(
      prisma as unknown as PrismaService,
      mail as unknown as MailService,
      {
        get: () => 'https://hoshimarket.xyz',
      } as unknown as ConfigService,
    );
  });

  it('TERJUAL: emailnya memuat harga, komisi, dan yang benar-benar masuk saldo', async () => {
    service.notifySold(target, SOLD);
    await flush();

    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const [arg] = mail.sendEmail.mock.calls[0] as [
      { to: string; subject: string; html: string },
    ];
    expect(arg.to).toBe('budi@example.com');
    expect(arg.subject).toContain('Charizard VMAX');
    // Angka-angkanya datang dari settlement yang baru commit — bukan dihitung ulang di sini.
    expect(arg.html).toContain('24.000.000');
    expect(arg.html).toContain('1.200.000');
    expect(arg.html).toContain('22.800.000');
    expect(arg.html).toContain('5%');
  });

  it('SATU RETAKAN PUN TIDAK LOLOS: mail yang menolak tidak pernah sampai ke pemanggil', async () => {
    // Pemanggilnya adalah settlement yang SUDAH commit. Rejection yang lolos di sini berarti
    // pemilik sudah dikredit tapi jalur pembayarannya meledak sesudahnya.
    mail.sendEmail.mockRejectedValue(new Error('resend down'));
    expect(() => service.notifySold(target, SOLD)).not.toThrow();
    await flush();
    // Dan tidak ada unhandled rejection yang tertinggal.
    expect(mail.sendEmail).toHaveBeenCalled();
  });

  it('pembacaan user yang gagal pun ditelan — email bukan bagian dari kontrak apa pun', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(() => service.notifyListed(target, { priceIdr: 1 })).not.toThrow();
    await flush();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('methodnya mengembalikan void — `await` yang lupa ditulis TIDAK BISA jadi bug', () => {
    // Bentuk inilah yang menegakkan aturannya: tidak ada Promise untuk di-await, jadi tidak ada
    // cara bagi pemanggil untuk menggantungkan jalur uangnya pada pengiriman email.
    expect(service.notifyLost(target)).toBeUndefined();
    expect(service.notifySold(target, SOLD)).toBeUndefined();
    expect(service.notifyListed(target, { priceIdr: 1 })).toBeUndefined();
  });

  /* ──────────── PATH B: PEMILIK TANPA EMAIL — JALUR NORMAL, BUKAN KEGAGALAN ──────────── */

  it('pemilik BELUM tertaut akun: tidak ada user yang dicari, tidak ada email yang dikirim', async () => {
    const unlinked = ConsignmentNotifyService.target({
      id: 'consign-2',
      consignorId: null,
      cardName: 'Pikachu',
      consignorNameAtIntake: 'Siti',
      consignorPhoneAtIntake: '+62822',
    });
    service.notifyListed(unlinked, { priceIdr: 5_000_000 });
    await flush();

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('akun TANPA email: log-nya memuat nama + telepon serah-terima — itu cara menghubunginya', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: null });
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    try {
      service.notifyListed(target, { priceIdr: 5_000_000 });
      await flush();
      expect(mail.sendEmail).not.toHaveBeenCalled();
      const line = String(log.mock.calls[0]?.[0] ?? '');
      expect(line).toContain('Budi');
      expect(line).toContain('+62811');
      expect(line).toContain('HUBUNGI MANUAL');
    } finally {
      log.mockRestore();
    }
  });

  it('kartu HILANG tanpa email: log-nya WARN, karena diam di sini berarti orang tidak diberi tahu', async () => {
    prisma.user.findUnique.mockResolvedValue({ email: '   ' });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      service.notifyLost(target);
      await flush();
      expect(mail.sendEmail).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('+62811');
    } finally {
      warn.mockRestore();
    }
  });

  /* ──────────────────────────────── kebersihan HTML ──────────────────────────────── */

  it('nama kartu di-ESCAPE: ia datang dari ketikan operator, bukan dari sumber tepercaya', async () => {
    const nasty = ConsignmentNotifyService.target({
      id: 'consign-3',
      consignorId: 'user-7',
      cardName: '<script>alert(1)</script>',
      consignorNameAtIntake: 'Budi',
      consignorPhoneAtIntake: '+62811',
    });
    service.notifyLost(nasty);
    await flush();

    const [arg] = mail.sendEmail.mock.calls[0] as [{ html: string }];
    expect(arg.html).not.toContain('<script>');
    expect(arg.html).toContain('&lt;script&gt;');
  });
});
