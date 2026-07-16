import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { BuybackDto } from './dto/buyback.dto';
import { GeneratePackDto } from './dto/generate-pack.dto';
import { PurchasePackDto } from './dto/purchase-pack.dto';
import { SubmitPackDto } from './dto/submit-pack.dto';
import { GachaService } from './gacha.service';

/**
 * Gacha CollectorCrypt — mount di /api/gacha (prefix global 'api' dari main.ts).
 *
 * Ada DUA alur beli yang hidup berdampingan, dan keduanya beda soal SIAPA YANG BAYAR:
 *
 * 1. Alur TREASURY (POST /gacha/purchase) — jalur untuk user Indonesia.
 *    Hoshi yang membayar USDC dan Hoshi yang menandatangani (server-side); wallet
 *    user cuma jadi ALAMAT PENERIMA kartu. User tidak pernah melihat popup wallet
 *    dan tidak menandatangani apa pun, karena ia tidak punya USDC maupun SOL —
 *    ia bayar rupiah. Satu request, satu response berisi kartu.
 *
 * 2. Alur WALLET USER (POST /gacha/packs → :memo/submit → :memo/open) — jalur asli.
 *    User yang bayar USDC dari wallet-nya sendiri, jadi ia WAJIB memutar lewat
 *    wallet di tengah jalan dan alurnya tidak bisa diringkas jadi satu request:
 *      POST /gacha/packs            → memo + transaksi UNSIGNED (belum ada dana berpindah)
 *      [browser] wallet user MENANDATANGANI
 *      POST /gacha/packs/:memo/submit → teruskan transaksi bertanda tangan ke CC
 *      POST /gacha/packs/:memo/open   → hasil undian VRF milik CC
 *
 * Route ini SENGAJA terpisah dari /api/packs (packs.controller.ts): itu jalur
 * inventory internal Hoshi (rarity 5-tier, rupiah, undian lokal). Yang di sini
 * diundi oleh VRF on-chain CollectorCrypt dan dibayar pakai USDC.
 */
@ApiTags('gacha')
@Controller('gacha')
export class GachaController {
  constructor(private readonly gacha: GachaService) {}

  /* --- Publik. Read-only, tidak menyentuh ledger maupun wallet siapa pun. --- */

  @Get('machines')
  @ApiOperation({
    summary:
      'Katalog mesin: harga, odds, EV, stock — sumber kebenaran ada di CollectorCrypt',
  })
  machines() {
    return this.gacha.machines();
  }

  @Get('stock')
  @ApiOperation({ summary: 'Sisa stok kartu per rarity (publik)' })
  stock() {
    return this.gacha.stock();
  }

  @Get('winners')
  @ApiQuery({
    name: 'packType',
    required: false,
    example: 'pokemon_50',
    description:
      'Kode mesin dari GET /gacha/machines. Kosongkan untuk menggabungkan beberapa mesin.',
  })
  @ApiOperation({
    summary:
      'Kartu-kartu yang baru dimenangkan untuk ticker "Live Card Won" (publik)',
  })
  winners(@Query('packType') packType?: string) {
    return this.gacha.winners(packType);
  }

  @Get('verify/:memo')
  @ApiOperation({
    summary:
      'Bukti VRF sebuah memo — sengaja publik supaya siapa pun bisa memeriksa undian',
  })
  vrfVerify(@Param('memo') memo: string) {
    return this.gacha.vrfVerify(memo);
  }

  /* --- Perlu login. Setiap route ber-memo memverifikasi kepemilikan di service:
         memo ditulis ke transaksi on-chain → PUBLIK, jadi ia kunci join, bukan kunci akses. --- */

  @Post('purchase')
  @ApiBearerAuth()
  // LUBANG TREASURY — DITUTUP. Route ini DULU cuma @UseGuards(JwtAuthGuard): SETIAP user login bisa
  // memanggilnya dan tiap panggilan membelanjakan ~$50 USDC treasury sungguhan TANPA gerbang bayar
  // apa pun (identitas gratis via auth.service → drain tak terbatas, minimal $500/hari lewat daily cap).
  // Jalur beli untuk user Indonesia sekarang HANYA lewat rail IDRX: POST /api/payments/pack → bayar
  // rupiah → callback/reconciler memverifikasi PAID+MINTED → PaymentsService yang memanggil purchase()
  // secara internal SETELAH mengklaim baris pembayaran rupiah secara atomik.
  // Route ini DIPERTAHANKAN khusus uji coba devnet dan DIKUNCI ke AdminGuard. JANGAN PERNAH
  // menurunkannya kembali ke JwtAuthGuard: user biasa tidak boleh lagi menyentuh purchase().
  @UseGuards(AdminGuard)
  // Rate limit BUKAN izin belanja — ia cuma membatasi ledakan; yang mengotorisasi pengeluaran
  // treasury tetap service (klaim pembayaran rupiah), bukan JWT/AdminGuard dan bukan angka ini.
  @Throttle({ default: { ttl: 60000, limit: 3 } })
  @ApiOperation({
    summary:
      'ADMIN-ONLY (devnet) — beli pack alur treasury langsung. User biasa memakai POST /api/payments/pack.',
    description:
      'Satu request, langsung selesai: user TIDAK menandatangani apa pun dan tidak perlu punya ' +
      'USDC/SOL. Treasury Hoshi jadi pembayar (playerAddress) sekaligus penanda tangan ' +
      'server-side, sedangkan wallet user dari JWT dipakai sebagai penerima kartu ' +
      '(altPlayerAddress) — alamat penerima diturunkan dari token, tidak pernah dari body.',
  })
  purchase(@Body() dto: PurchasePackDto, @CurrentUser() user: AuthUser) {
    return this.gacha.purchase(dto, user);
  }

  @Post('packs')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  // Lebih ketat dari default global (60/menit): tiap panggilan menerbitkan memo +
  // transaksi siap-tanda-tangan senilai ~$50 dan memicu 2 request keluar ke CC.
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Beli pack → memo + transaksi UNSIGNED (wallet user yang menandatangani)',
  })
  generate(@Body() dto: GeneratePackDto, @CurrentUser() user: AuthUser) {
    return this.gacha.generate(dto, user);
  }

  @Post('packs/:memo/submit')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Teruskan transaksi yang sudah ditandatangani wallet user ke CollectorCrypt',
  })
  submit(
    @Param('memo') memo: string,
    @Body() dto: SubmitPackDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.gacha.submit(memo, dto, user);
  }

  @Post('packs/:memo/open')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Buka pack → rarity/roll/points datang dari VRF CollectorCrypt, bukan dari kita',
  })
  open(@Param('memo') memo: string, @CurrentUser() user: AuthUser) {
    return this.gacha.open(memo, user);
  }

  /* --- 'me/packs' didaftarkan SEBELUM 'packs/:memo' supaya "me" tidak pernah
         tertangkap sebagai sebuah memo. --- */

  @Get('me/packs')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Riwayat pack milik user login (terbaru dulu)' })
  myPacks(@CurrentUser() user: AuthUser) {
    return this.gacha.myPacks(user.id);
  }

  @Get('packs/:memo')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Status satu pack milik sendiri (ledger kita + lifecycle versi CollectorCrypt)',
  })
  packStatus(@Param('memo') memo: string, @CurrentUser() user: AuthUser) {
    return this.gacha.packStatus(memo, user);
  }

  @Post('buyback')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Jual balik kartu (jendela 72 jam) → transaksi UNSIGNED + nominal refund dari CC',
  })
  buyback(@Body() dto: BuybackDto, @CurrentUser() user: AuthUser) {
    return this.gacha.buyback(dto, user);
  }
}
