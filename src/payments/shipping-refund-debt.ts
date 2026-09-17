import { Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * B1 — MEMBATALKAN REDEMPTION DI `AWAITING_PAYMENT` TIDAK BOLEH MENELAN INVOICE ONGKIR.
 *
 * KENAPA FILE INI ADA. `AWAITING_PAYMENT` berarti baris redemption-nya sendiri NOL uang: ongkir
 * Rupiah — kalau sudah dibayar — hidup di baris PaymentOrder, bukan di baris redemption. Jadi
 * membatalkan redemption AMAN. Yang TIDAK aman adalah membatalkannya lalu membiarkan order
 * ongkirnya menggantung di status yang tidak akan pernah bergerak lagi: itu menukar "kartu
 * terkunci selamanya" dengan "uang hilang diam-diam" — bug yang lebih mahal.
 *
 * Maka SETIAP jalur pembatalan (user maupun admin) WAJIB memanggil helper ini SESUDAH tulisan
 * pembatalannya berhasil. Ia menerjemahkan order ongkir yang tersangkut menjadi UTANG YANG
 * TERCATAT, dan MELAPORKAN semuanya — yang diubahnya sendiri maupun yang memang sudah tercatat.
 *
 * ┌──────────────── APA YANG TERJADI PADA TIAP STATUS ORDER ONGKIR ─────────────────────────────┐
 * │ PENDING     : nol Rupiah mendarat. Invoice-nya kedaluwarsa sendiri. TIDAK disentuh & TIDAK  │
 * │               dilaporkan (bukan utang).                                                     │
 * │ PAID        : Rupiah mendarat, klaim fulfilment belum diambil. SEMBUH SENDIRI — reconciler   │
 * │               memindai PAID, verifyAndFulfil mengklaimnya, fulfilShipping mendapat count!==1 │
 * │               (redemption sudah CANCELED) → failToRefund → REFUND_DUE refundSafe=true.       │
 * │               TIDAK disentuh di sini (jangan mendahului mesin yang memang bekerja), TAPI     │
 * │               DILAPORKAN + di-log supaya operator tahu ada Rupiah yang sedang jadi utang.    │
 * │ FULFILLING  : INI LUBANGNYA. Klaim atomik sudah diambil lalu prosesnya mati (deploy/OOM/     │
 * │               restart). Reconciler SENGAJA tidak menebus ulang order FULFILLING (risiko      │
 * │               dobel-bayar treasury) — ia hanya melaporkannya. Dan sesudah redemption-nya     │
 * │               CANCELED, fulfilShipping tidak akan pernah jalan lagi, jadi tidak ada satu pun │
 * │               proses yang akan mengubahnya jadi REFUND_DUE. Helper ini yang mengubahnya.     │
 * │ FULFILLED   : ongkirnya SUDAH dilayani (redemption seharusnya READY_TO_FUND, bukan           │
 * │               AWAITING_PAYMENT). Tidak disentuh; DILAPORKAN keras — butuh mata manusia.      │
 * │ REFUND_DUE  : utangnya SUDAH tercatat (mis. pin order menyimpang). Tidak disentuh; dilaporkan│
 * │               apa adanya supaya operator melihatnya di respons pembatalan, bukan cuma di log.│
 * │ EXPIRED /   : nol Rupiah mendarat (EXPIRED = vonis IDRX sendiri). Tidak disentuh, tidak      │
 * │ FAILED        dilaporkan.                                                                   │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * `refundSafe` TIDAK PERNAH DITULIS DI SINI — ia hanya DIBACA dan dilaporkan. Order ongkir yang
 * FULFILLING secara struktural PRA-belanja (fulfilShipping tidak pernah menyentuh treasury: ia
 * hanya menandai redemption READY_TO_FUND), jadi nilainya memang masih default `true`. Tapi
 * "memang seharusnya true" BUKAN alasan untuk MENULISNYA: kalau suatu hari ada jalur yang
 * menurunkannya ke false, menulis true di sini akan MENGHAPUS peringatan rugi-dobel itu. Kita
 * laporkan nilai yang BENAR-BENAR ada di baris.
 */

/** Status order ongkir yang berarti Rupiah-nya sudah/mungkin mendarat → wajib dilaporkan. */
const REPORTABLE_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.FULFILLING,
  PaymentStatus.FULFILLED,
  PaymentStatus.REFUND_DUE,
];

/**
 * SATU-SATUNYA status yang helper ini ubah. Sempit DENGAN SENGAJA: FULFILLING adalah satu-satunya
 * status yang, sesudah redemption-nya batal, tidak punya satu pun proses yang akan menggerakkannya.
 */
const CONVERTED_STATUS: PaymentStatus = PaymentStatus.FULFILLING;

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
  /** DIBACA dari baris, tidak pernah ditulis. false = JANGAN refund (rugi dobel). */
  refundSafe: boolean;
  /** true = panggilan INI yang menjadikannya REFUND_DUE. */
  recordedNow: boolean;
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
  /** Siapa yang membatalkan — ikut ditulis ke kolom `error` order supaya jejaknya durabel. */
  actor: string;
  /** Alasan singkat (user/admin). Ikut ditulis ke kolom `error`. */
  reason: string;
}): Promise<ShippingRefundDebt[]> {
  const { prisma, logger, redemptionId, actor, reason } = args;

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

  const out: ShippingRefundDebt[] = [];
  for (const order of orders ?? []) {
    if (order.status !== CONVERTED_STATUS) {
      out.push(describeUntouched(order, redemptionId, logger));
      continue;
    }

    const message =
      `UTANG ONGKIR KIRIM FISIK: redemption ${redemptionId} DIBATALKAN (${actor}) selagi order ini ` +
      `macet di FULFILLING — klaim fulfilment sudah diambil lalu prosesnya mati, dan fulfilShipping ` +
      `tidak akan pernah jalan lagi untuk baris yang sudah CANCELED. NOL USDC treasury pernah ` +
      `bergerak untuk order ongkir (fulfilShipping hanya menandai status). Alasan: ${reason}`;

    // Log DULU — utangnya harus terbit walaupun tulisan DB di bawah gagal.
    logger.error(
      `REFUND_DUE[ONGKIR KIRIM FISIK] ${order.merchantOrderId} (user ${order.userId}, ` +
        `Rp ${order.priceIdr}): ${message}`,
    );

    let statusAfter: PaymentStatus = order.status;
    let recordedNow = false;
    try {
      // BERPAGAR pada FULFILLING: kalau fulfilShipping yang sedang berjalan menang lebih dulu
      // (ia sendiri memanggil failToRefund dengan predikat yang sama), tulisan ini jadi no-op —
      // SATU utang, bukan dua. `refundSafe` sengaja TIDAK ada di `data`.
      const moved = await prisma.paymentOrder.updateMany({
        where: {
          merchantOrderId: order.merchantOrderId,
          status: CONVERTED_STATUS,
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
      operatorAction: order.refundSafe
        ? 'KEMBALIKAN Rupiah ongkir ini ke user (di luar sistem). Nol USDC treasury pernah bergerak.'
        : 'refundSafe=false — JANGAN refund sebelum posisi USDC dicek on-chain.',
    });
  }
  return out;
}

/** Order yang TIDAK kami sentuh: tetap dilaporkan supaya tidak ada uang yang lolos dari mata. */
function describeUntouched(
  order: ShippingOrderRow,
  redemptionId: string,
  logger: Logger,
): ShippingRefundDebt {
  let operatorAction: string;
  switch (order.status) {
    case PaymentStatus.PAID:
      operatorAction =
        'Order masih PAID: reconciler akan mengklaimnya, lalu fulfilShipping mendapat count!==1 ' +
        '(redemption sudah CANCELED) dan menandainya REFUND_DUE sendiri. TIDAK perlu aksi ' +
        'sekarang — cek lagi setelah satu putaran reconciler; kalau masih PAID, tandai manual.';
      break;
    case PaymentStatus.FULFILLED:
      operatorAction =
        'Order sudah FULFILLED (ongkirnya SUDAH dilayani) padahal redemption-nya belum lunas. ' +
        'Kombinasi ini seharusnya mustahil — periksa manual SEBELUM me-refund apa pun.';
      break;
    case PaymentStatus.REFUND_DUE:
      operatorAction = order.refundSafe
        ? 'Utang SUDAH tercatat sebelumnya (refundSafe=true) — kembalikan Rupiah-nya di luar sistem.'
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
    `ONGKIR TERTINGGAL ${order.merchantOrderId} (user ${order.userId}, Rp ${order.priceIdr}, ` +
      `status ${order.status}, refundSafe=${order.refundSafe}): redemption ${redemptionId} ` +
      `DIBATALKAN. ${operatorAction}`,
  );
  return {
    merchantOrderId: order.merchantOrderId,
    priceIdr: order.priceIdr,
    statusBefore: order.status,
    statusAfter: order.status,
    refundSafe: order.refundSafe,
    recordedNow: false,
    operatorAction,
  };
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}
