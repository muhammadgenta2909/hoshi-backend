import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ActivityType,
  ConsignmentPhotoKind,
  ConsignmentStatus,
  type Grader,
  ListingStatus,
  OfferStatus,
  PaymentStatus,
  Prisma,
  RedemptionStatus,
} from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { BalanceService } from '../balance/balance.service';
import {
  CONSIGNMENT_ERROR_CODE,
  consignmentError,
} from '../common/consignment.errors';
import {
  CONSIGNMENT_COMPENSATION_REASON,
  CONSIGNMENT_RETURN_METHOD,
  CONSIGNMENT_RETURN_PAYER,
  CONSIGNMENT_SALE_REASON,
  acceptCustodyClaimWhere,
  awaitingConsignorWhere,
  claimCodeRedeemWhere,
  isAwaitingConsignorClaim,
  isConsignmentSoldToBuyer,
  isConsignorLinked,
  isInHoshiCustody,
  isPhysicallyHeldByHoshi,
  isReturnAddressComplete,
  isReturnPlanReady,
  linkConsignorClaimWhere,
  listClaimWhere,
  liveConsignmentWhere,
  missingReturnAddressFields,
  requireLinkedConsignorId,
  takeDownClaimWhere,
  withdrawnReleaseClaimWhere,
  type ConsignmentReturnFacts,
} from '../common/consignment.gate';
import {
  isIndonesianDestination,
  resolveDomesticShippingIdr,
  type DomesticShippingQuote,
} from '../payments/domestic-shipping-rate';
import {
  chargeablePriceRangeSentence,
  isChargeablePrice,
} from '../payments/idrx-mint-bounds';
import {
  CLAIM_CODE_TTL_DAYS,
  claimCodeExpiryFrom,
  formatClaimCode,
  generateClaimCode,
  hashClaimCode,
  normalizeClaimCode,
} from '../common/consignment-claim-code';
import { shortWallet } from '../marketplace/marketplace.serialize';
import { PrismaService } from '../prisma/prisma.service';
import { ConsignmentNotifyService } from './consignment-notify.service';
import type {
  AcceptCustodyDto,
  AddConsignmentPhotosDto,
  ClaimConsignmentDto,
  CompensateConsignmentDto,
  ConsignmentPhotoInput,
  ConsignmentReturnPlanDto,
  CorrectConsignmentDto,
  CorrectConsignmentLabelDto,
  CreateConsignmentDto,
  CreateConsignmentListingDto,
  IssueClaimCodeDto,
  LinkConsignorDto,
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

/** Satu kolom LABEL yang dikoreksi: apa, dari apa, jadi apa. Lihat `correctLabel`. */
export interface LabelChange {
  field:
    | 'cardName'
    | 'cardSet'
    | 'cardNumber'
    | 'certNumber'
    | 'grader'
    | 'gradeLabel'
    | 'gradeScore';
  before: string | number | null;
  after: string | number | null;
}

/**
 * String kosong berarti KOSONGKAN kolomnya, bukan "simpan string kosong".
 *
 * Dibutuhkan karena koreksi yang benar kadang BERARTI menghapus: nomor sertifikat yang diketik
 * untuk kartu yang ternyata mentah, atau `gradeLabel` yang diisi padahal kartunya belum di-grade.
 * Tanpa ini, satu-satunya "perbaikan" adalah menuliskan nilai palsu lain.
 */
function blankToNull(v: string): string | null {
  const t = v.trim();
  return t.length === 0 ? null : t;
}

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ NOMOR SERTIFIKAT TANPA GRADER MEMATIKAN PENJAGA DOBEL-TITIP — DIAM-DIAM.                    ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Kunci anti-dobel-titip adalah PASANGAN: partial unique index `consignments_active_cert_uniq`
 * berbunyi `UNIQUE(grader, certNumber)` atas custody yang masih hidup. Postgres memperlakukan NULL
 * sebagai TIDAK SAMA DENGAN APA PUN — termasuk dengan NULL lain — jadi dua baris
 * `(NULL, '12345678')` TIDAK bentrok di index itu. Pra-ceknya pun dulu disyaratkan
 * `certNumber && dto.grader`, sehingga ia melewatkan keadaan yang sama tanpa sepatah kata.
 *
 * Akibatnya: SATU slab fisik bisa punya DUA titipan hidup sekaligus — persis yang index itu
 * dibangun untuk mencegah — dan tidak ada satu pun lapis yang berbunyi. Bentuk barisnya sendiri
 * juga tidak masuk akal: sebuah nomor sertifikat ADALAH nomor yang diterbitkan SEORANG grader, dan
 * "nomor sertifikat dari grader yang tidak diketahui" bukan identitas, cuma angka.
 *
 * Maka kombinasinya DITOLAK di kedua pintu yang bisa melahirkannya (`createIntake` dan
 * `correctLabel`), dengan SATU kalimat yang menyebut KEDUA field — supaya operator yang membacanya
 * tahu bahwa yang kurang bisa jadi dropdown Grader-nya, bukan nomornya.
 */
const CERT_WITHOUT_GRADER_MESSAGE =
  'Nomor sertifikat terisi tapi GRADER kosong. Keduanya satu paket: kunci anti-dobel-titip ' +
  'adalah pasangan (grader, certNumber), dan di Postgres grader NULL membuat kunci itu TIDAK ' +
  'PERNAH bentrok — satu slab fisik bisa punya dua titipan hidup sekaligus tanpa ada yang ' +
  'berbunyi. Pilih grader-nya (PSA/CGC/BGS) sesuai yang tertera di slab, ATAU kosongkan nomor ' +
  'sertifikatnya kalau kartunya memang MENTAH.';

/** "cardName: \"Charizad VMAX\" → \"Charizard VMAX\"" — untuk baris audit dan log. */
function describeChange(ch: LabelChange): string {
  const fmt = (v: string | number | null) =>
    v == null ? '(kosong)' : typeof v === 'number' ? String(v) : `"${v}"`;
  return `${ch.field}: ${fmt(ch.before)} → ${fmt(ch.after)}`;
}

/**
 * Berapa lama sebuah titipan boleh ada di rak TANPA pemilik tertaut sebelum dashboard
 * menandainya. Lebih pendek dari `STALE_INTAKE_DAYS` DENGAN SENGAJA: intake yang menggantung
 * berarti kartunya masih di tangan pemiliknya, sedangkan ini berarti kartunya ADA DI RAK KITA
 * dan kita belum tahu siapa yang harus dibayar kalau ia terjual. Yang kedua jauh lebih mendesak.
 */
const UNLINKED_CUSTODY_DAYS = 7;

/**
 * Batas panjang kolom `PaymentOrder.error`, SAMA PERSIS dengan `ERROR_MAX` di payments dan
 * `DEBT_ERROR_MAX` di shipping-refund-debt.ts. Utang yang kalimatnya terpotong di tengah tetap
 * utang; yang tidak boleh adalah tulisannya GAGAL karena kepanjangan.
 */
const BUYER_DEBT_ERROR_MAX = 500;

/**
 * Laporan pembukuan utang ke PEMBELI kartu titipan yang hilang sesudah terjual. Bentuknya
 * mengikuti `ShippingRefundDebt` (src/payments/shipping-refund-debt.ts): setiap baris menyebut
 * apa yang DILIHAT, apa yang DIUBAH, dan KALIMAT AKSI untuk operator — termasuk ketika tidak ada
 * apa pun yang bisa diubah, karena uang yang lolos dari mata adalah seluruh masalahnya.
 */
export interface ConsignmentBuyerRefundDebt {
  merchantOrderId: string | null;
  priceIdr: number | null;
  /** Status order pembeli sebelum pembukuan ini jalan. null = ordernya tidak bisa dibaca. */
  statusBefore: PaymentStatus | null;
  statusAfter: PaymentStatus | null;
  /** true = panggilan INI yang menjadikannya REFUND_DUE. */
  recordedNow: boolean;
  /** Kalimat yang dilihat operator. SELALU terisi, juga saat tidak ada yang bisa ditulis. */
  operatorAction: string;
}

/** Panjang minimal kata kunci pencarian pemilik. Lihat `searchConsignors`. */
const CONSIGNOR_SEARCH_MIN_QUERY = 3;

/** Jumlah kandidat maksimum yang ditampilkan sekaligus. Lihat `searchConsignors`. */
const CONSIGNOR_SEARCH_LIMIT = 20;

/* ───────────────────────── LANTAI HARGA YANG DISEPAKATI PEMILIK ───────────────────────── */

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ `reservePriceIdr` — MEMPERINGATKAN, TIDAK PERNAH MENOLAK. Dan sebabnya penting.             ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Kolom ini dicatat saat serah-terima sebagai "harga TERENDAH yang pemilik mau terima" — dan
 * sampai sekarang TIDAK ADA satu baris kode pun yang membacanya. Angka yang diketik seseorang di
 * teras rumah orang lain, lalu tidak pernah dipakai, lebih buruk daripada tidak ditanyakan: ia
 * membuat pemiliknya percaya ada pagar yang sebenarnya tidak ada.
 *
 * TAPI IA TIDAK BOLEH JADI PENOLAKAN, dan itu keputusan produk, bukan kemalasan:
 *   • pasar bergerak, dan menurunkan harga sering justru DIMINTA pemiliknya lewat telepon —
 *     percakapan yang tidak dilihat sistem;
 *   • `updatePrice` SUDAH menuntut alasan tertulis yang tersimpan permanen, jadi penurunannya
 *     tidak pernah bisa terjadi diam-diam;
 *   • operator yang diblokir sambil berdiri di depan pemiliknya tidak punya jalan keluar selain
 *     mengubah angka reserve-nya — dan pagar yang bisa dilangkahi dengan mengubah pagarnya
 *     sendiri bukan pagar, cuma gesekan yang mengajari orang mengabaikannya.
 *
 * Jadi: peringatan di respons rute (supaya layar bisa menanyakannya SEBELUM tombol ditekan),
 * kalimat yang sama DISIMPAN di baris audit (supaya "kami tahu ini di bawah reserve dan tetap
 * melakukannya" punya bukti tertulis), dan satu baris `actionRequired` selama listing-nya MASIH
 * tayang di bawah lantai itu.
 */
function belowReserveWarning(
  reservePriceIdr: number | null | undefined,
  priceIdr: number,
): string | null {
  if (reservePriceIdr == null || priceIdr >= reservePriceIdr) return null;
  return (
    `DI BAWAH HARGA TERENDAH YANG DISEPAKATI: Rp ${priceIdr} < reserve Rp ${reservePriceIdr}. ` +
    'Perubahan TETAP dilakukan — ini peringatan, bukan penolakan — tetapi angka reserve adalah ' +
    'bagian dari perjanjian bertanda tangan, jadi pastikan pemiliknya memang menyetujuinya.'
  );
}

/**
 * LEWAT MANA pemilik tertaut ke catatan titipannya. Disimpan di `consignorLinkMethod`, dan itu
 * bukan hiasan: kalau suatu hari ada sengketa tentang SIAPA pemilik sebuah kartu, jawabannya
 * berbeda kekuatannya tergantung jalannya — akun yang dipilih operator dari daftar (`SEARCH`
 * / `AT_INTAKE` / `ADMIN_LINK`) bersandar pada penilaian manusia saat itu, sedangkan
 * `CLAIM_CODE` bersandar pada kertas yang berpindah tangan bersama kartunya.
 */
const CONSIGNOR_LINK_METHOD = {
  /** Pemiliknya sudah punya akun dan dipilih operator saat serah-terima (Path A). */
  AT_INTAKE: 'AT_INTAKE',
  /** Pemiliknya menukarkan kode klaim di tanda terimanya (Path B). */
  CLAIM_CODE: 'CLAIM_CODE',
  /** Admin menautkan belakangan setelah memeriksa identitas secara langsung. */
  ADMIN_LINK: 'ADMIN_LINK',
} as const;

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
    // Pemberitahuan ke PEMILIK KARTU. Setiap method-nya `void` dan menelan errornya sendiri —
    // email TIDAK PERNAH boleh menggagalkan jalur custody maupun jalur uang. Lihat
    // `consignment-notify.service.ts`.
    private readonly notify: ConsignmentNotifyService,
    // HANYA untuk membaca `HOSHI_DOMESTIC_SHIPPING_FLAT_IDR` saat MENAKSIR ongkir balik —
    // lapis 5 dari resolusi tarif yang sudah ada (`resolveDomesticShippingIdr`). Tidak ada
    // keputusan lain di file ini yang bergantung pada env: gerbang custody membaca FAKTA
    // TERSIMPAN, tidak pernah flag.
    private readonly config: ConfigService,
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
    // ── SIAPA PEMILIKNYA: DUA JALAN, dan yang pertama sengaja dibuat yang paling mudah ───────
    //
    // PATH A — `consignorId` diberikan. Pemiliknya masuk akun SAAT serah-terima (momen terkuat
    // yang ada untuk mengikat identitas: kedua orangnya berdiri di tempat yang sama). Operator
    // menemukannya lewat `GET /admin/consignments/consignor-search`, yang MENGEMBALIKAN DAFTAR
    // dan tidak pernah mencocokkan sendiri; yang menulis tautan tetap satu-satunya nilai yang
    // tidak ambigu, yaitu id.
    //
    // PATH B — `consignorId` TIDAK diberikan. Pemiliknya belum punya akun, atau tidak mau membuat
    // satu sambil berdiri di teras rumahnya. Baris ini lahir TANPA pemilik, dan tanda terima yang
    // ia bawa pulang memuat KODE KLAIM sekali pakai. Kartunya tetap tercatat, tetap dipotret,
    // tetap bisa diminta kembali — hanya saja ia TIDAK BISA DIPAJANG sampai pemiliknya tertaut.
    //
    // YANG TIDAK PERNAH DITERIMA RUTE INI: email. `User.email` tidak unik dan tidak pernah
    // diverifikasi, jadi menautkan kartu senilai puluhan juta ke siapa pun yang MENGAKU memiliki
    // sebuah alamat adalah kelas bug terburuk yang bisa dipunyai fitur ini. Tidak ada field
    // "consignorEmail" di DTO, dan tidak boleh ditambahkan.
    let consignor: {
      id: string;
      walletAddress: string;
      displayName: string | null;
    } | null = null;
    if (dto.consignorId) {
      consignor = await this.prisma.user.findUnique({
        where: { id: dto.consignorId },
        select: { id: true, walletAddress: true, displayName: true },
      });
      if (!consignor) {
        throw new NotFoundException(
          'Akun pemilik kartu (consignorId) tidak ditemukan. Kalau pemiliknya memang belum punya ' +
            'akun Hoshi, JANGAN mengarang id: catat titipannya TANPA consignorId, dan tanda ' +
            'terimanya akan memuat kode klaim yang bisa ia tukarkan nanti.',
        );
      }
    }

    // ANTI-DOBEL-TITIP untuk slab bernomor sertifikat. Dicek di sini supaya pesannya bisa
    // menjelaskan; yang BENAR-BENAR menegakkannya adalah partial unique index
    // `consignments_active_cert_uniq` (migration 20260922000000) — pemeriksaan ini bisa basi
    // karena balapan, index-nya tidak.
    // Dinormalisasi SEBELUM dipakai: cek bentrok dan penyimpanan harus memakai nilai yang SAMA
    // PERSIS. Sebelumnya cek dan simpan sama-sama memakai dto mentah, jadi '12345' dan '12345 '
    // lolos sebagai dua titipan hidup untuk SATU kartu fisik — index unik parsialnya mencocokkan
    // string apa adanya. Butuh operator salah ketik di dua intake terpisah; murah untuk ditutup.
    /* ── HARGA YANG TIDAK BISA DITAGIHKAN DITOLAK DI SINI, DI DEPAN PEMILIK KARTU ────────────
       Batas IDRX berlaku pada nominal yang DITAGIHKAN — yaitu harga + fee QRIS ~0,7%. Tanpa
       pemeriksaan ini, harga Rp 15.000 (kartu graded murah, sangat mungkin) atau Rp 1,2 miliar
       (kartu kelas atas; batas DTO-nya sendiri 2 miliar, jadi memang dianggap mungkin) LOLOS
       intake, LOLOS "Pajang sekarang", tayang ACTIVE dengan tombol Beli yang menyala — dan baru
       gagal 400 saat ada pembeli sungguhan menekannya.

       Nol Rupiah hilang di situ, dan justru itu yang membuatnya berbahaya: TIDAK ADA SEORANG PUN
       yang tahu kartunya tidak bisa dibeli. Tidak operator, tidak pemiliknya. Kartu orang
       "dijual" berminggu-minggu tanpa satu pun peluang laku.

       Ditolak PALING AWAL karena di sinilah angkanya masih bisa dirundingkan: operator sedang
       duduk di depan pemilik kartu dan struknya belum ditandatangani. Pola yang sama sudah
       dipakai tarif ongkir admin — lihat kepala berkas payments/idrx-mint-bounds.ts. */
    if (!isChargeablePrice(dto.askPriceIdr)) {
      throw new BadRequestException(
        `Harga Rp ${dto.askPriceIdr.toLocaleString('id-ID')} tidak bisa ditagihkan. ` +
          chargeablePriceRangeSentence(),
      );
    }

    const certNumber = dto.certNumber?.trim() || null;
    // ── PENJAGA DOBEL-TITIP TIDAK BOLEH MATI DIAM-DIAM ──────────────────────────────────────
    // Lihat `CERT_WITHOUT_GRADER_MESSAGE`. Ditolak DI SINI, saat operator masih berdiri di depan
    // pemilik kartunya dan slab-nya masih ada di tangan: satu-satunya momen ketika "grader mana
    // yang tertera di label ini?" adalah pertanyaan yang bisa dijawab dalam dua detik.
    if (certNumber && !dto.grader) {
      throw new BadRequestException(CERT_WITHOUT_GRADER_MESSAGE);
    }
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

    // Kode klaim HANYA untuk Path B, dan diterbitkan OTOMATIS — bukan sebagai pilihan operator.
    // Titipan tanpa pemilik DAN tanpa kode adalah baris yang tidak punya jalan pulang sama sekali:
    // satu-satunya cara pemiliknya bisa mengambil alih catatannya adalah lewat admin, dan itu
    // berarti bergantung pada ingatan seseorang. Teks kodenya hidup HANYA di variabel ini dan di
    // body respons; yang masuk database hanya hash-nya.
    const now = new Date();
    const claimCode = consignor ? null : generateClaimCode();
    const claimCodeHash = claimCode ? hashClaimCode(claimCode) : null;

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.consignment.create({
        data: {
          consignorId: consignor?.id ?? null,
          ...(consignor
            ? {
                consignorLinkedAt: now,
                consignorLinkMethod: CONSIGNOR_LINK_METHOD.AT_INTAKE,
              }
            : {
                claimCodeHash,
                claimCodeIssuedAt: now,
                claimCodeExpiresAt: claimCodeExpiryFrom(now),
              }),
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
        // Baris audit menyebut KEBERADAAN kode, tidak pernah kodenya. Jejak audit adalah tempat
        // paling sering dibaca ulang di fitur ini; rahasia tidak ditaruh di sana.
        note:
          `Kesepakatan dicatat di ${created.receivedAtPlace}. Kartu BELUM diterima. ` +
          (consignor
            ? `Pemilik tertaut ke akun ${consignor.id} sejak serah-terima.`
            : 'Pemilik BELUM punya akun Hoshi; kode klaim diterbitkan di tanda terima (berlaku ' +
              `${CLAIM_CODE_TTL_DAYS} hari). Kartu ini TIDAK BISA dipajang sampai kodenya ` +
              'ditukarkan.'),
      });
      return created;
    });

    this.logger.log(
      `Titipan ${row.id} dicatat (INTAKE) oleh admin ${admin.id}: "${row.cardName}" milik ` +
        `${consignor ? consignor.id : `"${row.consignorNameAtIntake}" (BELUM tertaut akun)`}, ` +
        `ask Rp ${row.askPriceIdr}, komisi ${row.commissionBps} bps. ` +
        'Belum boleh dipajang — custody belum diterima.',
    );

    // TEKS KODENYA DIKEMBALIKAN TEPAT SEKALI, DI SINI. Tidak ada rute yang bisa membacanya lagi
    // dan tidak ada log yang memuatnya. Kalau kertasnya hilang, jalannya adalah PENERBITAN ULANG
    // (POST /admin/consignments/:id/claim-code) — yang mematikan kode lama.
    return {
      ...(await this.byId(row.id)),
      ...(claimCode
        ? {
            claimCode: formatClaimCode(claimCode),
            claimCodeExpiresInDays: CLAIM_CODE_TTL_DAYS,
            claimCodeNote:
              'CETAK KODE INI DI TANDA TERIMA DAN SERAHKAN BERSAMA KARTUNYA. Kode ditampilkan ' +
              'SEKALI dan tidak bisa dilihat lagi; kalau hilang, terbitkan ulang.',
          }
        : {}),
    };
  }

  /* ═══════════════════ 1b. MENEMUKAN PEMILIKNYA (PATH A) ═══════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ PENCARIAN PEMILIK — MENGEMBALIKAN DAFTAR, TIDAK PERNAH MENCOCOKKAN.                    ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Operator berdiri di rumah orang, dan yang ia punya hanya apa yang bisa dilihat di layar
   * ponsel pemilik kartunya: nama tampilan, alamat wallet, kadang email. Ia TIDAK punya id
   * database, dan tidak ada yang bisa mengetiknya di sana.
   *
   * KENAPA RUTE INI TIDAK PERNAH MENJAWAB "ini orangnya". Di schema ini hanya `walletAddress`
   * yang `@unique`. `displayName` boleh sama persis untuk sepuluh orang, dan `email` BUKAN HANYA
   * tidak unik — ia TIDAK PERNAH DIVERIFIKASI: siapa pun bisa mengetik alamat orang lain di
   * setelan profilnya sendiri. Jadi kecocokan atas kedua kolom itu adalah PETUNJUK, bukan
   * identitas. Rute yang memilihkan satu dari beberapa kandidat akan, cepat atau lambat,
   * menautkan kartu senilai puluhan juta Rupiah ke orang yang salah — dan akan melakukannya
   * diam-diam.
   *
   * MAKA BENTUK KONTRAKNYA:
   *   - hasilnya SELALU array, bahkan ketika panjangnya satu;
   *   - `ambiguous` true jika kandidatnya lebih dari satu, dan frontend WAJIB memaksa memilih;
   *   - `exactWalletMatch` menandai kandidat yang cocok PERSIS pada satu-satunya kolom unik,
   *     supaya operator tahu mana yang identitas dan mana yang cuma kemiripan;
   *   - `matchedOn` menyebut KOLOM MANA yang cocok, supaya "cocok karena emailnya" tidak pernah
   *     terbaca sebagai "terbukti orangnya";
   *   - `truncated` true berarti ada kandidat yang TIDAK ditampilkan; operator harus mempersempit
   *     dan tidak boleh memilih dari daftar yang ia tahu tidak lengkap.
   *
   * Rute ini TIDAK MENULIS APA PUN. Penautan terjadi di `createIntake` dan `linkConsignor`, dan
   * keduanya hanya menerima `consignorId` — satu-satunya nilai yang tidak ambigu.
   */
  async searchConsignors(rawQuery: string) {
    const q = (rawQuery ?? '').trim();
    // Ambang minimum: di bawah itu setiap kueri mengembalikan separuh tabel user, dan daftar yang
    // terlalu panjang untuk dibaca adalah daftar yang akan dipilih asal-asalan.
    if (q.length < CONSIGNOR_SEARCH_MIN_QUERY) {
      throw new BadRequestException(
        `Kata kunci pencarian minimal ${CONSIGNOR_SEARCH_MIN_QUERY} karakter. Pakai alamat ` +
          'wallet (satu-satunya yang unik), nama tampilan, atau email — lalu PILIH orangnya ' +
          'sendiri dari daftar.',
      );
    }

    const where = {
      OR: [
        { walletAddress: { contains: q, mode: 'insensitive' as const } },
        { displayName: { contains: q, mode: 'insensitive' as const } },
        { email: { contains: q, mode: 'insensitive' as const } },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        take: CONSIGNOR_SEARCH_LIMIT,
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          walletAddress: true,
          displayName: true,
          email: true,
          createdAt: true,
          _count: { select: { consignmentsConsigned: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    const qLower = q.toLowerCase();
    const matches = rows.map((u) => ({
      id: u.id,
      // Alamat wallet UTUH, bukan bentuk pendek: operator sedang MEMBANDINGKAN dengan layar orang
      // lain, dan `Abc1...Xyz9` membuat dua alamat yang berbeda tampak sama persis.
      walletAddress: u.walletAddress,
      displayName: u.displayName,
      email: u.email,
      createdAt: u.createdAt,
      consignmentCount: u._count.consignmentsConsigned,
      /** Cocok PERSIS pada satu-satunya kolom unik. Ini identitas; sisanya kemiripan. */
      exactWalletMatch: u.walletAddress.toLowerCase() === qLower,
      matchedOn: [
        u.walletAddress.toLowerCase().includes(qLower) ? 'walletAddress' : null,
        u.displayName?.toLowerCase().includes(qLower) ? 'displayName' : null,
        u.email?.toLowerCase().includes(qLower) ? 'email' : null,
      ].filter((v): v is string => v != null),
    }));

    return {
      query: q,
      total,
      /** true berarti ada kandidat yang tidak ditampilkan — persempit dulu, jangan pilih. */
      truncated: total > matches.length,
      /** >1 kandidat berarti operator WAJIB memilih. Tidak ada auto-pilih di sisi mana pun. */
      ambiguous: total > 1,
      matches,
      /**
       * Dibaca apa adanya oleh UI. Sengaja MENYEBUTKAN bahwa email tidak diverifikasi: operator
       * yang tidak tahu itu akan memperlakukan kecocokan email sebagai bukti.
       */
      advice:
        'Hanya alamat wallet yang unik di Hoshi. Nama tampilan bisa sama persis untuk beberapa ' +
        'orang, dan email TIDAK PERNAH diverifikasi — siapa pun bisa mengetik alamat orang lain ' +
        'di setelan profilnya. Cocokkan alamat wallet di layar pemilik kartunya sebelum memilih. ' +
        'Kalau ragu, JANGAN menebak: catat titipannya tanpa consignorId dan serahkan kode klaim ' +
        'bersama kartunya.',
    };
  }

  /* ═══════════════ 1c. KODE KLAIM & PENAUTAN PEMILIK (PATH B) ═══════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ SATU PENOLAKAN UNTUK SEMUA SEBAB. Rute penukaran TIDAK BOLEH jadi oracle.              ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Bentuk kode salah, kode tidak ada, kode kedaluwarsa, kode sudah dipakai, kode sudah
   * diterbitkan ulang, titipannya CANCELLED — SEMUANYA menghasilkan objek yang SAMA PERSIS.
   *
   * Kalau "tidak ditemukan" dan "kedaluwarsa" dibedakan, penebak mendapat konfirmasi bahwa
   * tebakannya MENGENAI SESUATU — dan itulah satu-satunya hal yang membuat menebak ada gunanya.
   * Kalau "sudah dipakai" dibedakan, penebak bisa memetakan kode mana yang pernah hidup.
   *
   * 404 (bukan 400/409) supaya jawabannya juga tidak membedakan "bentuknya salah" dari "tidak
   * ada": dua-duanya berarti tidak ada apa pun untuk dibuka.
   */
  private claimCodeInvalid() {
    return consignmentError({
      status: HttpStatus.NOT_FOUND,
      code: CONSIGNMENT_ERROR_CODE.CLAIM_CODE_INVALID,
      message:
        'Kode klaim ini tidak berlaku. Periksa lagi kode pada tanda terima Anda (huruf besar/' +
        'kecil dan tanda hubung tidak berpengaruh). Kode hanya bisa dipakai SEKALI dan berlaku ' +
        `${CLAIM_CODE_TTL_DAYS} hari sejak diterbitkan — kalau sudah lewat atau kertasnya ` +
        'hilang, hubungi Hoshi untuk penerbitan ulang.',
    });
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ TUKARKAN KODE KLAIM. Rute PEMILIK KARTU — inilah Path B yang menutup lingkarannya.     ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Yang membuat kode ini sah sebagai bukti kepemilikan BUKAN kerahasiaan saluran — tidak ada
   * saluran, ia dicetak di kertas. Yang membuatnya sah adalah SERAH-TERIMA FISIK yang sudah
   * terjadi: kode itu berpindah tangan pada detik yang sama dengan kartunya, di tanda terima
   * bertanda tangan yang sudah difoto. Siapa pun yang memegangnya ADALAH orang yang menyerahkan
   * kartunya.
   *
   * PENAUTANNYA KLAIM ATOMIK, dan bentuk itu melakukan pekerjaan nyata di sini: predikatnya
   * menyebut `consignorId: null`, jadi dua penukaran serentak tidak mungkin dua-duanya menang,
   * dan titipan yang SUDAH punya pemilik tidak bisa direbut oleh siapa pun. `count !== 1` bukan
   * error melainkan JAWABAN — dan jawabannya sama dengan semua penolakan lain (lihat
   * `claimCodeInvalid`).
   *
   * Penukaran yang berhasil MENGOSONGKAN `claimCodeHash` di transaksi yang sama: sesudah itu kode
   * tersebut tidak cocok dengan apa pun di tabel. "Sekali pakai" jadi bentuk baris, bukan janji.
   *
   * REM LEDAKAN ada di controller (`@Throttle` 5/menit/IP). Yang sebenarnya membuat menebak sia-sia
   * adalah 50 bit entropi kodenya — lihat `consignment-claim-code.ts`.
   */
  async claimByCode(dto: ClaimConsignmentDto, user: AuthUser) {
    const normalized = normalizeClaimCode(dto.code);
    // Bentuk yang mustahil dijawab PERSIS SAMA dengan kode yang tidak ada. Tidak ada jalan untuk
    // menyimpulkan "panjangnya benar tapi kodenya salah".
    if (!normalized) throw this.claimCodeInvalid();

    const hash = hashClaimCode(normalized);
    const now = new Date();

    const claimedId = await this.prisma.$transaction(async (tx) => {
      // `claimCodeHash` @unique → satu index lookup, dan satu kode tidak pernah bisa menunjuk dua
      // titipan. Pembacaan ini HANYA untuk mendapatkan id demi baris audit; gerbangnya ada di
      // `updateMany` di bawah, yang predikatnya tetap menyebut hash-nya.
      const found = await tx.consignment.findUnique({
        where: { claimCodeHash: hash },
        select: { id: true, cardName: true },
      });
      if (!found) return null;

      const claimed = await tx.consignment.updateMany({
        where: claimCodeRedeemWhere(hash, now),
        data: {
          consignorId: user.id,
          consignorLinkedAt: now,
          consignorLinkMethod: CONSIGNOR_LINK_METHOD.CLAIM_CODE,
          // SEKALI PAKAI, sebagai bentuk baris. Kedua kolom dikosongkan bersama-sama supaya tidak
          // ada baris yang punya tanggal kedaluwarsa untuk kode yang sudah tidak ada.
          claimCodeHash: null,
          claimCodeExpiresAt: null,
        },
      });
      // Kalah balapan, kedaluwarsa, sudah bertuan, atau CANCELLED — satu jawaban untuk semuanya.
      if (claimed.count !== 1) return null;

      await this.writeEvent(tx, {
        consignmentId: found.id,
        kind: 'CLAIM_CODE_REDEEMED',
        actor: user,
        // TIDAK PERNAH memuat kodenya. Baris audit adalah tempat yang paling sering dibaca ulang.
        note:
          `Kode klaim ditukarkan. Titipan ini sekarang tertaut ke akun ${user.id}. Mulai saat ` +
          'ini pemiliknya bisa melihat bukti serah-terimanya sendiri, meminta kartunya kembali, ' +
          'dan menerima hasil penjualannya.',
      });
      return found.id;
    });

    if (!claimedId) throw this.claimCodeInvalid();

    this.logger.warn(
      `Titipan ${claimedId} DITAUTKAN ke akun ${user.id} lewat kode klaim. Sejak sekarang ia ` +
        'boleh dipajang (kalau custody-nya sudah tercatat) dan hasil penjualannya punya tujuan.',
    );
    return this.byId(claimedId);
  }

  /**
   * TERBITKAN / TERBITKAN ULANG kode klaim. ADMIN-ONLY.
   *
   * JAWABAN UNTUK "KERTASNYA HILANG". Kode klaim tidak bisa dibaca kembali oleh siapa pun —
   * database hanya menyimpan hash-nya — jadi satu-satunya pemulihan adalah menerbitkan yang BARU.
   * Penerbitan ulang MENIMPA hash yang lama dalam satu tulisan, jadi kertas lama langsung mati;
   * tidak pernah ada dua kode hidup untuk satu titipan.
   *
   * KENAPA ADMIN, dan kenapa itu BUKAN kelemahan: yang bisa menerbitkan ulang adalah orang yang
   * memegang kartunya. Ia sudah bisa mengembalikan kartu itu ke siapa pun secara fisik; menerbitkan
   * secarik kertas baru tidak menambah kuasa apa pun yang belum ia punya. Yang ditambahkan adalah
   * JEJAKNYA: `note` WAJIB (min 10 karakter) dan tersimpan permanen sebagai baris audit, jadi
   * "kenapa kode ini diterbitkan ulang" selalu punya jawaban tertulis.
   *
   * DITOLAK kalau titipannya SUDAH punya pemilik: tidak ada yang perlu diklaim, dan menerbitkan
   * kode untuk kartu yang sudah bertuan hanya menciptakan kunci yang tidak membuka apa pun.
   */
  async issueClaimCode(id: string, dto: IssueClaimCodeDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    if (isConsignorLinked(c)) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          `Titipan ini sudah tertaut ke akun ${c.consignorId} — tidak ada yang perlu diklaim, ` +
          'jadi tidak ada kode yang diterbitkan. Kalau tautannya SALAH ORANG, itu bukan ' +
          'persoalan kode klaim: hentikan dulu (tarik listing-nya) dan selesaikan sebagai ' +
          'koreksi yang tercatat.',
        consignmentId: id,
      });
    }
    if (c.status === ConsignmentStatus.CANCELLED) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          'Kesepakatan ini sudah dibatalkan sebelum serah-terima; tidak ada kartu yang dipegang ' +
          'Hoshi dan tidak ada yang bisa diklaim.',
        consignmentId: id,
      });
    }

    // Tabrakan hash secara praktis mustahil (2^50 ruang per kode; @unique `claimCodeHash` adalah
    // penjaganya, dan P2002 terpetakan ke 409 oleh PrismaExceptionFilter). Tidak ada pra-cek di
    // sini dengan sengaja: pra-cek baca-lalu-tulis tetap bisa kalah balapan, jadi ia hanya akan
    // menjadi teater di depan index yang memang sudah menjamin.
    const code = generateClaimCode();
    const now = new Date();
    const expiresAt = claimCodeExpiryFrom(now);
    const reissue = c.claimCodeHash != null;

    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.consignment.updateMany({
        // Predikat yang SAMA dengan penautan: kalau pemiliknya tertaut barusan, klaim ini cocok
        // 0 baris dan tidak ada kode yang lahir untuk kartu yang sudah bertuan.
        where: linkConsignorClaimWhere(id),
        data: {
          claimCodeHash: hashClaimCode(code),
          claimCodeIssuedAt: now,
          claimCodeExpiresAt: expiresAt,
        },
      });
      if (claimed.count !== 1) {
        // Klaimnya membawa DUA syarat (`linkConsignorClaimWhere`), jadi kekalahannya punya dua
        // sebab dan operator berhak tahu keduanya: pemiliknya baru saja tertaut, ATAU
        // kesepakatannya baru saja dibatalkan. Yang kedua justru yang paling penting disebut —
        // kode untuk kesepakatan yang batal TIDAK AKAN PERNAH bisa ditukarkan, dan tanpa syarat
        // di dalam klaim, kertas itu sudah terlanjur dicetak dan diserahkan.
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Keadaan titipan ini berubah barusan — pemiliknya baru saja tertaut ke sebuah akun, ' +
            'atau kesepakatannya baru saja DIBATALKAN. Tidak ada kode yang diterbitkan, dan itu ' +
            'memang yang benar: kode untuk kesepakatan yang batal tidak akan pernah bisa ' +
            'ditukarkan. Muat ulang barisnya dan lihat statusnya sekarang.',
          consignmentId: id,
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'CLAIM_CODE_ISSUED',
        actor: admin,
        note:
          (reissue
            ? 'Kode klaim DITERBITKAN ULANG; kode sebelumnya MATI sejak detik ini. '
            : 'Kode klaim diterbitkan. ') +
          `Berlaku ${CLAIM_CODE_TTL_DAYS} hari. ${dto.note.trim()}`,
      });
    });

    this.logger.warn(
      `Kode klaim ${reissue ? 'DITERBITKAN ULANG' : 'diterbitkan'} untuk titipan ${id} ` +
        `("${c.cardName}") oleh admin ${admin.id}. Kode lama (kalau ada) sudah mati.`,
    );

    // Sekali lagi: teks kodenya ada TEPAT SEKALI, di sini.
    return {
      ...(await this.byId(id)),
      claimCode: formatClaimCode(code),
      claimCodeExpiresAt: expiresAt,
      claimCodeExpiresInDays: CLAIM_CODE_TTL_DAYS,
      reissued: reissue,
      claimCodeNote:
        'CETAK ULANG TANDA TERIMANYA DAN SERAHKAN KODE INI KE PEMILIK KARTU. Kode ditampilkan ' +
        'SEKALI; kode sebelumnya (kalau ada) sudah tidak berlaku.',
    };
  }

  /**
   * ADMIN MENAUTKAN AKUN PEMILIK ke titipan yang belum bertuan — Path A yang datang terlambat:
   * pemiliknya membuat akun di tempat, atau datang lagi ke kantor dan identitasnya diperiksa
   * langsung, atau kertasnya hilang dan ia lebih cepat ditolong begini daripada menunggu kode.
   *
   * `consignorId` SAJA yang diterima, dan itu disengaja. Tidak ada `consignorEmail`, tidak ada
   * `consignorName` — `User.email` tidak unik dan TIDAK PERNAH diverifikasi, jadi menerimanya di
   * sini berarti membiarkan kartu orang ditautkan ke siapa pun yang MENGAKU memiliki sebuah
   * alamat. Id-nya datang dari `GET /admin/consignments/consignor-search`, yang mengembalikan
   * DAFTAR dan memaksa operator memilih sendiri.
   *
   * `note` WAJIB: ia menjawab "bagaimana kamu tahu ini orangnya" secara tertulis dan permanen.
   */
  async linkConsignor(id: string, dto: LinkConsignorDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    if (isConsignorLinked(c)) {
      // Admin BOLEH tahu bahwa baris ini sudah bertuan dan siapa — ia sudah memegang kartunya,
      // dan menyembunyikannya hanya akan membuat ia mencoba lagi. (Bandingkan rute penukaran
      // kode, yang menghadap publik dan karena itu tidak membedakan sebab apa pun.)
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          `Titipan ini sudah tertaut ke akun ${c.consignorId}. Penautan TIDAK PERNAH menimpa ` +
          'pemilik yang sudah ada — kartu orang lain tidak boleh berpindah tangan karena satu ' +
          'panggilan yang salah ketik. Kalau tautannya memang salah, selesaikan sebagai koreksi ' +
          'yang tercatat, bukan dengan menimpanya diam-diam.',
        consignmentId: id,
      });
    }
    if (c.status === ConsignmentStatus.CANCELLED) {
      throw consignmentError({
        status: HttpStatus.CONFLICT,
        code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
        message:
          'Kesepakatan ini sudah dibatalkan sebelum serah-terima; tidak ada yang bisa ditautkan.',
        consignmentId: id,
      });
    }

    const target = await this.prisma.user.findUnique({
      where: { id: dto.consignorId },
      select: { id: true, walletAddress: true, displayName: true },
    });
    if (!target) {
      throw new NotFoundException(
        'Akun yang dituju tidak ditemukan. Cari dulu lewat ' +
          'GET /admin/consignments/consignor-search dan PILIH orangnya dari daftar — jangan ' +
          'mengetikkan id dari ingatan.',
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.consignment.updateMany({
        where: linkConsignorClaimWhere(id),
        data: {
          consignorId: target.id,
          consignorLinkedAt: now,
          consignorLinkMethod: CONSIGNOR_LINK_METHOD.ADMIN_LINK,
          // Kode klaim yang masih beredar ikut MATI: kartunya sudah bertuan, jadi kertas di saku
          // siapa pun tidak boleh lagi menunjuk ke baris ini.
          claimCodeHash: null,
          claimCodeExpiresAt: null,
        },
      });
      if (claimed.count !== 1) {
        // Dua sebab, dua-duanya berarti TIDAK ADA yang ditulis: pemiliknya baru saja tertaut
        // (mungkin ia menukarkan kode klaimnya pada detik yang sama), atau kesepakatannya baru
        // saja dibatalkan — dan menautkan pemilik ke kesepakatan yang batal tidak berarti apa pun.
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Keadaan titipan ini berubah barusan — pemiliknya baru saja tertaut ke sebuah akun ' +
            '(mungkin ia menukarkan kode klaimnya pada detik yang sama), atau kesepakatannya ' +
            'baru saja DIBATALKAN. Tidak ada yang ditimpa dan tidak ada yang ditautkan.',
          consignmentId: id,
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'CONSIGNOR_LINKED',
        actor: admin,
        note:
          `Pemilik ditautkan ke akun ${target.id} (${shortWallet(target.walletAddress)}) oleh ` +
          `admin. Snapshot saat serah-terima: "${c.consignorNameAtIntake}". Kode klaim yang ` +
          `masih beredar dimatikan. Dasar verifikasi: ${dto.note.trim()}`,
      });
    });

    this.logger.warn(
      `Titipan ${id} ("${c.cardName}") DITAUTKAN ke akun ${target.id} oleh admin ${admin.id}.`,
    );
    return this.byId(id);
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
    //
    // ┌──── KENAPA `HANDOVER` IKUT WAJIB, DAN KENAPA IA BUKAN SEKADAR FOTO KEEMPAT ───────────┐
    // │ FRONT/BACK/CERT membuktikan KEADAAN BARANGNYA. Tidak satu pun dari ketiganya           │
    // │ membuktikan ADA KESEPAKATAN — dan justru itu yang dipersoalkan kalau pemiliknya        │
    // │ ternyata sudah menjual kartu yang sama ke orang lain, atau kalau ia belakangan berkata │
    // │ tidak pernah menyetujui harga yang tertulis di layar kami. Foto slab yang bagus tidak  │
    // │ menjawab apa pun tentang itu; yang menjawabnya cuma selembar kertas bertanda tangan    │
    // │ DUA PIHAK, yang salinannya ADA DI TANGAN PEMILIKNYA (lihat                             │
    // │ `components/admin/HandoverReceipt.tsx` — struk dua lembar, identik, satu untuk         │
    // │ masing-masing pihak).                                                                 │
    // │                                                                                       │
    // │ `HANDOVER` = foto struk itu SESUDAH ditandatangani. Kalau operator tidak bisa          │
    // │ memotretnya, artinya strukya memang belum ditandatangani — dan kartu yang belum punya  │
    // │ perjanjian tertulis tidak boleh masuk rak kami.                                        │
    // │                                                                                       │
    // │ BERLAKU UNTUK PENERIMAAN BARU SAJA, dan itu bukan kelonggaran melainkan BENTUK dari    │
    // │ rute ini: gerbang ini hanya dilewati pada transisi INTAKE → IN_CUSTODY, dan baris yang │
    // │ custody-nya SUDAH tercatat tidak akan pernah melewatinya lagi (statusnya sudah bukan   │
    // │ INTAKE, dan `acceptCustodyClaimWhere` menuntut `custodyAcceptedAt: null`). Jadi tidak  │
    // │ ada satu pun kartu yang sudah di rak yang mendadak terkunci — tidak perlu backfill,    │
    // │ tidak perlu pengecualian bertanggal, tidak ada kolom baru yang harus diingat.          │
    // └───────────────────────────────────────────────────────────────────────────────────────┘
    const kinds = new Set<ConsignmentPhotoKind>([
      ...existing.photos.map((p) => p.kind),
      ...(dto.photos ?? []).map((p) => p.kind),
    ]);
    // Tiap yang kurang DISEBUT NAMANYA dalam bahasa manusia, bukan cuma token enum-nya: yang
    // membaca pesan ini adalah operator yang sedang berdiri di ruang tamu orang, dan "kurang
    // HANDOVER" tidak memberitahunya bahwa yang harus ia lakukan adalah memotret struk.
    const missing: string[] = [];
    if (!kinds.has(ConsignmentPhotoKind.FRONT)) {
      missing.push('FRONT (foto depan kartu)');
    }
    if (!kinds.has(ConsignmentPhotoKind.BACK)) {
      missing.push('BACK (foto belakang kartu)');
    }
    if (existing.certNumber && !kinds.has(ConsignmentPhotoKind.CERT)) {
      missing.push('CERT (foto label sertifikat)');
    }
    if (!kinds.has(ConsignmentPhotoKind.HANDOVER)) {
      missing.push(
        'HANDOVER (foto STRUK SERAH TERIMA yang sudah ditandatangani kedua pihak)',
      );
    }
    if (missing.length > 0) {
      throw consignmentError({
        status: HttpStatus.BAD_REQUEST,
        code: CONSIGNMENT_ERROR_CODE.EVIDENCE_REQUIRED,
        message:
          `Bukti belum lengkap: kurang ${missing.join(', ')}. Serah-terima tidak dicatat ` +
          'dan kartu ini tetap tidak bisa dipajang. Foto kartunya adalah bukti KONDISI saat ' +
          'diterima; foto struk bertanda tangan adalah bukti bahwa ada KESEPAKATAN — tanpa ' +
          'keduanya, sengketa nanti tidak bisa dimenangkan oleh siapa pun, termasuk oleh ' +
          'pemiliknya. Cetak struknya dari halaman titipan ini, minta pemiliknya ' +
          'menandatangani, lalu foto lembar yang sudah ditandatangani.',
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
    // ╔════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ "SUDAH PUNYA LISTING" TIDAK SAMA DENGAN "MASIH PUNYA LISTING YANG HIDUP".              ║
    // ╚════════════════════════════════════════════════════════════════════════════════════════╝
    //
    // Gerbang ini DULU berbunyi `if (c.listing) throw` — menolak SELAMANYA begitu baris Listing
    // pernah ada. Itu mengunci jalur yang paling manusiawi di seluruh fitur ini: pemilik menekan
    // "minta kartu saya kembali" dari HP-nya, `takeDown` menurunkan listing-nya ke CANCELLED dan
    // titipannya kembali ke IN_CUSTODY (kartunya MASIH di rak — custody sengaja tidak dilepas),
    // lalu ia berubah pikiran atau sadar salah pencet. Sesudah itu tidak ada satu pun rute di
    // repo ini yang bisa memajangnya lagi: `Listing.consignmentId` `@unique`, jadi baris CANCELLED
    // itu memegang slotnya, dan satu-satunya "pemulihan" adalah menyuruh pemiliknya menarik
    // kartunya sungguhan lalu menitipkannya kembali dari nol.
    //
    // Yang ditolak sekarang hanya listing yang BELUM CANCELLED. Batasnya penting: baris SOLD
    // TIDAK BOLEH ikut bisa dihidupkan — kartunya sudah MILIK PEMBELI, dan menghidupkannya berarti
    // menjual kartu yang sama kepada orang kedua. Baris ACTIVE juga ditolak, karena tidak ada apa
    // pun yang perlu dihidupkan dan menimpanya diam-diam akan menyembunyikan keadaan yang justru
    // harus diperiksa manusia.
    //
    // Pemeriksaan di sini ADA UNTUK PESANNYA. Yang MENEGAKKAN aturannya adalah `listClaimWhere`
    // (yang predikatnya kini menerima "belum punya listing ATAU listing-nya CANCELLED") plus
    // klaim atomik `CANCELLED → ACTIVE` di dalam transaksi di bawah.
    if (c.listing && c.listing.status !== ListingStatus.CANCELLED) {
      throw new ConflictException(
        `Titipan ini sudah punya listing (${c.listing.id}) berstatus ${c.listing.status}; ` +
          'hanya listing yang sudah DIBATALKAN yang bisa dipajang ulang.',
      );
    }
    /** Baris Listing CANCELLED milik titipan ini yang akan DIHIDUPKAN KEMBALI, kalau ada. */
    const revivableListingId = c.listing?.id ?? null;
    // ╔════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ GERBANG KEDUA, DAN SEBABNYA BERBEDA DARI GERBANG DI ATAS. JANGAN DISATUKAN.           ║
    // ╚════════════════════════════════════════════════════════════════════════════════════════╝
    //
    // Gerbang custody di atas menjawab "kartunya ada di tangan kita?". Gerbang ini menjawab
    // pertanyaan yang LAIN: "kalau kartu ini terjual, siapa yang kita bayar?".
    //
    // Sejak titipan bisa diterima dari orang yang belum punya akun Hoshi (kode klaim di tanda
    // terima), sebuah kartu BISA ada di rak kita DAN tetap tidak boleh dijual. Menjualnya berarti
    // Hoshi menerima Rupiah pembeli tanpa punya tujuan untuk menyalurkannya — memegang uang orang
    // tanpa cara menghubunginya, yang justru kebalikan dari seluruh janji fitur ini.
    //
    // KODE ERRORNYA SENGAJA BERBEDA (`OWNER_UNLINKED`, bukan `NOT_IN_CUSTODY`) karena
    // PEMULIHANNYA berbeda: yang ini diselesaikan dengan pemiliknya menukarkan kode klaimnya,
    // bukan dengan operator "mencatat serah-terima" untuk kartu yang sudah ada di raknya.
    //
    // Pemeriksaan di sini ADA UNTUK PESANNYA. Yang MENEGAKKAN aturannya adalah `listClaimWhere`
    // (predikatnya menyebut `consignorId: { not: null }`, dan `Listing.create` ada di transaksi
    // yang sama dengan klaim itu) plus dua CHECK constraint di database. Tanpa blok ini aturannya
    // tetap tidak bisa dilanggar — operator hanya akan menerima "klaim kalah" yang tidak
    // menjelaskan apa pun.
    const consignorId = requireLinkedConsignorId(c);
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
      where: { id: consignorId },
      select: { id: true, walletAddress: true, displayName: true },
    });

    const price = dto.priceIdrx ?? c.askPriceIdr;
    /* Pagar KEDUA, dan ia bukan pengulangan: harga di sini boleh datang dari `dto.priceIdrx`
       (operator menimpa harga kesepakatan saat memajang), dan baris lama yang sudah tersimpan
       sebelum pagar di `createIntake` ada bisa membawa `askPriceIdr` di luar rentang. Inilah
       titik terakhir sebelum kartunya tayang dengan tombol Beli yang menyala. */
    if (!isChargeablePrice(price)) {
      throw new BadRequestException(
        `Harga pajang Rp ${price.toLocaleString('id-ID')} tidak bisa ditagihkan, jadi kartunya ` +
          `akan tayang tanpa pernah bisa dibeli. ${chargeablePriceRangeSentence()}`,
      );
    }
    // MEMPERINGATKAN, BUKAN MENOLAK — lihat `belowReserveWarning`. Kalimatnya ikut masuk baris
    // audit, jadi "dipajang di bawah lantai yang disepakati" selalu punya jejak tertulis.
    const reserveWarning = belowReserveWarning(c.reservePriceIdr, price);
    /**
     * ISI BARIS LISTING — SATU objek, dipakai jalur BUAT-BARU dan jalur HIDUPKAN-KEMBALI.
     *
     * SENGAJA satu sumber. Kalau kedua jalur menulis daftar kolomnya sendiri-sendiri, "kartu yang
     * dipajang ulang" perlahan akan berbeda dari "kartu yang baru dipajang" di kolom yang tidak
     * pernah dilihat siapa pun sampai ia salah — mis. foto lama tertinggal padahal operator baru
     * mengunggah foto yang benar. Memajang ulang HARUS menghasilkan baris yang sama persis dengan
     * memajang pertama kali.
     *
     * ── BENTUK YANG DIPAKU CHECK CONSTRAINT `listings_consignment_shape_chk` ──
     * source HOSHI (default, bukan COLLECTORCRYPT) · sellable FALSE (default) · ccNftAddress NULL ·
     * escrowedAt NULL · sellerId NON-NULL. Kelimanya juga ditegakkan Postgres, jadi "kartu titipan
     * tidak bisa menempuh settlement escrow" adalah invarian DATABASE, bukan janji code-review.
     */
    const listingFields = {
      name: c.cardName,
      set: c.cardSet ?? dto.category ?? 'Consignment',
      rarity: dto.rarity ?? 'Rare',
      image: dto.image,
      imageBack: dto.imageBack ?? null,
      priceIdrx: price,
      expectedValueIdrx: dto.expectedValueIdrx ?? price,
      buybackIdrx: 0,
      grade: c.gradeLabel ?? `${c.grader} ${c.gradeScore ?? ''}`.trim(),
      // Non-null TANPA `!`: gerbang "kartu MENTAH belum bisa dipajang" di atas sudah melempar
      // untuk `grader == null`, dan objek ini dibangun DI LUAR callback transaksi — jadi
      // penyempitan tipe TypeScript-nya masih berlaku di sini.
      grader: c.grader,
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
      // Penjualnya DI-SEGARKAN tiap kali dipajang: wallet pemilik bisa berubah di antara dua
      // pemajangan, dan `sellerAddress` adalah salinan yang dibekukan — kalau ia basi, settlement
      // menulis alamat lama ke feed dan pemeriksaan `consignorId === sellerId` bisa melenceng.
      sellerId: consignor.id,
      sellerAddress: shortWallet(consignor.walletAddress),
    };
    const listingId = await this.prisma.$transaction(async (tx) => {
      // ══ KLAIM ATOMIK DULU. Kalau kalah, TIDAK ADA baris Listing yang pernah dibuat/dihidupkan. ══
      const claimed = await tx.consignment.updateMany({
        where: listClaimWhere(id),
        data: {
          status: ConsignmentStatus.LISTED,
          // ── PERMINTAAN PENARIKAN DICABUT, dan ini WAJIB ikut ditulis di sini ────────────
          //
          // Sejak kartu yang ditarik dari pajangan bisa dipajang ULANG, `withdrawRequestedAt`
          // yang tertinggal berarti: kartunya tayang di marketplace DAN sekaligus duduk
          // selamanya di `actionRequired` admin sebagai "pemilik minta kartunya kembali, atur
          // serah-terimanya" — sebuah peringatan yang tindakannya MUSTAHIL dari status LISTED
          // (`withdrawnReleaseClaimWhere` menuntut IN_CUSTODY), jadi ia tidak akan pernah bisa
          // hilang. Itu persis bentuk peringatan yang mengajari orang mengabaikan daftarnya.
          //
          // Ini BUKAN menghapus fakta custody: `custodyAcceptedAt`/`custodyReleasedAt` tidak
          // tersentuh. Yang dicabut adalah sebuah PERMINTAAN yang memang sudah tidak berlaku —
          // pemiliknya memilih menjual lagi — dan riwayatnya tetap utuh di `ConsignmentEvent`
          // (baris WITHDRAW_REQUEST / TAKE_DOWN lama + baris LIST yang baru).
          //
          // Rencana pengembaliannya (`returnMethod`/alamat) SENGAJA TIDAK ikut dihapus: ia
          // informasi yang mahal dikumpulkan, tidak menggerakkan gerbang mana pun selama
          // statusnya LISTED, dan akan berguna lagi kalau pemiliknya menarik kartunya nanti.
          withdrawRequestedAt: null,
        },
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
      let newListingId: string;
      if (revivableListingId) {
        // ╔══════════════════════════════════════════════════════════════════════════════════╗
        // ║ HIDUPKAN KEMBALI baris CANCELLED — BUKAN buat baris baru.                        ║
        // ╚══════════════════════════════════════════════════════════════════════════════════╝
        //
        // `Listing.consignmentId` `@unique`, jadi "baris baru" bukan pilihan yang ada: ia akan
        // menabrak constraint. Dan itu KEBETULAN YANG BENAR — riwayat satu kartu titipan memang
        // harus tinggal di SATU baris listing, supaya order lama, offer lama, dan baris activity
        // yang menunjuk `listingId` itu tidak mendadak menunjuk kartu yang "lain".
        //
        // KLAIM ATOMIK, dengan alasan yang sama seperti klaim titipan di atas: predikatnya
        // menyebut `status: CANCELLED`, jadi baris yang SOLD (atau yang sudah di-ACTIVE-kan
        // permintaan lain sedetik lalu) cocok NOL baris dan seluruh transaksi dibatalkan.
        // `consignmentId` ikut disebut supaya baris milik titipan LAIN tidak bisa tersentuh.
        const revived = await tx.listing.updateMany({
          where: {
            id: revivableListingId,
            consignmentId: id,
            status: ListingStatus.CANCELLED,
          },
          data: {
            ...listingFields,
            // Jejak pembeli dari kehidupan sebelumnya DIBERSIHKAN. Baris ini dijual lagi dari
            // nol; membiarkan `buyerId`/`soldAt` terisi berarti sebuah kartu yang sedang tayang
            // membawa nama pembeli yang tidak pernah membelinya.
            buyerId: null,
            soldAt: null,
          },
        });
        if (revived.count !== 1) {
          throw consignmentError({
            status: HttpStatus.CONFLICT,
            code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
            message:
              `Listing ${revivableListingId} milik titipan ini tidak lagi berstatus DIBATALKAN ` +
              '(sudah dipajang ulang oleh permintaan lain, atau sudah terjual). Tidak ada yang ' +
              'diubah.',
            consignmentId: id,
            listingId: revivableListingId,
          });
        }
        newListingId = revivableListingId;
      } else {
        const created = await tx.listing.create({
          data: { ...listingFields, consignmentId: id },
        });
        newListingId = created.id;
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'LIST',
        fromStatus: ConsignmentStatus.IN_CUSTODY,
        toStatus: ConsignmentStatus.LISTED,
        actor: admin,
        note:
          (revivableListingId
            ? `Listing ${newListingId} DIPAJANG ULANG (baris yang sama, sebelumnya dibatalkan ` +
              `atas permintaan pemilik) pada harga Rp ${price}.`
            : `Listing ${newListingId} dibuat pada harga Rp ${price}.`) +
          (reserveWarning ? ` ${reserveWarning}` : ''),
      });
      await tx.activity.create({
        data: {
          type: ActivityType.LISTED_CARD,
          listingId: newListingId,
          itemName: listingFields.name,
          itemImage: listingFields.image,
          category: listingFields.category,
          set: listingFields.set,
          amount: listingFields.priceIdrx,
          fromId: consignor.id,
          fromLabel:
            consignor.displayName?.trim() ||
            shortWallet(consignor.walletAddress),
          toId: null,
          toLabel: null,
        },
      });
      return newListingId;
    });

    this.logger.log(
      `Titipan ${id} DIPAJANG sebagai listing ${listingId} (Rp ${price}) oleh admin ${admin.id}. ` +
        'Kartunya ada di tangan Hoshi SEBELUM baris ini lahir — itu urutannya.' +
        (reserveWarning ? ` ${reserveWarning}` : ''),
    );
    // SESUDAH transaksi commit, dan `void` — kartunya sudah tayang apa pun yang terjadi pada
    // email. Kalau harganya salah, SEKARANG waktunya pemiliknya bicara, bukan setelah terjual.
    this.notify.notifyListed(ConsignmentNotifyService.target(c), {
      priceIdr: price,
    });
    return { belowReserveWarning: reserveWarning, ...(await this.byId(id)) };
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
    /* Pagar KETIGA. Menurunkan harga adalah jalan paling mudah untuk tidak sengaja menjatuhkan
       kartu ke bawah batas tagihan — dan kalau itu terjadi pada kartu yang SUDAH tayang, ia
       berubah dari bisa dibeli menjadi tidak, tanpa ada yang berubah di layar. */
    if (!isChargeablePrice(dto.askPriceIdr)) {
      throw new BadRequestException(
        `Harga baru Rp ${dto.askPriceIdr.toLocaleString('id-ID')} tidak bisa ditagihkan — ` +
          `kartunya akan tetap tayang tapi tidak bisa dibeli. ${chargeablePriceRangeSentence()}`,
      );
    }
    const before = c.askPriceIdr;
    // MEMPERINGATKAN, BUKAN MENOLAK — lihat `belowReserveWarning`. Inilah tempat paling mungkin
    // sebuah kartu turun ke bawah lantai yang disepakati pemiliknya, jadi kalimatnya dikembalikan
    // ke layar DAN disimpan di baris audit yang sama dengan alasan operatornya.
    const reserveWarning = belowReserveWarning(
      c.reservePriceIdr,
      dto.askPriceIdr,
    );
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
        /* ── `expectedValueIdrx` IKUT DIUBAH, DAN INI BUKAN KERAPIAN ──────────────────────────
           `createListingFor` menyamakan keduanya saat kartu titipan pertama kali dipajang
           (`expectedValueIdrx: dto.expectedValueIdrx ?? price`) — memang tidak ada taksiran
           pasar independen untuk kartu titipan; yang kita punya hanya harga yang disepakati.

           Kalau hanya `priceIdrx` yang turun, keduanya berpisah, dan serializer marketplace
           MENGARANG riwayat dari selisih itu: `readPriceHistory(null, [expectedValue, price])`
           menghasilkan "-40% 30D" lengkap dengan panah merah untuk kartu yang TIDAK PERNAH
           diperdagangkan sekali pun dan tidak punya riwayat 30 hari apa pun. Sortir "Best Value"
           ikut terbawa: kartu itu melompat ke puncak daftar penawaran terbaik semata-mata karena
           harganya pernah diturunkan.

           Kartu orang lain tidak boleh diberi riwayat pasar palsu demi tampak menarik. Kalau
           suatu saat taksiran pasar sungguhan memang ada, ia harus masuk sebagai field tersendiri
           yang DIISI MANUSIA — bukan sebagai sisa dari harga yang lupa ikut berubah. */
        await tx.listing.updateMany({
          where: { id: c.listing.id, status: ListingStatus.ACTIVE },
          data: {
            priceIdrx: dto.askPriceIdr,
            expectedValueIdrx: dto.askPriceIdr,
          },
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'PRICE',
        actor: admin,
        note:
          `Harga Rp ${before} → Rp ${dto.askPriceIdr}. ${dto.note.trim()}` +
          (reserveWarning ? ` ${reserveWarning}` : ''),
      });
    });
    if (reserveWarning) {
      this.logger.warn(`Titipan ${id}: ${reserveWarning} (admin ${admin.id})`);
    }
    return { belowReserveWarning: reserveWarning, ...(await this.byId(id)) };
  }

  /* ═══════════════════════════ 4. PENARIKAN KEMBALI ═══════════════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ RENCANA PENGEMBALIAN → KOLOM. Satu penerjemah, dipakai DUA rute (withdraw & release).  ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * ADA TEPAT SATU FUNGSI INI dengan sengaja. Alamat pengembalian bisa dicatat di dua momen yang
   * berbeda — saat pemiliknya meminta lewat telepon, atau pada detik ia berdiri di depan
   * operator — dan dua penerjemah untuk dua momen berarti dua aturan "alamat lengkap" yang suatu
   * hari akan berbeda. Yang boleh berbeda antara kedua rute adalah KAPAN ia dipanggil, bukan APA
   * yang ia anggap sah.
   *
   * MENGEMBALIKAN `data` Prisma, bukan menulis sendiri: pemanggilnya yang memutuskan di transaksi
   * mana tulisan itu duduk, dan di `release` ia WAJIB duduk di transaksi yang sama dengan klaim
   * pelepasan custody.
   *
   * NOL RUPIAH BERGERAK DI SINI. Taksiran ongkirnya adalah ANGKA YANG DICATAT, bukan tagihan:
   * tidak ada `PaymentOrder` yang terbit, tidak ada saldo yang disentuh. Lihat
   * `CONSIGNMENT_RETURN_PAYER` di gate untuk alasan panjangnya.
   */
  private async buildReturnPlanWrite(
    id: string,
    plan: ConsignmentReturnPlanDto,
  ): Promise<{
    data: Prisma.ConsignmentUpdateManyMutationInput;
    quote: DomesticShippingQuote | null;
    method: string;
    /**
     * Kalimat siap-pakai untuk baris audit: cara pengembaliannya, tujuannya, berapa ongkirnya,
     * siapa yang menanggung, dan bahwa penagihannya BELUM otomatis.
     *
     * DIBANGUN DI SINI, dari nilai yang sudah dinormalkan di fungsi ini — bukan dibaca ulang dari
     * `data` belakangan. `Prisma.ConsignmentUpdateManyMutationInput` membolehkan tiap kolom
     * berisi objek operator (`{ set: ... }`), jadi apa pun yang membacanya sebagai string sedang
     * bertaruh pada bentuk yang tidak dijamin tipe.
     */
    note: string;
  }> {
    const method = plan.returnMethod;
    const data: Prisma.ConsignmentUpdateManyMutationInput = {
      returnMethod: method,
    };

    let quote: DomesticShippingQuote | null = null;
    /** Salinan datar dari nilai yang ditulis — HANYA untuk menyusun kalimat audit di bawah. */
    let tujuan: string | null = null;

    if (method === CONSIGNMENT_RETURN_METHOD.COURIER) {
      const a = plan.returnAddress;
      // DITEGAKKAN DI SINI, bukan di decorator DTO, supaya penolakannya bisa menjelaskan HUBUNGAN
      // antara dua field ("kamu memilih kurir, jadi alamatnya wajib") alih-alih "validation
      // failed" yang tidak memberi tahu apa pun kepada operator yang sedang menelepon pemiliknya.
      if (!a) {
        throw consignmentError({
          status: HttpStatus.BAD_REQUEST,
          code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
          message:
            'Pengembalian lewat kurir butuh alamat tujuan yang lengkap (nama penerima, nomor ' +
            'telepon, alamat jalan, kota/kabupaten, provinsi, kode pos). Tanyakan sekarang, ' +
            'selagi pemiliknya masih bicara dengan Anda — kartunya tidak akan bisa ditandai ' +
            'terkirim tanpa itu. Kalau ia justru mau mengambil sendiri, pilih PICKUP.',
          consignmentId: id,
        });
      }
      // Negara default INDONESIA: seluruh jalur kurir di Hoshi adalah kurir domestik, dan
      // memaksa operator mengetik "Indonesia" di setiap pengembalian hanya menambah satu kolom
      // yang akan diisi asal-asalan. Nilai eksplisit TETAP dihormati — ia gerbang taksiran
      // ongkir di bawah, bukan hiasan.
      const country = a.country?.trim() || 'Indonesia';
      Object.assign(data, {
        returnRecipientName: a.recipientName.trim(),
        returnPhoneNumber: a.phoneNumber.trim(),
        returnPhoneCountryCode: a.phoneCountryCode?.trim() || null,
        returnStreet: a.street.trim(),
        returnApt: a.apt?.trim() || null,
        returnCity: a.city.trim(),
        returnState: a.state.trim(),
        returnZip: a.zip.trim(),
        returnCountry: country,
      });
      tujuan =
        `${a.city.trim()}, ${a.state.trim()} ${a.zip.trim()} ` +
        `a.n. ${a.recipientName.trim()}`;

      // ── TAKSIRAN ONGKIR: TARIF YANG SUDAH ADA, DAN TIDAK PERNAH MENGHALANGI ──────────────
      //
      // Dihitung `resolveDomesticShippingIdr` — fungsi dan TABEL yang SAMA dengan kirim domestik
      // stok Hoshi (`domestic_shipping_rates`). Satu daftar ongkir untuk seluruh Indonesia; dua
      // daftar berarti dua jawaban untuk satu provinsi yang sama, dan yang salah tidak akan
      // ketahuan sampai ada yang membandingkannya.
      //
      // DIBUNGKUS try/catch, DAN ITU KEPUTUSAN, BUKAN KEMALASAN: fungsi itu MELEMPAR untuk alamat
      // di luar Indonesia dan untuk tarif yang tidak masuk akal. Di jalur BAYAR, melempar memang
      // benar — user tidak boleh ditagih angka yang mustahil. Di sini tidak ada yang ditagih:
      // yang sedang terjadi adalah seseorang meminta BARANGNYA SENDIRI kembali, dan sebuah
      // taksiran yang gagal TIDAK BOLEH menghalangi itu. Gagal → `returnShippingFeeIdr` dibiarkan
      // kosong dan operator mengetiknya dari struk kurir.
      if (
        plan.returnShippingFeeIdr == null &&
        isIndonesianDestination(country)
      ) {
        try {
          quote = await resolveDomesticShippingIdr({
            prisma: this.prisma,
            logger: this.logger,
            dest: { city: a.city.trim(), state: a.state.trim(), country },
            env: (k) => this.config.get<string>(k),
          });
          data.returnShippingFeeIdr = quote.priceIdr;
        } catch (err) {
          this.logger.warn(
            `Taksiran ongkir balik titipan ${id} gagal dihitung ` +
              `(${err instanceof Error ? err.message : String(err)}). Pengembaliannya TETAP ` +
              'berjalan; nominal ongkirnya dibiarkan kosong untuk diisi operator dari struk kurir.',
          );
        }
      }
    }

    // Nominal yang DIKETIK operator selalu menang atas taksiran: yang benar adalah angka di struk
    // kurir, bukan tabel kita. 0 SENGAJA dibedakan dari kosong — "digratiskan" adalah fakta,
    // "belum dicatat" adalah ketiadaan fakta.
    if (plan.returnShippingFeeIdr != null) {
      data.returnShippingFeeIdr = plan.returnShippingFeeIdr;
    }
    if (plan.returnShippingPayer != null) {
      data.returnShippingPayer = plan.returnShippingPayer;
    }

    // ── KALIMAT AUDITNYA, disusun dari nilai yang sudah dinormalkan DI ATAS ─────────────────
    //
    // "Hoshi yang menanggung Rp 50.000" harus bisa dibaca ulang berbulan-bulan kemudian oleh
    // orang yang sedang menghitung berapa sebenarnya ongkos fitur ini — dan jejak audit adalah
    // satu-satunya tempat yang tidak bisa ditimpa.
    //
    // Kalimat penutupnya SELALU menyebut bahwa penagihannya belum otomatis. Angka yang tercatat
    // tanpa keterangan itu akan, cepat atau lambat, dibaca seseorang sebagai "sudah ditagih".
    const feeIdr = plan.returnShippingFeeIdr ?? (quote ? quote.priceIdr : null);
    const payer = plan.returnShippingPayer ?? null;
    const note =
      method === CONSIGNMENT_RETURN_METHOD.PICKUP
        ? 'Cara pengembalian: DIAMBIL SENDIRI di tempat Hoshi (tidak perlu alamat kirim).'
        : `Cara pengembalian: DIKIRIM KURIR ke ${tujuan ?? '—'}. ` +
          (feeIdr == null
            ? 'Ongkir balik BELUM dicatat.'
            : `Ongkir balik Rp ${feeIdr}` +
              (quote
                ? ` (taksiran tarif ${quote.scope}${
                    quote.regionUnresolved
                      ? ', wilayah tidak dikenali → tier penampung'
                      : ''
                  })`
                : '') +
              '.') +
          (payer == null
            ? ' Penanggung ongkir BELUM ditentukan.'
            : ` Ditanggung ${payer === CONSIGNMENT_RETURN_PAYER.HOSHI ? 'HOSHI' : 'PEMILIK KARTU'}.`) +
          ' Penagihannya BELUM otomatis — angka ini DICATAT, bukan ditagihkan.';

    return { data, quote, method, note };
  }

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
    // ── SIAPA YANG BOLEH MEMINTA KARTU INI KEMBALI ────────────────────────────────────────
    //
    // Titipan yang BELUM tertaut akun (`consignorId` null) TIDAK BISA dicocokkan dengan pengguna
    // mana pun — `actor.id` selalu non-null, jadi perbandingan di bawah otomatis menolak SETIAP
    // pengguna biasa. ITU BENAR DAN DISENGAJA: kalau titipan tanpa pemilik boleh ditarik oleh
    // siapa saja yang meminta, maka siapa pun bisa membawa pulang kartu orang lain.
    //
    // TAPI JALAN PULANGNYA TIDAK BOLEH HILANG, dan itu bagian terpenting dari paragraf ini.
    // Orang yang menyerahkan kartunya tanpa punya akun HARUS tetap bisa mengambilnya kembali.
    // Jalannya: ia datang ke operator, operator mencocokkan `consignorNameAtIntake` /
    // `consignorPhoneAtIntake` dan tanda terima bertanda tangan yang ia bawa, lalu menarik atas
    // namanya lewat rute admin (POST /admin/consignments/:id/withdraw). Dua kolom snapshot itulah
    // yang membuat langkah ini mungkin — alasan keduanya tetap WAJIB meski akunnya belum ada.
    if (actor.role !== 'ADMIN' && !isConsignorLinked(c)) {
      throw new ForbiddenException(
        'Titipan ini belum terhubung ke akun Hoshi mana pun, jadi ia tidak bisa ditarik lewat ' +
          'rute akun. Kalau ini kartu Anda: tukarkan dulu kode klaim di tanda terima Anda ' +
          '(POST /consignments/claim), atau hubungi Hoshi dengan membawa tanda terimanya — ' +
          'kartunya tetap milik Anda dan tetap bisa diminta kembali kapan saja, gratis.',
      );
    }
    if (actor.role !== 'ADMIN' && c.consignorId !== actor.id) {
      throw new ForbiddenException(
        'Hanya pemilik kartu (atau admin) yang bisa meminta kartu ini kembali.',
      );
    }
    const note = dto.note?.trim() ?? '';

    // ── KE MANA KARTUNYA PULANG — DITANYAKAN DI SINI, SELAGI ORANGNYA MASIH BICARA ────────
    //
    // Momen paling murah untuk menanyakan alamat adalah momen ini. Sesudahnya, operator harus
    // MENELEPON KEMBALI seseorang yang sudah menutup telepon — dan itulah bagaimana sebuah kartu
    // berakhir tercatat "ditarik" selama berminggu-minggu tanpa pernah dikirim ke mana pun.
    //
    // TETAP OPSIONAL: permintaan "saya mau kartu saya kembali" TIDAK BOLEH bisa gagal karena
    // sebuah kode pos. Yang TIDAK opsional adalah alamat pada saat kartunya ditandai KELUAR —
    // ditegakkan `withdrawnReleaseClaimWhere()`, di lapis yang tidak bisa dilewati kode mana pun.
    //
    // DIHITUNG HANYA UNTUK STATUS YANG MEMANG BISA MENYIMPANNYA. Permintaan untuk kartu yang
    // sudah TERJUAL pasti ditolak beberapa baris di bawah; menaksir ongkirnya lebih dulu berarti
    // satu pembacaan tabel tarif untuk keputusan yang tidak akan pernah dipakai — dan, lebih
    // buruk, satu jalur di mana permintaan yang DITOLAK sempat menyentuh sesuatu.
    const planned =
      dto.returnPlan &&
      (c.status === ConsignmentStatus.IN_CUSTODY ||
        c.status === ConsignmentStatus.LISTED)
        ? await this.buildReturnPlanWrite(id, dto.returnPlan)
        : null;
    const planNote = planned ? ` ${planned.note}` : '';

    switch (c.status) {
      // Kartunya belum pernah berpindah tangan → batalkan saja kesepakatannya.
      case ConsignmentStatus.INTAKE: {
        // ── RENCANA PENGEMBALIAN TIDAK BERLAKU DI SINI, DAN DITOLAK ALIH-ALIH DIABAIKAN ───
        //
        // Baris INTAKE berarti kesepakatannya dicatat tapi KARTUNYA TIDAK PERNAH BERPINDAH
        // TANGAN — ia masih di rumah pemiliknya. Tidak ada apa pun untuk dikirim balik, dan
        // menyimpan alamat pengembalian untuk kartu yang tidak pernah kami pegang hanya
        // menciptakan baris yang kelihatan seperti pengiriman yang tertunda.
        //
        // DITOLAK, BUKAN DIABAIKAN DIAM-DIAM: operator yang mengetik alamat lengkap lalu tidak
        // melihatnya tersimpan di mana pun berhak tahu kenapa, dan kalimat di bawah menyebutkan
        // alasannya. Diam adalah cara paling pasti membuat orang mengetiknya lagi.
        if (dto.returnPlan) {
          throw consignmentError({
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
            message:
              'Titipan ini masih berstatus INTAKE: kesepakatannya dicatat, tapi kartunya BELUM ' +
              'pernah diserahkan ke Hoshi — ia masih di tangan pemiliknya. Tidak ada yang perlu ' +
              'dikirim balik, jadi alamat pengembalian tidak disimpan. Kirim ulang permintaan ' +
              'ini TANPA returnPlan untuk membatalkan kesepakatannya.',
            consignmentId: id,
          });
        }
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
            // ══ `custodyReleasedAt` SENGAJA TIDAK DITULIS DI SINI, DAN ITU INTI FITURNYA. ══
            //
            // Yang terjadi barusan adalah sebuah PERMINTAAN, bukan perpindahan fisik. Kartunya
            // MASIH DI RAK KAMI, jadi ia MASIH TANGGUNG JAWAB HOSHI: masih bisa hilang, masih
            // harus terhitung di stok opname, masih muncul di `actionRequired`. Melepas custody
            // di sini akan membuat sebuah kartu yang belum ke mana-mana tercatat "selesai" —
            // tepat kegagalan yang seluruh bagian ini dibangun untuk menutup.
            data: { withdrawRequestedAt: new Date(), ...(planned?.data ?? {}) },
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
            note:
              'Pemilik minta kartunya kembali. Kartunya MASIH di rak Hoshi sampai serah-terima ' +
              `pengembaliannya dicatat. ${note}${planNote}`,
          });
        });
        return this.byId(id);
      }

      // Terpajang → turunkan listing-nya lebih dulu, ATOMIK, dalam satu transaksi.
      case ConsignmentStatus.LISTED: {
        const listingId = c.listing?.id;
        // ╔══════════════════════════════════════════════════════════════════════════════════╗
        // ║ BARIS YATIM: LISTED tapi listing-nya SUDAH TIDAK ADA. JANGAN MELEMPAR.          ║
        // ╚══════════════════════════════════════════════════════════════════════════════════╝
        //
        // Keadaan ini lahir dari satu sumber: `DELETE /admin/listings/:id` pernah menghapus
        // baris listing titipan (sekarang ditolak di titik tulisnya). Yang tersisa adalah kartu
        // FISIK MILIK ORANG LAIN di rak Hoshi tanpa satu pun jalan keluar — `takeDown` melempar
        // "data tidak konsisten" dan `createListingFor` menolak karena menuntut IN_CUSTODY.
        //
        // Melempar di sini menjadikan kerusakan data milik Hoshi sebagai HUKUMAN BAGI PEMILIK
        // KARTU. Yang benar: kerjakan klaim atomiknya apa adanya. Tidak ada listing yang perlu
        // diturunkan (memang sudah tidak ada), tidak ada offer yang bisa hidup tanpa listing,
        // dan tidak ada `LISTING_CANCELED` yang jujur untuk ditulis — yang tersisa justru satu
        // hal yang penting: mengembalikan titipannya ke IN_CUSTODY supaya pemiliknya tetap bisa
        // menarik kartunya lewat jalur pengembalian yang normal.
        if (!listingId) {
          await this.prisma.$transaction(async (tx) => {
            const back = await tx.consignment.updateMany({
              where: takeDownClaimWhere(id),
              // Custody TIDAK dilepas — sama seperti cabang normal di bawah. Kartunya masih di
              // rak kami sampai serah-terima pengembaliannya benar-benar dicatat.
              data: {
                status: ConsignmentStatus.IN_CUSTODY,
                withdrawRequestedAt: new Date(),
                ...(planned?.data ?? {}),
              },
            });
            if (back.count !== 1) {
              throw new ConflictException(
                'Status titipan berubah barusan; tidak ada yang diubah.',
              );
            }
            await this.writeEvent(tx, {
              consignmentId: id,
              kind: 'TAKE_DOWN',
              fromStatus: ConsignmentStatus.LISTED,
              toStatus: ConsignmentStatus.IN_CUSTODY,
              actor,
              note:
                'PEMULIHAN: catatan titipan berstatus LISTED tapi baris listing-nya sudah tidak ' +
                'ada (kemungkinan dihapus dari layar admin listings). Titipannya dikembalikan ke ' +
                'IN_CUSTODY atas permintaan pemilik supaya kartunya tetap bisa ditarik. Kartunya ' +
                `MASIH di rak Hoshi sampai serah-terima pengembaliannya dicatat. ${note}${planNote}`,
            });
          });
          return this.byId(id);
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
            // Sama seperti cabang IN_CUSTODY: custody TIDAK dilepas. Listing-nya turun, kartunya
            // kembali ke keadaan "di rak Hoshi, tidak dijual" — dan ia tetap tanggung jawab kami
            // sampai benar-benar berpindah tangan.
            data: {
              status: ConsignmentStatus.IN_CUSTODY,
              withdrawRequestedAt: new Date(),
              ...(planned?.data ?? {}),
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
            note:
              `Listing ${listingId} ditarik atas permintaan pemilik. Kartunya MASIH di rak ` +
              `Hoshi sampai serah-terima pengembaliannya dicatat. ${note}${planNote}`,
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
   *
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ UNTUK `WITHDRAWN`: KARTU TIDAK BISA DINYATAKAN KELUAR TANPA TAHU KE MANA IA PERGI.     ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Tiga lapis, dan ketiganya sengaja TIDAK saling menggantikan:
   *
   *   1. PEMERIKSAAN DI SINI       menulis PESANNYA — ia yang memberi tahu operator apa yang
   *                                kurang (alamat? resi? nama pengambil?) dan bagaimana
   *                                melengkapinya. Tanpa lapis ini aturannya tetap ditegakkan,
   *                                operator hanya akan menerima "klaim kalah" yang tidak
   *                                menjelaskan apa pun.
   *   2. PREDIKAT KLAIM            `withdrawnReleaseClaimWhere()` menyebut kolom alamatnya, jadi
   *                                POSTGRES yang menolak — bukan urutan kode. Alamat yang baru
   *                                dicatat di permintaan yang SAMA tetap terbaca karena rencana
   *                                pengembaliannya DITULIS LEBIH DULU di transaksi yang sama.
   *   3. CHECK `consignments_return_shape_chk`  bentuk barisnya tidak bisa jadi tidak konsisten
   *                                lewat jalur apa pun, termasuk SQL manual.
   *
   * `SHIPPED_TO_BUYER` TIDAK tersentuh oleh semua ini: pengiriman ke pembeli punya jalurnya
   * sendiri (`CardRedemption` + tarif domestik + rute kirim), dan menumpangkan resi pengembalian
   * di sana akan melahirkan dua tempat yang menyimpan resi untuk satu kejadian.
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
    // ── PENGEMBALIAN KE PEMILIK: SIAPKAN RENCANANYA DULU, LALU PERIKSA KELENGKAPANNYA ──────
    //
    // `planned` = rencana yang datang BERSAMA permintaan ini (pemiliknya datang tanpa
    // pemberitahuan, semuanya dicatat pada detik yang sama). Kalau tidak ada, yang berlaku adalah
    // rencana yang SUDAH tersimpan di baris sejak penarikan diminta.
    const isReturn = reason === 'WITHDRAWN';
    const planned =
      isReturn && dto.returnPlan
        ? await this.buildReturnPlanWrite(id, dto.returnPlan)
        : null;

    // Keadaan pengembalian SESUDAH rencana baru (kalau ada) diterapkan. Dihitung di memori supaya
    // pesan di bawah bisa menyebut apa yang kurang; yang MENEGAKKAN-nya tetap predikat klaim.
    const effective: ConsignmentReturnFacts = isReturn
      ? {
          returnMethod: c.returnMethod,
          returnRecipientName: c.returnRecipientName,
          returnPhoneNumber: c.returnPhoneNumber,
          returnStreet: c.returnStreet,
          returnCity: c.returnCity,
          returnState: c.returnState,
          returnZip: c.returnZip,
          returnCountry: c.returnCountry,
          ...((planned?.data ?? {}) as Partial<ConsignmentReturnFacts>),
        }
      : {
          returnMethod: null,
          returnRecipientName: null,
          returnPhoneNumber: null,
          returnStreet: null,
          returnCity: null,
          returnState: null,
          returnZip: null,
          returnCountry: null,
        };

    // Bukti serah-terimanya: resi untuk kurir, nama pengambil untuk ambil sendiri.
    const courier = dto.returnCourier?.trim() || null;
    const trackingNo = dto.returnTrackingNo?.trim() || null;
    const pickedUpBy = dto.returnPickedUpBy?.trim() || null;

    if (isReturn) {
      // (a) CARA PENGEMBALIANNYA belum dinyatakan sama sekali.
      if (effective.returnMethod == null) {
        throw consignmentError({
          status: HttpStatus.BAD_REQUEST,
          code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
          message:
            'Cara pengembalian kartu ini belum dicatat, jadi ia BELUM BISA ditandai keluar dari ' +
            'Hoshi. Pilih dulu: DIAMBIL SENDIRI (PICKUP) atau DIKIRIM KURIR (COURIER, dengan ' +
            'alamat lengkap). Kartunya TIDAK berubah keadaannya — ia tetap di rak dan tetap ' +
            'tanggung jawab Hoshi.',
          consignmentId: id,
        });
      }
      // (b) KURIR TANPA ALAMAT LENGKAP. Inilah kegagalan yang seluruh bagian ini dibuat untuk
      //     menutup: sebuah kartu tercatat "dikirim" ke tempat yang tidak pernah ditulis siapa pun.
      if (
        effective.returnMethod === CONSIGNMENT_RETURN_METHOD.COURIER &&
        !isReturnAddressComplete(effective)
      ) {
        throw consignmentError({
          status: HttpStatus.BAD_REQUEST,
          code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
          message:
            'Alamat pengembalian belum lengkap, jadi kartu ini TIDAK BISA ditandai terkirim. ' +
            `Yang masih kurang: ${missingReturnAddressFields(effective).join(', ')}. ` +
            'Tanyakan ke pemiliknya dan catat lewat permintaan penarikan (returnPlan), atau ' +
            'kirim ulang permintaan ini dengan returnPlan yang lengkap. Kartunya tetap di rak ' +
            'Hoshi sampai itu ada.',
          consignmentId: id,
        });
      }
      // (c) KURIR TANPA RESI. Tanpa nomor resi, "sudah dikirim" adalah klaim yang TIDAK BISA
      //     DIPERIKSA oleh pemilik kartunya sendiri — dan dialah satu-satunya orang yang berhak
      //     memeriksanya. Ditegakkan di sini (bukan di predikat klaim) karena nilainya LAHIR pada
      //     detik ini: predikat hanya bisa menuntut fakta yang sudah tersimpan.
      if (
        effective.returnMethod === CONSIGNMENT_RETURN_METHOD.COURIER &&
        (courier == null || trackingNo == null)
      ) {
        throw consignmentError({
          status: HttpStatus.BAD_REQUEST,
          code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
          message:
            'Nama kurir dan NOMOR RESI wajib diisi sebelum kartu titipan ditandai terkirim ' +
            'balik. Tanpa resi, "sudah dikirim" adalah pernyataan yang tidak bisa diperiksa oleh ' +
            'pemilik kartunya sendiri — padahal dialah satu-satunya orang yang berhak ' +
            'memeriksanya. Kalau kartunya justru diambil sendiri, ubah cara pengembaliannya ' +
            'menjadi PICKUP.',
          consignmentId: id,
        });
      }
      // (d) DIAMBIL SENDIRI TANPA CATATAN SIAPA YANG MENGAMBIL. Menyerahkan kartu senilai puluhan
      //     juta kepada "seseorang" tanpa nama adalah serah-terima yang tidak bisa dipertanggung-
      //     jawabkan kepada pemiliknya kalau ternyata bukan dia yang datang.
      if (
        effective.returnMethod === CONSIGNMENT_RETURN_METHOD.PICKUP &&
        pickedUpBy == null
      ) {
        throw consignmentError({
          status: HttpStatus.BAD_REQUEST,
          code: CONSIGNMENT_ERROR_CODE.RETURN_INCOMPLETE,
          message:
            'Catat SIAPA yang mengambil kartunya (returnPickedUpBy) — nama orang yang berdiri di ' +
            'depan Anda, dan dasar Anda yakin ia berhak menerimanya. Yang datang mengambil sering ' +
            'bukan pemegang akunnya, dan tanpa catatan ini serah-terimanya tidak bisa ' +
            'dipertanggungjawabkan kepada pemilik kartu.',
          consignmentId: id,
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // ══ RENCANA PENGEMBALIAN DITULIS LEBIH DULU, DI TRANSAKSI YANG SAMA. ══
      //
      // Urutan ini yang membuat lapis 2 (predikat klaim) tetap bisa membaca alamat yang baru
      // dicatat detik ini, TANPA melonggarkan prinsipnya: gerbang tetap membaca FAKTA TERSIMPAN
      // di baris, bukan nilai yang kebetulan lewat di body permintaan. Kalau klaim di bawah kalah,
      // seluruh transaksi ROLLBACK dan tulisan ini ikut hilang — tidak ada alamat yang tertinggal
      // untuk pelepasan yang tidak pernah terjadi.
      if (planned) {
        const savedPlan = await tx.consignment.updateMany({
          where: { id, status: from, custodyReleasedAt: null },
          data: planned.data,
        });
        if (savedPlan.count !== 1) {
          throw new ConflictException(
            'Status titipan berubah barusan; rencana pengembaliannya tidak ditulis dan kartunya ' +
              'tidak ditandai keluar.',
          );
        }
      }

      const claimed = await tx.consignment.updateMany({
        // ══ GERBANGNYA ADALAH PREDIKATNYA. ══
        // Untuk pengembalian ke pemilik, predikatnya ikut menyebut kolom ALAMAT — jadi "tidak
        // bisa ditandai terkirim tanpa alamat" ditegakkan Postgres, bukan oleh urutan kode.
        // Untuk SHIPPED_TO_BUYER, gerbangnya tetap seperti semula (jalur pembeli, bukan fitur ini).
        where: isReturn
          ? withdrawnReleaseClaimWhere(id)
          : { id, status: from, custodyReleasedAt: null },
        data: {
          status: ConsignmentStatus.RELEASED,
          custodyReleasedAt: new Date(),
          releaseReason: reason,
          releaseReceiptRef: dto.releaseReceiptRef ?? null,
          // Bukti serah-terimanya. HANYA untuk pengembalian ke pemilik — jalur pembeli menyimpan
          // resinya di `CardRedemption`, dan dua tempat untuk satu resi adalah dua jawaban.
          ...(isReturn
            ? {
                ...(courier ? { returnCourier: courier } : {}),
                ...(trackingNo ? { returnTrackingNo: trackingNo } : {}),
                ...(pickedUpBy ? { returnPickedUpBy: pickedUpBy } : {}),
              }
            : {}),
        },
      });
      if (claimed.count !== 1) {
        // Klaimnya membawa LEBIH DARI SATU syarat untuk pengembalian, jadi kekalahannya punya
        // lebih dari satu sebab dan operator berhak tahu keduanya — termasuk sebab yang TIDAK
        // terlihat di layarnya (alamat yang baru saja dihapus/diubah permintaan lain).
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message: isReturn
            ? 'Keadaan titipan ini berubah barusan — statusnya bergeser, kartunya sudah tercatat ' +
              'keluar oleh permintaan lain, atau rencana pengembaliannya tidak lagi lengkap. ' +
              'TIDAK ADA yang ditulis: kartunya tetap tercatat di rak Hoshi. Muat ulang barisnya ' +
              'dan lihat keadaannya sekarang.'
            : 'Status titipan berubah barusan; tidak ada yang ditulis.',
          consignmentId: id,
        });
      }
      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'RELEASE',
        fromStatus: from,
        toStatus: ConsignmentStatus.RELEASED,
        actor: admin,
        note:
          `${reason}. ${dto.note.trim()}` +
          (planned ? ` ${planned.note}` : '') +
          (isReturn
            ? effective.returnMethod === CONSIGNMENT_RETURN_METHOD.PICKUP
              ? ` Diambil sendiri oleh: ${pickedUpBy ?? '—'}.`
              : ` Dikirim ${courier ?? '—'}, resi ${trackingNo ?? '—'}.`
            : ''),
      });
    });
    this.logger.warn(
      `CUSTODY SELESAI: titipan ${id} ("${c.cardName}") KELUAR dari Hoshi (${reason}), ` +
        `dicatat admin ${admin.id}.` +
        (isReturn
          ? effective.returnMethod === CONSIGNMENT_RETURN_METHOD.PICKUP
            ? ` Diambil sendiri oleh ${pickedUpBy ?? '—'}.`
            : ` Dikirim ${courier ?? '—'} resi ${trackingNo ?? '—'}.`
          : ''),
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
    // Yang PALING TIDAK BOLEH senyap. Kalau pemiliknya tidak punya email (Path B), notifier
    // menulis log WARN berisi nama + telepon dari serah-terima — satu-satunya cara meneleponnya.
    this.notify.notifyLost(ConsignmentNotifyService.target(c));

    // ══ KARTU YANG SUDAH TERJUAL: YANG KEHILANGAN SEGALANYA ADALAH PEMBELI, BUKAN PEMILIK ══
    //
    // Kewajibannya LAHIR DI SINI, bukan saat seseorang membuka layar ganti rugi. Kalau menunggu
    // `compensate` dipanggil, utang ke pembeli hanya akan tercatat pada baris yang kebetulan
    // diklik operator — dan yang tidak diklik tidak akan muncul di daftar kerja mana pun.
    //
    // BEST-EFFORT dan TIDAK PERNAH MELEMPAR, persis seperti `recordShippingRefundDebts`: tulisan
    // LOST-nya sudah commit di atas, dan kegagalan pembukuan tidak boleh membuat operator melihat
    // 500 atas aksi yang sudah berhasil. Setiap kegagalan tetap terbit sebagai log ERROR.
    const buyerRefundDebt = isConsignmentSoldToBuyer(c)
      ? await this.recordBuyerRefundDebt(
          c,
          `titipan ditandai HILANG/RUSAK oleh admin ${admin.id}`,
          dto.note.trim(),
        )
      : null;

    return { ...(await this.byId(id)), buyerRefundDebt };
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ GANTI RUGI — SIAPA YANG DIPULIHKAN, BERAPA, DAN KENAPA "SUDAH PERNAH" BUKAN "SUKSES". ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * TIGA KEPUTUSAN YANG DITEGAKKAN RUTE INI, dan ketiganya pernah salah di sini:
   *
   * 1. NOMINALNYA DIBACA DARI STRUK, TIDAK DIKETIK. Dasarnya `askPriceIdr` — "Harga jual yang
   *    disepakati" yang tercetak di struk serah terima dua lembar yang ditandatangani kedua
   *    pihak. BUKAN `reservePriceIdr`, BUKAN taksiran pasar hari ini. `dto.amountIdr` turun
   *    pangkat jadi KONFIRMASI: kalau dikirim dan berbeda, permintaannya ditolak dengan KEDUA
   *    angka disebutkan. Itulah yang membunuh "kurang satu nol" sebelum ia menyentuh ledger.
   *
   * 2. KALAU KARTUNYA SUDAH TERJUAL, YANG DIPULIHKAN ADALAH PEMBELI — DAN RUTE INI MENOLAK.
   *    `fulfilConsignment` mengkredit pemilik 95% DI DALAM transaksi settlement, jadi begitu
   *    kartunya terjual pemiliknya SUDAH DIBAYAR, sementara kartunya masih di rak menunggu
   *    pembelinya meminta kirim. Kartu yang hilang di jendela itu meninggalkan PEMBELI dengan nol
   *    kartu dan nol Rupiah. Mengkredit pemilik di situ = membayar dua kali untuk satu kartu
   *    sambil membiarkan orang yang benar-benar dirugikan tidak menerima apa pun. Utang ke
   *    pembelinya dicatat lewat rail yang SUDAH ADA (`PaymentOrder` → REFUND_DUE), bukan rail
   *    baru — lihat `recordBuyerRefundDebt`.
   *
   * 3. "SUDAH PERNAH TERCATAT" ADALAH PENOLAKAN, BUKAN KEBERHASILAN. Dulu baris kedua
   *    mengembalikan `{ credited: false }` dengan HTTP 200, dan layar menampilkan toast hijau
   *    "Ganti rugi tercatat di saldo pemilik" sambil NOL rupiah bergerak. Sekarang keadaan itu
   *    melempar 409 yang MENYEBUT NOMINAL YANG SUDAH TERCATAT — jawaban yang tidak punya cara
   *    dibaca sebagai sukses, bahkan oleh layar yang tidak membaca satu pun field respons.
   *    `credited` karena itu kini HANYA pernah bernilai `true`.
   *
   * IDEMPOTENSINYA TETAP DI DATABASE: unique `(reason, refId)` pada `BalanceEntry` dengan
   * `refId = consignment.id`. Pra-cek di bawah ada UNTUK PESANNYA; yang menegakkan tetap index.
   */
  async compensate(id: string, dto: CompensateConsignmentDto, admin: AuthUser) {
    const c = await this.requireConsignment(id);
    if (c.status !== ConsignmentStatus.LOST) {
      throw new BadRequestException(
        `Ganti rugi hanya untuk titipan berstatus LOST; titipan ini ${c.status}.`,
      );
    }

    // ── (2) SUDAH PUNYA PEMBELI YANG MEMBAYAR → RUTE INI BUKAN JAWABANNYA ───────────────────
    if (isConsignmentSoldToBuyer(c)) {
      // Pembukuannya DIPASTIKAN ADA sebelum menolak, dan itu bukan kemewahan: baris LOST yang
      // ditandai SEBELUM `markLost` mulai mencatat utang pembeli — atau yang pencatatannya
      // kebetulan gagal waktu itu — tidak punya jalan lain untuk masuk ke daftar kerja refund.
      // Menolak tanpa mencatat berarti memberi tahu operator bahwa ada korban, lalu tidak
      // memberinya apa pun untuk ditindaklanjuti. Idempoten (predikat FULFILLED), tidak melempar.
      const debt = await this.recordBuyerRefundDebt(
        c,
        `percobaan ganti rugi ke PEMILIK ditolak (admin ${admin.id})`,
        dto.note.trim(),
      );
      throw new ConflictException(
        `Titipan ${id} SUDAH TERJUAL sebelum hilang (order ${c.soldOrderId ?? '(tidak tercatat)'}` +
          `, pembeli ${c.listing?.buyerId ?? '(tidak tercatat)'}). Ganti rugi ke PEMILIK ` +
          'DITOLAK: pemiliknya sudah menyerahkan kartunya DAN sudah menerima payout-nya ' +
          `(Rp ${c.payoutIdrx ?? 0}) di detik settlement — ia tetap memegangnya. Yang tidak ` +
          'menerima apa pun adalah PEMBELI yang sudah membayar penuh, dan dialah yang wajib ' +
          `dipulihkan. ${debt.operatorAction} JANGAN membuat kredit saldo untuk pemilik di baris ` +
          'ini; kalau memang ada kesepakatan terpisah dengan pemiliknya, catat lewat ' +
          'POST /admin/consignments/:id/correction dan selesaikan di luar sistem.',
      );
    }

    // ── UANG TIDAK PUNYA TUJUAN KALAU PEMILIKNYA BELUM TERTAUT ──────────────────────────────
    //
    // Kartu yang HILANG bisa saja kartu yang pemiliknya belum pernah membuat akun: ia menyerahkan
    // kartunya, membawa pulang tanda terima berkode klaim, lalu kartunya hilang di rak kami
    // SEBELUM ia sempat menukarkan kodenya. Mengkredit saldo di keadaan itu mustahil — tidak ada
    // akun untuk dikredit — dan kalau pemeriksaan ini tidak ada, `balance.credit` akan menerima
    // `null` sebagai userId dan gagal dengan pesan database yang tidak menjelaskan apa pun.
    //
    // Yang WAJIB dilakukan manusia lebih dulu: hubungi pemiliknya dengan
    // `consignorNameAtIntake` / `consignorPhoneAtIntake`, bantu ia masuk akun, tautkan
    // (POST /admin/consignments/:id/link-consignor atau kode klaimnya), BARU bayar. Ini bukan
    // hambatan birokrasi; ini satu-satunya cara ganti ruginya benar-benar sampai ke orangnya.
    const consignorId = requireLinkedConsignorId(c);

    // ── (1) NOMINALNYA DARI STRUK ───────────────────────────────────────────────────────────
    const amountIdr = c.askPriceIdr;
    if (!Number.isInteger(amountIdr) || amountIdr <= 0) {
      throw new BadRequestException(
        `Titipan ${id} tidak punya harga kesepakatan yang bisa dipakai sebagai dasar ganti rugi ` +
          `(askPriceIdr = ${String(amountIdr)}). Struk serah terima adalah sumber angkanya, dan ` +
          'baris ini tidak memuatnya — selesaikan dengan pemiliknya di luar sistem lalu catat ' +
          'kesepakatannya lewat POST /admin/consignments/:id/correction.',
      );
    }
    if (dto.amountIdr !== undefined && dto.amountIdr !== amountIdr) {
      throw new BadRequestException(
        `Nominal yang dikirim (Rp ${dto.amountIdr.toLocaleString('id-ID')}) BERBEDA dari harga ` +
          `jual yang disepakati di struk (Rp ${amountIdr.toLocaleString('id-ID')}). Dasar ganti ` +
          'rugi adalah angka yang tercetak di struk serah terima yang ditandatangani kedua ' +
          'pihak — bukan angka yang diketik ulang, bukan harga dasar (reserve), bukan taksiran ' +
          'pasar hari ini. Periksa lagi struknya; kalau struknya memang berbunyi lain, yang ' +
          'harus diperbaiki adalah catatan titipannya, bukan pembayarannya.',
      );
    }

    // ── (3) PRA-CEK "SUDAH PERNAH" — DEMI PESANNYA, BUKAN DEMI PENEGAKANNYA ────────────────
    const already = await this.findCompensationEntry(id);
    if (already) throw this.alreadyCompensated(id, already);

    // ── SATU TRANSAKSI: KREDIT + BARIS AUDIT ────────────────────────────────────────────────
    //
    // Dulu `balance.credit` berjalan dengan transaksinya SENDIRI dan `writeEvent` dipanggil
    // sesudahnya dengan `this.prisma`. Koneksi yang putus di antara keduanya meninggalkan saldo
    // pemilik yang sudah bertambah TANPA satu baris `ConsignmentEvent` pun — dan halaman titipan
    // membaca jejak audit, bukan ledger saldo. Operator berikutnya membuka barisnya, tidak
    // menemukan penyebutan ganti rugi, lalu membayar LAGI. Sekarang keduanya satu transaksi:
    // audit yang bisa gagal terpisah dari perubahan yang diauditnya bukan audit.
    //
    // `balance.credit(..., tx)` SENGAJA tidak menelan P2002 (lihat BalanceService): di dalam
    // transaksi pemanggil, baris ledger kembar MEMBATALKAN seluruh transaksi — jadi balapan
    // dengan permintaan kedua tidak bisa menghasilkan baris audit yatim, dan kami menerjemahkan
    // P2002-nya menjadi penolakan yang sama dengan pra-cek di atas.
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.balance.credit(
          {
            userId: consignorId,
            amountIdrx: amountIdr,
            reason: CONSIGNMENT_COMPENSATION_REASON,
            refId: id,
          },
          tx,
        );
        await this.writeEvent(tx, {
          consignmentId: id,
          kind: 'CORRECTION',
          actor: admin,
          note:
            `GANTI RUGI Rp ${amountIdr} dikreditkan ke saldo pemilik ${consignorId} — sebesar ` +
            'HARGA JUAL YANG DISEPAKATI di struk serah terima (askPriceIdr). ' +
            dto.note.trim(),
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const raced = await this.findCompensationEntry(id);
        throw this.alreadyCompensated(id, raced);
      }
      throw err;
    }

    this.logger.warn(
      `GANTI RUGI titipan ${id} ("${c.cardName}"): Rp ${amountIdr} dikreditkan ke saldo pemilik ` +
        `${consignorId} oleh admin ${admin.id}. Dasar: askPriceIdr dari struk serah terima.`,
    );
    return {
      /** HANYA pernah `true`. "Sudah pernah" sekarang terbit sebagai 409, bukan 200. */
      credited: true as const,
      /** Nominal yang BENAR-BENAR dikreditkan — dibaca dari struk, bukan dari body permintaan. */
      compensationIdr: amountIdr,
      ...(await this.byId(id)),
    };
  }

  /** Baris ledger ganti rugi untuk satu titipan, kalau sudah pernah ada. */
  private async findCompensationEntry(consignmentId: string) {
    return this.prisma.balanceEntry.findFirst({
      where: {
        reason: CONSIGNMENT_COMPENSATION_REASON,
        refId: consignmentId,
      },
      select: {
        id: true,
        userId: true,
        deltaIdrx: true,
        createdAt: true,
      },
    });
  }

  /**
   * Penolakan untuk ganti rugi KEDUA. Menyebut nominal yang SUDAH tercatat, karena itulah satu-
   * satunya informasi yang membuat operator bisa memutuskan langkah berikutnya: kalau angkanya
   * ternyata salah, yang dibutuhkan bukan "bayar lagi" (ledger append-only, dan kunci idempotensi
   * (reason, refId) akan menolaknya selamanya) melainkan KOREKSI yang terlihat sebagai koreksi.
   */
  private alreadyCompensated(
    consignmentId: string,
    entry: {
      deltaIdrx: bigint;
      userId: string;
      createdAt: Date;
    } | null,
  ): ConflictException {
    const nominal =
      entry != null
        ? `Rp ${Number(entry.deltaIdrx).toLocaleString('id-ID')}`
        : '(nominalnya gagal dibaca — periksa ledger saldo)';
    const kapan =
      entry != null ? entry.createdAt.toISOString() : '(waktu tidak terbaca)';
    return new ConflictException(
      `Ganti rugi untuk titipan ${consignmentId} SUDAH pernah tercatat: ${nominal} ke saldo ` +
        `${entry?.userId ?? '(pemilik)'} pada ${kapan}. NOL rupiah bergerak dari permintaan ini ` +
        '— dan itu SENGAJA: ledger saldo append-only dengan kunci idempotensi (reason, refId), ' +
        'jadi pembayaran kedua untuk titipan yang sama tidak mungkin terjadi lewat rute ini. ' +
        'KALAU NOMINAL YANG TERCATAT SALAH, jangan mencoba membayar ulang: catat selisihnya ' +
        'sebagai kesepakatan tertulis lewat POST /admin/consignments/:id/correction, lalu ' +
        'selesaikan pembayarannya di luar sistem. Koreksi harus TERLIHAT sebagai koreksi.',
    );
  }

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ UTANG KE PEMBELI — LEWAT RAIL YANG SUDAH ADA, BUKAN RAIL BARU.                         ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Kartu titipan yang hilang SESUDAH terjual meninggalkan satu orang dengan nol kartu dan nol
   * Rupiah: PEMBELINYA. Rupiah-nya tidak lagi duduk di treasury — 95%-nya sudah dikreditkan ke
   * saldo pemilik di detik settlement, dan 5%-nya jadi komisi. Jadi memulihkan pembeli BUKAN
   * "mengembalikan uang yang kami pegang" melainkan MEMBAYAR KERUGIAN dari kantong Hoshi.
   *
   * KENAPA `PaymentOrder` → REFUND_DUE, dan bukan tabel utang baru: itulah SATU-SATUNYA bentuk
   * "user sudah bayar dan tidak menerima apa pun" yang sudah dikenal seluruh sistem ini —
   * reconciler mengalarmkannya, /admin/transactions menampilkannya, dan operator sudah terlatih
   * membacanya. Utang yang lahir dalam bentuk yang tidak dikenali daftar kerja mana pun sama saja
   * dengan utang yang tidak dicatat. Polanya DISALIN dari `recordShippingRefundDebts`
   * (src/payments/shipping-refund-debt.ts), penulis PaymentStatus.REFUND_DUE kedua di repo ini:
   * log DULU, tulisan BERPAGAR pada status yang kami baca, tidak pernah melempar.
   *
   * ══ `refundSafe = false`, DAN ITU BUKAN KELALAIAN ══
   * `refundSafe = true` adalah KLAIM dengan dua paruh: uang user TERBUKTI kami pegang DAN
   * TERBUKTI belum diserahkan. Di sini paruh PERTAMA salah — uangnya sudah keluar ke saldo
   * pemilik. Operator yang menuruti aturan rumah ("baca refundSafe, bukan teksnya") karena itu
   * harus melihat "berhenti dan verifikasi", bukan "transfer sekarang": jumlah yang harus
   * dikembalikan, dari kantong siapa, dan apa yang terjadi pada payout pemilik adalah keputusan
   * manusia. Utangnya tetap TERCATAT — yang ditahan hanya izin transfernya, sama persis dengan
   * kebijakan `markProvenDeviationRefundDue` di payments.
   *
   * TIDAK PERNAH MELEMPAR. Pemanggilnya (`markLost`, `compensate`) sudah menulis/menolak; sebuah
   * kegagalan pembukuan tidak boleh membalikkan itu. Setiap kegagalan terbit sebagai log ERROR
   * yang menyebut PERSIS query pemulihannya.
   */
  private async recordBuyerRefundDebt(
    c: {
      id: string;
      cardName: string;
      status: ConsignmentStatus;
      soldOrderId: string | null;
      payoutIdrx: number | null;
      commissionIdrx: number | null;
      listing?: { id: string; buyerId: string | null } | null;
    },
    trigger: string,
    reason: string,
  ): Promise<ConsignmentBuyerRefundDebt> {
    const base = {
      merchantOrderId: c.soldOrderId,
      priceIdr: null as number | null,
      statusBefore: null as PaymentStatus | null,
      statusAfter: null as PaymentStatus | null,
      recordedNow: false,
    };

    if (!c.soldOrderId) {
      const action =
        `Titipan ${c.id} tercatat punya pembeli (listing.buyerId ` +
        `${c.listing?.buyerId ?? 'null'}) tapi TIDAK menyimpan merchantOrderId penjualannya, ` +
        'jadi utangnya tidak bisa ditempelkan ke baris pembayaran mana pun secara otomatis. ' +
        'CARI MANUAL: SELECT * FROM payment_orders WHERE "listingId" = ' +
        `'${c.listing?.id ?? '?'}' ORDER BY "createdAt" DESC — lalu tandai REFUND_DUE sendiri.`;
      this.logger.error(
        `UTANG PEMBELI TIDAK TERTEMPEL: ${action} Pemicu: ${trigger}.`,
      );
      return { ...base, operatorAction: action };
    }

    let order: {
      merchantOrderId: string;
      userId: string;
      priceIdr: number;
      status: PaymentStatus;
    } | null = null;
    try {
      order = await this.prisma.paymentOrder.findUnique({
        where: { merchantOrderId: c.soldOrderId },
        select: {
          merchantOrderId: true,
          userId: true,
          priceIdr: true,
          status: true,
        },
      });
    } catch (err) {
      const action =
        `Gagal membaca order pembeli ${c.soldOrderId} untuk titipan ${c.id}: ` +
        `${err instanceof Error ? err.message : String(err)}. Utangnya NYATA — periksa manual: ` +
        `SELECT * FROM payment_orders WHERE "merchantOrderId" = '${c.soldOrderId}'.`;
      this.logger.error(action);
      return { ...base, operatorAction: action };
    }

    if (!order) {
      const action =
        `Order pembeli ${c.soldOrderId} (titipan ${c.id}) TIDAK DITEMUKAN — utangnya tidak bisa ` +
        'dicatat otomatis. Ini seharusnya mustahil: kolom itu ditulis settlement sendiri. ' +
        'Periksa manual sebelum menutup kasusnya.';
      this.logger.error(action);
      return { ...base, operatorAction: action };
    }

    const message =
      `UTANG KE PEMBELI — KARTU TITIPAN HILANG SESUDAH TERJUAL. Titipan ${c.id} ` +
      `("${c.cardName}") ${trigger}, padahal kartunya SUDAH dibayar penuh lewat order ini dan ` +
      'masih menunggu dikirim. Pembeli memegang NOL kartu dan NOL Rupiah. Rupiah-nya TIDAK lagi ' +
      `di treasury: payout Rp ${c.payoutIdrx ?? 0} sudah masuk ke saldo pemilik kartu dan komisi ` +
      `Rp ${c.commissionIdrx ?? 0} sudah diambil di detik settlement — jadi memulihkan pembeli ` +
      'adalah KERUGIAN HOSHI, bukan pengembalian uang yang kami pegang. refundSafe=false: ' +
      'utangnya TERCATAT tapi transfernya keputusan manusia. Alasan: ' +
      reason;

    // Log DULU: utangnya harus terbit walaupun tulisan DB di bawah gagal. Format prefiksnya
    // SENGAJA sama dengan payments (`REFUND_DUE[JANGAN-REFUND][...]`) supaya pencarian log
    // operator yang sudah ada ikut menemukannya.
    this.logger.error(
      `REFUND_DUE[JANGAN-REFUND][KARTU TITIPAN HILANG] ${order.merchantOrderId} ` +
        `(user ${order.userId}, Rp ${order.priceIdr}): ${message}`,
    );

    const seen = {
      merchantOrderId: order.merchantOrderId,
      priceIdr: order.priceIdr,
      statusBefore: order.status,
    };

    if (order.status !== PaymentStatus.FULFILLED) {
      // TIDAK DISENTUH. Baris yang sudah REFUND_DUE berarti utangnya memang sudah tercatat
      // (mungkin oleh panggilan sebelumnya — rute ini idempoten karena predikat FULFILLED-nya);
      // status lain berarti settlement-nya tidak pernah selesai, dan menimpanya dari sini akan
      // menghapus keadaan yang justru harus diperiksa manusia.
      const action =
        order.status === PaymentStatus.REFUND_DUE
          ? `Utang ke pembeli SUDAH tercatat sebelumnya pada order ${order.merchantOrderId} ` +
            `(Rp ${order.priceIdr}). Baca kolom \`error\`-nya, verifikasi, lalu kembalikan ` +
            'Rupiah-nya ke pembeli di luar sistem — tidak ada kode yang mengirimkannya otomatis.'
          : `Order pembeli ${order.merchantOrderId} berstatus ` +
            `${order.status}, bukan FULFILLED — TIDAK disentuh. Periksa manual: kalau Rupiah ` +
            'pembeli memang mendarat, tandai REFUND_DUE sendiri; kalau tidak, tidak ada utang.';
      this.logger.error(
        `UTANG PEMBELI TIDAK DITULIS (status ${order.status}) untuk titipan ${c.id}: ${action}`,
      );
      return {
        ...seen,
        statusAfter: order.status,
        recordedNow: false,
        operatorAction: action,
      };
    }

    try {
      // BERPAGAR pada status yang KITA BACA. Panggilan kedua (mis. `compensate` sesudah
      // `markLost`) cocok 0 baris — SATU utang, bukan dua. `fulfilledAt` SENGAJA tidak dihapus:
      // order itu MEMANG pernah dilayani, dan menghapus stempelnya menghilangkan satu-satunya
      // bukti kapan Rupiah pembelinya diterima.
      const moved = await this.prisma.paymentOrder.updateMany({
        where: {
          merchantOrderId: order.merchantOrderId,
          status: PaymentStatus.FULFILLED,
        },
        data: {
          status: PaymentStatus.REFUND_DUE,
          error: message.slice(0, BUYER_DEBT_ERROR_MAX),
          refundSafe: false,
        },
      });
      const recordedNow = moved.count === 1;
      return {
        ...seen,
        statusAfter: recordedNow ? PaymentStatus.REFUND_DUE : order.status,
        recordedNow,
        operatorAction:
          `Utang ke PEMBELI tercatat di order ${order.merchantOrderId} (Rp ${order.priceIdr}) ` +
          'sebagai REFUND_DUE dengan refundSafe=FALSE. JANGAN transfer sebelum diverifikasi: ' +
          'Rupiah-nya sudah keluar ke saldo pemilik kartu, jadi mengembalikannya adalah ' +
          'kerugian Hoshi dan butuh keputusan manusia.',
      };
    } catch (err) {
      const action =
        `Gagal menandai REFUND_DUE pada order pembeli ${order.merchantOrderId} sesudah titipan ` +
        `${c.id} hilang: ${err instanceof Error ? err.message : String(err)}. Utangnya NYATA — ` +
        'tandai manual.';
      this.logger.error(action);
      return {
        ...seen,
        statusAfter: order.status,
        recordedNow: false,
        operatorAction: action,
      };
    }
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

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ KOREKSI LABEL — dan GARIS yang memisahkannya dari `addCorrection` di atas.             ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * ┌────────────────────────────────────────────────────────────────────────────────────────┐
   * │ `conditionNote` dan foto adalah BUKTI: pernyataan seseorang tentang keadaan kartu pada  │
   * │ HARI ia diterima. Bukti yang bisa diubah diam-diam sesudah sengketa dimulai TIDAK ADA   │
   * │ HARGANYA — bagi kedua pihak. Keduanya TETAP tidak punya rute update, dan itu tidak      │
   * │ dilonggarkan oleh satu baris pun di bawah ini.                                         │
   * │                                                                                        │
   * │ `cardName` dan kawan-kawannya adalah LABEL: klaim tentang kartu MANA ini, yang bisa     │
   * │ dicek terhadap kartu fisiknya sendiri dan terhadap situs grader-nya. Label yang salah   │
   * │ ketik BUKAN bukti tentang apa pun — ia cuma salah.                                      │
   * └────────────────────────────────────────────────────────────────────────────────────────┘
   *
   * KENAPA RUTE INI HARUS ADA, dengan kalimat yang konkret: `createListingFor` menyalin
   * `cardName` LANGSUNG ke `Listing.name`. Satu huruf yang terlewat di ponsel, di teras rumah
   * orang, jam lima sore — "Charizad VMAX" — menjadi JUDUL PUBLIK PERMANEN kartu orang lain
   * senilai Rp 24 juta. Sebelum rute ini, satu-satunya "perbaikan" yang tersedia adalah
   * `addCorrection`, yang sengaja TIDAK menimpa apa pun: koreksinya terkubur di jejak audit yang
   * tidak pernah dibaca satu pun calon pembeli, sementara judul yang salah tetap tayang.
   *
   * KONTRAKNYA, dan ketiganya dalam SATU transaksi:
   *   1. ALASAN WAJIB (`note`, min 10 karakter) — sama seperti perubahan harga.
   *   2. SEBELUM-DAN-SESUDAH tersimpan sebagai satu baris `ConsignmentEvent` ber-kind
   *      `LABEL_CORRECTION`. Nilai lamanya tidak hilang; ia pindah ke jejak audit. Itulah yang
   *      membuat "diperbaiki" tetap bisa dibedakan dari "selalu begitu".
   *   3. JUDUL LISTING YANG MASIH TAYANG IKUT DIPERBAIKI. Kalau langkah ini terpisah, akan ada
   *      jendela — sependek apa pun — ketika catatan titipan sudah benar dan yang dilihat publik
   *      masih salah; dan kalau yang kedua gagal, tidak akan ada yang tahu.
   *
   * GERBANG KONKURENSINYA ADALAH KLAIMNYA: `where` menyebut NILAI LAMA setiap kolom yang
   * disentuh. Dua operator yang memperbaiki field yang sama pada detik yang sama tidak bisa
   * dua-duanya menang — dan, yang lebih penting, "sebelum" yang tertulis di baris audit TIDAK
   * PERNAH karangan: kalau nilainya sudah bukan itu lagi, klaimnya cocok 0 baris.
   *
   * BOLEH DI STATUS APA PUN, TERMASUK SESUDAH TERJUAL. Catatan yang salah nama tetap salah
   * setelah kartunya pindah tangan, dan membiarkannya berarti arsip custody Hoshi menyimpan nama
   * kartu yang tidak pernah ada. Baris `Listing` hanya disentuh selama ia masih ACTIVE: listing
   * yang sudah SOLD adalah SNAPSHOT APA YANG DIBELI PEMBELI, dan itu bukan milik kita untuk
   * diubah. `era`/`category`/`rarity` di listing juga TIDAK disentuh — ketiganya pilihan tampilan
   * yang diketik operator saat memajang, bukan salinan dari kolom titipan.
   */
  async correctLabel(
    id: string,
    dto: CorrectConsignmentLabelDto,
    admin: AuthUser,
  ) {
    const c = await this.requireConsignment(id);

    const changes: LabelChange[] = [];
    const data: Prisma.ConsignmentUpdateManyMutationInput = {};
    // Gerbang optimistic. Mulai dari id, lalu setiap kolom yang disentuh menambahkan NILAI
    // LAMA-nya sebagai syarat — lihat paragraf "GERBANG KONKURENSINYA ADALAH KLAIMNYA".
    const guard: Prisma.ConsignmentWhereInput = { id };
    let provided = 0;

    if (dto.cardName !== undefined) {
      provided++;
      const next = dto.cardName.trim();
      if (next.length === 0) {
        throw new BadRequestException(
          'cardName tidak boleh dikosongkan: ia judul publik kartu ini. Kirim nama yang BENAR, ' +
            'bukan string kosong.',
        );
      }
      if (next !== c.cardName) {
        changes.push({ field: 'cardName', before: c.cardName, after: next });
        data.cardName = next;
        guard.cardName = c.cardName;
      }
    }
    if (dto.cardSet !== undefined) {
      provided++;
      const next = blankToNull(dto.cardSet);
      if (next !== c.cardSet) {
        changes.push({ field: 'cardSet', before: c.cardSet, after: next });
        data.cardSet = next;
        guard.cardSet = c.cardSet;
      }
    }
    if (dto.cardNumber !== undefined) {
      provided++;
      const next = blankToNull(dto.cardNumber);
      if (next !== c.cardNumber) {
        changes.push({
          field: 'cardNumber',
          before: c.cardNumber,
          after: next,
        });
        data.cardNumber = next;
        guard.cardNumber = c.cardNumber;
      }
    }
    if (dto.certNumber !== undefined) {
      provided++;
      const next = blankToNull(dto.certNumber);
      if (next !== c.certNumber) {
        changes.push({
          field: 'certNumber',
          before: c.certNumber,
          after: next,
        });
        data.certNumber = next;
        guard.certNumber = c.certNumber;
      }
    }
    if (dto.gradeLabel !== undefined) {
      provided++;
      const next = blankToNull(dto.gradeLabel);
      if (next !== c.gradeLabel) {
        changes.push({
          field: 'gradeLabel',
          before: c.gradeLabel,
          after: next,
        });
        data.gradeLabel = next;
        guard.gradeLabel = c.gradeLabel;
      }
    }
    if (dto.gradeScore !== undefined) {
      provided++;
      if (dto.gradeScore !== c.gradeScore) {
        changes.push({
          field: 'gradeScore',
          before: c.gradeScore,
          after: dto.gradeScore,
        });
        data.gradeScore = dto.gradeScore;
        guard.gradeScore = c.gradeScore;
      }
    }
    /* ── GRADER: satu-satunya jalan keluar dari kartu yang terkunci di rak ──────────────────
       Sebelum cabang ini ada, dropdown Grader yang tertinggal kosong saat intake adalah
       kesalahan PERMANEN: `createListingFor` menolak selamanya kartu tanpa grader, dan tidak ada
       satu rute pun yang bisa mengisinya sesudah serah-terima. Kartu fisik milik orang lain
       duduk di rak tanpa bisa dijual, dan satu-satunya jalan keluar dari IN_CUSTODY adalah
       RELEASE atau LOST — dua-duanya FAKTA PALSU di buku besar yang sengaja append-only.

       String kosong = kartunya ternyata MENTAH (kolomnya dikosongkan). Nilai lain sudah disaring
       `@IsIn` di DTO, jadi di sini ia pasti salah satu dari PSA/CGC/BGS. */
    let graderChange: LabelChange | null = null;
    if (dto.grader !== undefined) {
      provided++;
      const next = dto.grader === '' ? null : dto.grader;
      if (next !== c.grader) {
        graderChange = { field: 'grader', before: c.grader, after: next };
        changes.push(graderChange);
        data.grader = next;
        guard.grader = c.grader;
      }
    }

    if (provided === 0) {
      throw new BadRequestException(
        'Sebutkan minimal satu field yang dikoreksi (cardName, cardSet, cardNumber, ' +
          'certNumber, grader, gradeLabel, gradeScore). Catatan kondisi dan foto SENGAJA tidak ' +
          'bisa ditimpa — keduanya bukti; koreksi naratif ditulis lewat ' +
          'POST /admin/consignments/:id/correction.',
      );
    }
    if (changes.length === 0) {
      throw new BadRequestException(
        'Tidak ada yang berubah: semua nilai yang dikirim sudah sama persis dengan yang ' +
          'tersimpan. Tidak ada baris audit yang dibuat untuk perubahan yang tidak terjadi.',
      );
    }

    /* ══ GRADING YANG DIBACA PEMBELI SAAT IA MEMBAYAR TIDAK BOLEH BERUBAH SESUDAHNYA ══
       Nama kartu yang salah ketik tetap layak diperbaiki setelah terjual (arsip custody Hoshi
       tidak boleh menyimpan nama kartu yang tidak pernah ada) — itulah kenapa rute ini sengaja
       boleh dipakai di status apa pun. `grader` BERBEDA KELAS: ia bagian dari APA YANG DIBELI.
       Mengubahnya sesudah ada yang membayar berarti mengubah barangnya secara retroaktif, dan
       baris `Listing` yang SOLD memang sudah dijaga sebagai snapshot yang tidak disentuh. Kalau
       grading yang benar ternyata lain, itu sengketa antara Hoshi dan pembelinya — bukan sesuatu
       yang diselesaikan dengan menimpa satu kolom. */
    if (graderChange && isConsignmentSoldToBuyer(c)) {
      throw new ConflictException(
        `Titipan ${id} sudah punya pembeli yang membayar (order ` +
          `${c.soldOrderId ?? '(tidak tercatat)'}), jadi GRADER-nya tidak bisa dikoreksi lagi: ` +
          `pembeli membayar untuk kartu ber-grading "${c.grader ?? 'mentah'}" dan itulah yang ` +
          'dibacanya saat menekan Beli. Field label lain masih boleh dikoreksi. Kalau grading ' +
          'yang benar memang berbeda, itu urusan yang harus diselesaikan DENGAN pembelinya — ' +
          'catat duduk perkaranya lewat POST /admin/consignments/:id/correction.',
      );
    }

    /* ══ MENGOSONGKAN GRADER SELAGI KARTUNYA TAYANG: DITOLAK, DAN BUKAN KARENA TIPE DATA ══
       `Listing.grader` adalah enum NOT NULL berisi PSA/CGC/BGS saja — tidak ada nilai yang JUJUR
       di sana untuk kartu mentah (alasan yang sama yang membuat `createListingFor` menolak kartu
       tanpa grading). Jadi "kartunya ternyata mentah" TIDAK BISA dicerminkan ke baris listing
       yang sedang tayang, dan membiarkan koreksinya lewat akan meninggalkan pajangan publik yang
       menyebut grader yang catatan titipannya sendiri sudah bantah. Urutannya: turunkan dulu
       pajangannya (rute penarikan), baru koreksi — kartunya tetap di rak, tidak ada yang hilang. */
    if (
      graderChange &&
      graderChange.after == null &&
      c.listing?.status === ListingStatus.ACTIVE
    ) {
      throw new ConflictException(
        `Titipan ${id} SEDANG TAYANG (listing ${c.listing.id}), jadi grader-nya tidak bisa ` +
          'dikosongkan sekarang: kolom grader pada listing hanya mengenal PSA/CGC/BGS dan tidak ' +
          'punya nilai yang jujur untuk kartu MENTAH. Turunkan dulu pajangannya, baru koreksi ' +
          'labelnya — kartunya tetap di rak Hoshi selama itu.',
      );
    }

    /* ══ ANTI-DOBEL-TITIP: KUNCINYA PASANGAN (grader, certNumber), JADI DUA-DUANYA DIPERIKSA ══
       Dulu blok ini hanya melihat `certChange` dan hanya memakai `c.grader` yang LAMA. Sesudah
       `grader` bisa dikoreksi, keduanya salah: mengubah grader SAJA sudah memindahkan baris ini
       ke kunci unik yang LAIN — bisa tepat ke kunci yang sudah dipakai titipan hidup lain —
       tanpa satu pun pemeriksaan berbunyi. Maka yang dipakai di bawah adalah nilai SESUDAH
       koreksi untuk KEDUA kolom, dan pemicunya perubahan pada salah satu dari keduanya.

       Pemeriksaan ini ADA UNTUK PESANNYA; yang benar-benar menegakkannya tetap partial unique
       index `consignments_active_cert_uniq` (P2002 → 409 lewat filter Prisma). */
    const certChange = changes.find((ch) => ch.field === 'certNumber');
    const nextGrader = (
      graderChange ? graderChange.after : c.grader
    ) as Grader | null;
    const nextCert = (certChange ? certChange.after : c.certNumber) as
      | string
      | null;

    if (certChange || graderChange) {
      // Lihat `CERT_WITHOUT_GRADER_MESSAGE`. Dipicu HANYA kalau koreksinya menyentuh salah satu
      // dari pasangan itu: baris WARISAN yang sudah terlanjur berbentuk begitu tetap boleh
      // diperbaiki nama/set-nya tanpa dipaksa menyelesaikan urusan grader lebih dulu — memblokir
      // koreksi yang TIDAK ADA hubungannya hanya akan membuat rute ini ikut buntu.
      if (nextCert != null && nextGrader == null) {
        throw new BadRequestException(
          `${CERT_WITHOUT_GRADER_MESSAGE} (Sesudah koreksi ini baris ${id} akan berbunyi ` +
            `grader=(kosong), certNumber="${nextCert}".)`,
        );
      }
      if (nextCert != null && nextGrader != null) {
        const clash = await this.prisma.consignment.findFirst({
          where: {
            grader: nextGrader,
            certNumber: nextCert,
            id: { not: id },
            ...liveConsignmentWhere(),
          },
          select: { id: true, status: true },
        });
        if (clash) {
          throw new ConflictException(
            `Sertifikat ${nextGrader} ${nextCert} SUDAH dipakai titipan aktif lain ` +
              `(${clash.id}, status ${clash.status}). Satu kartu fisik tidak bisa punya dua ` +
              'titipan hidup — periksa lagi nomor yang tertera di slab-nya.',
          );
        }
      }
    }

    const listingId = c.listing?.id ?? null;
    let listingUpdated = false;
    // DIBEDAKAN dari `listingUpdated` supaya baris auditnya tidak berbohong: "tidak ada kolom
    // listing yang perlu disesuaikan" (mis. hanya `cardSet` yang dikosongkan) BUKAN hal yang
    // sama dengan "listing-nya sudah tidak ACTIVE sehingga tidak boleh disentuh".
    let listingMirrorAttempted = false;
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.consignment.updateMany({ where: guard, data });
      if (claimed.count !== 1) {
        throw consignmentError({
          status: HttpStatus.CONFLICT,
          code: CONSIGNMENT_ERROR_CODE.BAD_TRANSITION,
          message:
            'Salah satu nilai yang dikoreksi sudah berubah sejak layar ini dimuat (mungkin ' +
            'operator lain memperbaikinya lebih dulu). TIDAK ADA yang ditulis — muat ulang ' +
            'barisnya dan lihat nilainya sekarang sebelum mengoreksi lagi.',
          consignmentId: id,
        });
      }

      // ══ JUDUL PUBLIK IKUT, DI TRANSAKSI YANG SAMA ══
      if (listingId) {
        const listingData: Prisma.ListingUpdateManyMutationInput = {};
        for (const ch of changes) {
          if (ch.field === 'cardName') listingData.name = String(ch.after);
          // `Listing.set` NOT NULL: mengosongkan cardSet tidak boleh mengosongkan kolom itu.
          if (ch.field === 'cardSet' && ch.after != null) {
            listingData.set = String(ch.after);
          }
          if (ch.field === 'cardNumber') {
            listingData.cardNumber = ch.after == null ? null : String(ch.after);
          }
          if (ch.field === 'certNumber') {
            listingData.certificate =
              ch.after == null ? null : String(ch.after);
          }
        }
        // `grade`/`gradeScore` dihitung ULANG dari nilai SESUDAH koreksi, dengan rumus yang
        // SAMA PERSIS dengan `createListingFor` — supaya baris yang dikoreksi tidak berbeda
        // bentuk dari baris yang dipajang dengan nilai benar sejak awal.
        const labelChange = changes.find((ch) => ch.field === 'gradeLabel');
        const scoreChange = changes.find((ch) => ch.field === 'gradeScore');
        if (labelChange || scoreChange || graderChange) {
          // DIBACA DARI `changes`, BUKAN dari `data` dengan `??`: koreksi yang MENGOSONGKAN
          // `gradeLabel` menulis `null`, dan `null ?? c.gradeLabel` akan diam-diam memulihkan
          // label LAMA ke baris listing — persis label palsu yang rute ini ada untuk menghapus.
          // `changes` membedakan "tidak disebut" dari "disebut, dan nilainya null".
          const nextLabel = (labelChange ? labelChange.after : c.gradeLabel) as
            | string
            | null;
          const nextScore = (scoreChange ? scoreChange.after : c.gradeScore) as
            | number
            | null;
          // `nextGrader` (bukan `c.grader`) supaya rumus cadangan "PSA 10" tidak menyebut grader
          // LAMA pada baris yang grader-nya barusan diperbaiki.
          listingData.grade =
            nextLabel ?? `${nextGrader ?? ''} ${nextScore ?? ''}`.trim();
          listingData.gradeScore = nextScore ?? 0;
          // Kolomnya sendiri ikut, dan hanya kalau ada nilai yang sah: mengosongkannya selagi
          // listing ACTIVE sudah ditolak di atas, jadi cabang null di sini tidak bisa tercapai
          // untuk baris yang benar-benar tayang — tapi `updateMany` di bawah berpagar ACTIVE dan
          // NOT NULL-nya dijaga database, jadi kami tetap tidak mengirim null ke sana.
          if (graderChange && nextGrader != null) {
            listingData.grader = nextGrader;
          }
        }
        if (Object.keys(listingData).length > 0) {
          listingMirrorAttempted = true;
          const upd = await tx.listing.updateMany({
            // `consignmentId: id` ikut disebut: rute ini tidak boleh bisa menyentuh baris
            // listing mana pun yang bukan milik titipan ini.
            where: {
              id: listingId,
              consignmentId: id,
              status: ListingStatus.ACTIVE,
            },
            data: listingData,
          });
          listingUpdated = upd.count === 1;
        }
      }

      await this.writeEvent(tx, {
        consignmentId: id,
        kind: 'LABEL_CORRECTION',
        actor: admin,
        note:
          'Koreksi LABEL (menimpa kolom identitas kartu; catatan kondisi & foto TIDAK ' +
          `disentuh). ${changes.map(describeChange).join('; ')}. ` +
          (listingId
            ? listingUpdated
              ? `Judul publik listing ${listingId} ikut disesuaikan di transaksi yang sama. `
              : listingMirrorAttempted
                ? `Listing ${listingId} TIDAK disesuaikan (sudah tidak ACTIVE — baris itu ` +
                  'snapshot apa yang dibeli pembeli). '
                : `Listing ${listingId} tidak punya kolom yang perlu ikut berubah. `
            : '') +
          `Alasan: ${dto.note.trim()}`,
      });
    });

    this.logger.warn(
      `KOREKSI LABEL titipan ${id} oleh admin ${admin.id}: ` +
        `${changes.map(describeChange).join('; ')}.` +
        (listingUpdated ? ` Listing ${listingId} ikut disesuaikan.` : ''),
    );
    return {
      corrected: changes,
      listingUpdated,
      ...(await this.byId(id)),
    };
  }

  /* ══════════════════════════════ 7. PEMBACAAN ══════════════════════════════ */

  /**
   * ╔════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ `omit: { claimCodeHash: true }` — DIPASANG DI SETIAP PEMBACAAN DI FILE INI.            ║
   * ╚════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * `include` mengembalikan SELURUH kolom skalar baris itu, jadi tanpa `omit` hash kode klaim
   * ikut terbang ke browser — di rute admin MAUPUN di rute pemilik. Hash-nya bukan kode dan tidak
   * bisa dibalik, tapi ia satu-satunya bagian dari sebuah rahasia hidup yang tersimpan, dan tidak
   * ada satu pun pembaca yang membutuhkannya. `omit` dipilih alih-alih membuang field sesudahnya
   * karena ia juga MENGHAPUSNYA DARI TIPE: penambah field baru di serializer tidak bisa
   * mengembalikannya tanpa sadar. (Bandingkan `listUsers` di admin.service.ts, yang mencantumkan
   * kolomnya satu per satu supaya `nonce`/`passwordHash` tidak pernah ikut.)
   *
   * `claimCodeIssuedAt` / `claimCodeExpiresAt` SENGAJA TETAP DIKIRIM: keduanya bukan rahasia, dan
   * justru merekalah yang memberi tahu operator kapan sebuah kode perlu diterbitkan ulang.
   */
  private static readonly OMIT_SECRETS = { claimCodeHash: true } as const;

  /** Satu titipan, lengkap dengan bukti dan riwayatnya. */
  async byId(id: string) {
    const row = await this.prisma.consignment.findUnique({
      where: { id },
      omit: ConsignmentService.OMIT_SECRETS,
      include: {
        photos: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        listing: true,
        // Relasi OPSIONAL sejak titipan bisa diterima dari orang tanpa akun: `consignor` BISA
        // null di sini, dan frontend wajib menanganinya lewat `ownerLinked` di bawah, bukan
        // dengan menebak dari ada-tidaknya objek ini.
        consignor: {
          select: { id: true, displayName: true, walletAddress: true },
        },
        receivedBy: {
          select: { id: true, displayName: true, walletAddress: true },
        },
      },
    });
    if (!row) throw new NotFoundException('Titipan tidak ditemukan.');
    return { ...row, ...this.custodyFlags(row) };
  }

  /** Titipan milik user login. Rute PEMILIK — ia berhak melihat buktinya sendiri. */
  async listMine(userId: string) {
    const rows = await this.prisma.consignment.findMany({
      // `userId` selalu non-null, jadi baris yang BELUM tertaut (consignorId null) tidak pernah
      // muncul di sini — dan itu benar: sebelum kode klaimnya ditukarkan, tidak ada akun yang
      // berhak mengatakan baris ini miliknya. Inilah juga yang membuat penukaran kode terasa
      // sebagai jawaban: sesudahnya, kartunya muncul di sini.
      where: { consignorId: userId },
      omit: ConsignmentService.OMIT_SECRETS,
      include: {
        photos: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
        listing: {
          select: { id: true, status: true, priceIdrx: true, image: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    // ╔════════════════════════════════════════════════════════════════════════════════════════╗
    // ║ LISTING YANG SUDAH MATI TIDAK IKUT KELUAR DARI SINI.                                  ║
    // ╚════════════════════════════════════════════════════════════════════════════════════════╝
    //
    // `Listing.consignmentId` @unique, jadi relasi ini 1-1 dan baris listing yang sama DIPAKAI
    // ULANG saat kartunya dipajang lagi. Akibatnya sebuah titipan yang pemiliknya tarik dari
    // pajangan tetap menggendong baris listing CANCELLED — lengkap dengan HARGA PAJANG
    // TERAKHIRNYA, yang bisa jauh di bawah `askPriceIdr` di struk bertanda tangan yang dipegang
    // pemiliknya. Selama baris itu ikut terkirim, layar mana pun bisa membacanya sebagai "harga
    // yang disepakati" dan menunjukkan angka yang LEBIH RENDAH daripada yang ada di kertasnya.
    //
    // Dipotong DI SUMBERNYA, bukan di satu layar: harga pajang hanya berarti selama pajangannya
    // HIDUP, dan tautan "lihat di marketplace" ke listing yang sudah dibatalkan juga bukan
    // tautan — ia jalan buntu. `custodyFlags(r)` sengaja dihitung dari baris ASLI (di situ
    // `effectivePriceIdr` memang sudah jatuh ke `askPriceIdr` untuk listing non-ACTIVE), jadi
    // tidak ada bendera yang ikut berubah arti karenanya.
    return rows.map((r) => ({
      ...r,
      ...this.custodyFlags(r),
      listing: r.listing?.status === ListingStatus.CANCELLED ? null : r.listing,
    }));
  }

  /**
   * EMPAT JAWABAN YANG BERBEDA, dan keempatnya dikirim terpisah supaya frontend tidak perlu
   * menyimpulkan salah satunya dari yang lain:
   *
   *   inCustody           kartunya ADA di rak Hoshi dan boleh dijual (gerbang custody).
   *   ownerLinked         kita TAHU siapa yang dibayar kalau ia terjual.
   *   awaitingOwnerClaim  pemiliknya belum tertaut DAN penautan itu masih berarti sesuatu yang
   *                       belum Hoshi tunaikan — definisinya `isAwaitingConsignorClaim` di gate,
   *                       satu-satunya tempat ia ditulis (SQL-nya `awaitingConsignorWhere`).
   *   belowReserve        harga yang berlaku SEKARANG ada di bawah lantai yang disepakati pemilik.
   *
   * `inCustody && !ownerLinked` adalah kombinasi yang dulu MUSTAHIL dan sekarang normal: kartu
   * ada di tangan kita, dan ia tetap tidak boleh dipajang. UI yang menampilkan tombol "Pajang"
   * berdasarkan `inCustody` saja akan menawarkan aksi yang pasti ditolak.
   *
   * `belowReserve` MEMBACA HARGA LISTING kalau listing-nya masih ACTIVE, dan baru jatuh kembali
   * ke `askPriceIdr` kalau tidak ada listing yang tayang — karena yang dilihat pembeli, dan
   * karena itu yang benar-benar mengikat pemiliknya, adalah angka di baris listing. `reservePriceIdr`
   * sendiri ikut terkirim apa adanya di setiap baris (semua kolom skalar ikut di `byId`,
   * `listMine`, dan `adminList`), jadi layar bisa menampilkan ANGKANYA, bukan cuma benderanya.
   */
  private custodyFlags(
    r: {
      id: string;
      status: ConsignmentStatus;
      custodyAcceptedAt: Date | null;
      custodyReleasedAt: Date | null;
      consignorId: string | null;
      askPriceIdr: number;
      reservePriceIdr: number | null;
      listing?: { status: ListingStatus; priceIdrx: number } | null;
      withdrawRequestedAt?: Date | null;
    } & ConsignmentReturnFacts,
  ) {
    const ownerLinked = isConsignorLinked(r);
    const livePrice =
      r.listing && r.listing.status === ListingStatus.ACTIVE
        ? r.listing.priceIdrx
        : null;
    return {
      inCustody: isInHoshiCustody(r),
      ownerLinked,
      awaitingOwnerClaim: isAwaitingConsignorClaim(r),
      /** Boleh dipajang HANYA kalau KEDUA pertanyaan terjawab ya. */
      listable:
        isInHoshiCustody(r) &&
        ownerLinked &&
        r.status === ConsignmentStatus.IN_CUSTODY,
      /** Harga yang berlaku (listing tayang kalau ada, kalau tidak harga kesepakatan). */
      effectivePriceIdr: livePrice ?? r.askPriceIdr,
      belowReserve:
        r.reservePriceIdr != null &&
        (livePrice ?? r.askPriceIdr) < r.reservePriceIdr,

      /* ── PENGEMBALIAN: DUA JAWABAN LAGI, DAN KEDUANYA MEMANG TERPISAH ──────────────────────
         returnAddressComplete  alamat pengembaliannya lengkap menurut SATU-SATUNYA definisi
                                yang ada (`isReturnAddressComplete` di gate). Relevan HANYA untuk
                                metode COURIER.
         returnPlanReady        kita tahu CUKUP untuk berani melepas custody: PICKUP selalu siap,
                                COURIER siap kalau alamatnya lengkap.

         KENAPA DIKIRIM SERVER DAN BUKAN DITURUNKAN UI. Layar admin yang menghitung sendiri
         "alamatnya lengkap?" adalah SALINAN KEDUA dari aturan yang sudah hidup di gate dan di
         CHECK database — dan salinan kedua berarti salah satunya akan diam-diam salah, lalu
         menawarkan tombol "Catat kartu keluar" yang pasti ditolak sambil pemilik kartunya
         menunggu di depan meja. */
      returnAddressComplete: isReturnAddressComplete(r),
      returnPlanReady: isReturnPlanReady(r),
      /** Ditarik tapi kartunya MASIH di rak kami — keadaan yang tidak boleh hilang dari layar. */
      returnPending:
        r.withdrawRequestedAt != null && r.custodyReleasedAt == null,
    };
  }

  /**
   * Dashboard admin. `actionRequired` adalah intinya: pola "surface it or it's invisible" yang
   * sama dengan `listUnsellableStock`. Barang orang lain yang tergeletak tanpa ada yang melihat
   * adalah cara paling umum sebuah janji custody diingkari tanpa siapa pun berniat begitu.
   */
  async adminList(status?: ConsignmentStatus, filter?: 'AWAITING_OWNER') {
    const rows = await this.prisma.consignment.findMany({
      where: {
        ...(status ? { status } : {}),
        // Filter eksplisit "tampilkan yang menunggu pemiliknya". Satu definisi dengan
        // `awaitingConsignorWhere()` di gate, supaya daftar dan hitungannya tidak bisa melenceng.
        ...(filter === 'AWAITING_OWNER' ? awaitingConsignorWhere() : {}),
      },
      omit: ConsignmentService.OMIT_SECRETS,
      include: {
        photos: { select: { id: true, kind: true, url: true } },
        // `buyerId` ikut DENGAN SENGAJA: ia salah satu dari tiga fakta yang menjawab "kartu ini
        // sudah punya pembeli yang membayar?" (`isConsignmentSoldToBuyer`), dan jawabannya
        // menentukan SIAPA yang harus dipulihkan kalau kartunya hilang. Tanpa kolom ini,
        // `actionRequired` akan menyuruh membayar pemilik untuk kartu yang pemiliknya sudah
        // dibayar.
        listing: {
          select: { id: true, status: true, priceIdrx: true, buyerId: true },
        },
        // BISA null sejak titipan boleh diterima dari orang tanpa akun. Kolom snapshot
        // `consignorNameAtIntake`/`consignorPhoneAtIntake` ikut terkirim di baris yang sama dan
        // SELALU terisi — itulah yang dipakai operator untuk menghubungi orangnya.
        consignor: {
          select: { id: true, displayName: true, walletAddress: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const now = Date.now();
    const staleBefore = new Date(now - STALE_INTAKE_DAYS * 24 * 60 * 60 * 1000);
    const unlinkedStaleBefore = new Date(
      now - UNLINKED_CUSTODY_DAYS * 24 * 60 * 60 * 1000,
    );

    /* ══════════ DUA PEMBACAAN TAMBAHAN — KEDUANYA MENJAWAB "APA YANG MASIH KAMI UTANGI" ══════
       Keduanya dibaca DARI FAKTA, bukan dari status baris titipannya, karena justru statusnyalah
       yang berbohong di kedua kasus: LOST terbaca "selesai" padahal ganti ruginya belum dibayar
       sepeser pun, dan SOLD terbaca "beres" padahal custody-nya tidak pernah ditutup. */

    /** Titipan LOST yang ganti ruginya SUDAH tercatat di ledger → yang tidak ada di sini, belum. */
    const compensatedIds = new Set<string>();
    const lostIds = rows
      .filter((r) => r.status === ConsignmentStatus.LOST)
      .map((r) => r.id);
    if (lostIds.length > 0) {
      const entries = await this.prisma.balanceEntry.findMany({
        where: {
          reason: CONSIGNMENT_COMPENSATION_REASON,
          refId: { in: lostIds },
        },
        select: { refId: true },
      });
      for (const e of entries) if (e.refId) compensatedIds.add(e.refId);
    }

    /**
     * Baris SOLD yang paketnya SUDAH berangkat menurut jalur kirim, per `listingId`.
     *
     * Penutupan custody saat paket berangkat bersifat BEST-EFFORT di luar transaksi (lihat
     * admin.service.ts, PATCH redemption → SHIPPED): kalau tulisannya gagal, kegagalannya hanya
     * hidup di satu baris log yang tidak dibaca siapa pun, dan catatan titipan orang lain tetap
     * berbunyi "masih di rak Hoshi" selamanya. Pembacaan ini yang memunculkannya kembali.
     *
     * IN_TRANSIT & DELIVERED ikut, bukan cuma SHIPPED: ketiganya sama-sama berarti paketnya
     * SUDAH keluar dari tangan Hoshi, dan baris yang terlanjur maju ke status berikutnya justru
     * yang paling lama tertinggal.
     */
    const shippedByListingId = new Map<string, string>();
    const openSoldListingIds = rows
      .filter(
        (r) =>
          r.status === ConsignmentStatus.SOLD &&
          r.custodyReleasedAt == null &&
          r.listing != null,
      )
      .map((r) => r.listing!.id);
    if (openSoldListingIds.length > 0) {
      const shipped = await this.prisma.cardRedemption.findMany({
        where: {
          listingId: { in: openSoldListingIds },
          status: {
            in: [
              RedemptionStatus.SHIPPED,
              RedemptionStatus.IN_TRANSIT,
              RedemptionStatus.DELIVERED,
            ],
          },
        },
        select: { id: true, listingId: true, status: true },
      });
      for (const s of shipped) {
        if (s.listingId) {
          shippedByListingId.set(s.listingId, `${s.id} (${s.status})`);
        }
      }
    }

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
        // ── KARTUNYA DI RAK KITA DAN KITA BELUM TAHU SIAPA PEMILIKNYA ────────────────────
        //
        // SENGAJA DIPISAH dari alasan INTAKE di atas dan SENGAJA berambang lebih pendek. Ini
        // bukan "kesepakatan yang menggantung" melainkan BARANG ORANG LAIN YANG SUDAH ADA DI
        // TANGAN KITA tanpa siapa pun di sisi sistem yang bisa dihubungi. Kalimatnya menyebut
        // pemulihannya, dan TIDAK menyebut custody — kartunya sudah ada, yang kurang orangnya.
        if (
          isPhysicallyHeldByHoshi(r) &&
          !isConsignorLinked(r) &&
          r.createdAt < unlinkedStaleBefore
        ) {
          reasons.push(
            `Kartunya ADA di rak Hoshi tapi pemiliknya BELUM tertaut akun setelah lebih dari ` +
              `${UNLINKED_CUSTODY_DAYS} hari — tidak bisa dipajang, dan kalau sampai hilang, ` +
              `ganti ruginya tidak punya tujuan. Hubungi ${r.consignorNameAtIntake} di ` +
              `${r.consignorPhoneAtIntake}: minta ia menukarkan kode klaimnya, atau tautkan ` +
              'akunnya setelah identitasnya diperiksa.',
          );
        }
        // ── HARGA TAYANG DI BAWAH LANTAI YANG DISEPAKATI PEMILIK ────────────────────────
        //
        // Bukan penolakan (lihat `belowReserveWarning`) — tapi selama kartunya MASIH tayang di
        // bawah angka itu, keadaannya masih berlangsung, jadi ia harus tetap terlihat. Hanya
        // untuk listing yang ACTIVE: harga listing yang sudah SOLD/CANCELLED tidak bisa diapa-
        // apakan lagi, dan menyalakan peringatan untuknya cuma kebisingan.
        if (
          r.reservePriceIdr != null &&
          r.listing != null &&
          r.listing.status === ListingStatus.ACTIVE &&
          r.listing.priceIdrx < r.reservePriceIdr
        ) {
          reasons.push(
            `Terpajang Rp ${r.listing.priceIdrx}, DI BAWAH harga terendah yang disepakati ` +
              `pemilik (reserve Rp ${r.reservePriceIdr}). Pastikan pemiliknya memang setuju — ` +
              'angka reserve bagian dari perjanjian bertanda tangan. Kalau belum, naikkan lagi ' +
              'lewat PATCH /admin/consignments/:id/price.',
          );
        }
        // Kode klaimnya kedaluwarsa dan pemiliknya masih belum tertaut → terbitkan ulang.
        //
        // Predikatnya `isAwaitingConsignorClaim`, BUKAN "bukan CANCELLED": kartu yang sudah
        // DIKEMBALIKAN (RELEASED) ke orang yang menyerahkannya tidak menunggu kode apa pun, dan
        // menerbitkan ulang untuknya hanya menyetel ulang jam 30 hari tanpa menyelesaikan apa pun.
        if (
          isAwaitingConsignorClaim(r) &&
          r.claimCodeExpiresAt != null &&
          r.claimCodeExpiresAt.getTime() <= now
        ) {
          reasons.push(
            'Kode klaimnya sudah KEDALUWARSA dan pemiliknya belum tertaut. Terbitkan ulang ' +
              '(POST /admin/consignments/:id/claim-code) lalu serahkan kodenya ke pemiliknya.',
          );
        }
        // ── PEMILIK SUDAH MINTA KARTUNYA KEMBALI, TAPI KARTUNYA MASIH DI RAK KITA ───────────
        //
        // Kalimatnya SENGAJA menyebut APA YANG KURANG, bukan sekadar "belum dicatat". Sebelum
        // rencana pengembalian punya kolom, baris ini hanya bisa berkata "atur serah-terimanya" —
        // dan operator yang membacanya tidak punya cara tahu apakah yang hilang adalah alamat,
        // nomor resi, atau tidak ada apa-apa dan tinggal menekan tombol. Peringatan yang tidak
        // menyebut langkah berikutnya adalah peringatan yang diajarkan untuk diabaikan.
        if (r.withdrawRequestedAt != null && r.custodyReleasedAt == null) {
          const base =
            'Pemilik minta kartunya kembali; kartunya MASIH di rak Hoshi dan serah-terima ' +
            'pengembaliannya BELUM dicatat.';
          if (r.returnMethod == null) {
            reasons.push(
              `${base} Cara pengembaliannya juga belum ditentukan — tanyakan ke pemiliknya: ` +
                'diambil sendiri, atau dikirim kurir (butuh alamat lengkap + ongkir)?',
            );
          } else if (!isReturnPlanReady(r)) {
            reasons.push(
              `${base} Alamat pengembaliannya BELUM LENGKAP (kurang: ` +
                `${missingReturnAddressFields(r).join(', ')}), jadi kartu ini tidak akan bisa ` +
                'ditandai terkirim sampai dilengkapi.',
            );
          } else if (r.returnShippingPayer == null) {
            reasons.push(
              `${base} Tujuannya sudah jelas; yang belum adalah SIAPA yang menanggung ongkir ` +
                'baliknya — catat sekarang, supaya ongkos yang ditanggung Hoshi tidak jadi ' +
                'kebocoran yang tidak terlihat di laporan mana pun.',
            );
          } else {
            reasons.push(
              `${base} Tujuan dan ongkirnya sudah lengkap — tinggal kirim/serahkan, lalu catat ` +
                'resi (atau siapa yang mengambil) di rute pelepasan custody.',
            );
          }
        }
        // ── KARTU HILANG YANG GANTI RUGINYA BELUM DIBAYAR SEPESER PUN ────────────────────
        //
        // Begitu admin mencatat LOST, barisnya pindah ke tab "Selesai / hilang" — dan di sanalah
        // ia berhenti dilihat siapa pun. Padahal LOST bukan akhir apa pun: ia titik ketika Hoshi
        // MULAI BERUTANG. Sebuah tab berlabel "Selesai" yang memuat utang yang belum dibayar
        // adalah cara paling rapi untuk melupakan janji tertulis kepada pemilik kartu.
        //
        // Kalimatnya MENYEBUT NOMINAL YANG DIJANJIKAN STRUK (`askPriceIdr`) karena itulah dasar
        // ganti ruginya (lihat `compensate`) — peringatan yang tidak menyebut angkanya menyuruh
        // operator mencari sendiri apa yang harus dibayar, dan itu langkah yang akan dilewati.
        if (r.status === ConsignmentStatus.LOST && !compensatedIds.has(r.id)) {
          reasons.push(
            isConsignmentSoldToBuyer(r)
              ? `HILANG/RUSAK SESUDAH TERJUAL dan belum ada pemulihan yang tercatat. Pemiliknya ` +
                  `sudah menerima payout Rp ${r.payoutIdrx ?? 0}; yang memegang NOL kartu dan NOL ` +
                  `Rupiah adalah PEMBELI (order ${r.soldOrderId ?? '(tidak tercatat)'}). Utangnya ` +
                  'ada di baris pembayaran itu sebagai REFUND_DUE — buka /admin/transactions, ' +
                  'verifikasi, lalu kembalikan Rupiah-nya ke pembeli. JANGAN mengkredit pemilik.'
              : `HILANG/RUSAK tapi GANTI RUGINYA BELUM TERCATAT. Struk serah terima yang ` +
                  `ditandatangani kedua pihak menjanjikan Rp ${r.askPriceIdr.toLocaleString('id-ID')} ` +
                  '(harga jual yang disepakati). Kartunya milik orang lain, dan ini janji ' +
                  'tertulis, bukan kebijakan yang bisa ditunda. ' +
                  // Kalimat yang menyuruh membayar padahal pembayarannya PASTI ditolak adalah
                  // kalimat yang mengajari operator mengabaikan daftar ini. Titipan tanpa
                  // pemilik tertaut tidak punya akun untuk dikredit — yang dibutuhkan lebih
                  // dulu adalah menelepon orangnya, bukan menekan tombol bayar.
                  (isConsignorLinked(r)
                    ? 'Bayar lewat POST /admin/consignments/:id/compensate.'
                    : `Pemiliknya BELUM tertaut akun, jadi ganti ruginya belum punya tujuan: ` +
                      `hubungi ${r.consignorNameAtIntake} di ${r.consignorPhoneAtIntake}, ` +
                      'tautkan akunnya, BARU bayar.'),
          );
        }
        // Sudah terjual, tapi pembeli belum meminta pengiriman — kartunya masih di rak kita.
        if (
          r.status === ConsignmentStatus.SOLD &&
          r.custodyReleasedAt == null
        ) {
          // ── PAKETNYA SUDAH BERANGKAT TAPI CUSTODY-NYA TIDAK PERNAH DITUTUP ─────────────
          //
          // Penutupan custody saat paket diserahkan ke kurir BEST-EFFORT di luar transaksi
          // (admin.service.ts, PATCH redemption → SHIPPED), jadi kegagalannya cuma hidup di log.
          // Akibatnya catatan titipan orang lain berbunyi "masih di rak Hoshi" untuk kartu yang
          // sudah di tangan pembelinya — kebalikan dari kenyataan, di satu-satunya tempat yang
          // dijadikan rujukan kalau nanti ada sengketa.
          const shipment = r.listing
            ? shippedByListingId.get(r.listing.id)
            : undefined;
          reasons.push(
            shipment
              ? `Paketnya SUDAH berangkat (redemption ${shipment}) tapi custody titipan ini ` +
                  'TIDAK PERNAH ditutup — `custodyReleasedAt` masih kosong, jadi catatan ini ' +
                  'masih berbunyi "kartunya di rak Hoshi" untuk kartu yang sudah di tangan ' +
                  'pembelinya. Tutup sekarang lewat POST /admin/consignments/:id/release ' +
                  '(SHIPPED_TO_BUYER).'
              : 'Sudah TERJUAL tapi kartunya masih di rak Hoshi (pembeli belum minta kirim).',
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

    /**
     * ╔══════════════════════════════════════════════════════════════════════════════════════╗
     * ║ SEKILAS: KARTU DI TANGAN KITA YANG MASIH MENUNGGU PEMILIKNYA.                        ║
     * ╚══════════════════════════════════════════════════════════════════════════════════════╝
     *
     * TERPISAH dari `actionRequired` DENGAN SENGAJA. `actionRequired` hanya menyala setelah
     * ambang waktu terlewat — sedangkan daftar ini menampilkan SEMUANYA, sejak hari pertama,
     * karena pertanyaan "kartu siapa saja yang saya pegang tanpa tahu pemiliknya" harus bisa
     * dijawab SEKARANG, bukan seminggu lagi.
     *
     * Tiap baris memuat nama & telepon dari snapshot serah-terima (satu-satunya cara menghubungi
     * orangnya saat belum ada akun) dan keadaan kode klaimnya, supaya operator tahu apakah yang
     * dibutuhkan adalah menelepon atau menerbitkan ulang.
     */
    const awaitingOwner = rows
      // SATU definisi dengan `awaitingConsignorWhere()` yang dipakai filter SQL di atas, dan
      // dengan flag `awaitingOwnerClaim` per baris. Ketiganya memanggil fungsi yang SAMA, jadi
      // hitungan badge, isi daftar, dan bendera di barisnya tidak bisa saling bertentangan.
      .filter((r) => isAwaitingConsignorClaim(r))
      .map((r) => ({
        id: r.id,
        cardName: r.cardName,
        status: r.status,
        /** Kartunya benar-benar di rak kita (bukan sekadar kesepakatan yang dicatat). */
        heldByHoshi: isPhysicallyHeldByHoshi(r),
        storageLocation: r.storageLocation,
        receivedAtPlace: r.receivedAtPlace,
        consignorNameAtIntake: r.consignorNameAtIntake,
        consignorPhoneAtIntake: r.consignorPhoneAtIntake,
        claimCodeIssuedAt: r.claimCodeIssuedAt,
        claimCodeExpiresAt: r.claimCodeExpiresAt,
        claimCodeExpired:
          r.claimCodeExpiresAt != null && r.claimCodeExpiresAt.getTime() <= now,
        /** Tidak ada kode hidup sama sekali → satu-satunya jalan adalah menerbitkan ulang. */
        needsClaimCode: r.claimCodeExpiresAt == null,
        createdAt: r.createdAt,
      }));

    return {
      total: rows.length,
      rows: rows.map((r) => ({ ...r, ...this.custodyFlags(r) })),
      actionRequired,
      awaitingOwner,
      /** Angka untuk badge: berapa kartu yang dipegang Hoshi tanpa pemilik tertaut. */
      awaitingOwnerCount: awaitingOwner.length,
    };
  }

  /* ══════════════════════════════ internal ══════════════════════════════ */

  /**
   * Baris titipan untuk dipakai DI DALAM service ini.
   *
   * SENGAJA TIDAK memakai `OMIT_SECRETS`, tidak seperti `byId`/`listMine`/`adminList`: hasilnya
   * TIDAK PERNAH dikembalikan ke client (setiap rute menutup dengan `this.byId(...)`, yang
   * mengomit), dan `issueClaimCode` MEMBUTUHKAN `claimCodeHash` untuk tahu apakah ia sedang
   * menerbitkan atau MENERBITKAN ULANG. Kalau suatu saat ada rute yang mengembalikan baris ini apa
   * adanya, ia WAJIB mengomit dulu.
   */
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
