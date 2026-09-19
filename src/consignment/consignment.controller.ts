import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { ConsignmentService } from './consignment.service';
import { WithdrawConsignmentDto } from './dto/consignment.dto';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TITIPAN — DUA RUTE MILIK PEMILIK KARTU, dan KEDUANYA memang harus ada.                      ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * 1. MELIHAT TITIPANNYA SENDIRI — lengkap dengan foto saat serah-terima, catatan kondisi, nama
 *    penerimanya, nomor sertifikat, komisi yang disepakati, dan seluruh riwayat auditnya.
 *    Buktinya milik DIA, bukan milik kami; menyembunyikannya di dashboard admin akan mengubah
 *    seluruh catatan ini menjadi "kata Hoshi" lagi.
 *
 * 2. MEMINTA KARTUNYA KEMBALI — kapan saja, GRATIS. Nol Rupiah bergerak di jalur ini: tanpa biaya
 *    penyimpanan, tanpa biaya penanganan, tanpa biaya listing. Itu SELURUH nilai tuas ini.
 *    Ini, bersama sertifikat grading yang bisa dicek di situs grader-nya sendiri, adalah alasan
 *    sebenarnya orang mau menitipkan kartunya — bukan NFT.
 *
 * TIDAK ADA rute pencatatan self-service. Yang mencatat titipan adalah orang yang benar-benar
 * memegang kartunya (lihat consignment.admin.controller.ts).
 */
@ApiTags('consignments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('consignments')
export class ConsignmentController {
  constructor(private readonly service: ConsignmentService) {}

  @Get('mine')
  @ApiOperation({
    summary:
      'Titipan milik saya, lengkap dengan bukti serah-terima dan riwayatnya. Buktinya milik ' +
      'pemilik kartu, bukan milik Hoshi.',
  })
  mine(@CurrentUser() user: AuthUser) {
    return this.service.listMine(user.id);
  }

  @Post(':id/withdraw')
  @ApiOperation({
    summary:
      'Minta kartu saya kembali. GRATIS dan tanpa syarat selama kartunya belum terjual. Kalau ' +
      'kartunya sedang terpajang, listing-nya diturunkan ATOMIK di transaksi yang sama — dan ' +
      'kalau ia justru terjual pada detik yang sama, permintaan ini ditolak apa adanya dan ' +
      'hasil penjualannya masuk ke saldo Anda.',
  })
  withdraw(
    @Param('id') id: string,
    @Body() dto: WithdrawConsignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.requestWithdrawal(id, dto, user);
  }
}
