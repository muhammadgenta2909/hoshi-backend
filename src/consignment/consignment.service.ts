import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActivityType,
  ConsignmentPhotoKind,
  ConsignmentStatus,
  ListingStatus,
  OfferStatus,
  Prisma,
} from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { BalanceService } from '../balance/balance.service';
import {
  CONSIGNMENT_ERROR_CODE,
  consignmentError,
} from '../common/consignment.errors';
import {
  CONSIGNMENT_COMPENSATION_REASON,
  CONSIGNMENT_SALE_REASON,
  acceptCustodyClaimWhere,
  isInHoshiCustody,
  listClaimWhere,
  liveConsignmentWhere,
  takeDownClaimWhere,
} from '../common/consignment.gate';
import { shortWallet } from '../marketplace/marketplace.serialize';
import { PrismaService } from '../prisma/prisma.service';
import type {
  AcceptCustodyDto,
  AddConsignmentPhotosDto,
  CompensateConsignmentDto,
  ConsignmentPhotoInput,
  CorrectConsignmentDto,
  CreateConsignmentDto,
  CreateConsignmentListingDto,
  MarkConsignmentLostDto,
  ReleaseConsignmentDto,
  UpdateConsignmentPriceDto,
  WithdrawConsignmentDto,
} from './dto/consignment.dto';

// Alasan ledger hidup di `src/common/consignment.gate.ts` supaya PaymentsService bisa memakainya
// tanpa menyeret modul ini (dan siklus impor) ke dalam modul pembayaran. Di-re-export di sini
// karena di sinilah pembaca mencarinya.
export { CONSIGNMENT_SALE_REASON, CONSIGNMENT_COMPENSATION_REASON };

/** Berapa lama sebuah INTAKE boleh menganggur sebelum dashboard menandainya perlu tindakan. */
const STALE_INTAKE_DAYS = 14;

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KONSINYASI — BARANG ORANG LAIN, FISIKNYA DI TANGAN HOSHI.                                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Risiko yang ditakutkan pemilik produk: "jangan sampai ada case misal kita jual kartu seseorang,
 * tapi dia ternyata jual pribadi ke orang lain."
 *
 * Ditutup oleh URUTAN, bukan kepintaran: KARTUNYA SUDAH DI TANGAN HOSHI SEBELUM listing-nya tayang.
 * Dan urutan itu ditegakkan oleh SATU hal — `createListingFor` adalah satu-satunya kode di repo
 * ini yang menulis `Listing.consignmentId`, dan ia melakukannya di dalam transaksi yang SAMA
 * dengan klaim atomik berpredikat `custodyAcceptedAt != null`. Jadi baris Listing titipan tidak
 * bisa ADA tanpa custody — bukan karena ada yang ingat memeriksa, melainkan karena tidak ada jalan
 * kode lain untuk membuatnya.
 *
 * SEMUA rute di sini ADMIN-ONLY kecuali dua milik pemilik kartu (lihat consignment.controller.ts):
 * melihat titipannya sendiri, dan meminta kartunya kembali.
 *
 * NOL USDC, NOL SOL, NOL on-chain, NOL escrow, NOL panggilan CollectorCrypt di SELURUH file ini.
 */
@Injectable()
export class ConsignmentService {
  private readonly logger = new Logger(ConsignmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly balance: BalanceService,
  ) {}

  /* ══════════════════════════════════ 1. INTAKE ══════════════════════════════════ */

  /**
   * Catat KESEPAKATAN. Kartunya BELUM tentu diserahkan — status lahir `INTAKE`, dan baris INTAKE
   * tidak bisa dipajang oleh apa pun maupun dijual oleh apa pun.
   *
   * KENAPA DUA LANGKAH (intake lalu accept) DAN BUKAN SATU: yang menutup risiko jual-ganda adalah
   * fakta FISIK "kartunya ada di tangan kami", dan fakta itu hanya diketahui oleh orang yang
   * benar-benar memegangnya. Menggabungkannya dengan pencatatan kesepakatan akan membuat satu
   * formulir menyatakan dua hal yang berbeda kebenarannya.
   */
  async createIntake(dto: CreateConsignmentDto, admin: AuthUser) {
    const consignor = await this.prisma.user.findUnique({
      where: { id: dto.consignorId },
      select: { id: true, walletAddress: true, displayName: true },
    });
    if (!consignor) {
      throw new NotFoundException(
        'Pemilik kartu (consignor) tidak ditemukan. Ia harus sudah punya akun Hoshi — ' +
          'kalau tidak, tidak ada siapa pun yang bisa dikredit saat kartunya terjual.',
      );
    }

    // ANTI-DOBEL-TITIP untuk slab bernomor sertifikat. Dicek di sini supaya pesannya bisa
    // menjelaskan; yang BENAR-BENAR menegakkannya adalah partial unique index
    // `consignments_active_cert_uniq` (migration 20260922000000) — pemeriksaan ini bisa basi
    // karena balapan, index-nya tidak.
    // Dinormalisasi SEBELUM dipakai: cek bentrok dan penyimpanan harus memakai nilai yang SAMA
    // PERSIS. Sebelumnya cek dan simpan sama-sama memakai dto mentah, jadi '12345' dan '12345 '
    // lolos sebagai dua titipan hidup untuk SATU kartu fisik — index unik parsialnya mencocokkan
    // string apa adanya. Butuh operator salah ketik di dua intake terpisah; murah untuk ditutup.
    const certNumber = dto.certNumber?.trim() || null;
    if (certNumber && dto.grader) {
      const clash = await this.prisma.consignment.findFirst({
        where: {
          grader: dto.grader,
          certNumber,
          ...liveConsignmentWhere(),
        },
        select: { id: true, status: true },
      });
      if (clash) {
        throw new ConflictException(
          `Kartu dengan sertifikat ${dto.grader} ${certNumber} SUDAH tercatat sebagai ` +
            `titipan aktif (${clash.id}, status ${clash.status}). Satu kartu fisik tidak bisa ` +
            'dititipkan dua kali. Kalau kartu yang lama sudah dikembalikan, catat pengembaliannya ' +
            'dulu (POST /admin/consignments/:id/release).',
        );
      }
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.consignment.create({
        data: {
          consignorId: consignor.id,
          consignorNameAtIntake: dto.consignorNameAtIntake.trim(),
          consignorPhoneAtIntake: dto.consignorPhoneAtIntake.trim(),
          consignorIdKind: dto.consignorIdKind ?? null,
          consignorIdLast4: dto.consignorIdLast4 ?? null,
          receivedById: admin.id,
          receivedAtPlace: dto.receivedAtPlace.trim(),
          cardName: dto.cardName.trim(),
          cardSet: dto.cardSet ?? null,
          cardNumber: dto.cardNumber ?? null,
          language: dto.language ?? null,
          tcg: dto.tcg ?? null,
          grader: dto.grader ?? null,
          certNumber,
          gradeLabel: dto.gradeLabel ?? null,
          gradeScore: dto.gradeScore ?? null,
          conditionNote: dto.conditionNote.trim(),
          rawCondition: dto.rawCondition ?? null,
          intakeReceiptRef: dto.intakeReceiptRef ?? null,
          agreementRef: dto.agreementRef ?? null,
          askPriceIdr: dto.askPriceIdr,
          reservePriceIdr: dto.reservePriceIdr ?? null,
          // Snapshot. Tidak dibaca ulang dari env saat payout — lihat komentar kolomnya.
          ...(dto.commissionBps != null
            ? { commissionBps: dto.commissionBps }
            : {}),
          status: ConsignmentStatus.INTAKE,
        },
      });
      await this.writePhotos(tx, created.id, dto.photos, admin);
      await this.writeEvent(tx, {
        consignmentId: created.id,
        kind: 'INTAKE',
        toStatus: ConsignmentStatus.INTAKE,
        actor: admin,
        note: `Kesepakatan dicatat di ${created.receivedAtPlace}. Kartu BELUM diterima.`,
      });
      return created;
    });

    this.logger.log(
      `Titipan ${row.id} dicatat (INTAKE) oleh admin ${admin.id}: "${row.cardName}" milik ` +
        `${consignor.id}, ask Rp ${row.askPriceIdr}, komisi ${row.commissionBps} bps. ` +
        'Belum boleh dipajang — custody belum diterima.',
    );
    return this.byId(row.id);
  }

  /* ═══════════════════════════ 2. TERIMA CUSTODY (INVARIAN) ══════════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ SATU-SATUNYA PENULIS `custodyAcceptedAt` DI SELURUH REPO. TIDAK ADA YANG MENGHAPUSNYA. ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Dipanggil oleh orang yang BENAR-BENAR MEMEGANG kartunya, sesudah buktinya lengkap. Bentuknya
   * klaim atomik — gerbangnya ADALAH predikatnya — persis seperti `VaultService.claim`
   * (STORED→MINTING) dan `submitEscrow` (PENDING_ESCROW→ACTIVE).
   */
  async acceptCustody(id: string, dto: AcceptCustodyDto, admin: AuthUser) {
    const existing = await this.requireConsignment(id);
    if (existing.status !== ConsignmentStatus.INTAKE) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          `Titipan ini berstatus ${existing.status}; serah-terima hanya bisa dicatat dari ` +
          'INTAKE. Stempel custody ditulis SEKALI dan tidak pernah bisa ditulis ulang.',
        consignmentId: id,
      });
    }

    // ── BUKTI: WAJIB, dan ditegakkan DI SINI, bukan sekadar oleh tipe ──────────────────────
    //
    // Menerima kartu orang lain TANPA foto adalah kegagalan yang membuat SETIAP sengketa nanti
    // tidak bisa dimenangkan oleh SIAPA PUN — termasuk oleh pemiliknya. Foto depan/belakang
    // (plus foto sertifikat kalau slab bernomor) adalah bukti yang HOSHI SENDIRI ciptakan dan
    // tidak bisa diam-diam direvisi: baris foto append-only, tidak ada endpoint update.
    const kinds = new Set<ConsignmentPhotoKind>([
      ...existing.photos.map((p) => p.kind),
      ...(dto.photos ?? []).map((p) => p.kind),
    ]);
    const missing: string[] = [];
    if (!kinds.has(ConsignmentPhotoKind.FRONT)) missing.push('FRONT');
    if (!kinds.has(ConsignmentPhotoKind.BACK)) missing.push('BACK');
    if (existing.certNumber && !kinds.has(ConsignmentPhotoKind.CERT)) {
      missing.push('CERT');
    }
    if (missing.length > 0) {
      throw consignmentError({
        status: HttpStatus.BAD_REQUEST,
        code: CONSIGNMENT_ERROR_CODE.EVIDENCE_REQUIRED,
        message:
          `Foto bukti belum lengkap: kurang ${missing.join(', ')}. Serah-terima tidak dicatat ` +
          'dan kartu ini tetap tidak bisa dipajang. Foto inilah bukti kondisi kartu SAAT ' +
          'DITERIMA — tanpa itu, sengketa nanti tidak bisa dimenangkan oleh siapa pun, ' +
          'termasuk oleh pemiliknya.',
        consignmentId: id,
      });
    }
    if (existing.conditionNote.trim().length === 0) {
      throw consignmentError({
        status: HttpStatus.BAD_REQUEST,
        code: CONSIGNMENT_ERROR_CODE.EVIDENCE_REQUIRED,
        message:
          'Catatan kondisi saat diterima kosong. Isi dulu lewat intake sebelum mencatat ' +
          'serah-terima.',
        consignmentId: id,
      });
    }
    const storageLocation = dto.storageLocation.trim();
    if (storageLocation.length === 0) {
      throw consignmentError({
        status: HttpStatus.BAD_REQUEST,
        code: CONSIGNMENT_ERROR_CODE.EVIDENCE_REQUIRED,
        message:
          'Lokasi penyimpanan wajib diisi: kartu orang lain yang tidak tercatat ada di rak mana ' +
          'adalah kartu yang belum benar-benar kita pegang.',
        consignmentId: id,
      });
    }

    await this.prisma.$transaction(async (tx) => {
      await this.writePhotos(tx, id, dto.photos, admin);
      // ══ KLAIM ATOMIK. Gerbangnya ADALAH predikatnya. ══
      const claimed = await tx.consignment.updateMany({
        where: acceptCustodyClaimWhere(id),
        data: {
          status: ConsignmentStatus.IN_CUSTODY,
          custodyAcceptedAt: new Date(),
          storageLocation,
          receivedById: admin.id,
          ...(dto.intakeReceiptRef
            ? { intakeReceiptRef: dto.intakeReceiptRef }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Serah-terima titipan ini sudah tercatat oleh permintaan lain (atau statusnya ' +
            'berubah barusan). Tidak ada yang ditulis dua kali.',
          consignmentId: id,
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'ACCEPT_CUSTODY',
        fromStatus: ConsignmentStatus.INTAKE,
        toStatus: ConsignmentStatus.IN_CUSTODY,
        actor: admin,
        note:
          `Kartu DITERIMA FISIK di ${storageLocation}. ` +
          (dto.note?.trim() ? dto.note.trim() : ''),
      });
    });

    this.logger.warn(
      `CUSTODY DITERIMA: titipan ${id} ("${existing.cardName}", pemilik ${existing.consignorId}) ` +
        `sekarang ADA DI TANGAN HOSHI di ${storageLocation}, dicatat admin ${admin.id}. ` +
        'Stempel ini tidak pernah dihapus oleh kode mana pun.',
    );
    return this.byId(id);
  }

  /* ═══════════════════════════════ 3. PAJANG ═══════════════════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ SATU-SATUNYA PENULIS `Listing.consignmentId` DI SELURUH REPO.                          ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `Listing.create` dan klaim `IN_CUSTODY → LISTED` berada di SATU transaksi, dan klaim itu
   * berpredikat `custodyAcceptedAt != null, custodyReleasedAt = null`. Karena itu baris Listing
   * titipan TIDAK BISA LAHIR tanpa custody — dan itulah, tepatnya, penutup risiko jual-ganda:
   * tidak ada listing titipan yang bisa tayang untuk kartu yang masih dipegang pemiliknya.
   */
  async createListingFor(
    id: string,
    dto: CreateConsignmentListingDto,
    admin: AuthUser,
  ) {
    const c = await this.requireConsignment(id);
    if (!isInHoshiCustody(c) || c.status !== ConsignmentStatus.IN_CUSTODY) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.NOT_IN_CUSTODY,
        message:
          `Titipan ini berstatus ${c.status} — hanya kartu yang serah-terimanya SUDAH tercatat ` +
          'dan masih ada di penyimpanan Hoshi yang boleh dipajang. Inilah urutan yang menutup ' +
          'risiko kartu yang sama dijual dua kali.',
        consignmentId: id,
      });
    }
    if (c.listing) {
      throw new ConflictException(
        `Titipan ini sudah punya listing (${c.listing.id}).`,
      );
    }
    // ── BATAS SLICE 1 YANG DISENGAJA: kartu MENTAH belum bisa dipajang. ───────────────────
    // `Listing.grader` adalah enum NOT NULL berisi PSA/CGC/BGS saja. Untuk kartu tanpa grading
    // tidak ada nilai yang JUJUR di sana, dan mengarang salah satunya berarti MEMBERI LABEL PALSU
    // PADA KARTU ORANG LAIN — tepat hal yang seluruh fitur ini dibangun untuk tidak dilakukan.
    // Intake, custody, bukti, dan penarikan kembali SEMUANYA sudah bekerja untuk kartu mentah;
    // yang ditunda hanya pemajangannya, sampai `Grader` punya nilai RAW (perubahan schema
    // tersendiri yang menyentuh filter marketplace).
    if (c.grader == null) {
      throw consignmentError({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
        code: CONSIGNMENT_ERROR_CODE.UNSUPPORTED_ACTION,
        message:
          'Kartu titipan TANPA grading belum bisa dipajang di fase ini: kolom grader pada ' +
          'listing hanya mengenal PSA/CGC/BGS, dan mengisinya dengan salah satu dari itu berarti ' +
          'memberi label palsu pada kartu orang lain. Titipannya tetap tercatat dan tetap bisa ' +
          'ditarik kembali kapan saja.',
        consignmentId: id,
      });
    }

    const consignor = await this.prisma.user.findUniqueOrThrow({
      where: { id: c.consignorId },
      select: { id: true, walletAddress: true, displayName: true },
    });

    const price = dto.priceIdrx ?? c.askPriceIdr;
    const listingId = await this.prisma.$transaction(async (tx) => {
      // ══ KLAIM ATOMIK DULU. Kalau kalah, TIDAK ADA baris Listing yang pernah dibuat. ══
      const claimed = await tx.consignment.updateMany({
        where: listClaimWhere(id),
        data: { status: ConsignmentStatus.LISTED },
      });
      if (claimed.count !== 1) {
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Titipan ini tidak lagi siap dipajang (sudah dipajang, ditarik, atau kartunya sudah ' +
            'keluar). Tidak ada listing yang dibuat.',
          consignmentId: id,
        });
      }
      const listing = await tx.listing.create({
        data: {
          name: c.cardName,
          set: c.cardSet ?? dto.category ?? 'Consignment',
          rarity: dto.rarity ?? 'Rare',
          image: dto.image,
          imageBack: dto.imageBack ?? null,
          priceIdrx: price,
          expectedValueIdrx: dto.expectedValueIdrx ?? price,
          buybackIdrx: 0,
          grade: c.gradeLabel ?? `${c.grader} ${c.gradeScore ?? ''}`.trim(),
          grader: c.grader!,
          gradeScore: c.gradeScore ?? 0,
          language: c.language ?? 'English',
          era: dto.era ?? c.cardSet ?? 'Unknown',
          element: dto.element ?? 'Unknown',
          category: dto.category ?? 'Consignment',
          tcg: c.tcg ?? null,
          cardNumber: c.cardNumber ?? null,
          certificate: c.certNumber ?? null,
          vaultLocation: c.storageLocation ?? null,
          status: ListingStatus.ACTIVE,
          // ── BENTUK YANG DIPAKU CHECK CONSTRAINT `listings_consignment_shape_chk` ──
          // source HOSHI (default, bukan COLLECTORCRYPT) · sellable FALSE (default) ·
          // ccNftAddress NULL · escrowedAt NULL · sellerId NON-NULL.
          // Kelimanya juga ditegakkan Postgres, jadi "kartu titipan tidak bisa menempuh
          // settlement escrow" adalah invarian DATABASE, bukan janji code-review.
          sellerId: consignor.id,
          sellerAddress: shortWallet(consignor.walletAddress),
          consignmentId: id,
        },
      });
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'LIST',
        fromStatus: ConsignmentStatus.IN_CUSTODY,
        toStatus: ConsignmentStatus.LISTED,
        actor: admin,
        note: `Listing ${listing.id} dibuat pada harga Rp ${price}.`,
      });
      await tx.activity.create({
        data: {
          type: ActivityType.LISTED_CARD,
          listingId: listing.id,
          itemName: listing.name,
          itemImage: listing.image,
          category: listing.category,
          set: listing.set,
          amount: listing.priceIdrx,
          fromId: consignor.id,
          fromLabel:
            consignor.displayName?.trim() ||
            shortWallet(consignor.walletAddress),
          toId: null,
          toLabel: null,
        },
      });
      return listing.id;
    });

    this.logger.log(
      `Titipan ${id} DIPAJANG sebagai listing ${listingId} (Rp ${price}) oleh admin ${admin.id}. ` +
        'Kartunya ada di tangan Hoshi SEBELUM baris ini lahir — itu urutannya.',
    );
    return this.byId(id);
  }

  /**
   * Ubah harga kartu titipan. Rute ADMIN, dan SENGAJA bukan `PATCH /marketplace/:id` milik
   * penjual: harganya bagian dari perjanjian bertanda tangan, jadi perubahannya wajib beralasan
   * dan alasannya disimpan. Kolom kesepakatan dan harga listing ditulis dalam SATU transaksi,
   * supaya keduanya tidak pernah menyimpang.
   */
  async updatePrice(
    id: string,
    dto: UpdateConsignmentPriceDto,
    admin: AuthUser,
  ) {
    const c = await this.requireConsignment(id);
    if (c.custodyReleasedAt != null) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.NOT_IN_CUSTODY,
        message:
          'Kartu ini sudah tidak ada di penyimpanan Hoshi — harganya tidak bisa diubah lagi.',
        consignmentId: id,
      });
    }
    const before = c.askPriceIdr;
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.consignment.updateMany({
        where: {
          id,
          custodyReleasedAt: null,
          status: { not: ConsignmentStatus.SOLD },
        },
        data: { askPriceIdr: dto.askPriceIdr },
      });
      if (changed.count !== 1) {
        throw new ConflictException(
          'Titipan ini tidak lagi bisa diubah harganya (sudah terjual atau kartunya sudah keluar).',
        );
      }
      if (c.listing) {
        // Harga listing hanya diubah selama ia masih ACTIVE. Kalau sudah SOLD, basis payout
        // memang bukan harga listing melainkan yang BENAR-BENAR dibayar pembeli — lihat
        // `fulfilConsignment`.
        await tx.listing.updateMany({
          where: { id: c.listing.id, status: ListingStatus.ACTIVE },
          data: { priceIdrx: dto.askPriceIdr },
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'PRICE',
        actor: admin,
        note: `Harga Rp ${before} → Rp ${dto.askPriceIdr}. ${dto.note.trim()}`,
      });
    });
    return this.byId(id);
  }

  /* ═══════════════════════════ 4. PENARIKAN KEMBALI ═══════════════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ TUAS KEPERCAYAAN TERKUAT: pemilik boleh minta kartunya kembali, KAPAN SAJA, GRATIS.    ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * NOL Rupiah bergerak di jalur ini — tanpa biaya penyimpanan, tanpa biaya penanganan, tanpa
   * biaya listing. Itu SELURUH nilai tuas ini; melemahkannya berarti menghapusnya.
   *
   * BALAPAN YANG SESUNGGUHNYA, dan diselesaikan persis seperti `MarketplaceService.cancel`
   * menyelesaikannya di jalur P2P: invoice pembeli BISA hidup selagi listing masih ACTIVE
   * (settlement baru meng-klaim ACTIVE→SOLD saat fulfilment, bukan saat invoice terbit). Jadi ada
   * jendela di mana penarikan menurunkan listing selagi Rupiah sedang di jalan. Dua hasil, dua-
   * duanya aman:
   *
   *   • PENARIKAN MENANG → pembayaran yang mendarat belakangan menemukan listing bukan ACTIVE,
   *     klaim `fulfilConsignment` cocok 0 baris → failToRefund → REFUND_DUE, refundSafe = true.
   *     KARTU TIDAK PERNAH BERGERAK. PEMILIK TIDAK PERNAH DIKREDIT. Rupiah pembeli utuh.
   *   • PENARIKAN KALAH (listing sudah SOLD) → transaksi ROLLBACK seluruhnya, dan pemiliknya
   *     diberi tahu apa adanya: kartunya terjual sebelum permintaan ini sampai; hasilnya ada di
   *     saldo.
   *
   * Yang TIDAK MUNGKIN adalah keduanya sekaligus — karena klaim `LISTED → IN_CUSTODY` di sini dan
   * klaim `LISTED → SOLD` di settlement menamai status sumber yang SAMA.
   */
  async requestWithdrawal(
    id: string,
    dto: WithdrawConsignmentDto,
    actor: AuthUser,
  ) {
    const c = await this.requireConsignment(id);
    if (actor.role !== 'ADMIN' && c.consignorId !== actor.id) {
      throw new ForbiddenException(
        'Hanya pemilik kartu (atau admin) yang bisa meminta kartu ini kembali.',
      );
    }
    const note = dto.note?.trim() ?? '';

    switch (c.status) {
      // Kartunya belum pernah berpindah tangan → batalkan saja kesepakatannya.
      case ConsignmentStatus.INTAKE: {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.consignment.updateMany({
            where: { id, status: ConsignmentStatus.INTAKE },
            data: {
              status: ConsignmentStatus.CANCELLED,
              withdrawRequestedAt: new Date(),
            },
          });
          if (claimed.count !== 1) {
            throw new ConflictException(
              'Status titipan berubah barusan. Coba lagi.',
            );
          }
          await this.writeEvent(tx, {
            consignmentId: id,
            kind: 'CANCEL',
            fromStatus: ConsignmentStatus.INTAKE,
            toStatus: ConsignmentStatus.CANCELLED,
            actor,
            note:
              'Kesepakatan dibatalkan sebelum serah-terima; tidak ada kartu yang berpindah. ' +
              note,
          });
        });
        return this.byId(id);
      }

      // Di rak, belum dipajang → catat permintaannya; admin mengatur serah-terimanya.
      case ConsignmentStatus.IN_CUSTODY: {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.consignment.updateMany({
            where: {
              id,
              status: ConsignmentStatus.IN_CUSTODY,
              custodyReleasedAt: null,
            },
            data: { withdrawRequestedAt: new Date() },
          });
          if (claimed.count !== 1) {
            throw new ConflictException(
              'Status titipan berubah barusan. Coba lagi.',
            );
          }
          await this.writeEvent(tx, {
            consignmentId: id,
            kind: 'WITHDRAW_REQUEST',
            fromStatus: ConsignmentStatus.IN_CUSTODY,
            toStatus: ConsignmentStatus.IN_CUSTODY,
            actor,
            note: `Pemilik minta kartunya kembali. ${note}`,
          });
        });
        return this.byId(id);
      }

      // Terpajang → turunkan listing-nya lebih dulu, ATOMIK, dalam satu transaksi.
      case ConsignmentStatus.LISTED: {
        const listingId = c.listing?.id;
        if (!listingId) {
          throw new ConflictException(
            `Titipan ${id} berstatus LISTED tapi tidak punya baris listing — data tidak ` +
              'konsisten; hubungi admin.',
          );
        }
        await this.prisma.$transaction(async (tx) => {
          // Bentuk PERSIS `MarketplaceService.cancel`: gerbang ACTIVE→CANCELLED menutup jendela
          // beli SEBELUM apa pun yang lain disentuh.
          const down = await tx.listing.updateMany({
            where: {
              id: listingId,
              consignmentId: id,
              status: ListingStatus.ACTIVE,
            },
            data: { status: ListingStatus.CANCELLED },
          });
          if (down.count !== 1) {
            throw consignmentError({
              status: HttpStatus.CONFLICT,
              code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
              message:
                'Kartu ini sudah terjual sebelum permintaan penarikan sampai, jadi ia tidak bisa ' +
                'ditarik lagi — kartunya sekarang milik pembeli. Hasil penjualannya ada di ' +
                'saldo Anda. Tidak ada yang berubah karena permintaan ini.',
              listingId,
              consignmentId: id,
            });
          }
          const back = await tx.consignment.updateMany({
            where: takeDownClaimWhere(id),
            data: {
              status: ConsignmentStatus.IN_CUSTODY,
              withdrawRequestedAt: new Date(),
            },
          });
          if (back.count !== 1) {
            throw new ConflictException(
              'Status titipan berubah barusan; tidak ada yang diubah.',
            );
          }
          // Offer yang masih hidup ditutup: tidak ada lagi listing yang bisa mereka beli.
          // (Di slice 1 offer untuk kartu titipan memang ditolak di depan — ini pagar kedua.)
          await tx.offer.updateMany({
            where: {
              listingId,
              status: { in: [OfferStatus.PENDING, OfferStatus.ACCEPTED] },
            },
            data: { status: OfferStatus.REJECTED },
          });
          await tx.activity.create({
            data: {
              type: ActivityType.LISTING_CANCELED,
              listingId,
              itemName: c.cardName,
              itemImage: c.listing?.image ?? null,
              category: c.listing?.category ?? null,
              set: c.listing?.set ?? null,
              amount: null,
              fromId: c.consignorId,
              fromLabel: c.consignorNameAtIntake,
              toId: null,
              toLabel: null,
            },
          });
          await this.writeEvent(tx, {
            consignmentId: id,
            kind: 'TAKE_DOWN',
            fromStatus: ConsignmentStatus.LISTED,
            toStatus: ConsignmentStatus.IN_CUSTODY,
            actor,
            note: `Listing ${listingId} ditarik atas permintaan pemilik. ${note}`,
          });
        });
        return this.byId(id);
      }

      // Kartunya SUDAH MILIK PEMBELI. Tidak bisa ditarik — dan ini tidak boleh punya celah.
      case ConsignmentStatus.SOLD:
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Kartu ini sudah terjual, jadi tidak bisa ditarik kembali — kartunya sekarang milik ' +
            'pembeli. Hasil penjualannya sudah masuk ke saldo Anda.',
          consignmentId: id,
        });

      default:
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message: `Titipan ini berstatus ${c.status}; tidak ada yang bisa ditarik.`,
          consignmentId: id,
        });
    }
  }

  /* ═══════════════════ 5. KARTU KELUAR: RELEASE / LOST ═══════════════════ */

  /**
   * Kartunya FISIK keluar dari Hoshi — dikembalikan ke pemilik, atau diserahkan ke kurir untuk
   * pembeli. Menulis `custodyReleasedAt`, yang TIDAK PERNAH dihapus. Sesudah ini
   * `isInHoshiCustody` false di semua tempat, jadi kartunya tidak bisa dijual, tidak bisa
   * dikirim, dan tidak bisa dipajang ulang — semuanya struktural.
   *
   * Dari SOLD hanya `SHIPPED_TO_BUYER` yang masuk akal; dari IN_CUSTODY hanya `WITHDRAWN`.
   * "Hilang" punya rutenya sendiri supaya ia tidak pernah bisa tercatat sebagai pengembalian biasa.
   */
  async release(id: string, dto: ReleaseConsignmentDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    const reason = dto.releaseReason.trim().toUpperCase();
    if (reason !== 'WITHDRAWN' && reason !== 'SHIPPED_TO_BUYER') {
      throw new BadRequestException(
        'releaseReason harus WITHDRAWN atau SHIPPED_TO_BUYER. Kartu HILANG dicatat lewat ' +
          'POST /admin/consignments/:id/lost — supaya "hilang" tidak pernah tercatat diam-diam ' +
          'sebagai pengembalian biasa.',
      );
    }
    const from =
      reason === 'WITHDRAWN'
        ? ConsignmentStatus.IN_CUSTODY
        : ConsignmentStatus.SOLD;
    if (c.status !== from) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          `Pelepasan dengan alasan ${reason} hanya sah dari status ${from}; titipan ini ` +
          `berstatus ${c.status}. Kalau kartunya masih terpajang, tarik listing-nya dulu.`,
        consignmentId: id,
      });
    }
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.consignment.updateMany({
        where: { id, status: from, custodyReleasedAt: null },
        data: {
          status: ConsignmentStatus.RELEASED,
          custodyReleasedAt: new Date(),
          releaseReason: reason,
          releaseReceiptRef: dto.releaseReceiptRef ?? null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Status titipan berubah barusan; tidak ada yang ditulis.',
        );
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'RELEASE',
        fromStatus: from,
        toStatus: ConsignmentStatus.RELEASED,
        actor: admin,
        note: `${reason}. ${dto.note.trim()}`,
      });
    });
    this.logger.warn(
      `CUSTODY SELESAI: titipan ${id} ("${c.cardName}") KELUAR dari Hoshi (${reason}), ` +
        `dicatat admin ${admin.id}.`,
    );
    return this.byId(id);
  }

  /**
   * Kartu HILANG atau RUSAK dalam pengawasan Hoshi. Menutup semuanya dalam satu transaksi:
   * custody dilepas, dan listing yang masih hidup DITURUNKAN lewat klaim atomik yang sama
   * bentuknya dengan penarikan — jadi kartu yang hilang tidak bisa tetap terpajang.
   *
   * YANG MASIH BUTUH MANUSIA: besaran ganti ruginya, dan percakapannya. Yang bisa dilakukan
   * software hanyalah memastikan kartu itu tidak bisa dijual, dikirim, atau dipajang lagi.
   */
  async markLost(id: string, dto: MarkConsignmentLostDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    if (c.custodyReleasedAt != null) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message: `Titipan ini sudah ditutup (${c.status}); tidak bisa ditandai hilang lagi.`,
        consignmentId: id,
      });
    }
    if (c.custodyAcceptedAt == null) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          'Serah-terima kartu ini belum pernah tercatat, jadi ia tidak pernah ada dalam ' +
          'pengawasan Hoshi — tidak ada yang bisa hilang. Batalkan kesepakatannya saja.',
        consignmentId: id,
      });
    }
    const from = c.status;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.consignment.updateMany({
        where: { id, status: from, custodyReleasedAt: null },
        data: {
          status: ConsignmentStatus.LOST,
          custodyReleasedAt: new Date(),
          releaseReason: 'LOST',
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException(
          'Status titipan berubah barusan; tidak ada yang ditulis.',
        );
      }
      if (c.listing) {
        await tx.listing.updateMany({
          where: {
            id: c.listing.id,
            consignmentId: id,
            status: ListingStatus.ACTIVE,
          },
          data: { status: ListingStatus.CANCELLED },
        });
        await tx.offer.updateMany({
          where: {
            listingId: c.listing.id,
            status: { in: [OfferStatus.PENDING, OfferStatus.ACCEPTED] },
          },
          data: { status: OfferStatus.REJECTED },
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'LOST',
        fromStatus: from,
        toStatus: ConsignmentStatus.LOST,
        actor: admin,
        note: dto.note.trim(),
      });
    });
    this.logger.error(
      `TITIPAN HILANG/RUSAK: ${id} ("${c.cardName}", pemilik ${c.consignorId}) ditandai LOST ` +
        `oleh admin ${admin.id}. Listing (kalau ada) sudah diturunkan. Ganti rugi = keputusan ` +
        'manusia: POST /admin/consignments/:id/compensate.',
    );
    return this.byId(id);
  }

  /**
   * Ganti rugi ke pemilik kartu, lewat ledger saldo yang SUDAH ADA — bukan buku besar kedua.
   * IDEMPOTEN lewat unique `(reason, refId)` pada `BalanceEntry`, dengan `refId = consignment.id`:
   * klik dua kali tidak bisa membayar dua kali.
   */
  async compensate(id: string, dto: CompensateConsignmentDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    if (c.status !== ConsignmentStatus.LOST) {
      throw new BadRequestException(
        `Ganti rugi hanya untuk titipan berstatus LOST; titipan ini ${c.status}.`,
      );
    }
    const { credited } = await this.balance.credit({
      userId: c.consignorId,
      amountIdrx: dto.amountIdr,
      reason: CONSIGNMENT_COMPENSATION_REASON,
      refId: id,
    });
    await this.writeEvent(this.prisma, {
      consignmentId: id,
      kind: 'CORRECTION',
      actor: admin,
      note:
        `Ganti rugi Rp ${dto.amountIdr} ${credited ? 'dikreditkan' : '(SUDAH pernah dikreditkan — tidak dobel)'}. ` +
        dto.note.trim(),
    });
    return { credited, ...(await this.byId(id)) };
  }

  /* ══════════════════════════════ 6. BUKTI & KOREKSI ══════════════════════════════ */

  /** Tambah foto bukti. APPEND-ONLY — tidak ada rute update/delete untuk baris foto. */
  async addPhotos(id: string, dto: AddConsignmentPhotosDto, admin: AuthUser) {
    await this.requireConsignment(id);
    await this.prisma.$transaction(async (tx) => {
      await this.writePhotos(tx, id, dto.photos, admin);
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'PHOTO',
        actor: admin,
        note: `${dto.photos.length} foto ditambahkan (${dto.photos
          .map((p) => p.kind)
          .join(', ')}).`,
      });
    });
    return this.byId(id);
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ KOREKSI TERLIHAT SEBAGAI KOREKSI. Catatan intake adalah BUKTI.                         ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Tidak ada rute yang menimpa `conditionNote`, foto, atau kolom identitas kartu. Sebuah catatan
   * kondisi yang bisa diubah diam-diam SESUDAH sengketa dimulai TIDAK ADA HARGANYA sebagai bukti —
   * bagi kedua pihak. Jadi koreksi ditulis sebagai baris audit BARU, dan riwayatnya utuh.
   */
  async addCorrection(id: string, dto: CorrectConsignmentDto, admin: AuthUser) {
    await this.requireConsignment(id);
    await this.writeEvent(this.prisma, {
      consignmentId: id,
      kind: 'CORRECTION',
      actor: admin,
      note: dto.note.trim(),
    });
    return this.byId(id);
  }

  /* ══════════════════════════════ 7. PEMBACAAN ══════════════════════════════ */

  /** Satu titipan, lengkap dengan bukti dan riwayatnya. */
  async byId(id: string) {
    const row = await this.prisma.consignment.findUnique({
      where: { id },
      include: {
        photos: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        listing: true,
        consignor: {
          select: { id: true, displayName: true, walletAddress: true },
        },
        receivedBy: {
          select: { id: true, displayName: true, walletAddress: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Titipan tidak ditemukan.');
    return { ...row, inCustody: isInHoshiCustody(row) };
  }

  /** Titipan milik user login. Rute PEMILIK — ia berhak melihat buktinya sendiri. */
  async listMine(userId: string) {
    const rows = await this.prisma.consignment.findMany({
      where: { consignorId: userId },
      include: {
        photos: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        listing: {
          select: { id: true, status: true, priceIdrx: true, image: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, inCustody: isInHoshiCustody(r) }));
  }

  /**
   * Dashboard admin. `actionRequired` adalah intinya: pola "surface it or it's invisible" yang
   * sama dengan `listUnsellableStock`. Barang orang lain yang tergeletak tanpa ada yang melihat
   * adalah cara paling umum sebuah janji custody diingkari tanpa siapa pun berniat begitu.
   */
  async adminList(status?: ConsignmentStatus) {
    const rows = await this.prisma.consignment.findMany({
      where: status ? { status } : {},
      include: {
        photos: { select: { id: true, kind: true, url: true } },
        listing: { select: { id: true, status: true, priceIdrx: true } },
        consignor: {
          select: { id: true, displayName: true, walletAddress: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const staleBefore = new Date(
      Date.now() - STALE_INTAKE_DAYS * 24 * 60 * 60 * 1000,
    );
    const actionRequired = rows
      .map((r) => {
        const reasons: string[] = [];
        // Disepakati tapi kartunya tidak pernah diserahkan.
        if (
          r.status === ConsignmentStatus.INTAKE &&
          r.createdAt < staleBefore
        ) {
          reasons.push(
            `INTAKE sudah lebih dari ${STALE_INTAKE_DAYS} hari tanpa serah-terima.`,
          );
        }
        // Pemilik sudah minta kartunya kembali, tapi kartunya belum benar-benar diserahkan.
        if (r.withdrawRequestedAt != null && r.custodyReleasedAt == null) {
          reasons.push(
            'Pemilik minta kartunya kembali; serah-terima pengembaliannya BELUM dicatat.',
          );
        }
        // Sudah terjual, tapi pembeli belum meminta pengiriman — kartunya masih di rak kita.
        if (
          r.status === ConsignmentStatus.SOLD &&
          r.custodyReleasedAt == null
        ) {
          reasons.push(
            'Sudah TERJUAL tapi kartunya masih di rak Hoshi (pembeli belum minta kirim).',
          );
        }
        return reasons.length > 0
          ? { id: r.id, cardName: r.cardName, reasons }
          : null;
      })
      .filter(
        (v): v is { id: string; cardName: string; reasons: string[] } =>
          v != null,
      );

    return {
      total: rows.length,
      rows: rows.map((r) => ({ ...r, inCustody: isInHoshiCustody(r) })),
      actionRequired,
    };
  }

  /* ══════════════════════════════ internal ══════════════════════════════ */

  private async requireConsignment(id: string) {
    const row = await this.prisma.consignment.findUnique({
      where: { id },
      include: { photos: true, listing: true },
    });
    if (!row) throw new NotFoundException('Titipan tidak ditemukan.');
    return row;
  }

  private async writePhotos(
    tx: Prisma.TransactionClient,
    consignmentId: string,
    photos: ConsignmentPhotoInput[] | undefined,
    admin: AuthUser,
  ): Promise<void> {
    if (!photos || photos.length === 0) return;
    await tx.consignmentPhoto.createMany({
      data: photos.map((p) => ({
        consignmentId,
        url: p.url,
        kind: p.kind,
        note: p.note ?? null,
        addedBy: admin.id,
      })),
    });
  }

  /**
   * SETIAP perubahan keadaan menulis SATU baris di sini: siapa, kapan, apa. Append-only.
   * Menerima `PrismaService` maupun `TransactionClient` supaya baris audit selalu bisa ditulis
   * di transaksi yang SAMA dengan perubahannya — audit yang bisa gagal terpisah dari perubahan
   * yang diauditnya bukan audit.
   */
  private async writeEvent(
    client: Prisma.TransactionClient | PrismaService,
    args: {
      consignmentId: string;
      kind: string;
      fromStatus?: ConsignmentStatus;
      toStatus?: ConsignmentStatus;
      actor: AuthUser | null;
      note?: string;
    },
  ): Promise<void> {
    await client.consignmentEvent.create({
      data: {
        consignmentId: args.consignmentId,
        kind: args.kind,
        fromStatus: args.fromStatus ?? null,
        toStatus: args.toStatus ?? null,
        actorId: args.actor?.id ?? null,
        actorLabel: args.actor
          ? args.actor.displayName?.trim() ||
            shortWallet(args.actor.walletAddress)
          : null,
        note: args.note?.trim() || null,
      },
    });
  }
}
