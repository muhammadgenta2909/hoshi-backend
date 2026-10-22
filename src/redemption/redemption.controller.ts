import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  SHIPPING_ERROR_CODE,
  noEffectError,
} from '../collectorcrypt/cc-shipping.errors';
import { ShippingExceptionFilter } from '../common/shipping-exception.filter';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CcAccessToken } from '../auth/cc-access-token.decorator';
import { CancelRedemptionDto } from './dto/cancel-redemption.dto';
import { RequestRedemptionDto } from './dto/request-redemption.dto';
import { SiwsNonceDto, SiwsRefreshDto, SiwsVerifyDto } from './dto/siws.dto';
import { SubmitBurnDto } from './dto/submit-burn.dto';
import { RedemptionService } from './redemption.service';

/**
 * Kirim kartu fisik ke rumah (redeem). Mount di /api/redemptions.
 *
 * RECORD-ONLY: endpoint ini HANYA mencatat permintaan — TIDAK burn/transfer NFT, TIDAK menyentuh
 * treasury. Pemenuhan fisik manual oleh admin.
 */
@ApiTags('redemptions')
@Controller('redemptions')
// KONTRAK ERROR: setiap kegagalan di controller ini keluar sebagai
//   { statusCode, error, code, message, stage, retryable, redemptionId? }
// Filter ini adalah JARING PENGAMAN-nya: ia memastikan tidak ada yang lolos sebagai 500
// "Internal server error" tanpa `code`, dan ia TIDAK PERNAH menaikkan sesuatu jadi retryable —
// yang belum berkode dicap UNCLASSIFIED/UNEXPECTED dengan stage UNKNOWN. Lihat cc-shipping.errors.ts.
@UseFilters(ShippingExceptionFilter)
export class RedemptionController {
  constructor(private readonly redemption: RedemptionService) {}

  @Post()
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Minta kirim kartu fisik ke rumah (record-only: TIDAK burn/transfer NFT, NFT tetap di ' +
      'tempat). Body menyebut TEPAT SATU: `nftAddress` (kartu vault CollectorCrypt / hasil ' +
      'pack → jalur CC) atau `listingId` (kartu STOK HOSHI yang kamu beli → jalur kurir ' +
      'DOMESTIK, tanpa NFT/burn/USDC/CC sama sekali). Rail-nya diputuskan SERVER dan ' +
      'di-snapshot permanen di baris redemption.',
  })
  request(
    @Body() dto: RequestRedemptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.redemption.request(dto, user);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Riwayat permintaan kirim kartu fisik milik user (terbaru dulu)',
  })
  listMine(@CurrentUser() user: AuthUser) {
    return this.redemption.listMine(user.id);
  }

  /**
   * B1 — JALAN KELUAR user untuk baris yang BELUM menyentuh uang.
   *
   * Tanpa rute ini AWAITING_PAYMENT adalah kunci kartu PERMANEN: invoice IDRX kedaluwarsa,
   * barisnya tetap memblokir, dan POST /redemptions menjawab 400 REDEMPTION_ALREADY_ACTIVE
   * selamanya. Pagar uangnya ada di service (status + ledger order + fundingSignature/refundSafe),
   * dan tulisannya berpagar predikat sehingga tidak bisa balapan dengan callback pembayaran.
   *
   * SENGAJA TIDAK digerbang HOSHI_CC_SHIPPING_ENABLED: baris record-only pun harus bisa dibatalkan
   * saat jalur real-nya mati.
   */
  @Post(':id/cancel')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Batalkan permintaan kirim SENDIRI — HANYA selama baris redemption-nya nol uang (REQUESTED ' +
      'atau AWAITING_PAYMENT). Ditolak kalau order ongkirnya PAID (pemenuhan otomatis masih ' +
      'berjalan) atau FULFILLED. Order yang macet di FULFILLING / sudah REFUND_DUE TIDAK menghalangi: ' +
      'utangnya tetap tercatat di tagihannya sendiri dan dilaporkan di `shippingDebts`. ' +
      'READY_TO_FUND ke atas ditolak: ongkir sudah lunas / USDC sudah pindah — lewat admin.',
  })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelRedemptionDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.redemption.cancel(id, user, dto?.reason);
  }

  /* ─────────── KIRIM DOMESTIK (stok Hoshi, kurir lokal) — TANPA CC, TANPA gerbang CC ───────────
     Jalur ini TIDAK menyentuh CollectorCrypt: tidak ada NFT untuk dibakar, tidak ada USDC yang
     didanai, tidak ada tanda tangan wallet, dan tidak ada header x-cc-access-token. Ia karena
     itu TIDAK digerbang HOSHI_CC_SHIPPING_ENABLED dan TIDAK ikut terblokir oleh kredensial CC
     yang masih ditunggu. Tagihan ongkirnya diterbitkan POST /payments/shipping/domestic. */

  @Get(':id/domestic-quote')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Ongkir kirim DOMESTIK (Rupiah) untuk permintaan kirim stok Hoshi. READ-ONLY: nol uang, ' +
      'nol order, nol efek samping. Sumber angkanya PERSIS sama dengan yang ditagihkan ' +
      'POST /payments/shipping/domestic, jadi yang dilihat user dan yang ditagihkan tidak bisa ' +
      'lahir dari dua kalkulasi berbeda. Angkanya datang dari TARIF KURIR NYATA (Biteship, ' +
      'dihitung dari kode pos) bila lapis itu menyala dan menjawab — `source: "COURIER_API"` — ' +
      'dan kalau tidak, dari tier per wilayah seperti sebelumnya. Respons menyebut ' +
      '`scope`/`label` tier yang menang, `province` yang dibaca dari alamat, dan ' +
      '`regionUnresolved` (true = provinsinya tak dikenal → dipakai tarif penampung). ' +
      'UNTUK TARIF KURIR: `priceIdr` adalah SATU-SATUNYA angka yang ditagihkan; kalau tarif ' +
      'kurirnya di bawah minimum penerbitan tagihan (Rp 20.000) ia sudah DINAIKKAN, dan itu ' +
      'dinyatakan lewat `raisedToMintFloor: true` + `courierPriceIdr` (tarif mentah kurir, JEJAK ' +
      'saja). Layar WAJIB menampilkan `priceIdr`, bukan `courierPriceIdr`. Alamat di ' +
      'luar Indonesia ditolak 400 (ADDRESS_UNSUPPORTED) — DI SINI, sebelum user menekan bayar. ' +
      'Baris jalur CollectorCrypt ditolak 400 (WRONG_RAIL).',
  })
  domesticQuote(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.redemption.domesticQuote(id, user);
  }

  /* ---------------- SIWS (Track B) — login wallet Phantom ke CC (digerbang HOSHI_CC_SHIPPING_ENABLED) ----------------
     Handshake PRA-AUTH ke CC: hasilnya accessToken cca_ yang lalu dikirim frontend di header
     x-cc-access-token (nama lama x-privy-identity-token masih diterima) pada panggilan shipping di
     bawah — backend merelaynya sebagai `Authorization: Bearer` tanpa perubahan. Ini SATU-SATUNYA
     kredensial yang bisa menuntaskan redemption Solana (API key CC ditolak untuk leg burn-nya).
     Rute-rute ini sendiri tetap butuh JWT Hoshi (user sudah login via wallet-nya). Gerbang fitur
     ada DI SERVICE (assertEnabled), sama polanya dengan estimate/prepare/burn/status. */

  @Post('siws/nonce')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary:
      'SIWS: minta nonce CC untuk wallet SENDIRI (wajib wallet === user login, 403 bila beda)',
  })
  siwsNonce(@Body() dto: SiwsNonceDto, @CurrentUser() user: AuthUser) {
    // Kepemilikan wallet: user hanya boleh mencetak sesi CC untuk wallet-NYA sendiri.
    if (dto.wallet !== user.walletAddress) {
      throw noEffectError(
        HttpStatus.FORBIDDEN,
        SHIPPING_ERROR_CODE.SIWS_WALLET_MISMATCH,
        'Hanya boleh SIWS untuk wallet Anda sendiri (wallet tidak cocok dengan akun login).',
      );
    }
    return this.redemption.siwsNonce(dto.wallet);
  }

  @Post('siws/verify')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary:
      'SIWS: verifikasi message + signature → token sesi CC (accessToken cca_ / refreshToken ccr_)',
  })
  siwsVerify(@Body() dto: SiwsVerifyDto) {
    return this.redemption.siwsVerify(dto.message, dto.signature);
  }

  @Post('siws/refresh')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary: 'SIWS: tukar refreshToken CC (ccr_) dengan pasangan accessToken/refreshToken baru',
  })
  siwsRefresh(@Body() dto: SiwsRefreshDto) {
    return this.redemption.siwsRefresh(dto.refreshToken);
  }

  /* ---------------- Jalur REAL CC Vault Shipping (digerbang HOSHI_CC_SHIPPING_ENABLED) ----------------
     Semua butuh ACCESS TOKEN SESI CC (cca_, dari /siws/verify) di header x-cc-access-token
     (fallback lama: x-privy-identity-token). 400 bila kosong. */

  @Post(':id/estimate')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 20 } })
  @ApiOperation({
    summary:
      'Taksir ongkir kirim fisik (USD + USDC + Rupiah) — tak menyentuh dana & tak membuat shipment ' +
      '(hanya memastikan alamat kirim sudah ada di CC, karena /redeem/estimate minta shippingAddressId)',
  })
  estimate(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @CcAccessToken() ccAccessToken: string,
  ) {
    return this.redemption.estimate(id, user, ccAccessToken);
  }

  @Post(':id/fund-and-prepare')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      'Danai USDC ongkir ke wallet user + bangun transaksi burn UNSIGNED (setelah ongkir Rupiah lunas)',
  })
  fundAndPrepare(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @CcAccessToken() ccAccessToken: string,
  ) {
    return this.redemption.fundAndPrepare(id, user, ccAccessToken);
  }

  @Post(':id/re-prepare')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      'Terbitkan ULANG transaksi burn UNSIGNED untuk redemption yang SUDAH didanai (HANYA status ' +
      'FUNDED) — pemulihan saat batch transaksi 15 menit CC kedaluwarsa. TIDAK mendanai ulang: ' +
      'nol dana berpindah, ongkir yang sudah didanai tidak ditagih dua kali.',
  })
  reprepare(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @CcAccessToken() ccAccessToken: string,
  ) {
    return this.redemption.reprepareBurn(id, user, ccAccessToken);
  }

  @Post(':id/submit-burn')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary: 'Teruskan transaksi burn+ship yang sudah ditandatangani user ke CollectorCrypt',
  })
  submitBurn(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @CcAccessToken() ccAccessToken: string,
    @Body() dto: SubmitBurnDto,
  ) {
    return this.redemption.submitBurn(
      id,
      user,
      ccAccessToken,
      dto.signedTransactions,
      dto.signedDelistTransactions ?? [],
    );
  }

  @Get(':id/status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Poll status shipment CC → status Hoshi + tracking',
  })
  status(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @CcAccessToken() ccAccessToken: string,
  ) {
    return this.redemption.status(id, user, ccAccessToken);
  }
}
