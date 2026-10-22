import { HttpStatus } from '@nestjs/common';
import { P2P_ERROR_CODE, p2pNoEffectError } from '../marketplace/p2p.errors';
import { readSponsorCapEnv, type SponsorCapEnvKey } from './sponsor-cap-env';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ C — SPONSOR GAS PENITIPAN ESCROW: PLAFONNYA, TERPISAH DARI SOLANA.                       ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * MASALAH: menitipkan kartu ke escrow butuh transaksi Solana, dan transaksi butuh SOL. PENJUAL
 * yang membayarnya (EscrowService.buildTransferToEscrowTx dulu memakai `setFeePayer(seller)`),
 * padahal user yang masuk lewat Google punya wallet Privy embedded bersaldo SOL NOL. Mereka bukan
 * "kesulitan membayar" — mereka SAMA SEKALI TIDAK BISA menitipkan kartu, jadi tidak bisa menjual.
 *
 * YANG DIPILIH: fee payer DIPISAH dari authority. Penjual tetap menandatangani sebagai PEMILIK
 * kartu (tidak ada yang bisa memindahkan kartunya tanpa dia), wallet escrow menandatangani HANYA
 * sebagai pembayar gas. Satu transaksi, dua tanda tangan, NOL SOL berpindah ke wallet user.
 *
 * KENAPA BUKAN "TOP-UP SOL KE WALLET PENJUAL" (yang memang dilakukan TreasuryService.fundUsdc
 * untuk jalur ongkir): di sana user HARUS memegang SOL karena DIA yang menyiarkan burn-nya; di
 * sini tidak. Dan bedanya besar: top-up memberi user ASET YANG BISA DIBAWA PERGI (0,005 SOL =
 * ±1000× fee yang sebenarnya, dan bisa ditarik), sehingga "buat listing lalu batalkan" berubah
 * jadi keran SOL. Sponsor fee tidak memberi apa pun yang bisa dibawa pergi: lamports-nya masuk
 * ke validator, bukan ke wallet penjual.
 *
 * KENAPA PLAFONNYA ADA: fee per transaksi kecil (≈5.000 lamports) TAPI TIDAK TERBATAS secara
 * agregat, dan membuat listing itu GRATIS serta BISA DIULANG — identitas di sistem ini gratis
 * (auth meng-upsert user untuk alamat apa pun). Tanpa plafon, siapa pun yang sadar bahwa
 * "listing = transaksi gratis dibayari Hoshi" bisa menguras SOL escrow. Dan kerugiannya BUKAN
 * gas-nya: escrow yang kehabisan SOL TIDAK BISA LAGI MENYERAHKAN KARTU KE PEMBELI.
 *
 * File ini SENGAJA tidak mengimpor apa pun dari Solana/Prisma: ia menerima angka dan
 * mengembalikan keputusan. Itu yang membuat plafonnya bisa diuji tanpa RPC, key, atau DB.
 */

/** Jendela plafon berjalan. Sama dengan plafon 24 jam treasury. */
export const SPONSOR_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Kunci advisory lock Postgres yang MENYERIALKAN seluruh keputusan sponsor (F3).
 *
 * Sebelum ini urutannya baca → putuskan → tulis TANPA transaksi, tanpa kunci, dan tanpa
 * unique constraint yang bisa bertabrakan. N permintaan yang datang bersamaan membaca
 * agregat 24 jam yang SAMA, semuanya lolos, semuanya menulis — jadi plafon per-penjual,
 * plafon global, DAN cadangan SOL escrow semuanya bisa dilewati sekaligus. Throttle per-IP
 * tidak membatasinya: identitas di sistem ini gratis.
 *
 * `pg_advisory_xact_lock` (BUKAN `pg_advisory_lock`) dipilih SENGAJA: ia ber-cakupan
 * TRANSAKSI dan dilepas otomatis saat commit/rollback, jadi ia aman di bawah connection
 * pooling mode-transaksi dan tidak bisa bocor kalau prosesnya mati — dua keberatan yang
 * membuat kunci ber-cakupan SESI ditolak di tempat lain di repo ini (lihat TreasurySwapLock).
 *
 * Angkanya arbitrer tapi TETAP: ia hanya perlu unik terhadap kunci advisory lain di database
 * yang sama. Jangan diubah — mengubahnya berarti dua versi deploy memegang kunci yang berbeda
 * dan berhenti saling menyerialkan tepat pada saat rolling deploy.
 */
export const SPONSOR_LOCK_KEY = 826_100_918;

/**
 * Margin di ATAS fee yang harus dipegang PENJUAL supaya jalur mundur "penjual bayar gas"
 * layak ditawarkan (lamports). 0,001 SOL.
 *
 * Gunanya bukan menakar kekayaan penjual, melainkan memilih pesan error yang BENAR: kalau
 * penjual jelas-jelas tidak bisa membayar, mengembalikan transaksi "silakan bayar sendiri"
 * hanya menukar penyebab yang jujur (kuota/saldo sponsor) dengan kegagalan simulasi yang
 * membingungkan. Di bawah margin ini kami tetap melaporkan alasan sponsor yang sebenarnya.
 */
export const SPONSOR_FALLBACK_SELLER_MIN_MARGIN_LAMPORTS = 1_000_000;

/**
 * Plafon fee untuk SATU transaksi penitipan (lamports). Fee transfer Core biasa ≈ 5.000 lamports;
 * 50.000 memberi ruang 10× untuk priority fee / tanda tangan tambahan tanpa pernah mendekati
 * nominal yang berarti. Angka fee-nya sendiri TIDAK ditebak: ia dibaca dari `getFeeForMessage`
 * pada pesan yang PERSIS akan disiarkan, lalu dibandingkan ke plafon ini.
 */
export const SPONSOR_DEFAULT_MAX_FEE_LAMPORTS = 50_000;

/**
 * Plafon 24 jam GLOBAL (lamports). 20.000.000 = 0,02 SOL ≈ 4.000 penitipan per hari pada fee
 * normal. Jauh di atas volume nyata, jauh di bawah saldo gas escrow — sama seperti plafon
 * treasury: longgar untuk pemakaian sah, ketat untuk penyalahgunaan.
 */
export const SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS = 20_000_000;

/**
 * Plafon 24 jam PER PENJUAL (jumlah transaksi yang DITERBITKAN). Ini rem anti-Sybil yang
 * sesungguhnya: plafon global saja bisa dihabiskan satu akun, dan throttle per-IP tidak menolong
 * karena identitas gratis. 20 penitipan/hari jauh di atas perilaku penjual sungguhan.
 */
export const SPONSOR_DEFAULT_MAX_PER_SELLER_24H = 20;

/**
 * SOL yang WAJIB TERSISA di escrow sesudah menanggung fee ini (lamports). 0,01 SOL.
 * BUKAN cadangan sopan-santun: escrow-lah yang membayar gas saat MENYERAHKAN kartu ke pembeli
 * dan saat MENGEMBALIKANNYA ke penjual. Escrow yang kehabisan SOL = kartu terkunci di dalamnya.
 * Karena itu sponsor penitipan (kenyamanan) SELALU mengalah pada penyerahan (kewajiban).
 */
export const SPONSOR_DEFAULT_RESERVE_LAMPORTS = 10_000_000;

export interface SponsorCaps {
  maxFeeLamports: number;
  dailyCapLamports: number;
  maxPerSeller24h: number;
  reserveLamports: number;
}

export interface ConfigReader {
  get<T = string>(key: string): T | undefined;
}

/**
 * Baca SATU plafon dari env. Aturan bacanya hidup di `sponsor-cap-env.ts` dan dipakai bersama
 * oleh validasi boot — lihat file itu untuk kenapa "0" WAJIB berarti nol.
 *
 * DUA nilai cadangan, dan bedanya penting:
 *   • `unset`   — env memang tidak di-set → default bawaan. Keadaan normal.
 *   • `invalid` — env di-set ke sesuatu yang tidak terbaca. Backend seharusnya sudah MENOLAK
 *     START untuk ini (validateEnv), jadi cabang ini adalah PERTAHANAN LAPIS KEDUA untuk proses
 *     yang entah bagaimana tetap hidup (config source lain, test, config yang diganti saat
 *     runtime). Arahnya FAIL-CLOSED, bukan default: nilai yang tidak terbaca tidak boleh
 *     memberi izin belanja yang tidak pernah diminta siapa pun.
 */
function capConfig(
  config: ConfigReader,
  key: SponsorCapEnvKey,
  bounds: { unset: number; invalid: number },
): number {
  const reading = readSponsorCapEnv(config.get<string>(key));
  if (reading.kind === 'value') return reading.value;
  return reading.kind === 'invalid' ? bounds.invalid : bounds.unset;
}

/**
 * Sponsor gas MENYALA kecuali dimatikan eksplisit (`HOSHI_ESCROW_SPONSOR_FEE=false`).
 *
 * Default-NYALA — beda dari flag fitur lain di repo ini, dan itu disengaja: ini bukan fitur
 * tambahan melainkan SYARAT AGAR FITURNYA UTUH. Dengan sponsor mati, jalur P2P tetap jalan tapi
 * hanya untuk penjual yang kebetulan sudah punya SOL — yaitu bukan pengguna Google, yang adalah
 * mayoritasnya. Mematikannya adalah pilihan sadar ("penjual bayar gas sendiri"), bukan default.
 *
 * Dan ia TIDAK menyalakan apa pun sendiri: seluruh jalur escrow tetap mati sampai
 * HOSHI_P2P_ENABLED dinyalakan, karena tanpa itu listing tidak pernah masuk PENDING_ESCROW.
 */
export function sponsorEnabled(config: ConfigReader): boolean {
  return (
    (config.get<string>('HOSHI_ESCROW_SPONSOR_FEE') ?? 'true')
      .trim()
      .toLowerCase() !== 'false'
  );
}

/**
 * Plafon yang BERLAKU SEKARANG.
 *
 * `0` DITERIMA dan berarti NOL untuk ketiga plafon — itulah rem tangan operator saat insiden
 * (`HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS=0` ⇒ tidak ada lagi transaksi yang disponsori, tanpa
 * deploy). Sebelumnya `0` diam-diam berubah jadi default dan operator justru mendapat 0,02
 * SOL/hari, yaitu kebalikan dari yang dia minta.
 *
 * Nilai yang TIDAK TERBACA memakai `invalid` di bawah, bukan default:
 *   • tiga PLAFON → 0. Plafon nol menolak semua sponsorship (fail-closed); penjual yang punya SOL
 *     sendiri tetap bisa menitipkan kartu lewat jalur mundur "penjual bayar gas".
 *   • CADANGAN escrow → default bawaan, BUKAN 0. Ia LANTAI, bukan plafon: menolkannya berarti
 *     mengizinkan sponsor menguras SOL escrow sampai habis — arah yang salah untuk nilai yang
 *     kita sendiri tidak yakin membacanya. Default adalah lantai tertinggi yang kami berani sebut.
 */
export function sponsorCaps(config: ConfigReader): SponsorCaps {
  return {
    maxFeeLamports: capConfig(config, 'HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS', {
      unset: SPONSOR_DEFAULT_MAX_FEE_LAMPORTS,
      invalid: 0,
    }),
    dailyCapLamports: capConfig(
      config,
      'HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS',
      { unset: SPONSOR_DEFAULT_DAILY_CAP_LAMPORTS, invalid: 0 },
    ),
    maxPerSeller24h: capConfig(
      config,
      'HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H',
      { unset: SPONSOR_DEFAULT_MAX_PER_SELLER_24H, invalid: 0 },
    ),
    reserveLamports: capConfig(
      config,
      'HOSHI_ESCROW_SPONSOR_RESERVE_LAMPORTS',
      {
        unset: SPONSOR_DEFAULT_RESERVE_LAMPORTS,
        invalid: SPONSOR_DEFAULT_RESERVE_LAMPORTS,
      },
    ),
  };
}

export interface SponsorDecisionInput {
  caps: SponsorCaps;
  /**
   * Fee yang DIBACA dari jaringan untuk pesan yang PERSIS akan disiarkan (getFeeForMessage).
   * null = jaringan tidak bisa menjawab → DITOLAK, bukan ditebak. Menebak fee berarti
   * menandatangani kewajiban yang nominalnya tidak kita ketahui.
   */
  feeLamports: number | null;
  /** Lamports yang SUDAH DITERBITKAN (bukan yang terpakai) dalam 24 jam terakhir. */
  issuedLamports24h: number;
  /** Berapa transaksi sponsor yang DITERBITKAN untuk penjual ini dalam 24 jam terakhir. */
  issuedBySeller24h: number;
  /** Saldo SOL wallet escrow (lamports). null = tidak terbaca → DITOLAK. */
  escrowLamports: number | null;
  /**
   * Lamports yang SUDAH DIJANJIKAN tapi BELUM TERPAKAI: sponsorship yang sudah kami
   * tandatangani di jendela ini dan `consumedAt`-nya masih null.
   *
   * KENAPA IA IKUT DIKURANGKAN DARI SALDO: tiap baris seperti itu adalah transaksi bertanda
   * tangan escrow yang ADA DI TANGAN PENJUAL dan bisa ia siarkan kapan saja selama blockhash-
   * nya berlaku. Saldo on-chain belum berkurang, tapi ia sudah bukan milik kami untuk
   * dijanjikan lagi. Memakai saldo kotor membuat cadangan escrow bisa ditembus oleh sekumpulan
   * penitipan yang semuanya "belum terpakai" — dan escrow yang kehabisan SOL tidak bisa lagi
   * MENYERAHKAN kartu ke pembeli.
   */
  outstandingLamports: number;
}

/**
 * URUTAN PEMERIKSAAN = URUTAN KETATNYA, dan SEMUANYA PRA-TANDA-TANGAN: kalau salah satu menolak,
 * belum ada transaksi yang keluar dari sini, jadi NOL lamport bisa bergerak. Itulah sebabnya
 * semua error di sini ber-stage NO_EFFECT dan tidak boleh berubah jadi stage lain.
 */
export function assertSponsorWithinCaps(input: SponsorDecisionInput): void {
  const { caps } = input;

  // 1. Fee harus TERBACA. Tidak terbaca = tidak diketahui = ditolak (fail-closed).
  if (
    input.feeLamports == null ||
    !Number.isSafeInteger(input.feeLamports) ||
    input.feeLamports < 0
  ) {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Biaya jaringan untuk menitipkan kartu sedang tidak bisa dibaca. Coba lagi sebentar ' +
        'lagi — tidak ada yang berubah dan tidak ada biaya yang keluar.',
    );
  }

  // 2. Plafon PER-TRANSAKSI. Pagar terhadap satu transaksi yang nominalnya tidak wajar
  //    (lonjakan priority fee, atau pesan yang entah bagaimana jadi jauh lebih besar).
  if (input.feeLamports > caps.maxFeeLamports) {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Biaya jaringan Solana sedang tidak wajar tingginya, jadi penitipan kartu ditunda. ' +
        'Coba lagi nanti — tidak ada biaya yang keluar.',
    );
  }

  // 3. Plafon PER-PENJUAL 24 jam. Dicek SEBELUM plafon global supaya satu akun yang rakus tidak
  //    bisa membuat seluruh sistem tampak "kuota penuh" bagi orang lain.
  if (input.issuedBySeller24h >= caps.maxPerSeller24h) {
    throw p2pNoEffectError(
      HttpStatus.TOO_MANY_REQUESTS,
      P2P_ERROR_CODE.SPONSOR_QUOTA,
      'Anda sudah mencapai batas penitipan kartu untuk hari ini. Coba lagi besok — tidak ada ' +
        'biaya yang keluar.',
    );
  }

  // 4. Plafon GLOBAL 24 jam, dihitung dari yang DITERBITKAN (lihat komentar tabel ledger).
  if (input.issuedLamports24h + input.feeLamports > caps.dailyCapLamports) {
    throw p2pNoEffectError(
      HttpStatus.TOO_MANY_REQUESTS,
      P2P_ERROR_CODE.SPONSOR_QUOTA,
      'Kuota biaya jaringan Hoshi untuk hari ini sedang penuh. Coba lagi nanti — tidak ada ' +
        'biaya yang keluar.',
    );
  }

  // 5. PREFLIGHT SALDO. Terakhir karena paling mahal dibaca, tapi TIDAK boleh dilewati: escrow
  //    yang kehabisan SOL tidak bisa lagi menyerahkan kartu ke pembeli maupun mengembalikannya.
  if (
    input.escrowLamports == null ||
    !Number.isSafeInteger(input.escrowLamports)
  ) {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Saldo gas Hoshi sedang tidak bisa dibaca. Coba lagi sebentar lagi — tidak ada biaya ' +
        'yang keluar.',
    );
  }
  // Kewajiban yang sudah terbit tapi belum disiarkan TETAP akan menagih saldo ini. Angka yang
  // dibandingkan ke cadangan karena itu saldo BERSIH, bukan saldo kotor. Nilai negatif/NaN
  // diperlakukan sebagai tidak terbaca → fail-closed, sama seperti saldo yang tidak terbaca.
  if (
    !Number.isSafeInteger(input.outstandingLamports) ||
    input.outstandingLamports < 0
  ) {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Saldo gas Hoshi sedang tidak bisa dibaca. Coba lagi sebentar lagi — tidak ada biaya ' +
        'yang keluar.',
    );
  }
  const uncommittedLamports = input.escrowLamports - input.outstandingLamports;
  if (uncommittedLamports < input.feeLamports + caps.reserveLamports) {
    throw p2pNoEffectError(
      HttpStatus.SERVICE_UNAVAILABLE,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Hoshi sedang tidak bisa menanggung biaya jaringan untuk menitipkan kartu. Coba lagi ' +
        'nanti — tidak ada biaya yang keluar.',
    );
  }
}
