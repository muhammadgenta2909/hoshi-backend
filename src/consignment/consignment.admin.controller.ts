import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConsignmentStatus } from '@prisma/client';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthUser } from '../auth/jwt.strategy';
import { ConsignmentService } from './consignment.service';
import {
  AcceptCustodyDto,
  AddConsignmentPhotosDto,
  CompensateConsignmentDto,
  CorrectConsignmentDto,
  CreateConsignmentDto,
  CreateConsignmentListingDto,
  MarkConsignmentLostDto,
  ReleaseConsignmentDto,
  UpdateConsignmentPriceDto,
  WithdrawConsignmentDto,
} from './dto/consignment.dto';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ TITIPAN — RUTE ADMIN. Semuanya di balik AdminGuard, TANPA KECUALI.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * TIDAK ADA rute self-service untuk mencatat titipan, dan itu disengaja: sebuah endpoint yang bisa
 * dipanggil orang asing untuk menyatakan "kartu saya ada di kalian" adalah mesin pembuat
 * kebohongan. Yang mencatat adalah orang yang benar-benar memegang kartunya.
 *
 * NOL USDC, NOL SOL, NOL on-chain, NOL escrow, NOL panggilan CollectorCrypt di SELURUH rute ini.
 */
@ApiTags('admin-consignments')
@ApiBearerAuth()
@UseGuards(AdminGuard)
@Controller('admin/consignments')
export class ConsignmentAdminController {
  constructor(private readonly service: ConsignmentService) {}

  @Get()
  @ApiOperation({
    summary:
      'Daftar titipan + actionRequired (INTAKE yang menggantung, penarikan yang belum ' +
      'diserahkan, SOLD yang kartunya masih di rak).',
  })
  list(@Query('status') status?: ConsignmentStatus) {
    return this.service.adminList(status);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Satu titipan lengkap dengan foto bukti dan riwayat auditnya.',
  })
  byId(@Param('id') id: string) {
    return this.service.byId(id);
  }

  @Post()
  @ApiOperation({
    summary:
      'Catat KESEPAKATAN (status INTAKE). Kartunya belum tentu diserahkan — baris INTAKE tidak ' +
      'bisa dipajang oleh apa pun dan tidak bisa dijual oleh apa pun.',
  })
  create(@Body() dto: CreateConsignmentDto, @CurrentUser() admin: AuthUser) {
    return this.service.createIntake(dto, admin);
  }

  @Post(':id/photos')
  @ApiOperation({
    summary:
      'Tambah foto bukti. APPEND-ONLY: tidak ada rute update/delete untuk foto.',
  })
  addPhotos(
    @Param('id') id: string,
    @Body() dto: AddConsignmentPhotosDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.addPhotos(id, dto, admin);
  }

  @Post(':id/accept-custody')
  @ApiOperation({
    summary:
      'SATU-SATUNYA penulis custodyAcceptedAt. Panggil HANYA setelah kartunya benar-benar di ' +
      'tangan Hoshi. Menolak kalau foto FRONT/BACK (dan CERT bila ada nomor sertifikat), ' +
      'catatan kondisi, atau lokasi penyimpanan belum ada.',
  })
  accept(
    @Param('id') id: string,
    @Body() dto: AcceptCustodyDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.acceptCustody(id, dto, admin);
  }

  @Post(':id/listing')
  @ApiOperation({
    summary:
      'Pajang kartu titipan. SATU-SATUNYA penulis Listing.consignmentId, dan ia berjalan di ' +
      'transaksi yang sama dengan klaim IN_CUSTODY→LISTED — jadi listing titipan tidak bisa ' +
      'lahir sebelum custody tercatat.',
  })
  createListing(
    @Param('id') id: string,
    @Body() dto: CreateConsignmentListingDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.createListingFor(id, dto, admin);
  }

  @Patch(':id/price')
  @ApiOperation({
    summary:
      'Ubah harga. Rute ADMIN (bukan PATCH /marketplace/:id milik penjual): harga bagian dari ' +
      'perjanjian, jadi wajib beralasan dan alasannya disimpan permanen.',
  })
  updatePrice(
    @Param('id') id: string,
    @Body() dto: UpdateConsignmentPriceDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.updatePrice(id, dto, admin);
  }

  @Post(':id/withdraw')
  @ApiOperation({
    summary:
      'Tarik kembali atas nama pemilik (admin). Sama persis dengan rute pemiliknya sendiri. ' +
      'GRATIS — nol Rupiah bergerak di jalur ini.',
  })
  withdraw(
    @Param('id') id: string,
    @Body() dto: WithdrawConsignmentDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.requestWithdrawal(id, dto, admin);
  }

  @Post(':id/release')
  @ApiOperation({
    summary:
      'Kartunya FISIK keluar dari Hoshi (WITHDRAWN / SHIPPED_TO_BUYER). Menulis ' +
      'custodyReleasedAt, yang tidak pernah dihapus. Kartu HILANG punya rute sendiri.',
  })
  release(
    @Param('id') id: string,
    @Body() dto: ReleaseConsignmentDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.release(id, dto, admin);
  }

  @Post(':id/lost')
  @ApiOperation({
    summary:
      'Kartu hilang/rusak dalam pengawasan Hoshi. Listing yang masih hidup ikut diturunkan di ' +
      'transaksi yang sama.',
  })
  markLost(
    @Param('id') id: string,
    @Body() dto: MarkConsignmentLostDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.markLost(id, dto, admin);
  }

  @Post(':id/compensate')
  @ApiOperation({
    summary:
      'Ganti rugi ke pemilik lewat ledger saldo yang sudah ada. IDEMPOTEN per titipan — klik ' +
      'dua kali tidak bisa membayar dua kali.',
  })
  compensate(
    @Param('id') id: string,
    @Body() dto: CompensateConsignmentDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.compensate(id, dto, admin);
  }

  @Post(':id/correction')
  @ApiOperation({
    summary:
      'Koreksi catatan intake. TIDAK menimpa kolom apa pun — ditulis sebagai baris audit baru, ' +
      'supaya koreksi TERLIHAT sebagai koreksi.',
  })
  correct(
    @Param('id') id: string,
    @Body() dto: CorrectConsignmentDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.addCorrection(id, dto, admin);
  }
}
