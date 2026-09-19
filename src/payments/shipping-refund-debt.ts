import { Logger } from '@nestjs/common';
import { PaymentStatus, RedemptionStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * B1 — MEMBATALKAN SEBUAH REDEMPTION TIDAK BOLEH MENELAN INVOICE ONGKIRNYA.
 *
 * KENAPA FILE INI ADA. Baris redemption yang dibatalkan lewat rute-rute pra-danai itu sendiri NOL
 * uang: ongkir Rupiah — kalau sudah dibayar — hidup di baris PaymentOrder, bukan di baris
 * redemption. Jadi membatalkan redemption AMAN. Yang TIDAK aman adalah membatalkannya lalu
 * membiarkan order ongkirnya menggantung di status yang tidak akan pernah bergerak lagi: itu
 * menukar "kartu terkunci selamanya" dengan "uang hilang diam-diam" — bug yang lebih mahal.
 *
 * Maka SETIAP jalur pembatalan (user maupun admin) WAJIB memanggil helper ini SESUDAH tulisan
 * pembatalannya berhasil. Ia menerjemahkan order ongkir yang tersangkut menjadi UTANG YANG
 * TERCATAT, dan MELAPORKAN semuanya — yang diubahnya sendiri maupun yang memang sudah tercatat.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ B1 (RONDE INI) — DUA RAIL MEMBERI ARTI YANG BERBEDA PADA `FULFILLED`. INI INTINYA.           ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 * Dulu helper ini hanya mengenal SATU status yang bisa tersangkut (FULFILLING), karena di rail CC
 * `fulfilShipping` memindahkan redemption AWAITING_PAYMENT → READY_TO_FUND: sebuah order ongkir
 * FULFILLED di sana berarti redemption-nya SEHARUSNYA READY_TO_FUND, dan "FULFILLED + dibatalkan"
 * memang kombinasi yang mustahil.
 *
 * Di rail DOMESTIK artinya TERBALIK. `fulfilShipping` menulis order FULFILLED dan redemption
 * PACKING dalam SATU transaksi (payments.service.ts, fulfilShipping). Jadi setiap baris domestik
 * yang ongkirnya lunas PASTI punya order FULFILLED — dan `PACKING → CANCELED` adalah transisi
 * admin yang SAH (admin.service.ts, tabel `allowed`) dan satu klik di dashboard. "FULFILLED +
 * dibatalkan" di rail ini BUKAN anomali: ia adalah HASIL NORMAL dari pembatalan admin, dan ia
 * adalah UTANG REFUND yang nyata. Sebelum perbaikan ini: NOL tulisan DB, order tetap FULFILLED,
 * dan Rupiah ongkir user tidak muncul di SATU PUN daftar kerja refund (bukan di alert REFUND_DUE
 * milik reconciler, bukan di /admin/transactions) — jejaknya cuma satu baris log.
 *
 * ┌──────────────── APA YANG TERJADI PADA TIAP STATUS ORDER ONGKIR ─────────────────────────────┐
 * │ PENDING     : nol Rupiah mendarat. Invoice-nya kedaluwarsa sendiri. TIDAK disentuh & TIDAK  │
 * │               dilaporkan (bukan utang).                                                     │
 * │ PAID        : Rupiah mendarat, klaim fulfilment belum diambil. SEMBUH SENDIRI — reconciler   │
 * │               memindai PAID, verifyAndFulfil mengklaimnya, fulfilShipping mendapat count!==1 │
 * │               (redemption sudah CANCELED) → failToRefund → REFUND_DUE refundSafe=true.       │
 * │               Berlaku di KEDUA rail. TIDAK disentuh di sini (jangan mendahului mesin yang    │
 * │               memang bekerja), TAPI DILAPORKAN + di-log supaya operator tahu ada Rupiah yang │
 * │               sedang jadi utang.                                                            │
 * │ FULFILLING  : KEDUA RAIL. Klaim atomik sudah diambil lalu prosesnya mati (deploy/OOM/        │
 * │               restart). Reconciler SENGAJA tidak menebus ulang order FULFILLING (risiko      │
 * │               dobel-bayar treasury) — ia hanya melaporkannya. Dan sesudah redemption-nya     │
 * │               CANCELED, fulfilShipping tidak akan pernah jalan lagi, jadi tidak ada satu pun │
 * │               proses yang akan mengubahnya jadi REFUND_DUE. Helper ini yang mengubahnya.     │
 * │ FULFILLED   : ARTINYA BERGANTUNG RAIL.                                                      │
 * │               • CC_VAULT      : ongkirnya SUDAH dilayani (redemption seharusnya             │
 * │                                 READY_TO_FUND, bukan dibatalkan). Tidak disentuh;            │
 * │                                 DILAPORKAN keras — butuh mata manusia. Kalimatnya TIDAK      │
 * │                                 BERUBAH: di rail ini ia memang masih benar.                  │
 * │               • HOSHI_DOMESTIC: ongkir LUNAS, paket BELUM diserahkan ke kurir. UTANG REFUND  │
 * │                                 YANG NYATA → DIUBAH jadi REFUND_DUE di sini.                 │
 * │ REFUND_DUE  : utangnya SUDAH tercatat (mis. pin order menyimpang). Tidak disentuh; dilaporkan│
 * │               apa adanya supaya operator melihatnya di respons pembatalan, bukan cuma di log.│
 * │ EXPIRED /   : nol Rupiah mendarat (EXPIRED = vonis IDRX sendiri). Tidak disentuh, tidak      │
 * │ FAILED        dilaporkan.                                                                   │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ POSISI `refundSafe` — DIBACA, TIDAK PERNAH DITULIS. Juga di rail domestik.                   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 * Di rail DOMESTIK, "uangnya memang boleh dikembalikan" adalah pernyataan yang BENAR dan berbeda
 * kelas dari kasus pasca-danai rail CC: `fulfilShipping` domestik tidak menyentuh treasury sama
 * sekali (nol USDC, nol SOL, nol burn, nol panggilan CC — ia cuma menggerakkan dua status), dan
 * pembatalan hanya sah dari status PRA-SERAH-TERIMA (lihat `PRE_HANDOVER_STATUSES` di bawah, yang
 * DIPERIKSA dan bukan diasumsikan). Jadi kedua syarat `refundSafe=true` — "uangnya ada pada kami"
 * dan "barangnya belum diserahkan" — memang terpenuhi.
 *
 * Tapi "memang seharusnya true" BUKAN alasan untuk MENULISNYA. Satu-satunya cara sebuah order
 * ongkir domestik bisa berstatus refundSafe=false adalah `markProvenDeviationRefundDue` (pin IDRX
 * TERBUKTI menyimpang → Rupiah-nya tidak terbukti mendarat di treasury kami). Menulis `true` di
 * sini akan MENGHAPUS peringatan itu dan menyuruh operator mengirim uang yang belum tentu pernah
 * kita terima. Maka: nilai yang dilaporkan adalah nilai yang BENAR-BENAR ADA di baris, dan
 * `refundSafe` sengaja TIDAK ADA di `data` tulisan mana pun di file ini.
 */

/** Rail sebuah baris redemption — DITURUNKAN dari kolom `listingId` yang persisten & immutable. */
export type ShippingRefundRail = 'HOSHI_DOMESTIC' | 'CC_VAULT';

/** Status order ongkir yang berarti Rupiah-nya sudah/mungkin mendarat → wajib dilaporkan. */
const REPORTABLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FULFILLING,
  PaymentStatus.FULFILLED,
  PaymentStatus.REFUND_DUE,
];

/**
 * Status order ongkir yang helper ini ubah jadi REFUND_DUE, PER RAIL. Sempit DENGAN SENGAJA.
 *
 * CC_VAULT       : FULFILLING saja — satu-satunya status yang, sesudah redemption-nya batal, tidak
 *                  punya satu pun proses yang akan menggerakkannya.
 * HOSHI_DOMESTIC : FULFILLING + FULFILLED. FULFILLED ikut karena di rail ini ia berarti "ongkir
 *                  lunas, paket belum jalan" dan sesudah CANCELED tidak ada apa pun yang akan
 *                  menyentuhnya lagi (fulfilShipping hanya berjalan dari AWAITING_PAYMENT).
 */
const CONVERTIBLE_STATUSES: Record<ShippingRefundRail, PaymentStatus[]> = {
  CC_VAULT: [PaymentStatus.FULFILLING],
  HOSHI_DOMESTIC: [PaymentStatus.FULFILLING, PaymentStatus.FULFILLED],
};

/**
 * Status redemption yang membuktikan BARANGNYA BELUM DISERAHKAN saat pembatalan terjadi.
 *
 * KENAPA DIPERIKSA DAN BUKAN DIASUMSIKAN. Klaim "aman di-refund" di rail domestik bersandar pada
 * dua hal: nol USDC bergerak (struktural, tidak bisa berubah) DAN paketnya belum diserahkan ke
 * kurir (kontingen pada TABEL TRANSISI admin). Hari ini tabel itu tidak mengizinkan
 * SHIPPED/DELIVERED → CANCELED, jadi kondisinya selalu benar. Kalau suatu hari seseorang menambah
 * rute itu, komentar tidak akan menahannya — predikat ini yang menahannya: order FULFILLED-nya
 * tidak akan diubah, dan operatornya akan melihat kalimat yang menyuruh memeriksa dulu.
 */
const PRE_HANDOVER_STATUSES: RedemptionStatus[] = [
  RedemptionStatus.REQUESTED,
  RedemptionStatus.AWAITING_PAYMENT,
  RedemptionStatus.PACKING,
];

const DEBT_ERROR_MAX = 500;

/** Baris order ongkir seperlunya — bentuk minimal supaya helper ini gampang diuji. */
interface ShippingOrderRow {
  merchantOrderId: string;
  priceIdr: number;
  status: PaymentStatus;
  refundSafe: boolean;
  userId: string;
}

/** Laporan satu order ongkir — dikembalikan ke pemanggil agar ikut tampil di respons API. */
export interface ShippingRefundDebt {
  merchantOrderId: string;
  priceIdr: number;
  /** Status sebelum helper ini jalan. */
  statusBefore: PaymentStatus;
  /** Status sesudahnya (sama dengan `statusBefore` kecuali kami yang mengubahnya). */
  statusAfter: PaymentStatus;
  /** DIBACA dari baris, tidak pernah ditulis. false = JANGAN refund (rugi dobel / belum terbukti). */
  refundSafe: boolean;
  /** true = panggilan INI yang menjadikannya REFUND_DUE. */
  recordedNow: boolean;
  /** Rail baris redemption-nya — supaya operator tidak perlu menebak kalimat mana yang berlaku. */
  rail: ShippingRefundRail;
  /** Kalimat yang dilihat operator. */
  operatorAction: string;
}

/**
 * Terjemahkan order ongkir milik redemption yang BARU SAJA dibatalkan menjadi utang yang tercatat.
 *
 * TIDAK PERNAH MELEMPAR: pembatalannya sudah commit, dan kegagalan pembukuan tidak boleh membuat
 * user melihat 500 atas aksi yang sudah berhasil. Setiap kegagalan tetap terbit di log ERROR.
 */
export async function recordShippingRefundDebts(args: {
  prisma: PrismaService;
  logger: Logger;
  redemptionId: string;
  /**
   * RAIL baris redemption-nya. WAJIB (bukan opsional) dengan sengaja: ia menentukan apakah sebuah
   * order FULFILLED adalah anomali atau utang, dan pemanggil baru harus DIPAKSA memutuskannya.
   * Turunkan dari `isDomesticRedemption(row)` — yaitu dari kolom `listingId`, bukan dari flag env.
   */
  rail: ShippingRefundRail;
  /** Status redemption TEPAT SEBELUM pembatalan — bukti "barangnya belum diserahkan". */
  canceledFromStatus: RedemptionStatus;
  /** Siapa yang membatalkan — ikut ditulis ke kolom `error` order supaya jejaknya durabel. */
  actor: string;
  /** Alasan singkat (user/admin). Ikut ditulis ke kolom `error`. */
  reason: string;
}): Promise<ShippingRefundDebt[]> {
  const {
    prisma,
    logger,
    redemptionId,
    rail,
    canceledFromStatus,
    actor,
    reason,
  } = args;

  let orders: ShippingOrderRow[];
  try {
    orders = (await prisma.paymentOrder.findMany({
      where: {
        redemptionId,
        packType: 'SHIPPING',
        status: { in: REPORTABLE_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    })) as unknown as ShippingOrderRow[];
  } catch (err) {
    logger.error(
      `Redemption ${redemptionId} DIBATALKAN tapi pembukuan order ongkirnya gagal dibaca: ` +
        `${errText(err)}. PERIKSA MANUAL: SELECT * FROM payment_orders WHERE "redemptionId" = ` +
        `${redemptionId}.`,
    );
    return [];
  }

  const preHandover = PRE_HANDOVER_STATUSES.includes(canceledFromStatus);
  const convertible = CONVERTIBLE_STATUSES[rail].filter(
    // FULFILLED hanya boleh diubah kalau paketnya TERBUKTI belum diserahkan. FULFILLING tidak
    // butuh syarat itu: ia berarti fulfilment-nya belum pernah selesai sama sekali.
    (s) => s !== PaymentStatus.FULFILLED || preHandover,
  );

  const out: ShippingRefundDebt[] = [];
  for (const order of orders ?? []) {
    if (!convertible.includes(order.status)) {
      out.push(
        describeUntouched(order, redemptionId, rail, canceledFromStatus, logger),
      );
      continue;
    }

    const message = debtMessage({
      rail,
      from: order.status,
      redemptionId,
      canceledFromStatus,
      actor,
      reason,
    });

    // Log DULU — utangnya harus terbit walaupun tulisan DB di bawah gagal.
    logger.error(
      `REFUND_DUE[ONGKIR KIRIM FISIK · ${rail}] ${order.merchantOrderId} (user ${order.userId}, ` +
        `Rp ${order.priceIdr}): ${message}`,
    );

    let statusAfter: PaymentStatus = order.status;
    let recordedNow = false;
    try {
      // BERPAGAR pada status yang KITA BACA: kalau fulfilShipping yang sedang berjalan menang
      // lebih dulu (ia sendiri memanggil failToRefund dengan predikat yang sama), tulisan ini jadi
      // no-op — SATU utang, bukan dua. `refundSafe` sengaja TIDAK ada di `data`.
      // `fulfilledAt` juga TIDAK dihapus: ongkir itu MEMANG pernah dilayani, dan menghapus
      // stempelnya menghilangkan satu-satunya bukti kapan Rupiah-nya diterima.
      const moved = await prisma.paymentOrder.updateMany({
        where: {
          merchantOrderId: order.merchantOrderId,
          status: order.status,
        },
        data: {
          status: PaymentStatus.REFUND_DUE,
          error: message.slice(0, DEBT_ERROR_MAX),
        },
      });
      recordedNow = moved.count === 1;
      statusAfter = recordedNow ? PaymentStatus.REFUND_DUE : order.status;
      if (!recordedNow) {
        // Pihak lain menang. Baca ulang supaya laporan menyebut keadaan yang BENAR, bukan tebakan.
        const fresh = await prisma.paymentOrder.findUnique({
          where: { merchantOrderId: order.merchantOrderId },
        });
        statusAfter = fresh?.status ?? order.status;
        logger.warn(
          `Order ongkir ${order.merchantOrderId}: penandaan REFUND_DUE dari pembatalan redemption ` +
            `${redemptionId} jadi no-op — baris sudah berpindah ke ${statusAfter} (fulfilment yang ` +
            'sedang berjalan menang duluan). Utangnya tetap tercatat di baris itu.',
        );
      }
    } catch (err) {
      logger.error(
        `Gagal menandai REFUND_DUE pada order ongkir ${order.merchantOrderId} sesudah redemption ` +
          `${redemptionId} dibatalkan: ${errText(err)}. Utangnya NYATA — tandai manual.`,
      );
    }

    out.push({
      merchantOrderId: order.merchantOrderId,
      priceIdr: order.priceIdr,
      statusBefore: order.status,
      statusAfter,
      refundSafe: order.refundSafe,
      recordedNow,
      rail,
      operatorAction: convertedOperatorAction(rail, order.refundSafe),
    });
  }
  return out;
}

/** Kalimat yang ditulis ke kolom `error` order DAN ke log — beda per rail, karena artinya beda. */
function debtMessage(args: {
  rail: ShippingRefundRail;
  from: PaymentStatus;
  redemptionId: string;
  canceledFromStatus: RedemptionStatus;
  actor: string;
  reason: string;
}): string {
  const { rail, from, redemptionId, canceledFromStatus, actor, reason } = args;
  const tail = `Alasan: ${reason}`;

  if (from === PaymentStatus.FULFILLED) {
    // Hanya mungkin di rail DOMESTIK (lihat CONVERTIBLE_STATUSES).
    return (
      `UTANG ONGKIR KIRIM DOMESTIK: redemption ${redemptionId} DIBATALKAN (${actor}) dari status ` +
      `${canceledFromStatus}, SESUDAH ongkir Rupiah-nya LUNAS. Di rail domestik fulfilShipping ` +
      `menandai order FULFILLED dan memindahkan redemption ke PACKING dalam SATU transaksi, jadi ` +
      `FULFILLED di sini berarti "ongkir dibayar, paket BELUM diserahkan ke kurir" — ini KEJADIAN ` +
      `NORMAL sesudah pembatalan admin, BUKAN anomali. NOL USDC/SOL treasury pernah bergerak di ` +
      `rail ini (nol burn, nol CollectorCrypt) dan NOL barang pernah berpindah. KEMBALIKAN ongkir ` +
      `Rupiah-nya ke user DI LUAR SISTEM. ${tail}`
    );
  }

  if (rail === 'HOSHI_DOMESTIC') {
    return (
      `UTANG ONGKIR KIRIM DOMESTIK: redemption ${redemptionId} DIBATALKAN (${actor}) dari status ` +
      `${canceledFromStatus} selagi order ini macet di FULFILLING — klaim fulfilment sudah diambil ` +
      `lalu prosesnya mati, dan fulfilShipping tidak akan pernah jalan lagi untuk baris yang sudah ` +
      `CANCELED. NOL USDC/SOL treasury pernah bergerak di rail ini. ${tail}`
    );
  }

  return (
    `UTANG ONGKIR KIRIM FISIK: redemption ${redemptionId} DIBATALKAN (${actor}) selagi order ini ` +
    `macet di FULFILLING — klaim fulfilment sudah diambil lalu prosesnya mati, dan fulfilShipping ` +
    `tidak akan pernah jalan lagi untuk baris yang sudah CANCELED. NOL USDC treasury pernah ` +
    `bergerak untuk order ongkir (fulfilShipping hanya menandai status). ${tail}`
  );
}

/** Kalimat aksi untuk order yang BARU SAJA kami jadikan REFUND_DUE. */
function convertedOperatorAction(
  rail: ShippingRefundRail,
  refundSafe: boolean,
): string {
  if (refundSafe) {
    return rail === 'HOSHI_DOMESTIC'
      ? 'KEMBALIKAN Rupiah ongkir ini ke user (di luar sistem). Rail DOMESTIK: nol USDC/SOL ' +
          'treasury pernah bergerak dan paketnya belum diserahkan ke kurir.'
      : 'KEMBALIKAN Rupiah ongkir ini ke user (di luar sistem). Nol USDC treasury pernah bergerak.';
  }
  // refundSafe=false di rail DOMESTIK hanya punya SATU sebab yang mungkin: pin IDRX menyimpang.
  // Rail ini tidak punya langkah pasca-belanja sama sekali, jadi "cek USDC on-chain" akan menyuruh
  // operator memeriksa sesuatu yang tidak pernah ada.
  return rail === 'HOSHI_DOMESTIC'
    ? 'refundSafe=false — JANGAN refund. Di rail DOMESTIK nol USDC pernah bergerak, jadi sebabnya ' +
        'PASTI pin IDRX yang TERBUKTI menyimpang: Rupiah-nya tidak terbukti mendarat di treasury ' +
        'kami. Verifikasi dulu di dashboard IDRX, bukan on-chain.'
    : 'refundSafe=false — JANGAN refund sebelum posisi USDC dicek on-chain.';
}

/** Order yang TIDAK kami sentuh: tetap dilaporkan supaya tidak ada uang yang lolos dari mata. */
function describeUntouched(
  order: ShippingOrderRow,
  redemptionId: string,
  rail: ShippingRefundRail,
  canceledFromStatus: RedemptionStatus,
  logger: Logger,
): ShippingRefundDebt {
  const domestic = rail === 'HOSHI_DOMESTIC';
  let operatorAction: string;
  switch (order.status) {
    case PaymentStatus.PAID:
      operatorAction =
        'Order masih PAID: reconciler akan mengklaimnya, lalu fulfilShipping mendapat count!==1 ' +
        '(redemption sudah CANCELED) dan menandainya REFUND_DUE sendiri. TIDAK perlu aksi ' +
        'sekarang — cek lagi setelah satu putaran reconciler; kalau masih PAID, tandai manual.';
      break;
    case PaymentStatus.FULFILLED:
      // Di rail DOMESTIK ini hanya tersisa untuk kasus PASCA-SERAH-TERIMA (paket sudah jalan),
      // yang tabel transisi admin hari ini tidak mengizinkan. Kalimatnya harus menyuruh berhenti.
      operatorAction = domestic
        ? 'Order sudah FULFILLED (ongkir LUNAS) dan pembatalan datang dari status ' +
          `${canceledFromStatus} — yaitu SESUDAH paketnya diserahkan. JANGAN refund dulu: ` +
          'pastikan paketnya benar-benar tidak sampai ke user (lacak resinya) sebelum ' +
          'mengembalikan ongkirnya, atau Anda membayar dua kali.'
        : // Rail CC: kalimat LAMA, dan di sini ia MASIH BENAR — fulfilShipping rail CC memindahkan
          // redemption ke READY_TO_FUND, jadi "FULFILLED tapi baris redemption-nya batal" memang
          // kombinasi yang tidak bisa dihasilkan satu pun jalur normal.
          'Order sudah FULFILLED (ongkirnya SUDAH dilayani) padahal redemption-nya belum lunas. ' +
          'Kombinasi ini seharusnya mustahil — periksa manual SEBELUM me-refund apa pun.';
      break;
    case PaymentStatus.REFUND_DUE:
      operatorAction = order.refundSafe
        ? 'Utang SUDAH tercatat sebelumnya (refundSafe=true) — kembalikan Rupiah-nya di luar sistem.'
        : domestic
          ? // Rail DOMESTIK tidak punya langkah pasca-belanja, jadi sebabnya cuma bisa satu.
            'Utang sudah tercatat TAPI refundSafe=false. Di rail DOMESTIK nol USDC pernah ' +
            'bergerak, jadi sebabnya PASTI PIN IDRX MENYIMPANG: Rupiah-nya tidak terbukti pernah ' +
            'kami terima. JANGAN refund — verifikasi dulu di dashboard IDRX.'
          : // B2 — refundSafe=false punya DUA sebab dan `error` menyebut yang mana DI DEPAN:
            // pasca-belanja (verifikasi ON-CHAIN) atau pin IDRX menyimpang (verifikasi di dashboard
            // IDRX, karena Rupiah-nya TIDAK TERBUKTI mendarat di treasury kami).
            'Utang sudah tercatat TAPI refundSafe=false — JANGAN refund. Baca kolom `error`: kalau ' +
            'PASCA-BELANJA, cek posisi USDC on-chain; kalau PIN MENYIMPANG, uangnya tidak terbukti ' +
            'pernah kami terima — verifikasi dulu di dashboard IDRX.';
      break;
    default:
      operatorAction = 'Tidak ada aksi.';
  }
  logger.error(
    `ONGKIR TERTINGGAL[${rail}] ${order.merchantOrderId} (user ${order.userId}, ` +
      `Rp ${order.priceIdr}, status ${order.status}, refundSafe=${order.refundSafe}): ` +
      `redemption ${redemptionId} DIBATALKAN dari ${canceledFromStatus}. ${operatorAction}`,
  );
  return {
    merchantOrderId: order.merchantOrderId,
    priceIdr: order.priceIdr,
    statusBefore: order.status,
    statusAfter: order.status,
    refundSafe: order.refundSafe,
    recordedNow: false,
    rail,
    operatorAction,
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
