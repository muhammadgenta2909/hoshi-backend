import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedemptionStatus } from '@prisma/client';
import type { CardRedemption } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { CcShippingClient } from './cc-shipping.client';
import type {
  CcShipmentStatus,
  CcShippingAddressInput,
  CcSiwsNonceResponse,
  CcSiwsRefreshResponse,
  CcSiwsVerifyResponse,
} from './cc-shipping.types';
import {
  TreasuryFundIndeterminateError,
  TreasuryService,
} from './treasury.service';
import { usdDollarsToUsdcBaseUnits } from './cc-gacha.types';

/** Perusahaan kurir default untuk prepare/estimate. */
const DEFAULT_DELIVERY_COMPANY = 'ups';

/**
 * Berapa jauh ongkir OTORITATIF dari /redeem/prepare boleh MELEBIHI yang user bayar (di-snapshot
 * ke order saat invoice terbit) sebelum kita menolak MENDANAI. Default 10% — ongkir bisa bergeser
 * antara "user bayar" dan "user menandatangani". Selisih di dalam plafon ini ditanggung treasury.
 */
const SHIPPING_MAX_SLIPPAGE_BPS = 1000;
const BPS_DENOMINATOR = 10_000;

/** Batas panjang pesan error yang disimpan/di-log. */
const ERROR_MAX = 500;

const errorMessage = (err: unknown): string =>
  (err instanceof Error ? err.message : 'Unknown error').slice(0, ERROR_MAX);

/**
 * Kegagalan SETELAH USDC treasury didanai ke wallet user (fundUsdc SUKSES/INDETERMINATE) tetapi
 * burn+ship belum tuntas. Ditangani KHUSUS oleh pemanggil: USDC sudah/mungkin ada di wallet user →
 * JANGAN auto-refund Rupiah (rugi dobel; user memegang USDC ter-earmark); selesaikan lewat
 * resume/reclaim. Sepadan dengan ResellerPostBuyError.
 */
export class ShippingPostFundError extends Error {
  constructor(
    message: string,
    readonly redemptionId: string,
  ) {
    super(message);
    this.name = 'ShippingPostFundError';
  }
}

export interface ShippingEstimate {
  /** USD (dolar penuh) dari CC. */
  usd: number;
  /** USDC base unit (6 desimal) — yang nanti didanai/dibayar. */
  usdcBaseUnits: number;
}

export interface FundAndPrepareResult {
  /** base64 UNSIGNED — wallet user yang menandatangani. */
  transactions: string[];
  delistTransactions: string[];
  outboundShipmentId: string;
  /** USDC base unit yang SUDAH didanai treasury ke wallet user. */
  totalCostUsdc: number;
}

/**
 * Orkestrasi CC Vault Shipping — kirim kartu fisik keluar dari vault CC. Hidup DI DALAM
 * CollectorCryptModule karena butuh TreasuryService (private key) untuk MENDANAI USDC ongkir ke
 * wallet user just-in-time — pola yang sama dengan GachaService & ResellerSettlementService.
 *
 * ALUR (user Indonesia bayar Rupiah, tidak punya USDC/SOL):
 *   redeem → bayar Rupiah (IDRX) → READY_TO_FUND → fundAndPrepare (treasury danai USDC + CC prepare)
 *   → user TANDA TANGAN burn → submitBurn (CC burn+ship) → refreshStatus (tracking).
 * USDC adalah PASS-THROUGH TERIKAT yang didanai oleh Rupiah yang dibayar (net-neutral).
 *
 * DIGERBANG: HOSHI_CC_SHIPPING_ENABLED !== 'true' → seluruh jalur real ini menolak (record-only
 * tetap seperti apa adanya). Gerbang ada di assertEnabled() + di PaymentsService (createShippingOrder).
 */
@Injectable()
export class CcShippingService {
  private readonly logger = new Logger(CcShippingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: CcShippingClient,
    private readonly treasury: TreasuryService,
  ) {}

  /** Gerbang fitur. Pola sama dengan CcBuyService.assertEnabled. */
  assertEnabled(): void {
    const on =
      (this.config.get<string>('HOSHI_CC_SHIPPING_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true';
    if (!on) {
      throw new ServiceUnavailableException(
        'Kirim kartu fisik (CC Vault Shipping) belum diaktifkan di deployment ini ' +
          '(set HOSHI_CC_SHIPPING_ENABLED=true setelah alurnya diuji).',
      );
    }
  }

  /**
   * Taksiran ongkir untuk satu redemption (READ-ONLY: tidak membuat shipment / tidak menyentuh
   * dana). Mengembalikan USD + USDC base unit. Alamat dibangun dari SNAPSHOT redemption (diverifikasi
   * saat request) — bukan dari body klien.
   *
   * Konversi ke Rupiah dilakukan pemanggil (RedemptionService / PaymentsService.createShippingOrder)
   * lewat PaymentsService.quoteRupiah — service ini SENGAJA tidak bergantung pada PaymentsService
   * supaya tidak ada import melingkar (PaymentsModule sudah meng-import CollectorCryptModule).
   */
  async estimateForRedemption(
    redemptionId: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<ShippingEstimate> {
    this.assertEnabled();
    const row = await this.ownedRedemption(redemptionId, user);
    const email = await this.userEmail(row.userId);
    const res = await this.client.estimate(privyToken, {
      nftAddresses: [row.nftAddress],
      shippingAddress: this.toCcAddress(row, email),
      deliveryCompany: DEFAULT_DELIVERY_COMPANY,
    });
    return this.toEstimate(res.totalCost);
  }

  /**
   * INTI MONEY-CRITICAL. Danai USDC treasury ke wallet user lalu bangun transaksi burn+ship
   * UNSIGNED untuk ditandatangani user. URUTAN = properti keamanannya (jangan ditukar):
   *
   *   1. Muat redemption; pastikan milik user + status READY_TO_FUND.
   *   2. Pastikan alamat kirim CC ada (buat bila belum), persist ccShippingAddressId.
   *   3. CC /redeem/prepare → totalCost(USD) OTORITATIF + outboundShipmentId + tx UNSIGNED.
   *      Persist outboundShipmentId + totalCostUsdc. (Semua langkah 1–3 = PRA-danai → refundSafe TETAP true.)
   *   4. Guard slippage: totalCost tidak boleh melebihi plafon dari yang user BAYAR. Lewat → tolak (masih pra-danai).
   *   5. Klaim ATOMIK READY_TO_FUND → FUNDING (count===1) — dua sesi tak bisa double-fund.
   *   6. treasury.fundUsdc(...). Sukses → FUNDED + fundingSignature + refundSafe=FALSE (PASCA-danai).
   *        - fundUsdc throw PRA-broadcast → LEPAS klaim balik ke READY_TO_FUND, refundSafe TETAP true.
   *        - fundUsdc INDETERMINATE → status TETAP FUNDING + refundSafe=FALSE + ShippingPostFundError; JANGAN refund.
   *   7. Kembalikan tx UNSIGNED untuk ditandatangani frontend.
   */
  async fundAndPrepare(
    redemptionId: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<FundAndPrepareResult> {
    this.assertEnabled();

    // 1. Muat + cek pemilik + status.
    const row = await this.ownedRedemption(redemptionId, user);
    if (row.status !== RedemptionStatus.READY_TO_FUND) {
      throw new BadRequestException(
        `Redemption ini belum siap didanai (status ${row.status}). ` +
          'Selesaikan pembayaran ongkir Rupiah dulu.',
      );
    }

    // 2. Alamat kirim CC (buat bila belum). PRA-danai.
    const ccAddressId = await this.ensureCcShippingAddress(row, privyToken);

    // 3. CC prepare → OTORITATIF. PRA-danai.
    const email = await this.userEmail(user.id);
    const prepared = await this.client.prepare(privyToken, {
      nftAddresses: [row.nftAddress],
      shippingAddressId: ccAddressId,
      coin: 'USDC',
      deliveryCompany: DEFAULT_DELIVERY_COMPANY,
      ...(email ? { email } : {}),
    });
    if (
      !prepared.outboundShipmentId ||
      !Array.isArray(prepared.transactions) ||
      prepared.transactions.length === 0
    ) {
      throw new ServiceUnavailableException(
        'CollectorCrypt tidak mengembalikan transaksi burn yang bisa ditandatangani.',
      );
    }
    const totalCostUsdc = this.toEstimate(prepared.totalCost).usdcBaseUnits;
    const delistTransactions = Array.isArray(prepared.delistTransactions)
      ? prepared.delistTransactions
      : [];

    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: {
        outboundShipmentId: prepared.outboundShipmentId,
        totalCostUsdc,
      },
    });

    // 4. Guard slippage terhadap yang user BAYAR (snapshot order). PRA-danai → aman ditolak.
    await this.assertCostWithinPaid(row, totalCostUsdc);

    // 5. Klaim ATOMIK READY_TO_FUND → FUNDING. Dua sesi tak bisa dua kali danai.
    const claimed = await this.prisma.cardRedemption.updateMany({
      where: { id: row.id, status: RedemptionStatus.READY_TO_FUND },
      data: { status: RedemptionStatus.FUNDING },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        'Pendanaan ongkir untuk redemption ini sedang/sudah diproses. ' +
          'Jangan ulangi — cek statusnya.',
      );
    }

    // 6. DANAI USDC. Titik peralihan PRA→PASCA-danai.
    let fundingSignature: string;
    try {
      const funded = await this.treasury.fundUsdc({
        toWallet: user.walletAddress,
        amountBaseUnits: totalCostUsdc,
      });
      fundingSignature = funded.signature;
    } catch (err) {
      if (err instanceof TreasuryFundIndeterminateError) {
        // INDETERMINATE: USDC MUNGKIN sudah pindah → refundSafe=FALSE, status TETAP FUNDING (tersangkut,
        // diselesaikan manual/reclaim). JANGAN lepas klaim (itu jalur pra-danai). JANGAN auto-refund.
        await this.markPostFund(
          row.id,
          err.signature,
          RedemptionStatus.FUNDING,
          `fundUsdc INDETERMINATE: ${err.message}`,
        );
        throw new ShippingPostFundError(
          `Pendanaan USDC ongkir (redemption ${row.id}) TIDAK PASTI — USDC mungkin sudah pindah ke ` +
            `wallet user. CEK ON-CHAIN & reclaim; JANGAN refund Rupiah. (${err.message})`,
          row.id,
        );
      }
      // PRA-broadcast: belum ada USDC keluar → LEPAS klaim balik ke READY_TO_FUND, refundSafe TETAP true.
      await this.prisma.cardRedemption.updateMany({
        where: { id: row.id, status: RedemptionStatus.FUNDING },
        data: { status: RedemptionStatus.READY_TO_FUND },
      });
      this.logger.warn(
        `fundAndPrepare ${row.id}: fundUsdc gagal PRA-broadcast (${errorMessage(err)}). ` +
          'Klaim dilepas balik ke READY_TO_FUND — tidak ada USDC keluar, refundSafe tetap true.',
      );
      throw err;
    }

    // Sukses terkonfirmasi → FUNDED + refundSafe=FALSE. Dari sini USDC ada di wallet user.
    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: {
        status: RedemptionStatus.FUNDED,
        fundingSignature,
        refundSafe: false,
      },
    });
    this.logger.warn(
      `fundAndPrepare ${row.id}: FUNDED — ${totalCostUsdc} USDC base unit didanai ke ` +
        `${user.walletAddress} (sig ${fundingSignature}). refundSafe=false; JANGAN auto-refund Rupiah.`,
    );

    // 7. Kembalikan tx UNSIGNED untuk ditandatangani frontend.
    return {
      transactions: prepared.transactions,
      delistTransactions,
      outboundShipmentId: prepared.outboundShipmentId,
      totalCostUsdc,
    };
  }

  /**
   * Teruskan transaksi burn+ship yang SUDAH ditandatangani user ke CC. burn TIDAK idempoten →
   * satu redemption hanya boleh burn SEKALI. Klaim ATOMIK FUNDED → BURN_SUBMITTED (count===1)
   * lebih dulu (dua submit paralel → satu menang), lalu panggil CC.
   *
   * ANY throw dari client.burn = INDETERMINATE PASCA-danai (CC mungkin sudah menyiarkan burn):
   * status TETAP BURN_SUBMITTED, refundSafe=FALSE, JANGAN refund/unfund → ShippingPostFundError.
   */
  async submitBurn(
    redemptionId: string,
    user: AuthUser,
    privyToken: string,
    signedTransactions: string[],
  ): Promise<{ status: RedemptionStatus; burnSignature: string | null }> {
    this.assertEnabled();

    if (!Array.isArray(signedTransactions) || signedTransactions.length === 0) {
      throw new BadRequestException('signedTransactions kosong.');
    }

    const row = await this.ownedRedemption(redemptionId, user);
    if (row.status !== RedemptionStatus.FUNDED) {
      // Tolak BURN_SUBMITTED/terminal — burn tidak boleh diulang.
      throw new BadRequestException(
        row.status === RedemptionStatus.BURN_SUBMITTED
          ? 'Burn untuk redemption ini sedang/sudah diproses — jangan submit ulang (burn tidak bisa diulang).'
          : `Redemption ini belum siap di-burn (status ${row.status}).`,
      );
    }
    if (!row.outboundShipmentId) {
      throw new BadRequestException(
        'Shipment CC belum disiapkan — jalankan fund-and-prepare dulu.',
      );
    }

    // Klaim ATOMIK FUNDED → BURN_SUBMITTED sebelum menyentuh CC. count!==1 = ada yang menang duluan.
    const claimed = await this.prisma.cardRedemption.updateMany({
      where: { id: row.id, status: RedemptionStatus.FUNDED },
      data: { status: RedemptionStatus.BURN_SUBMITTED },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException(
        'Burn untuk redemption ini sedang/sudah diproses — jangan submit ulang.',
      );
    }

    let burnSignature: string | null = null;
    try {
      const res = await this.client.burn(privyToken, row.outboundShipmentId, {
        transactions: signedTransactions,
      });
      burnSignature =
        typeof res.signature === 'string' && res.signature.length > 0
          ? res.signature
          : null;
    } catch (err) {
      // INDETERMINATE PASCA-danai. Status SUDAH BURN_SUBMITTED (dari klaim). refundSafe=FALSE.
      await this.prisma.cardRedemption.update({
        where: { id: row.id },
        data: {
          refundSafe: false,
          note: `submitBurn INDETERMINATE: ${errorMessage(err)}`.slice(0, ERROR_MAX),
        },
      });
      this.logger.error(
        `submitBurn ${row.id} KRITIS: burn CC (shipment ${row.outboundShipmentId}) GAGAL/INDETERMINATE: ` +
          `${errorMessage(err)}. CC MUNGKIN sudah membakar+mengirim. JANGAN refund/unfund. Selesaikan manual.`,
      );
      throw new ShippingPostFundError(
        `Burn redemption ${row.id} TIDAK PASTI — CC mungkin sudah membakar. JANGAN refund. (${errorMessage(err)})`,
        row.id,
      );
    }

    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: { burnSignature, refundSafe: false },
    });
    this.logger.warn(
      `submitBurn ${row.id}: BURN_SUBMITTED (shipment ${row.outboundShipmentId}` +
        `${burnSignature ? `, sig ${burnSignature}` : ''}).`,
    );
    return { status: RedemptionStatus.BURN_SUBMITTED, burnSignature };
  }

  /**
   * Poll status shipment CC (tak ada webhook) → petakan ke status Hoshi + persist tracking.
   * Hanya MEMAJUKAN (BURN_SUBMITTED→IN_TRANSIT→DELIVERED/…); tidak pernah memundurkan status yang
   * sudah lebih jauh (CC yang flaky tidak boleh menurunkan DELIVERED).
   */
  async refreshStatus(
    redemptionId: string,
    user: AuthUser,
    privyToken: string,
  ): Promise<CardRedemption> {
    this.assertEnabled();
    const row = await this.ownedRedemption(redemptionId, user);
    if (!row.outboundShipmentId) {
      // Belum di-prepare → tidak ada yang bisa di-poll. Kembalikan apa adanya.
      return row;
    }

    const remote = await this.client.getShipment(
      privyToken,
      row.outboundShipmentId,
    );
    const trackingIds = Array.isArray(remote.trackingIds)
      ? remote.trackingIds.filter(isNonEmptyString)
      : [];
    const trackingUrls = Array.isArray(remote.trackingUrls)
      ? remote.trackingUrls.filter(isNonEmptyString)
      : [];

    const mapped = mapCcShipmentStatus(remote.status);
    // Hanya maju dari BURN_SUBMITTED/IN_TRANSIT ke IN_TRANSIT/DELIVERED/SHIP_FAILED_POST_BURN.
    const advanceTo =
      mapped &&
      (mapped === RedemptionStatus.IN_TRANSIT ||
        mapped === RedemptionStatus.DELIVERED ||
        mapped === RedemptionStatus.SHIP_FAILED_POST_BURN)
        ? mapped
        : undefined;

    await this.prisma.cardRedemption.updateMany({
      where: {
        id: row.id,
        status: {
          in: [RedemptionStatus.BURN_SUBMITTED, RedemptionStatus.IN_TRANSIT],
        },
      },
      data: {
        trackingIds,
        trackingUrls,
        ...(advanceTo ? { status: advanceTo } : {}),
      },
    });

    const refreshed = await this.prisma.cardRedemption.findUnique({
      where: { id: row.id },
    });
    return refreshed ?? row;
  }

  /* ---------------------- SIWS (Track B) — login handshake CC ----------------------
     Relay PRA-AUTH murni untuk user wallet (Phantom) agar dapat sesi CC. TANPA DB, TANPA
     persistensi — sama seperti sikap "token identitas tak pernah dipersist" di jalur shipping:
     kita cuma meneruskan dan mengembalikan token ke frontend. DIGERBANG HOSHI_CC_SHIPPING_ENABLED
     lewat assertEnabled() (pola sama dengan estimate/fund/burn/status). Kepemilikan wallet
     (body.wallet === user.walletAddress) ditegakkan di controller. */

  /** nonce: suntik partnerAppId/domain/uri dari config lalu relay. Config kosong → 503 (siwsConfig). */
  async siwsNonce(wallet: string): Promise<CcSiwsNonceResponse> {
    this.assertEnabled();
    const { partnerAppId, domain, uri } = this.siwsConfig();
    return this.client.siwsNonce({ wallet, partnerAppId, domain, uri });
  }

  /** verify: relay message+signature apa adanya → token sesi CC (cca_/ccr_). */
  // async: assertEnabled() throw jadi rejected promise (bukan sync throw), konsisten dgn method lain.
  async siwsVerify(
    message: string,
    signature: string,
  ): Promise<CcSiwsVerifyResponse> {
    this.assertEnabled();
    return this.client.siwsVerify({ message, signature });
  }

  /** refresh: relay refreshToken apa adanya → pasangan token baru. */
  async siwsRefresh(refreshToken: string): Promise<CcSiwsRefreshResponse> {
    this.assertEnabled();
    return this.client.siwsRefresh({ refreshToken });
  }

  /* --- Internal --- */

  /**
   * Baca config SIWS LAZY (pola sama endpoint() di client). Salah satu kosong → 503 jelas
   * ("SIWS not configured …") supaya kita TIDAK memanggil CC dengan partnerAppId/domain/uri
   * undefined. Hanya jalur nonce yang butuh config; verify/refresh tidak.
   */
  private siwsConfig(): { partnerAppId: string; domain: string; uri: string } {
    const read = (k: string): string =>
      (this.config.get<string>(k) ?? '').trim();
    const partnerAppId = read('COLLECTORCRYPT_PARTNER_APP_ID');
    const domain = read('COLLECTORCRYPT_SIWS_DOMAIN');
    const uri = read('COLLECTORCRYPT_SIWS_URI');
    const missing = [
      partnerAppId ? '' : 'COLLECTORCRYPT_PARTNER_APP_ID',
      domain ? '' : 'COLLECTORCRYPT_SIWS_DOMAIN',
      uri ? '' : 'COLLECTORCRYPT_SIWS_URI',
    ].filter((k) => k.length > 0);
    if (missing.length > 0) {
      throw new ServiceUnavailableException(
        `SIWS not configured — set ${missing.join(', ')}.`,
      );
    }
    return { partnerAppId, domain, uri };
  }

  /**
   * Redemption milik user login. Kepemilikan lewat LEDGER (userId), bukan klaim klien — id
   * redemption bisa bocor tapi bukan kapabilitas.
   */
  private async ownedRedemption(
    redemptionId: string,
    user: AuthUser,
  ): Promise<CardRedemption> {
    const row = await this.prisma.cardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (!row) throw new NotFoundException('Redemption tidak ditemukan.');
    if (row.userId !== user.id) {
      this.logger.warn(
        `Akses redemption ${redemptionId} ditolak untuk user ${user.id} (pemilik: ${row.userId}).`,
      );
      throw new ForbiddenException('Redemption ini bukan milik Anda.');
    }
    return row;
  }

  /** Buat alamat kirim di CC bila belum ada; persist id-nya. Idempoten via kolom ccShippingAddressId. */
  private async ensureCcShippingAddress(
    row: CardRedemption,
    privyToken: string,
  ): Promise<string> {
    if (row.ccShippingAddressId) return row.ccShippingAddressId;
    const email = await this.userEmail(row.userId);
    const created = await this.client.createShippingAddress(
      privyToken,
      this.toCcAddress(row, email),
    );
    if (!created.id) {
      throw new ServiceUnavailableException(
        'CollectorCrypt tidak mengembalikan id alamat kirim.',
      );
    }
    await this.prisma.cardRedemption.update({
      where: { id: row.id },
      data: { ccShippingAddressId: created.id },
    });
    return created.id;
  }

  /**
   * Guard slippage: ongkir OTORITATIF (prepare) tidak boleh melebihi plafon dari yang user BAYAR
   * (di-snapshot ke PaymentOrder.priceUsdc saat invoice). Lewat = pra-danai → tolak & refund aman.
   */
  private async assertCostWithinPaid(
    row: CardRedemption,
    totalCostUsdc: number,
  ): Promise<void> {
    const order = row.paymentOrderId
      ? await this.prisma.paymentOrder.findUnique({
          where: { id: row.paymentOrderId },
        })
      : await this.prisma.paymentOrder.findFirst({
          where: { redemptionId: row.id, packType: 'SHIPPING' },
          orderBy: { createdAt: 'desc' },
        });
    if (!order || order.priceUsdc <= 0) {
      throw new BadRequestException(
        'Tidak menemukan order ongkir Rupiah yang sudah dibayar untuk redemption ini.',
      );
    }
    const ceiling = applyBpsCeil(
      order.priceUsdc,
      BPS_DENOMINATOR + SHIPPING_MAX_SLIPPAGE_BPS,
    );
    if (totalCostUsdc > ceiling) {
      this.logger.warn(
        `fundAndPrepare ${row.id} TOLAK: ongkir CC ${totalCostUsdc} > plafon ${ceiling} ` +
          `(dibayar ${order.priceUsdc} + ${SHIPPING_MAX_SLIPPAGE_BPS} bps).`,
      );
      throw new BadRequestException(
        'Ongkir kirim naik melebihi yang Anda bayar — pendanaan dibatalkan. ' +
          'Tidak ada dana yang berpindah; ongkir Rupiah bisa di-refund.',
      );
    }
  }

  /** Tandai state PASCA-danai (indeterminate): refundSafe=false, simpan sig + catatan. */
  private async markPostFund(
    id: string,
    signature: string,
    status: RedemptionStatus,
    note: string,
  ): Promise<void> {
    try {
      await this.prisma.cardRedemption.update({
        where: { id },
        data: {
          status,
          refundSafe: false,
          fundingSignature: signature,
          note: note.slice(0, ERROR_MAX),
        },
      });
    } catch (err) {
      this.logger.error(
        `Gagal menandai state PASCA-danai redemption ${id}: ${errorMessage(err)} (asli: ${note})`,
      );
    }
  }

  private async userEmail(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? undefined;
  }

  /** Snapshot alamat redemption → bentuk alamat CC. */
  private toCcAddress(
    row: CardRedemption,
    email: string | undefined,
  ): CcShippingAddressInput {
    return {
      fullName: row.recipientName,
      country: row.country,
      streetAddress: row.street,
      apartment: row.apt ?? undefined,
      city: row.city,
      state: row.state ?? undefined,
      zip: row.zip,
      phoneNumber: row.phoneNumber ?? undefined,
      email,
      isDefault: true,
    };
  }

  /**
   * Ongkir CC `totalCost` = USD dolar penuh (seperti field harga CC lain) → USDC base unit.
   * Validasi ketat: jalur uang tidak boleh menerima NaN/negatif/tak-hingga.
   */
  private toEstimate(totalCostUsd: unknown): ShippingEstimate {
    const usd = Number(totalCostUsd);
    if (!Number.isFinite(usd) || usd <= 0) {
      throw new ServiceUnavailableException(
        'Ongkir dari CollectorCrypt tidak masuk akal. Coba lagi nanti.',
      );
    }
    return { usd, usdcBaseUnits: usdDollarsToUsdcBaseUnits(usd) };
  }
}

/** `value * bps / 10.000`, dibulatkan KE ATAS, MURNI INTEGER (sama pola applyBps PaymentsService). */
function applyBpsCeil(value: number, bps: number): number {
  const numerator = value * bps;
  if (!Number.isSafeInteger(numerator)) {
    throw new ServiceUnavailableException(
      'Perhitungan ongkir melampaui batas bilangan bulat aman.',
    );
  }
  const remainder = numerator % BPS_DENOMINATOR;
  const quotient = (numerator - remainder) / BPS_DENOMINATOR;
  return remainder === 0 ? quotient : quotient + 1;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/** Petakan status shipment CC → status redemption Hoshi. null = tak dikenal (abaikan). */
function mapCcShipmentStatus(
  status: CcShipmentStatus | string,
): RedemptionStatus | null {
  switch (status) {
    case 'Created':
    case 'PaymentPending':
    case 'PaymentReceived':
    case 'Pending':
    case 'Processing':
      return RedemptionStatus.BURN_SUBMITTED;
    case 'Shipped':
      return RedemptionStatus.IN_TRANSIT;
    case 'Delivered':
      return RedemptionStatus.DELIVERED;
    case 'ActionRequired':
    case 'Cancelled':
      return RedemptionStatus.SHIP_FAILED_POST_BURN;
    default:
      return null;
  }
}
