import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { ConsignmentService } from './consignment.service';
import {
  ClaimConsignmentDto,
  WithdrawConsignmentDto,
} from './dto/consignment.dto';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TITIPAN — TIGA RUTE MILIK PEMILIK KARTU, dan KETIGANYA memang harus ada.                    ║
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
 * 3. MENUKARKAN KODE KLAIM — inilah yang membuat Hoshi bisa menerima kartu dari orang yang BELUM
 *    punya akun. Kartunya diserahkan hari itu juga; kodenya ada di tanda terima yang ia bawa
 *    pulang; akunnya dibuat kapan pun ia mau. Tanpa rute ini, satu-satunya kolektor yang bisa
 *    menitipkan kartu adalah kolektor yang kebetulan sudah punya akun — yang berarti hampir tidak
 *    ada, karena PM mendatangi mereka di rumah.
 *
 * TIDAK ADA rute pencatatan self-service. Yang mencatat titipan adalah orang yang benar-benar
 * memegang kartunya (lihat consignment.admin.controller.ts). Rute klaim di bawah BUKAN
 * pengecualiannya: ia tidak bisa MEMBUAT catatan titipan, ia hanya bisa menautkan akun ke catatan
 * yang SUDAH dibuat oleh orang yang memegang kartunya — dan hanya dengan kode yang ia serahkan
 * sendiri bersama kartunya.
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

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ TUKARKAN KODE KLAIM — inilah yang membuat titipan bisa diterima dari orang TANPA AKUN.  ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Pemilik kartu menyerahkan kartunya hari itu juga dan pulang membawa tanda terima bertanda
   * tangan yang memuat sebuah kode. Kapan pun setelahnya, dengan cara masuk apa pun (wallet,
   * Google — SIWS tetap satu-satunya jalur auth di belakangnya), ia mengetik kode itu di sini dan
   * catatan titipannya menjadi miliknya: buktinya bisa ia lihat, kartunya bisa ia minta kembali,
   * dan hasil penjualannya punya tujuan.
   *
   * KENAPA KODE ITU CUKUP SEBAGAI BUKTI: ia berpindah tangan PADA DETIK YANG SAMA dengan
   * kartunya, di depan dua orang, dengan foto serah-terima. Kekuatannya bukan dari kerahasiaan
   * saluran — ia dicetak di kertas — melainkan dari serah-terima fisik yang sudah terjadi.
   *
   * @Throttle 5/menit/IP. INI REM LEDAKAN, BUKAN PENGAMANNYA. Yang membuat menebak sia-sia adalah
   * 50 bit entropi kodenya (32^10 kemungkinan): pada 5 tebakan per menit, satu kode hidup butuh
   * ~10^8 tahun untuk ditemukan. Throttle-nya ada supaya percobaan massal juga tidak membebani
   * database, dan supaya lonjakan kegagalan terlihat.
   *
   * SETIAP kegagalan dijawab dengan objek yang SAMA PERSIS — bentuk salah, tidak ada,
   * kedaluwarsa, sudah dipakai, sudah bertuan. Rute ini tidak pernah mengonfirmasi tebakan.
   */
  @Post('claim')
  @Throttle({ default: { ttl: 60000, limit: 5 } })
  @ApiOperation({
    summary:
      'Tukarkan kode klaim pada tanda terima serah-terima Anda. Sekali pakai. Semua kegagalan ' +
      'dijawab identik — rute ini tidak pernah memberi tahu apakah sebuah kode ada.',
  })
  claim(@Body() dto: ClaimConsignmentDto, @CurrentUser() user: AuthUser) {
    return this.service.claimByCode(dto, user);
  }

  /**
   * MINTA KARTU SAYA KEMBALI — dan, kalau mau, sebutkan sekalian ke mana ia dikirim.
   *
   * `returnPlan` OPSIONAL, dan opsionalnya disengaja: permintaan "saya mau kartu saya kembali"
   * TIDAK BOLEH bisa gagal karena sebuah kode pos. Pemilik yang menekan tombolnya dari ponsel di
   * jalan tetap harus bisa menyampaikan maksudnya; alamatnya menyusul lewat rute yang sama, atau
   * lewat operator. Yang TIDAK opsional adalah alamat pada saat kartunya ditandai keluar.
   *
   * TETAP GRATIS. Mencatat ongkir balik BUKAN menagihnya: nol Rupiah bergerak di jalur ini.
   */
  @Post(':id/withdraw')
  @ApiOperation({
    summary:
      'Minta kartu saya kembali. GRATIS dan tanpa syarat selama kartunya belum terjual. Kalau ' +
      'kartunya sedang terpajang, listing-nya diturunkan ATOMIK di transaksi yang sama — dan ' +
      'kalau ia justru terjual pada detik yang sama, permintaan ini ditolak apa adanya dan ' +
      'hasil penjualannya masuk ke saldo Anda. Boleh menyertakan `returnPlan` (diambil sendiri, ' +
      'atau dikirim kurir ke alamat tertentu); mengirimnya lagi berarti memperbaruinya. ' +
      'Permintaan ini TIDAK melepas custody — kartunya tetap tanggung jawab Hoshi sampai ' +
      'benar-benar berpindah tangan.',
  })
  withdraw(
    @Param('id') id: string,
    @Body() dto: WithdrawConsignmentDto,
    @CurrentUser() user: AuthUser,
  ) {
    return this.service.requestWithdrawal(id, dto, user);
  }
}
