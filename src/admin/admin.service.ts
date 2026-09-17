import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// CATATAN: cloudinary SENGAJA TIDAK di-import di sini (top-level). SDK-nya memvalidasi CLOUDINARY_URL
// saat MODULE DI-LOAD dan melempar Error kalau formatnya salah (harus diawali 'cloudinary://'). Import
// top-level = satu env rusak meng-crash SELURUH backend saat boot (crash-loop, deploy gagal). Kita
// require LAZY + tangkap error di cloudinaryLib() → env rusak cuma menonaktifkan cloudinary.
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import {
  ActivityType,
  ListingSource,
  ListingStatus,
  OfferStatus,
  PaymentStatus,
  Prisma,
  RedemptionStatus,
  StorageProvider,
  VaultStatus,
  WithdrawalStatus,
} from '@prisma/client';
import { MarketplaceService } from '../marketplace/marketplace.service';
import { PrismaService } from '../prisma/prisma.service';
import { recordShippingRefundDebts } from '../payments/shipping-refund-debt';
import { appendBoundedNote, NOTE_MAX } from '../common/append-note';
import { AdminCreateListingDto } from './dto/admin-create-listing.dto';
import { AdminUpdateListingDto } from './dto/admin-update-listing.dto';
import { CreateContactMessageDto } from './dto/contact-message.dto';
import { ImportListingsDto } from './dto/import-listings.dto';
import {
  QueryAdminActivityDto,
  QueryAdminCardsDto,
  QueryAdminListingsDto,
} from './dto/query-admin.dto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Label wallet ringkas: 5 depan + ".." + 4 belakang (cermin shortWallet marketplace). */
function shortWalletLabel(w: string): string {
  return w.length <= 11 ? w : `${w.slice(0, 5)}..${w.slice(-4)}`;
}

export interface AdminStatsResponse {
  totalListings: number;
  activeListings: number;
  soldListings: number;
  /** Ditarik penjual (delisting). */
  cancelledListings: number;
  /** Nunggu kartu masuk escrow (hanya jalur P2P real; 0 di staging mock). */
  pendingEscrowListings: number;
  totalUsers: number;
  totalCards: number;
  totalRevenue: number;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly marketplace: MarketplaceService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.prisma.user.findFirst({ where: { email } });
    if (!user || !user.passwordHash) {
      throw new BadRequestException('Invalid email or password.');
    }
    const valid = await verify(user.passwordHash, password);
    if (!valid) {
      throw new BadRequestException('Invalid email or password.');
    }
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      role: 'ADMIN',
    });
    return {
      accessToken,
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  async stats(): Promise<AdminStatsResponse> {
    const [
      totalListings,
      activeListings,
      soldListings,
      cancelledListings,
      pendingEscrowListings,
      totalUsers,
      totalCards,
    ] = await Promise.all([
      this.prisma.listing.count(),
      this.prisma.listing.count({ where: { status: ListingStatus.ACTIVE } }),
      this.prisma.listing.count({ where: { status: ListingStatus.SOLD } }),
      this.prisma.listing.count({ where: { status: ListingStatus.CANCELLED } }),
      this.prisma.listing.count({
        where: { status: ListingStatus.PENDING_ESCROW },
      }),
      this.prisma.user.count(),
      // "Jenis kartu" = jumlah DESAIN UNIK yang benar-benar dipajang (distinct nama listing), BUKAN
      // baris tabel `Card` internal. Mayoritas listing (hasil sinkron CC) tak mengisi cardId, jadi
      // card.count() dulu cuma menghitung ~8 desain ter-mint/admin → menyesatkan. Distinct nama
      // listing mencerminkan variasi kartu yang sebenarnya di marketplace.
      this.prisma.listing
        .findMany({ distinct: ['name'], select: { name: true } })
        .then((rows) => rows.length),
    ]);
    const revenueAgg = await this.prisma.listing.aggregate({
      where: { status: ListingStatus.SOLD },
      _sum: { priceIdrx: true },
    });
    return {
      totalListings,
      activeListings,
      soldListings,
      cancelledListings,
      pendingEscrowListings,
      totalUsers,
      totalCards,
      totalRevenue: revenueAgg._sum.priceIdrx ?? 0,
    };
  }

  /* ---------------------- Kirim kartu fisik (redemption) ---------------------- */

  /** Semua permintaan kirim kartu fisik (admin), terbaru dulu. */
  async listRedemptions() {
    return this.prisma.cardRedemption.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /**
   * Admin memajukan status kirim REDEMPTION — HANYA baris RECORD-ONLY + resolusi manual jalur real.
   *
   * PEMBAGIAN TEGAS setelah CC Vault Shipping ada:
   *  - Baris RECORD-ONLY (REQUESTED/PACKING/SHIPPED): admin yang memenuhi fisik manual
   *    (REQUESTED→PACKING→SHIPPED) atau membatalkan (→CANCELED). Nol on-chain — tak ada burn/transfer.
   *  - Baris JALUR REAL (AWAITING_PAYMENT…): burn-nya USER yang menandatangani (bukan admin), dan
   *    status majunya digerakkan CcShippingService + poll shipment CC — BUKAN dari sini. Yang admin
   *    boleh cuma RESOLUSI MANUAL: menandai funding yang ditinggalkan user sebagai RECLAIM_DUE
   *    (USDC sudah/mungkin keluar → refundSafe=false, JANGAN refund Rupiah; reclaim USDC on-chain).
   *
   * B1 — SETIAP STATUS PEMBLOKIR WAJIB PUNYA JALAN KELUAR. Memblokir tanpa jalan keluar = kunci
   * kartu PERMANEN, dan tiga status dulu tidak punya satu pun:
   *   - SHIPPED               -> DELIVERED : penutupan jalur record-only (kartunya sudah sampai).
   *   - RECLAIM_DUE           -> CANCELED  : ops SUDAH mereklaim/menutup USDC-nya. Kartunya tidak
   *                                          pernah dibakar, jadi mint-nya memang boleh hidup lagi.
   *                                          refundSafe TIDAK disentuh (tetap false) — menutup
   *                                          kasus BUKAN berarti Rupiah jadi bisa di-refund.
   *   - SHIP_FAILED_POST_BURN -> DELIVERED : kasus support tuntas dan kartunya benar-benar sampai.
   *   - IN_TRANSIT            -> DELIVERED : B2 — lihat blok di bawah. Satu-satunya sel matriks
   *                                          yang jalan keluarnya dulu BUKAN milik kita.
   *
   * ┌─ B2 — SEBUAH STATUS TIDAK BOLEH BERGANTUNG PADA NIAT BAIK PIHAK KETIGA ────────────────────┐
   * │ IN_TRANSIT dulu TIDAK punya kunci di peta ini: satu-satunya jalan keluarnya adalah poll    │
   * │ status CC menjawab `Delivered`. Kalau CC memarkir shipment di `Shipped` (mapCcShipmentStatus│
   * │ memetakannya ke IN_TRANSIT — tidak memajukan apa pun), atau GET /outbound-shipment/:id      │
   * │ mulai menjawab 200-body-kosong "id tak dikenal" (refreshStatus sengaja TIDAK menulis apa pun│
   * │ pada kasus itu), barisnya tersangkut SELAMANYA — dan `nftAddress`-nya ikut menahan indeks   │
   * │ unik yang dilebarkan, jadi mint itu tidak bisa diminta kirim lagi.                          │
   * │ NOL UANG dipertaruhkan (IN_TRANSIT = NFT-nya memang SUDAH dibakar, jadi tidak ada yang bisa │
   * │ menebusnya dua kali) — yang dipertaruhkan adalah KENDALI. Operator yang sudah memastikan    │
   * │ kartunya sampai sekarang bisa menutupnya sendiri, tanpa mengedit Postgres.                  │
   * └────────────────────────────────────────────────────────────────────────────────────────────┘
   *
   * Status yang tetap tak bisa digerakkan endpoint ini (AWAITING_PAYMENT, BURN_SUBMITTED,
   * DELIVERED, REFUND_DUE, CANCELED, dan READY_TO_FUND) SENGAJA punya rute sendiri,
   * bukan tanpa rute:
   *   - AWAITING_PAYMENT-> CANCELED   : POST /admin/redemptions/:id/cancel-awaiting-payment
   *                                     (wajib beralasan; melaporkan utang ongkir yang tersisa).
   *   - BURN_SUBMITTED  -> FUNDED     : POST /admin/redemptions/:id/recover-burn-submitted
   *                                     (wajib beralasan + pernyataan verifikasi ke CC).
   *   - READY_TO_FUND   -> REFUND_DUE : POST /admin/redemptions/:id/settle-refund-due
   *                                     (wajib beralasan; satu-satunya penulis REFUND_DUE).
   *   - DELIVERED / REFUND_DUE / CANCELED: terminal, tidak memblokir apa pun.
   *
   * IN_TRANSIT kini punya DUA jalan keluar: poll shipment CC (CcShippingService.refreshStatus →
   * `Delivered`) yang OTOMATIS tapi MILIK PIHAK KETIGA, dan PATCH status ini yang MILIK KITA.
   */
  async updateRedemptionStatus(id: string, status: RedemptionStatus) {
    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    // Partial: status yang tak tercantum → tak punya transisi admin (default []). Ini yang menutup
    // BURN_SUBMITTED/DELIVERED dst. dari sentuhan admin, sekaligus menyenangkan tipe
    // (enum RedemptionStatus kini punya banyak nilai jalur-real).
    const allowed: Partial<Record<RedemptionStatus, RedemptionStatus[]>> = {
      [RedemptionStatus.REQUESTED]: [
        RedemptionStatus.PACKING,
        RedemptionStatus.SHIPPED,
        RedemptionStatus.CANCELED,
      ],
      [RedemptionStatus.PACKING]: [
        RedemptionStatus.SHIPPED,
        RedemptionStatus.CANCELED,
      ],
      // B1: penutupan jalur record-only. Tanpa ini SHIPPED memblokir mint-nya selamanya.
      [RedemptionStatus.SHIPPED]: [RedemptionStatus.DELIVERED],
      // Resolusi manual jalur real: funding yang ditinggalkan user → RECLAIM_DUE (USDC sudah/mungkin
      // keluar; JANGAN refund Rupiah, reclaim USDC on-chain manual).
      [RedemptionStatus.FUNDING]: [RedemptionStatus.RECLAIM_DUE],
      [RedemptionStatus.FUNDED]: [RedemptionStatus.RECLAIM_DUE],
      // B1: penutupan RECLAIM_DUE sesudah USDC-nya benar-benar direklaim/ditulis-rugi. Kartunya
      // TIDAK pernah dibakar (itulah arti RECLAIM_DUE), jadi mint-nya memang boleh diminta lagi.
      // refundSafe TIDAK ikut ditulis di sini: ia tetap false, dan gerbang refund tetap menolak.
      [RedemptionStatus.RECLAIM_DUE]: [RedemptionStatus.CANCELED],
      // B1: penutupan kasus support pasca-burn yang akhirnya sampai ke user.
      [RedemptionStatus.SHIP_FAILED_POST_BURN]: [RedemptionStatus.DELIVERED],
      // B2: penutupan yang DIKENDALIKAN KITA untuk kiriman yang diparkir CC di `Shipped`.
      // Tidak menyentuh uang: IN_TRANSIT berarti NFT-nya sudah dibakar, jadi tidak ada yang bisa
      // ditebus dua kali dan tidak ada Rupiah yang jadi bisa di-refund gara-gara transisi ini.
      [RedemptionStatus.IN_TRANSIT]: [RedemptionStatus.DELIVERED],
    };
    if (!(allowed[row.status] ?? []).includes(status)) {
      throw new BadRequestException(
        `Tidak bisa mengubah status dari ${row.status} ke ${status}.`,
      );
    }
    if (status === RedemptionStatus.SHIPPED) {
      this.logger.warn(
        `Redemption ${id} → SHIPPED (record-only, pemenuhan fisik manual). Burn CC jalur real ` +
          `di-tandatangani USER lewat /redemptions/:id/submit-burn — bukan di sini.`,
      );
    }
    // RECLAIM_DUE: USDC treasury sudah/mungkin didanai ke wallet user tapi burn tak dituntaskan →
    // refundSafe=false supaya gerbang refund tak pernah membalikkan Rupiah (rugi dobel).
    // Perhatikan ARAH-nya: hanya MASUK ke RECLAIM_DUE yang menulis false. KELUAR darinya
    // (→ CANCELED) sengaja TIDAK menulis apa pun — refundSafe tetap false. Tidak ada satu pun
    // cabang di method ini yang pernah menulis refundSafe=true.
    const extra =
      status === RedemptionStatus.RECLAIM_DUE ? { refundSafe: false } : {};
    if (
      row.status === RedemptionStatus.RECLAIM_DUE &&
      status === RedemptionStatus.CANCELED
    ) {
      this.logger.error(
        `Redemption ${id}: RECLAIM_DUE → CANCELED (penutupan manual). Operator MENYATAKAN USDC ` +
          `ongkir sudah direklaim atau ditulis-rugi. refundSafe TETAP ${row.refundSafe} — ` +
          'penutupan ini BUKAN izin me-refund Rupiah. Kartunya tidak pernah dibakar, jadi mint ' +
          `${row.nftAddress} kembali bisa diminta kirim.`,
      );
    }
    if (status === RedemptionStatus.RECLAIM_DUE) {
      this.logger.warn(
        `Redemption ${id} → RECLAIM_DUE (resolusi manual). USDC ongkir sudah/mungkin di wallet ` +
          `user — reclaim on-chain; JANGAN refund Rupiah (refundSafe=false).`,
      );
    }
    // B2: penutupan MANUAL sebuah kiriman jalur-real. Poll CC yang biasanya melakukannya tidak
    // pernah menjawab `Delivered` untuk baris ini, jadi operator MENYATAKAN kartunya sampai.
    // refundSafe TIDAK disentuh: menutup kasus BUKAN izin membalikkan Rupiah.
    if (
      row.status === RedemptionStatus.IN_TRANSIT &&
      status === RedemptionStatus.DELIVERED
    ) {
      this.logger.warn(
        `Redemption ${id}: IN_TRANSIT → DELIVERED (penutupan MANUAL, bukan dari poll CC). ` +
          `Shipment CC ${row.outboundShipmentId ?? 'tidak ada'}, nft ${row.nftAddress}, user ` +
          `${row.userId}. Operator MENYATAKAN kiriman sudah sampai — CC tidak pernah menjawab ` +
          `\`Delivered\`. refundSafe TETAP ${row.refundSafe}; NFT-nya memang sudah dibakar, jadi ` +
          'mint ini tidak bisa (dan tidak boleh) diminta kirim lagi.',
      );
    }
    return this.prisma.cardRedemption.update({
      where: { id },
      data: { status, ...extra },
    });
  }

  /**
   * PEMULIHAN MANUAL: kembalikan SATU baris yang nyangkut di BURN_SUBMITTED ke FUNDED.
   *
   * ⚠️ OPERATOR MENYATAKAN SUDAH MEMVERIFIKASI KE COLLECTORCRYPT BAHWA KARTUNYA BELUM DIBAKAR.
   * Kalau ternyata sudah dibakar, aksi ini mengundang user menandatangani burn KEDUA untuk kartu
   * yang sudah tidak ada. Verifikasi dulu lewat GET /outbound-shipment/:id atau
   * support@collectorcrypt.com. Aksi ini TIDAK PERNAH membuat uang bisa di-refund: refundSafe
   * DIPAKSA tetap false.
   *
   * KENAPA ADA: `updateRedemptionStatus` SENGAJA tidak bisa menggerakkan BURN_SUBMITTED — itu
   * pilihan keamanan yang tetap berlaku. Tapi beberapa kegagalan burn mendarat di BURN_SUBMITTED
   * tanpa jalan keluar otomatis (403 CC yang tidak membawa jaminan "nothing was burned"; pelepasan
   * klaim ke FUNDED yang gagal), sementara reprepareBurn HANYA menerima FUNDED. Tanpa rute ini
   * satu-satunya pilihan manusia adalah mengedit Postgres langsung.
   *
   * BUKAN endpoint "set status apa saja": HANYA transisi BURN_SUBMITTED -> FUNDED, tidak ada
   * parameter status, dan wajib disertai alasan operator yang ikut disimpan di baris.
   */
  async recoverBurnSubmittedToFunded(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan pemulihan wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.BURN_SUBMITTED) {
      throw new BadRequestException(
        `Pemulihan ini HANYA untuk baris yang nyangkut di BURN_SUBMITTED — status sekarang ${row.status}.`,
      );
    }

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN RECOVER BURN_SUBMITTED->FUNDED ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] operator menyatakan sudah memverifikasi ke CollectorCrypt bahwa ` +
      `kartu BELUM dibakar. Alasan: ${reason}`;

    // Log KERAS dulu — supaya jejaknya ada bahkan kalau tulisan DB gagal setelah ini.
    // B2: catatan SEBELUMNYA ikut di-log. Itu satu-satunya string yang membedakan "submitBurn LEG
    // GAGAL" / "submitBurn INDETERMINATE" / "submitBurn DITOLAK CC tanpa membakar apa pun", dan
    // dulu ia lenyap tanpa jejak karena aksi ini MENIMPA kolom note.
    this.logger.error(
      `PEMULIHAN MANUAL redemption ${id}: BURN_SUBMITTED -> FUNDED oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. Shipment CC ${row.outboundShipmentId ?? 'tidak ada'}, ` +
        `nft ${row.nftAddress}, user ${row.userId}. refundSafe TETAP false (uang TIDAK jadi bisa ` +
        `di-refund). CATATAN SEBELUMNYA (penyebab baris ini nyangkut): ` +
        `${row.note ?? '(kosong)'}. Alasan operator: ${reason}`,
    );

    // Berpagar status di updateMany: baris yang keburu bergerak (mis. poll CC memajukannya ke
    // IN_TRANSIT/DELIVERED) TIDAK akan dimundurkan oleh balapan.
    const moved = await this.prisma.cardRedemption.updateMany({
      where: { id, status: RedemptionStatus.BURN_SUBMITTED },
      data: {
        status: RedemptionStatus.FUNDED,
        // TIDAK PERNAH true. Uang treasury sudah pindah ke wallet user; pemulihan ini murni soal
        // status baris, bukan soal uang.
        refundSafe: false,
        // B2 — MENAMBAH, BUKAN MENIMPA. `note` adalah satu-satunya bukti DURABEL kenapa baris ini
        // nyangkut (log droplet dirotasi; baris DB tidak). Menimpanya di sini berarti aksi
        // pemulihan menghapus penyebabnya — itulah cara aksi ini bisa MENUTUPI kerugian nyata:
        // lewat efek samping, bukan lewat desain. Pemotongan membuang bagian TERTUA, tidak pernah
        // alasan kegagalan yang terbaru.
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum pemulihan tereksekusi — muat ulang lalu cek lagi.',
      );
    }

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      warning:
        'Baris dikembalikan ke FUNDED. Dengan menjalankan ini Anda MENYATAKAN sudah memverifikasi ' +
        'ke CollectorCrypt bahwa kartu ini BELUM dibakar. refundSafe tetap false — USDC ongkir ' +
        'sudah ada di wallet user; JANGAN me-refund Rupiah-nya.',
    };
  }

  /**
   * B1 — SATU-SATUNYA JALAN KELUAR untuk READY_TO_FUND: tandai ongkir Rupiah sebagai UTANG REFUND.
   *
   * KENAPA ADA: READY_TO_FUND berarti Rupiah ongkir SUDAH LUNAS tapi USDC BELUM dikirim. Kalau
   * pendanaan tidak pernah bisa dijalankan — assertCostWithinPaid menolak permanen karena harga CC
   * bergerak melewati plafon slippage, atau user tidak pernah kembali — baris itu dulu tersangkut
   * SELAMANYA: tidak ada transisi admin, tidak ada rute user, dan kartunya ikut terkunci karena
   * READY_TO_FUND memblokir. Pesan error-nya bahkan menjanjikan "ongkir Rupiah bisa di-refund"
   * padahal TIDAK ADA satu pun kode di repo ini yang bisa menindaklanjutinya.
   *
   * INI SATU-SATUNYA PENULIS RedemptionStatus.REFUND_DUE di seluruh repo.
   *
   * APA YANG ANDA NYATAKAN SEBAGAI OPERATOR DENGAN MENJALANKAN INI:
   *   • Anda akan MENGEMBALIKAN Rupiah ongkir user DI LUAR SISTEM (IDRX/manual). Baris ini menjadi
   *     catatan utang itu; tidak ada kode yang mengirim uangnya otomatis.
   *   • Dan itu MEMANG boleh: di READY_TO_FUND NOL USDC treasury pernah bergerak. Itu bukan
   *     kepercayaan, itu DIPERIKSA — fundingSignature WAJIB null dan refundSafe WAJIB true, dan
   *     keduanya ikut jadi PREDIKAT pada tulisan berpagar di bawah. Satu saja menyimpang → ditolak,
   *     karena itu berarti baris ini pernah menyentuh jalur pasca-danai dan Rupiah-nya TIDAK aman
   *     di-refund (rugi dobel). Kasus seperti itu diselesaikan lewat RECLAIM_DUE, bukan lewat sini.
   *
   * refundSafe TIDAK DITULIS di sini. Ia sudah true dan diverifikasi true sebagai predikat, dan
   * aturan repo ini mutlak: tidak ada satu pun tempat yang boleh MENULIS refundSafe=true.
   *
   * EFEK SAMPING YANG DISENGAJA: REFUND_DUE ada di TERMINAL_STATUSES, jadi mint-nya BEBAS lagi —
   * user bisa meminta kirim ulang (dengan invoice ongkir baru) tanpa menunggu refundnya beres.
   * BUKAN endpoint "set status apa saja": HANYA READY_TO_FUND -> REFUND_DUE, tanpa parameter
   * status, wajib beralasan, dan alasannya DITAMBAHKAN ke catatan baris (tidak menimpa).
   */
  async settleReadyToFundAsRefundDue(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan penyelesaian wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.READY_TO_FUND) {
      throw new BadRequestException(
        'Penyelesaian refund ongkir ini HANYA untuk baris READY_TO_FUND (Rupiah lunas, USDC belum ' +
          `dikirim) — status sekarang ${row.status}.`,
      );
    }
    // FAIL-CLOSED. Dua kolom jejak PASCA-danai: kalau salah satunya menyimpang, baris ini pernah
    // menyentuh jalur pendanaan dan Rupiah-nya TIDAK aman di-refund — apa pun status-nya sekarang.
    if (row.fundingSignature !== null || row.refundSafe !== true) {
      this.logger.error(
        `Penyelesaian refund redemption ${id} DITOLAK: status READY_TO_FUND tapi membawa jejak ` +
          `PASCA-danai (fundingSignature=${row.fundingSignature ?? 'null'}, ` +
          `refundSafe=${row.refundSafe}). JANGAN refund Rupiah sebelum posisi USDC dicek on-chain.`,
      );
      throw new BadRequestException(
        'Baris ini membawa jejak pendanaan USDC (fundingSignature/refundSafe). Refund Rupiah TIDAK ' +
          'aman sampai posisi USDC dicek on-chain — selesaikan lewat RECLAIM_DUE, bukan lewat rute ini.',
      );
    }

    // Order Rupiah-nya — supaya operator tahu PERSIS apa yang harus dikembalikan.
    const order = row.paymentOrderId
      ? await this.prisma.paymentOrder.findUnique({
          where: { id: row.paymentOrderId },
        })
      : await this.prisma.paymentOrder.findFirst({
          where: { redemptionId: id, packType: 'SHIPPING' },
          orderBy: { createdAt: 'desc' },
        });

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN SETTLE READY_TO_FUND->REFUND_DUE ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] ongkir Rupiah ${order?.merchantOrderId ?? 'order tidak ditemukan'} ` +
      `(Rp ${order?.priceIdr ?? '?'}) dinyatakan sebagai UTANG REFUND; nol USDC treasury pernah ` +
      `bergerak untuk baris ini. Alasan: ${reason}`;

    // Log KERAS dulu — jejaknya ada bahkan kalau tulisan DB gagal setelah ini. Catatan SEBELUMNYA
    // ikut di-log sebelum ditambahi (B2: jangan pernah menghilangkan bukti yang lama).
    this.logger.error(
      `UTANG REFUND ONGKIR redemption ${id}: READY_TO_FUND -> REFUND_DUE oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. User ${row.userId}, nft ${row.nftAddress}, order ` +
        `${order?.merchantOrderId ?? 'tidak ditemukan'} Rp ${order?.priceIdr ?? '?'}. refundSafe ` +
        `TETAP true dan fundingSignature null → Rupiah ini BENAR-BENAR aman di-refund, dan operator ` +
        `WAJIB mengembalikannya di luar sistem. CATATAN SEBELUMNYA: ${row.note ?? '(kosong)'}. ` +
        `Alasan operator: ${reason}`,
    );

    // Tulisan BERPAGAR: predikatnya mengulang KETIGA syarat uang, jadi keputusan di atas tidak bisa
    // basi karena balapan (mis. fundAndPrepare yang menang klaim READY_TO_FUND -> FUNDING).
    // refundSafe DIBACA sebagai predikat, TIDAK PERNAH ditulis.
    const moved = await this.prisma.cardRedemption.updateMany({
      where: {
        id,
        status: RedemptionStatus.READY_TO_FUND,
        fundingSignature: null,
        refundSafe: true,
      },
      data: {
        status: RedemptionStatus.REFUND_DUE,
        processedAt: new Date(),
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum penyelesaian tereksekusi (mungkin pendanaan USDC ' +
          'barusan dimulai) — muat ulang lalu cek lagi. JANGAN refund sebelum statusnya jelas.',
      );
    }

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      rupiahOrder: order
        ? {
            merchantOrderId: order.merchantOrderId,
            priceIdr: order.priceIdr,
            status: order.status,
            paidAt: order.paidAt,
          }
        : null,
      warning:
        'Baris ditandai REFUND_DUE. Di status READY_TO_FUND NOL USDC treasury pernah bergerak ' +
        '(fundingSignature null + refundSafe true — diverifikasi sebagai SYARAT, bukan diasumsikan), ' +
        'jadi ongkir Rupiah ini BENAR-BENAR aman di-refund. REFUND ITU HARUS ANDA LAKUKAN DI LUAR ' +
        'SISTEM: tidak ada kode yang mengirim uangnya otomatis. Kartunya tidak pernah dibakar dan ' +
        'mint-nya kini bebas — user boleh meminta kirim lagi dengan tagihan ongkir baru.',
    };
  }

  /**
   * B1 — JALAN KELUAR TERAKHIR untuk `AWAITING_PAYMENT`: batalkan barisnya (admin), apa pun status
   * order ongkirnya.
   *
   * KENAPA ADA, PADAHAL USER SUDAH PUNYA TOMBOL BATAL. Tombol user sengaja menolak dua status order
   * (PAID, FULFILLED) karena di sana pemenuhan otomatisnya masih hidup / sudah tuntas. Itu benar
   * untuk tombol, tapi menyisakan kasus di mana TIDAK ADA yang bisa bergerak:
   *   • user sudah pergi (ganti wallet, akun ditinggalkan) dan barisnya menahan mint selamanya;
   *   • order PAID yang IDRX-nya tidak pernah bisa diverifikasi (mis. pin tak terbaca berulang),
   *     jadi reconciler mengulang tanpa pernah konvergen.
   * Tanpa rute ini, satu-satunya pilihan manusia adalah mengedit Postgres langsung — dan itulah
   * bentuk kambuh yang sama untuk ketiga kalinya.
   *
   * PAGAR UANG (SAMA KETATNYA dengan rute admin lain):
   *   • HANYA dari AWAITING_PAYMENT. Tidak ada parameter status; tidak bisa dipakai untuk apa pun lain.
   *   • FAIL-CLOSED pada jejak PASCA-danai: fundingSignature WAJIB null dan refundSafe WAJIB true,
   *     dan keduanya ikut jadi PREDIKAT tulisan berpagar. refundSafe DIBACA, TIDAK PERNAH DITULIS.
   *   • Wajib beralasan (≥10 karakter) dan alasannya DITAMBAHKAN (bukan menimpa) ke catatan baris.
   *
   * KENAPA AMAN WALAU ONGKIRNYA SUDAH DIBAYAR: di AWAITING_PAYMENT baris redemption-nya NOL uang.
   * Utang ongkir hidup di baris PaymentOrder, dan baris itu TIDAK ikut dibatalkan —
   * `recordShippingRefundDebts` menjadikan yang macet di FULFILLING sebagai REFUND_DUE dan
   * MELAPORKAN sisanya. Hasil laporannya ikut dikembalikan di respons ini supaya operator melihat
   * PERSIS berapa Rupiah yang harus dikembalikan, bukan cuma "sudah dibatalkan".
   */
  async cancelAwaitingPayment(
    id: string,
    note: string,
    admin: { id: string; walletAddress: string; role: string },
  ) {
    const reason = (note ?? '').trim();
    if (reason.length < 10) {
      throw new BadRequestException(
        'Alasan pembatalan wajib diisi (minimal 10 karakter) dan akan disimpan permanen di baris ini.',
      );
    }

    const row = await this.prisma.cardRedemption.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Permintaan kirim tidak ditemukan.');
    }
    if (row.status !== RedemptionStatus.AWAITING_PAYMENT) {
      throw new BadRequestException(
        'Pembatalan ini HANYA untuk baris AWAITING_PAYMENT (tagihan ongkir terbit, baris ' +
          `redemption belum menyentuh uang) — status sekarang ${row.status}.`,
      );
    }
    // FAIL-CLOSED. Dua kolom jejak PASCA-danai: kalau salah satunya menyimpang, baris ini pernah
    // menyentuh jalur pendanaan USDC dan TIDAK boleh ditutup lewat rute pra-danai ini.
    if (row.fundingSignature !== null || row.refundSafe !== true) {
      this.logger.error(
        `Pembatalan admin redemption ${id} DITOLAK: status AWAITING_PAYMENT tapi membawa jejak ` +
          `PASCA-danai (fundingSignature=${row.fundingSignature ?? 'null'}, ` +
          `refundSafe=${row.refundSafe}). Selesaikan lewat RECLAIM_DUE, bukan lewat rute ini.`,
      );
      throw new BadRequestException(
        'Baris ini membawa jejak pendanaan USDC (fundingSignature/refundSafe) padahal statusnya ' +
          'AWAITING_PAYMENT. Jangan ditutup lewat rute ini — cek posisi USDC on-chain dulu.',
      );
    }

    const stamp = new Date().toISOString();
    const persistedNote =
      `[ADMIN CANCEL AWAITING_PAYMENT->CANCELED ${stamp} oleh ${admin.id} ` +
      `(${admin.walletAddress})] baris redemption nol uang; utang ongkir (bila ada) tetap ` +
      `tercatat di PaymentOrder-nya sendiri. Alasan: ${reason}`;

    // Log KERAS dulu — jejaknya ada bahkan kalau tulisan DB gagal setelah ini.
    this.logger.error(
      `PEMBATALAN ADMIN redemption ${id}: AWAITING_PAYMENT -> CANCELED oleh admin ${admin.id} ` +
        `(${admin.walletAddress}) pada ${stamp}. User ${row.userId}, nft ${row.nftAddress}. ` +
        `Mint-nya jadi BEBAS diminta kirim lagi. CATATAN SEBELUMNYA: ${row.note ?? '(kosong)'}. ` +
        `Alasan operator: ${reason}`,
    );

    // Tulisan BERPAGAR: predikatnya mengulang KETIGA syarat, jadi keputusan di atas tidak bisa basi
    // karena balapan (mis. fulfilShipping yang menang klaim AWAITING_PAYMENT -> READY_TO_FUND).
    const moved = await this.prisma.cardRedemption.updateMany({
      where: {
        id,
        status: RedemptionStatus.AWAITING_PAYMENT,
        fundingSignature: null,
        refundSafe: true,
      },
      data: {
        status: RedemptionStatus.CANCELED,
        processedAt: new Date(),
        note: appendBoundedNote(row.note, persistedNote, NOTE_MAX),
      },
    });
    if (moved.count !== 1) {
      throw new ConflictException(
        'Baris sudah berpindah status sebelum pembatalan tereksekusi (mungkin pembayaran ongkirnya ' +
          'barusan masuk) — muat ulang lalu cek lagi.',
      );
    }

    // PEMBUKUAN — sesudah pembatalan commit. Order ongkir yang macet di FULFILLING jadi REFUND_DUE;
    // yang lain dilaporkan apa adanya. Tidak pernah melempar.
    const shippingDebts = await recordShippingRefundDebts({
      prisma: this.prisma,
      logger: this.logger,
      redemptionId: id,
      actor: `admin ${admin.id}`,
      reason,
    });

    const updated = await this.prisma.cardRedemption.findUnique({
      where: { id },
    });
    return {
      redemption: updated,
      /** Tagihan ongkir yang terpengaruh + aksi operatornya. [] = nol Rupiah pernah mendarat. */
      shippingDebts,
      warning:
        'Baris DIBATALKAN dan mint-nya kini bebas — user boleh meminta kirim lagi. Pembatalan ini ' +
        'TIDAK menghapus tagihan ongkirnya: periksa `shippingDebts` di respons ini. Setiap order ' +
        'yang tercatat REFUND_DUE dengan refundSafe=true WAJIB Anda kembalikan DI LUAR SISTEM — ' +
        'tidak ada kode yang mengirim uangnya otomatis.',
    };
  }

  /**
   * Ledger transaksi pembayaran (PaymentOrder) untuk admin — dipisah per jenis:
   *   • PACK     : order buka-pack gacha (listingId null)
   *   • RESELLER : beli kartu katalog CC yang dijual Hoshi (listing.sellerId null)
   *   • P2P      : beli kartu antar user (listing.sellerId ada)
   * PaymentOrder tak punya relasi Prisma ke Listing (listingId cuma string), jadi kita join manual.
   */
  async listTransactions(query: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(Math.max(1, query.limit ?? 30), 100);
    const where: Prisma.PaymentOrderWhereInput = {};
    if (query.status && query.status in PaymentStatus) {
      where.status = query.status as PaymentStatus;
    }
    const [orders, total] = await Promise.all([
      this.prisma.paymentOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.paymentOrder.count({ where }),
    ]);

    const listingIds = [
      ...new Set(
        orders.map((o) => o.listingId).filter((x): x is string => !!x),
      ),
    ];
    const buyerIds = [...new Set(orders.map((o) => o.userId))];
    const [listings, buyers] = await Promise.all([
      listingIds.length
        ? this.prisma.listing.findMany({
            where: { id: { in: listingIds } },
            select: {
              id: true,
              name: true,
              sellerId: true,
              sellerAddress: true,
              source: true,
            },
          })
        : Promise.resolve(
            [] as {
              id: string;
              name: string;
              sellerId: string | null;
              sellerAddress: string;
              source: ListingSource;
            }[],
          ),
      this.prisma.user.findMany({
        where: { id: { in: buyerIds } },
        select: { id: true, walletAddress: true, displayName: true },
      }),
    ]);
    const sellerIds = [
      ...new Set(
        listings.map((l) => l.sellerId).filter((x): x is string => !!x),
      ),
    ];
    const sellers = sellerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: sellerIds } },
          select: { id: true, walletAddress: true, displayName: true },
        })
      : [];
    const listingMap = new Map(listings.map((l) => [l.id, l]));
    const buyerMap = new Map(buyers.map((u) => [u.id, u]));
    const sellerMap = new Map(sellers.map((u) => [u.id, u]));
    const label = (
      u?: { walletAddress: string; displayName: string | null } | null,
    ): string | null =>
      u ? (u.displayName ?? shortWalletLabel(u.walletAddress)) : null;

    const data = orders.map((o) => {
      const listing = o.listingId ? listingMap.get(o.listingId) : null;
      const type: 'PACK' | 'RESELLER' | 'P2P' = !o.listingId
        ? 'PACK'
        : listing && listing.sellerId == null
          ? 'RESELLER'
          : 'P2P';
      // "Vault" ala model PM: CC vault (kartu CC, harga default, Hoshi 0% margin) vs Hoshi vault
      // (Hoshi ambil 5% / stok Hoshi sendiri). RESELLER katalog CC = CC vault; RESELLER stok Hoshi
      // (source ≠ COLLECTORCRYPT) & P2P antar user = Hoshi vault; PACK/TOPUP bukan kartu vault.
      const vault: 'CC' | 'HOSHI' | null =
        type === 'PACK'
          ? null
          : type === 'P2P'
            ? 'HOSHI'
            : listing?.source === ListingSource.COLLECTORCRYPT
              ? 'CC'
              : 'HOSHI';
      const seller = listing?.sellerId
        ? sellerMap.get(listing.sellerId)
        : null;
      return {
        id: o.id,
        merchantOrderId: o.merchantOrderId,
        type,
        vault,
        status: o.status,
        priceIdr: o.priceIdr,
        item: listing?.name ?? (type === 'PACK' ? o.packType : null),
        buyer: label(buyerMap.get(o.userId)) ?? o.userId,
        seller:
          type === 'RESELLER'
            ? 'Hoshi'
            : type === 'P2P'
              ? (label(seller) ?? listing?.sellerAddress ?? null)
              : null,
        createdAt: o.createdAt,
        paidAt: o.paidAt,
        fulfilledAt: o.fulfilledAt,
      };
    });
    return { data, total, page, limit };
  }

  /**
   * Ringkasan keuangan untuk admin: pemasukan dipisah reseller vs P2P, TOTAL KEWAJIBAN (saldo
   * penjual yang belum ditarik = utang Hoshi), + daftar saldo tiap penjual. Treasury on-chain &
   * "profit yang aman ditarik" (treasury − kewajiban) dihitung di controller (yang punya akses gacha).
   */
  async financeSummary() {
    const [resellerAgg, hoshiInvAgg, p2pAgg, sellers, pendingWdAgg] =
      await Promise.all([
        // Reseller = Hoshi jual kartu KATALOG CC (source COLLECTORCRYPT, tanpa penjual user).
        this.prisma.listing.aggregate({
          where: {
            status: ListingStatus.SOLD,
            sellerId: null,
            source: ListingSource.COLLECTORCRYPT,
          },
          _sum: { priceIdrx: true },
          _count: true,
        }),
        // Inventaris Hoshi = Hoshi jual kartu SENDIRI (source HOSHI, tanpa penjual user).
        // Seluruh omzet = pendapatan Hoshi (bukan modal CC, bukan titipan penjual).
        this.prisma.listing.aggregate({
          where: {
            status: ListingStatus.SOLD,
            sellerId: null,
            source: ListingSource.HOSHI,
          },
          _sum: { priceIdrx: true },
          _count: true,
        }),
        this.prisma.listing.aggregate({
          where: { status: ListingStatus.SOLD, sellerId: { not: null } },
          _sum: { priceIdrx: true },
          _count: true,
        }),
      this.prisma.user.findMany({
        where: { balanceIdrx: { gt: 0 } },
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          balanceIdrx: true,
        },
        orderBy: { balanceIdrx: 'desc' },
      }),
      // Penarikan REQUESTED = saldo SUDAH di-debit (keluar dari balanceIdrx) tapi payout BELUM
      // keluar treasury → kewajiban yang tak tercermin di balanceIdrx maupun treasury. WAJIB dihitung,
      // kalau tidak "profit aman ditarik" over-stated & treasury bisa kurang saat payout dicairkan.
      this.prisma.withdrawal.aggregate({
        where: { status: WithdrawalStatus.REQUESTED },
        _sum: { amountIdr: true },
        _count: true,
      }),
    ]);
    const sellerBalances = sellers.map((u) => ({
      id: u.id,
      wallet: u.walletAddress,
      label: u.displayName ?? shortWalletLabel(u.walletAddress),
      balanceIdr: Number(u.balanceIdrx),
    }));
    const liabilitiesIdr = sellerBalances.reduce(
      (s, u) => s + u.balanceIdr,
      0,
    );
    const pendingWithdrawalsIdr = Number(pendingWdAgg._sum.amountIdr ?? 0n);
    return {
      reseller: {
        count: resellerAgg._count,
        grossIdr: resellerAgg._sum.priceIdrx ?? 0,
      },
      hoshiInventory: {
        count: hoshiInvAgg._count,
        grossIdr: hoshiInvAgg._sum.priceIdrx ?? 0,
      },
      p2p: { count: p2pAgg._count, grossIdr: p2pAgg._sum.priceIdrx ?? 0 },
      liabilitiesIdr,
      pendingWithdrawalsIdr,
      pendingWithdrawalsCount: pendingWdAgg._count,
      sellerCount: sellerBalances.length,
      sellerBalances,
    };
  }

  async listListings(query: QueryAdminListingsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ListingWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.vault) where.vaultLocation = query.vault;
    if (query.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { sellerAddress: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const orderBy: Prisma.ListingOrderByWithRelationInput =
      query.sort === 'price-asc'
        ? { priceIdrx: 'asc' }
        : query.sort === 'price-desc'
          ? { priceIdrx: 'desc' }
          : { listedAt: 'desc' };
    const [data, total] = await Promise.all([
      this.prisma.listing.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
        include: { nft: true },
      }),
      this.prisma.listing.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /** Distinct, non-empty vault locations across all listings — powers the admin
   *  "filter by vault" dropdown. Sorted alphabetically for a stable menu. */
  async listVaults(): Promise<string[]> {
    const rows = await this.prisma.listing.findMany({
      where: { vaultLocation: { not: null } },
      distinct: ['vaultLocation'],
      select: { vaultLocation: true },
      orderBy: { vaultLocation: 'asc' },
    });
    return rows
      .map((r) => r.vaultLocation)
      .filter((v): v is string => !!v && v.trim().length > 0);
  }

  async getListing(id: string) {
    const row = await this.prisma.listing.findUnique({
      where: { id },
      include: { nft: true },
    });
    if (!row) throw new NotFoundException('Listing not found.');
    return row;
  }

  async createListing(dto: AdminCreateListingDto) {
    const row = await this.prisma.listing.create({
      data: {
        name: dto.name,
        set: dto.set,
        rarity: dto.rarity,
        image: dto.image,
        imageBack: dto.imageBack,
        priceIdrx: dto.price,
        expectedValueIdrx: dto.expectedValue,
        buybackIdrx: dto.buyback ?? 0,
        grade: dto.grade,
        grader: dto.grader,
        gradeScore: dto.gradeScore,
        language: dto.language,
        era: dto.era,
        element: dto.element,
        category: dto.category,
        sellerAddress: dto.sellerAddress ?? 'admin',
        // Stok Hoshi genuine yang di-upload admin → boleh dijual (jalur Hoshi-inventory). Seed
        // chart-filler TIDAK lewat sini, jadi tetap sellable=false (tak bisa dibeli).
        sellable: true,
        certificate: dto.certificate,
        vaultLocation: dto.vaultLocation,
        cardNumber: dto.cardNumber,
        variant: dto.variant,
        priceHistory: dto.priceHistory ?? [dto.expectedValue, dto.price],
        offers: [],
      },
      include: { nft: true },
    });
    return row;
  }

  /**
   * Field yang MILIK CollectorCrypt pada listing hasil sync: nilainya di-refresh
   * setiap re-sync, jadi edit admin di sini pasti tertimpa lagi — lebih jujur
   * menolaknya dengan 400 daripada menerima edit yang umurnya sampai sync
   * berikutnya. Model bisnisnya "kita hanya edit harga di atas katalog mereka":
   * price / expectedValue / buyback / priceHistory tetap boleh.
   */
  private static readonly CC_LOCKED_FIELDS = [
    'name',
    'set',
    'rarity',
    'image',
    'imageBack',
    'grade',
    'grader',
    'gradeScore',
    'language',
    'era',
    'element',
    'category',
    'certificate',
    'vaultLocation',
    'cardNumber',
    'variant',
    'contractAddress',
  ] as const satisfies readonly (keyof AdminUpdateListingDto)[];

  async updateListing(id: string, dto: AdminUpdateListingDto) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    if (existing.source === ListingSource.COLLECTORCRYPT) {
      const locked = AdminService.CC_LOCKED_FIELDS.filter(
        (field) => dto[field] !== undefined,
      );
      if (locked.length > 0) {
        throw new BadRequestException(
          `Listing ini hasil sync CollectorCrypt — metadata milik mereka dan akan ` +
            `ditimpa re-sync. Field terkunci: ${locked.join(', ')}. ` +
            `Yang bisa diedit: price, expectedValue, buyback, priceHistory.`,
        );
      }
    }
    return this.prisma.listing.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.set !== undefined && { set: dto.set }),
        ...(dto.rarity !== undefined && { rarity: dto.rarity }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.imageBack !== undefined && { imageBack: dto.imageBack }),
        ...(dto.price !== undefined && { priceIdrx: dto.price }),
        ...(dto.expectedValue !== undefined && {
          expectedValueIdrx: dto.expectedValue,
        }),
        ...(dto.buyback !== undefined && { buybackIdrx: dto.buyback }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
        ...(dto.grader !== undefined && { grader: dto.grader }),
        ...(dto.gradeScore !== undefined && { gradeScore: dto.gradeScore }),
        ...(dto.language !== undefined && { language: dto.language }),
        ...(dto.era !== undefined && { era: dto.era }),
        ...(dto.element !== undefined && { element: dto.element }),
        ...(dto.category !== undefined && { category: dto.category }),
        ...(dto.certificate !== undefined && { certificate: dto.certificate }),
        ...(dto.vaultLocation !== undefined && {
          vaultLocation: dto.vaultLocation,
        }),
        ...(dto.cardNumber !== undefined && { cardNumber: dto.cardNumber }),
        ...(dto.variant !== undefined && { variant: dto.variant }),
        ...(dto.contractAddress !== undefined && {
          contractAddress: dto.contractAddress,
        }),
        ...(dto.priceHistory !== undefined && {
          priceHistory: dto.priceHistory,
        }),
      },
      include: { nft: true },
    });
  }

  /**
   * Activate / deactivate a listing (ACTIVE ⇄ CANCELLED). Deactivating just hides
   * it from the marketplace; the row and its data stay intact, so it can be
   * re-activated later — unlike deleteListing which removes it.
   *
   * A SOLD listing is off-limits: it changed hands via a purchase (buyer set), so
   * flipping it back to ACTIVE would re-list a card that is no longer ours to sell.
   */
  async setListingStatus(id: string, status: 'ACTIVE' | 'CANCELLED') {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    if (existing.status === ListingStatus.SOLD) {
      throw new BadRequestException(
        'Listing yang sudah SOLD tidak bisa diaktifkan/nonaktifkan.',
      );
    }
    return this.prisma.listing.update({
      where: { id },
      data: { status: status },
      include: { nft: true },
    });
  }

  async importListings(dto: ImportListingsDto) {
    const seller = dto.sellerOverride ?? 'admin';
    const items = dto.items.map((item) => ({
      name: item.name,
      set: item.set,
      rarity: item.rarity,
      image: item.image,
      priceIdrx: item.price,
      expectedValueIdrx: item.expectedValue ?? item.price,
      buybackIdrx: item.buyback ?? 0,
      grade: item.grade,
      grader: item.grader,
      gradeScore: item.gradeScore,
      language: item.language ?? 'EN',
      era: item.era ?? '',
      element: item.element ?? '',
      category: item.category ?? '',
      sellerAddress: seller,
      certificate: item.certificate,
      vaultLocation: item.vaultLocation,
      cardNumber: item.cardNumber,
      variant: item.variant,
      priceHistory: [item.expectedValue ?? item.price, item.price],
      offers: [],
    }));
    const created = await this.prisma.$transaction(
      items.map((data) =>
        this.prisma.listing.create({ data, include: { nft: true } }),
      ),
    );
    return { imported: created.length, items: created };
  }

  async deleteListing(id: string) {
    const existing = await this.prisma.listing.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Listing not found.');
    await this.prisma.listing.delete({ where: { id } });
    return { deleted: true, id };
  }

  async listCards(query: QueryAdminCardsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.CardWhereInput = {};
    if (query.search) {
      where.name = { contains: query.search, mode: 'insensitive' };
    }
    if (query.set) where.set = query.set;
    if (query.rarity) where.rarity = query.rarity;
    const [data, total] = await Promise.all([
      this.prisma.card.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.card.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  /**
   * Feed aktivitas admin dibaca dari tabel `Activity` (event log append-only yang
   * ditulis real-time oleh MarketplaceService) — BUKAN lagi direkonstruksi dari
   * status listing terkini. Rekonstruksi lama menghilangkan riwayat (listed→cancel
   * →listed lagi jadi satu baris) dan membuat re-sync CC memunculkan event palsu.
   */
  async listActivity(query: QueryAdminActivityDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ActivityWhereInput = {};
    // `action` = salah satu nilai ActivityType (mis. SALE_CARD). Nilai lain diabaikan.
    if (query.action && query.action in ActivityType)
      where.type = query.action as ActivityType;
    if (query.search)
      where.itemName = { contains: query.search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.activity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          itemName: true,
          itemImage: true,
          category: true,
          set: true,
          amount: true,
          fromLabel: true,
          toLabel: true,
          listingId: true,
          createdAt: true,
        },
      }),
      this.prisma.activity.count({ where }),
    ]);

    const mapped = data.map((a) => ({
      id: a.id,
      type: a.type,
      itemName: a.itemName,
      itemImage: a.itemImage,
      category: a.category,
      set: a.set,
      amount: a.amount,
      fromLabel: a.fromLabel,
      toLabel: a.toLabel,
      listingId: a.listingId,
      createdAt: a.createdAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private readonly logger = new Logger(AdminService.name);
  private readonly uploadDir = path.join(__dirname, '..', '..', 'uploads');

  /* ---------- Contact Messages ---------- */

  async listMessages(query: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.ContactMessageWhereInput = {};
    if (query.status === 'read') where.isRead = true;
    else if (query.status === 'unread') where.isRead = false;
    if (query.search) {
      where.OR = [
        { listingName: { contains: query.search, mode: 'insensitive' } },
        { senderName: { contains: query.search, mode: 'insensitive' } },
        { senderEmail: { contains: query.search, mode: 'insensitive' } },
        { text: { contains: query.search, mode: 'insensitive' } },
      ];
    }
    const [data, total] = await Promise.all([
      this.prisma.contactMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  }

  async createMessage(dto: CreateContactMessageDto) {
    return this.prisma.contactMessage.create({ data: dto });
  }

  async markMessageRead(id: string, isRead: boolean) {
    const row = await this.prisma.contactMessage.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Message not found');
    return this.prisma.contactMessage.update({
      where: { id },
      data: { isRead },
    });
  }

  /* ---------- Offers (aggregate from Listing JSON) ---------- */
  async listOffers(query: {
    page?: number;
    limit?: number;
    listingId?: string;
    search?: string;
    status?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.OfferWhereInput = {};
    if (query.listingId) where.listingId = query.listingId;
    if (query.search)
      where.listing = { name: { contains: query.search, mode: 'insensitive' } };
    // Filter status opsional. Hanya nilai enum yang valid diterima; nilai lain
    // (mis. "ALL" atau typo) diabaikan agar tidak melempar 500.
    if (query.status && query.status in OfferStatus)
      where.status = query.status as OfferStatus;

    const [data, total] = await Promise.all([
      this.prisma.offer.findMany({
        where,
        // Ambil sekalian data yang SUDAH ada di DB supaya admin bisa menilai
        // offer tanpa membuka listing: thumbnail, harga ask, status listing,
        // dan wallet pembeli. Jangan pernah ikutkan `nonce` user.
        include: {
          listing: {
            select: {
              id: true,
              name: true,
              image: true,
              priceIdrx: true,
              status: true,
            },
          },
          buyer: {
            select: { id: true, displayName: true, walletAddress: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.offer.count({ where }),
    ]);

    const mapped = data.map((o) => ({
      id: o.id,
      listingId: o.listingId,
      listingName: o.listing?.name ?? '',
      listingImage: o.listing?.image ?? null,
      listingStatus: o.listing?.status ?? null,
      askPrice: o.listing?.priceIdrx ?? null,
      user: o.user,
      buyerWallet: o.buyer?.walletAddress ?? null,
      amount: o.amount,
      status: o.status,
      createdAt: o.createdAt.toISOString(),
      // updatedAt = kapan offer di-resolve (accept/reject/cancel) untuk baris
      // non-PENDING. Untuk PENDING nilainya sama dengan createdAt.
      updatedAt: o.updatedAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /* ---------- Users ---------- */

  /**
   * Daftar user untuk admin. Sumbernya sama dengan angka "Users" di dashboard
   * (prisma.user.count()). PENTING: JANGAN pernah select `nonce` atau
   * `passwordHash` — keduanya rahasia keamanan (replay-login & kredensial admin).
   */
  async listUsers(query: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.UserWhereInput = {};
    if (query.role) where.role = query.role;
    if (query.search)
      where.OR = [
        { walletAddress: { contains: query.search, mode: 'insensitive' } },
        { displayName: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          role: true,
          email: true,
          createdAt: true,
          _count: {
            select: {
              listingsSelling: true,
              listingsBought: true,
              offersMade: true,
              ccPackPurchases: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const mapped = data.map((u) => ({
      id: u.id,
      walletAddress: u.walletAddress,
      displayName: u.displayName,
      role: u.role,
      email: u.email,
      createdAt: u.createdAt.toISOString(),
      listings: u._count.listingsSelling,
      bought: u._count.listingsBought,
      offers: u._count.offersMade,
      packs: u._count.ccPackPurchases,
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /* ---------- Vault / Inventory (custody location) ---------- */

  /**
   * Daftar item vault untuk admin — menjawab "inventory kita ada di vault mana".
   * Bisa difilter per status (STORED/MINTING/MINTED/REDEEMED) dan per provider
   * custody, plus cari via serial / nama kartu / label lokasi.
   */
  async listVaultItems(query: {
    page?: number;
    limit?: number;
    status?: string;
    provider?: string;
    search?: string;
  }) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.VaultItemWhereInput = {};
    if (query.status && query.status in VaultStatus)
      where.status = query.status as VaultStatus;
    if (query.provider && query.provider in StorageProvider)
      where.storageProvider = query.provider as StorageProvider;
    if (query.search)
      where.OR = [
        { serialNumber: { contains: query.search, mode: 'insensitive' } },
        { vaultLocation: { contains: query.search, mode: 'insensitive' } },
        { card: { name: { contains: query.search, mode: 'insensitive' } } },
      ];

    const [data, total] = await Promise.all([
      this.prisma.vaultItem.findMany({
        where,
        include: {
          card: { select: { id: true, name: true, imageUrl: true, set: true } },
          owner: {
            select: { id: true, displayName: true, walletAddress: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.vaultItem.count({ where }),
    ]);

    const mapped = data.map((v) => ({
      id: v.id,
      serialNumber: v.serialNumber,
      status: v.status,
      storageProvider: v.storageProvider,
      vaultLocation: v.vaultLocation,
      cardId: v.cardId,
      cardName: v.card?.name ?? '',
      cardImage: v.card?.imageUrl ?? null,
      cardSet: v.card?.set ?? null,
      ownerWallet: v.owner?.walletAddress ?? null,
      ownerLabel: v.owner?.displayName ?? null,
      createdAt: v.createdAt.toISOString(),
      updatedAt: v.updatedAt.toISOString(),
    }));

    return {
      data: mapped,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Admin memindahkan/mengoreksi lokasi custody sebuah item vault. */
  async updateVaultItem(
    id: string,
    dto: { storageProvider?: string; vaultLocation?: string | null },
  ) {
    const data: Prisma.VaultItemUpdateInput = {};
    if (dto.storageProvider !== undefined) {
      if (!(dto.storageProvider in StorageProvider))
        throw new BadRequestException('storageProvider tidak valid');
      data.storageProvider = dto.storageProvider as StorageProvider;
    }
    if (dto.vaultLocation !== undefined) data.vaultLocation = dto.vaultLocation;
    // P2025 (row tidak ada) dipetakan ke 404 oleh PrismaExceptionFilter global.
    return this.prisma.vaultItem.update({ where: { id }, data });
  }

  /* ---------- Daily Stats (Charts) ---------- */

  async dailyStats(days = 30) {
    const now = new Date();
    const since = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - days,
      ),
    );

    const listings = await this.prisma.listing.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, priceIdrx: true, status: true, soldAt: true },
    });

    const dateMap = new Map<string, { listings: number; revenue: number }>();
    for (let i = 0; i < days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      const key = d.toISOString().slice(0, 10);
      dateMap.set(key, { listings: 0, revenue: 0 });
    }

    for (const l of listings) {
      const key = l.createdAt.toISOString().slice(0, 10);
      if (dateMap.has(key)) dateMap.get(key)!.listings++;
      if (l.status === 'SOLD' && l.soldAt) {
        const soldKey = l.soldAt.toISOString().slice(0, 10);
        if (dateMap.has(soldKey)) dateMap.get(soldKey)!.revenue += l.priceIdrx;
      }
    }

    const dailyListings: { date: string; count: number }[] = [];
    const dailyRevenue: { date: string; amount: number }[] = [];
    for (const [date, vals] of dateMap) {
      dailyListings.push({ date, count: vals.listings });
      dailyRevenue.push({ date, amount: vals.revenue });
    }
    dailyListings.sort((a, b) => a.date.localeCompare(b.date));
    dailyRevenue.sort((a, b) => a.date.localeCompare(b.date));

    const statusDist = [
      {
        status: 'ACTIVE',
        count: await this.prisma.listing.count({ where: { status: 'ACTIVE' } }),
      },
      {
        status: 'SOLD',
        count: await this.prisma.listing.count({ where: { status: 'SOLD' } }),
      },
      {
        status: 'CANCELLED',
        count: await this.prisma.listing.count({
          where: { status: 'CANCELLED' },
        }),
      },
    ];

    const topListings = await this.prisma.listing.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { views: 'desc' },
      take: 5,
      select: { id: true, name: true, views: true, priceIdrx: true },
    });

    const conversionAgg = await this.prisma.listing.aggregate({
      _count: true,
      where: { status: 'SOLD' },
    });
    const totalListings = await this.prisma.listing.count();
    const conversionRate =
      totalListings > 0 ? (conversionAgg._count / totalListings) * 100 : 0;

    return {
      dailyListings,
      dailyRevenue,
      statusDistribution: statusDist,
      topListings,
      conversionRate: Math.round(conversionRate * 100) / 100,
    };
  }

  /* ---------- Image Upload ---------- */

  /**
   * Accept/reject dari admin DIDELEGASIKAN ke MarketplaceService — jalur yang
   * sama dengan tombol penjual di halaman profil. Dulu method ini cuma menulis
   * `status: ACCEPTED` tanpa menjual listing atau mint NFT: offer tampak diterima
   * padahal kartunya tidak pernah pindah tangan, dan penjual kehilangan tombol
   * accept-nya (status bukan PENDING lagi). Admin = moderasi, bukan alur utama.
   */
  acceptOffer(id: string) {
    return this.marketplace.acceptOfferAsAdmin(id);
  }

  rejectOffer(id: string) {
    return this.marketplace.rejectOfferAsAdmin(id);
  }

  /**
   * Upload gambar listing.
   *
   * PRODUKSI: kalau `CLOUDINARY_URL` di-set, byte diunggah ke Cloudinary dan yang
   * dikembalikan adalah URL CDN ABSOLUT (secure_url). Ini penting karena:
   *   1) disk container Render bersifat EPHEMERAL — file lokal hilang tiap redeploy;
   *   2) URL relatif `/uploads/...` tidak resolve dari origin frontend (Vercel).
   *
   * DEV: kalau env belum di-set, jatuh balik ke disk lokal (URL relatif) supaya
   * pengembangan lokal tetap jalan tanpa akun Cloudinary. JANGAN andalkan jalur ini
   * di produksi. Set `CLOUDINARY_URL` di env Render.
   */
  /**
   * Kredensial Cloudinary boleh diisi lewat SALAH SATU dari:
   *   a) CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name>  (1 baris), atau
   *   b) CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET (3 baris).
   * Dua-duanya didukung supaya tidak tergantung format yang ditampilkan dashboard.
   */
  // Cache instance cloudinary (atau null kalau gagal load). undefined = belum dicoba.
  private cld: (typeof import('cloudinary'))['v2'] | null | undefined = undefined;

  /** Load cloudinary LAZY + DEFENSIF. require di sini bisa THROW kalau CLOUDINARY_URL salah format —
   *  ditangkap → return null (cloudinary dianggap tak tersedia), backend TETAP jalan. */
  private cloudinaryLib(): (typeof import('cloudinary'))['v2'] | null {
    if (this.cld !== undefined) return this.cld;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.cld = (require('cloudinary') as typeof import('cloudinary')).v2;
    } catch (e) {
      this.logger.error(
        `Cloudinary gagal dimuat (CLOUDINARY_URL kemungkinan salah format — harus 'cloudinary://…'): ` +
          `${e instanceof Error ? e.message : String(e)}. Upload gambar jatuh ke DATA URL.`,
      );
      this.cld = null;
    }
    return this.cld;
  }

  private cloudinaryReady(): boolean {
    const cld = this.cloudinaryLib();
    if (!cld) return false;
    // SDK otomatis membaca process.env.CLOUDINARY_URL saat config() dipanggil.
    if (cld.config().cloud_name) return true;
    const cloudName = this.config.get<string>('CLOUDINARY_CLOUD_NAME');
    const apiKey = this.config.get<string>('CLOUDINARY_API_KEY');
    const apiSecret = this.config.get<string>('CLOUDINARY_API_SECRET');
    if (cloudName && apiKey && apiSecret) {
      cld.config({
        cloud_name: cloudName,
        api_key: apiKey,
        api_secret: apiSecret,
        secure: true,
      });
      return true;
    }
    return false;
  }

  async uploadImage(file: Express.Multer.File): Promise<{ url: string }> {
    if (!file) throw new BadRequestException('No file uploaded');
    if (!file.mimetype?.startsWith('image/'))
      throw new BadRequestException('Hanya file gambar yang diperbolehkan');

    const cld = this.cloudinaryLib();
    if (cld && this.cloudinaryReady()) {
      const dataUri = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
      const uploaded = await cld.uploader.upload(dataUri, {
        folder: 'hoshi/listings',
        resource_type: 'image',
      });
      return { url: uploaded.secure_url };
    }

    // Tanpa Cloudinary di PRODUKSI/staging: simpan sebagai DATA URL base64. Berbeda dari fallback
    // disk (URL relatif `/uploads/...` yang 404 di origin frontend & hilang tiap redeploy), data URL
    // SELF-CONTAINED: render langsung di <img>, tersimpan di DB (bukan disk ephemeral), tanpa host
    // eksternal. Dibatasi 2MB supaya baris DB tidak membengkak — untuk volume besar tetap set
    // CLOUDINARY_URL. Ini bikin upload LANGSUNG JALAN tanpa kredensial apa pun.
    if (this.config.get<string>('NODE_ENV') === 'production') {
      const MAX = 2 * 1024 * 1024;
      const size = file.size ?? file.buffer.length;
      if (size > MAX)
        throw new BadRequestException(
          'Gambar terlalu besar (maks 2MB tanpa Cloudinary). Kompres dulu, atau set CLOUDINARY_URL di server.',
        );
      return {
        url: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`,
      };
    }

    // Fallback dev-only: tulis ke disk lokal (URL relatif — hanya berguna lokal).
    this.logger.warn(
      'Kredensial Cloudinary belum di-set (CLOUDINARY_URL, atau CLOUDINARY_CLOUD_NAME + ' +
        'CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET) — upload jatuh ke disk lokal (ephemeral, dev-only).',
    );
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const filename = `${crypto.randomUUID()}${ext}`;
    const dest = path.join(this.uploadDir, filename);
    if (!fs.existsSync(this.uploadDir))
      fs.mkdirSync(this.uploadDir, { recursive: true });
    fs.writeFileSync(dest, file.buffer);
    return { url: `/uploads/${filename}` };
  }

  async seedAdmin(email: string, password: string, secret?: string) {
    // Fail closed: tanpa ADMIN_SECRET di env, seed tidak bisa dipakai sama
    // sekali — endpoint ini membuat akun ADMIN, bukan sekadar data demo.
    const expected = this.config.get<string>('ADMIN_SECRET');
    if (!expected || secret !== expected) {
      throw new ForbiddenException(
        'Seed admin butuh header x-admin-secret yang cocok dengan env ADMIN_SECRET.',
      );
    }
    const existing = await this.prisma.user.findFirst({ where: { email } });
    if (existing) throw new ConflictException('Admin already exists');
    const passwordHash = await hash(password);
    return this.prisma.user.create({
      data: {
        walletAddress: `admin-${email.replace(/[^a-zA-Z0-9]/g, '')}`,
        email,
        passwordHash,
        role: 'ADMIN',
        displayName: 'Admin',
      },
    });
  }

  async seedChartData() {
    // Guard: endpoint ini menulis 91 listing demo langsung ke tabel `listings`
    // yang dipakai dashboard. Dilarang di production agar angka riil tidak
    // tercemar data palsu.
    if (this.config.get<string>('NODE_ENV') === 'production')
      throw new ForbiddenException('Seed chart data dilarang di production.');
    const SEED_CARDS = [
      {
        name: 'Pikachu VMAX',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Lightning',
        category: 'Special Illustration',
        priceIdrx: 45000000,
        expectedValueIdrx: 48000000,
        image: 'https://placehold.co/400x560/3a2e0e/ffd700?text=Pikachu+VMAX',
      },
      {
        name: 'Charizard VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Classic',
        element: 'Fire',
        category: 'Character Illustration',
        priceIdrx: 52000000,
        expectedValueIdrx: 55000000,
        image: 'https://placehold.co/400x560/4a0e0e/ffd700?text=Charizard+VMAX',
      },
      {
        name: 'Mewtwo VSTAR',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Psychic',
        category: 'Special Illustration',
        priceIdrx: 28000000,
        expectedValueIdrx: 30000000,
        image: 'https://placehold.co/400x560/2e0e4a/ffd700?text=Mewtwo+VSTAR',
      },
      {
        name: 'Gengar VMAX',
        set: 'Classic',
        rarity: 'Legendary Rare',
        grade: 'CGC 9',
        grader: 'CGC' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Classic',
        element: 'Darkness',
        category: 'Special Illustration',
        priceIdrx: 35000000,
        expectedValueIdrx: 38000000,
        image: 'https://placehold.co/400x560/2e0e0e/ffd700?text=Gengar+VMAX',
      },
      {
        name: 'Eevee V',
        set: 'Promo',
        rarity: 'Epic',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'English',
        era: 'Modern',
        element: 'Normal',
        category: 'Illustration',
        priceIdrx: 8500000,
        expectedValueIdrx: 9200000,
        image: 'https://placehold.co/400x560/3a2e0e/c8a84e?text=Eevee+V',
      },
      {
        name: 'Umbreon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 10',
        grader: 'BGS' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Darkness',
        category: 'Character Illustration',
        priceIdrx: 62000000,
        expectedValueIdrx: 65000000,
        image: 'https://placehold.co/400x560/1a1a2e/ffd700?text=Umbreon+VMAX',
      },
      {
        name: 'Rayquaza V',
        set: 'Classic',
        rarity: 'Legendary',
        grade: 'CGC 9.5',
        grader: 'CGC' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Classic',
        element: 'Dragon',
        category: 'Special Illustration',
        priceIdrx: 38000000,
        expectedValueIdrx: 40000000,
        image: 'https://placehold.co/400x560/0e3a2e/ffd700?text=Rayquaza+V',
      },
      {
        name: 'Glaceon VSTAR',
        set: 'Jungle',
        rarity: 'Epic',
        grade: 'PSA 10',
        grader: 'PSA' as const,
        gradeScore: 10,
        language: 'English',
        era: 'Modern',
        element: 'Water',
        category: 'Illustration',
        priceIdrx: 18000000,
        expectedValueIdrx: 20000000,
        image: 'https://placehold.co/400x560/0e1a4a/aaccff?text=Glaceon+VSTAR',
      },
      {
        name: 'Lucario V',
        set: 'Rare',
        rarity: 'Rare',
        grade: 'PSA 9',
        grader: 'PSA' as const,
        gradeScore: 9,
        language: 'Japan',
        era: 'Modern',
        element: 'Fighting',
        category: 'Character Illustration',
        priceIdrx: 6500000,
        expectedValueIdrx: 7200000,
        image: 'https://placehold.co/400x560/4a2e0e/d4a64e?text=Lucario+V',
      },
      {
        name: 'Sylveon VMAX',
        set: 'Evolving',
        rarity: 'Legendary',
        grade: 'BGS 9.5',
        grader: 'BGS' as const,
        gradeScore: 9.5,
        language: 'English',
        era: 'Modern',
        element: 'Fairy',
        category: 'Character Illustration',
        priceIdrx: 42000000,
        expectedValueIdrx: 45000000,
        image: 'https://placehold.co/400x560/2e1a3a/ffb6c1?text=Sylveon+VMAX',
      },
    ];

    const now = new Date();
    let created = 0;

    for (let dayOffset = 90; dayOffset >= 0; dayOffset--) {
      const card = SEED_CARDS[dayOffset % SEED_CARDS.length];
      const createdAt = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - dayOffset,
          8,
          0,
          0,
        ),
      );
      await this.prisma.listing.create({
        data: {
          ...card,
          buybackIdrx: Math.round(card.priceIdrx * 0.7),
          sellerAddress: 'seed-admin',
          status: 'ACTIVE',
          createdAt,
          listedAt: createdAt,
          updatedAt: createdAt,
          priceHistory: [card.expectedValueIdrx, card.priceIdrx],
          offers: [],
        },
      });
      created++;
    }

    return {
      listingsCreated: created,
      dateRange: {
        to: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 0,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
        from: new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() - 90,
            8,
            0,
            0,
          ),
        )
          .toISOString()
          .slice(0, 10),
      },
    };
  }
}
