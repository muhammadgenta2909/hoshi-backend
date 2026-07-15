import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthUser } from '../auth/jwt.strategy';
import { CreatePackOrderDto } from './dto/create-pack-order.dto';
import { PaymentsService } from './payments.service';

/**
 * Rail pembayaran IDRX — mount di /api/payments (prefix global 'api' dari main.ts).
 *
 * Inilah SATU-SATUNYA jalan sah menuju belanja treasury untuk user Indonesia. Alur lama
 * POST /gacha/purchase (yang membelanjakan ~$50 USDC treasury per panggilan tanpa gerbang
 * bayar) sudah ditutup — sekarang hanya PaymentsService yang boleh memanggil
 * GachaService.purchase(), dan hanya SETELAH sebuah PaymentOrder rupiah diklaim secara atomik.
 *
 * Controller ini SENGAJA setipis mungkin: setiap keputusan uang (harga, penerima kartu,
 * verifikasi lunas, klaim atomik) ada di service. Yang ada di sini cuma bentuk HTTP-nya —
 * termasuk dua keputusan HTTP yang, kalau salah, langsung berarti uang hilang: callback WAJIB
 * selalu 2xx (IDRX tidak pernah retry) dan callback WAJIB lepas dari throttler global.
 */
@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  @Post('pack')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  // Rem ledakan saja — TIAP order memicu satu mint-request keluar ke IDRX + satu panggilan
  // harga ke CC + satu baris yang harus dipoll reconciler. Rate limit BUKAN gerbangnya: identitas
  // gratis (auth.service upsert user untuk alamat apa pun) membuat batas per-IP mudah di-Sybil.
  // Plafon yang sesungguhnya per-user (jumlah order PENDING) ditegakkan di service (assertOrderQuota).
  @Throttle({ default: { ttl: 60000, limit: 10 } })
  @ApiOperation({
    summary:
      'Terbitkan tagihan rupiah untuk satu pack → QR / VA / paymentUrl IDRX (tidak ada USDC bergerak)',
    description:
      'User membayar rupiah lewat QRIS/e-wallet/VA. Nominal & penerima TIDAK PERNAH dari body: ' +
      'harga di-snapshot server dari mesin CC + kurs IDRX, penerima IDRX selalu treasury Hoshi, ' +
      'penerima kartu diturunkan dari baris User saat fulfilment. Kartu baru dibeli setelah IDRX ' +
      'mengonfirmasi PAID+MINTED lewat callback/reconciler — bukan di request ini.',
  })
  createPackOrder(
    @Body() dto: CreatePackOrderDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.createPackOrder(dto, user);
  }

  @Get('me/orders')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Riwayat order pembayaran milik user login (terbaru dulu)',
  })
  myOrders(@CurrentUser() user: AuthUser) {
    return this.payments.myOrders(user.id);
  }

  @Get('orders/:merchantOrderId')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiParam({
    name: 'merchantOrderId',
    description:
      'Kunci join yang diterbitkan IDRX. PUBLIK, bukan kapabilitas — service tetap ' +
      'mengecek kepemilikan, jadi hanya pemilik order yang bisa melihat nominal/QR/wallet-nya.',
  })
  @ApiOperation({
    summary:
      'Status satu order milik sendiri (dicek kepemilikannya di service)',
  })
  getOrder(
    @Param('merchantOrderId') merchantOrderId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.payments.getOrder(merchantOrderId, user);
  }

  @Post('idrx/callback')
  // PUBLIK, TANPA GUARD — IDRX tidak bisa mengirim JWT kita. Justru KARENA itu body-nya tidak
  // dipercaya: service membaca TEPAT satu field (merchantOrderId) lalu memverifikasi ulang
  // server-to-server ke History API IDRX. Membaca paymentStatus dari body = siapa pun yang tahu
  // URL ini bisa mengklaim pack ~$50 gratis.
  @HttpCode(200)
  // Callback IDRX datang dari segelintir IP egress tetap dan berbagi SATU bucket throttler
  // global (diperparah trust-proxy yang mati di prod: semua request tampak dari IP proxy Render).
  // Sebuah 429 di sini = callback yang tidak pernah IDRX ulangi = pembayaran hilang. Aman dilepas
  // karena route ini tidak mengerjakan apa pun dari body: lookup O(1) lalu 2xx, verifikasi async.
  @SkipThrottle()
  @ApiOperation({
    summary:
      'Webhook IDRX (publik, tak bertanda tangan) → selalu 2xx; body cuma pemicu, bukti diambil ulang',
  })
  async handleCallback(
    // Longgar dengan sengaja. Diketik sebagai Record<string, unknown> agar metatype-nya native
    // (Object) sehingga ValidationPipe global (whitelist + forbidNonWhitelisted, main.ts) TIDAK
    // menolaknya — DTO ketat akan mem-400 setiap callback begitu IDRX menambah satu field baru,
    // dan callback yang di-400 tidak pernah diulang = uang hilang.
    @Body() body: Record<string, unknown>,
  ): Promise<{ received: true }> {
    // handleCallback() service sudah dirancang TIDAK PERNAH melempar. Try/catch ini murni jaring
    // pengaman berlapis: apa pun yang tak terduga di sini tidak boleh berubah jadi non-2xx, karena
    // IDRX tidak pernah retry. Rekonsiler (POST /payments/reconcile) tetap menangkap order ini
    // lewat polling History API — callback murni optimasi latency, bukan sumber kebenaran.
    try {
      await this.payments.handleCallback(body);
    } catch (err) {
      this.logger.error(
        `Callback IDRX gagal diproses (tetap 2xx, reconciler menyusul): ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
    return { received: true };
  }

  @Post('reconcile')
  @ApiBearerAuth()
  @UseGuards(AdminGuard)
  // Rekonsiler adalah infrastruktur WAJIB, bukan optimasi: ia satu-satunya yang menyelamatkan
  // user yang sudah bayar saat callback hilang (deploy/502/OOM) atau URL callback salah didaftar.
  // Dilepas dari throttler global karena cadence-nya dipicu cron/uptime pinger eksternal dan tidak
  // boleh ikut kena 429 gara-gara bucket global yang jenuh oleh trafik lain di belakang proxy Render.
  // AdminGuard yang menjaganya dari penyalahgunaan, bukan rate limit.
  @SkipThrottle()
  @ApiOperation({
    summary:
      'Admin: satu putaran rekonsiliasi — poll History API untuk order stale, tebus yang PAID+MINTED',
  })
  reconcile() {
    return this.payments.reconcile();
  }
}
