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
      'Daftar titipan + actionRequired (INTAKE yang menggantung, kartu di rak yang pemiliknya ' +
      'belum tertaut, kode klaim kedaluwarsa, penarikan yang belum diserahkan, SOLD yang ' +
      'kartunya masih di rak) + awaitingOwner (sekilas: kartu di tangan kita yang masih ' +
      'menunggu pemiliknya, lengkap dengan nama & telepon dari serah-terima).',
  })
  list(
    @Query('status') status?: ConsignmentStatus,
    @Query('filter') filter?: 'AWAITING_OWNER',
  ) {
    return this.service.adminList(status, filter);
  }

  /**
   * ╔══════════════════════════════════════════════════════════════════════════════════════════╗
   * ║ CARI PEMILIK. MENGEMBALIKAN DAFTAR — TIDAK PERNAH "ini orangnya".                        ║
   * ╚══════════════════════════════════════════════════════════════════════════════════════════╝
   *
   * Dipakai operator yang sedang berdiri di rumah pemilik kartu: yang ia punya cuma apa yang
   * terlihat di layar ponsel orang itu (nama tampilan, alamat wallet, kadang email), bukan id
   * database.
   *
   * DI ATAS `@Get(':id')` DENGAN SENGAJA. Nest mencocokkan rute sesuai URUTAN DEKLARASI; kalau
   * rute ini ada di bawah, `GET /admin/consignments/consignor-search` akan tertangkap sebagai
   * `byId('consignor-search')` dan dijawab 404 — bug yang sulit dilihat karena keduanya benar
   * secara sintaksis.
   *
   * Rute ini TIDAK MENULIS APA PUN. Yang menulis tautan adalah `POST /` (intake) dan
   * `POST /:id/link-consignor`, dan keduanya HANYA menerima `consignorId`.
   */
  @Get('consignor-search')
  @ApiOperation({
    summary:
      'Cari calon pemilik kartu (min 3 karakter) untuk dipilih SENDIRI oleh operator. Selalu ' +
      'mengembalikan daftar; `ambiguous` true berarti lebih dari satu kandidat dan UI WAJIB ' +
      'memaksa memilih. Hanya walletAddress yang unik — displayName bisa kembar dan email TIDAK ' +
      'PERNAH diverifikasi, jadi kecocokan atas keduanya adalah petunjuk, bukan identitas.',
  })
  searchConsignors(@Query('q') q?: string) {
    return this.service.searchConsignors(q ?? '');
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
      'bisa dipajang oleh apa pun dan tidak bisa dijual oleh apa pun. `consignorId` OPSIONAL: ' +
      'kalau pemiliknya belum punya akun, kosongkan dan responsnya memuat KODE KLAIM sekali ' +
      'pakai untuk dicetak di tanda terima — kode itu ditampilkan SEKALI dan tidak bisa dibaca ' +
      'lagi. Kartu tanpa pemilik tertaut TIDAK BISA dipajang maupun terjual.',
  })
  create(@Body() dto: CreateConsignmentDto, @CurrentUser() admin: AuthUser) {
    return this.service.createIntake(dto, admin);
  }

  /**
   * TERBITKAN / TERBITKAN ULANG kode klaim — jawaban untuk "tanda terimanya hilang".
   *
   * Kodenya tidak bisa dibaca kembali oleh siapa pun (database hanya menyimpan hash-nya), jadi
   * satu-satunya pemulihan adalah menerbitkan yang BARU. Penerbitan ulang MENIMPA hash yang lama
   * dalam satu tulisan: kertas lama langsung mati, dan tidak pernah ada dua kode hidup untuk satu
   * titipan.
   *
   * DITOLAK kalau titipannya sudah punya pemilik — kunci yang tidak membuka apa pun tidak perlu
   * dibuat. `note` WAJIB dan tersimpan permanen.
   */
  @Post(':id/claim-code')
  @ApiOperation({
    summary:
      'Terbitkan / terbitkan ulang kode klaim untuk titipan yang pemiliknya belum tertaut. ' +
      'Kodenya dikembalikan SEKALI di respons dan tidak pernah bisa dibaca lagi; penerbitan ' +
      'ulang mematikan kode sebelumnya. Ditolak kalau titipannya sudah bertuan.',
  })
  issueClaimCode(
    @Param('id') id: string,
    @Body() dto: IssueClaimCodeDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.issueClaimCode(id, dto, admin);
  }

  /**
   * TAUTKAN akun pemilik ke titipan yang belum bertuan (Path A yang datang terlambat: pemiliknya
   * membuat akun di tempat, atau datang lagi dan identitasnya diperiksa langsung).
   *
   * HANYA menerima `consignorId`, yang datang dari `GET consignor-search` — email tidak unik dan
   * tidak pernah diverifikasi, jadi ia tidak boleh jadi kunci penautan. TIDAK PERNAH menimpa
   * pemilik yang sudah ada: predikat klaimnya menyebut `consignorId: null`.
   */
  @Post(':id/link-consignor')
  @ApiOperation({
    summary:
      'Tautkan akun pemilik ke titipan yang belum bertuan. Hanya menerima consignorId (dipilih ' +
      'dari consignor-search), wajib beralasan, dan TIDAK PERNAH menimpa pemilik yang sudah ada. ' +
      'Kode klaim yang masih beredar ikut dimatikan.',
  })
  linkConsignor(
    @Param('id') id: string,
    @Body() dto: LinkConsignorDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.linkConsignor(id, dto, admin);
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
      'tangan Hoshi. Menolak kalau foto FRONT/BACK/HANDOVER (dan CERT bila ada nomor ' +
      'sertifikat), catatan kondisi, atau lokasi penyimpanan belum ada. HANDOVER = foto STRUK ' +
      'SERAH TERIMA yang sudah ditandatangani kedua pihak; syarat ini berlaku untuk penerimaan ' +
      'BARU saja, karena rute ini hanya bisa dilewati satu kali per titipan (INTAKE → ' +
      'IN_CUSTODY).',
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

  /**
   * TARIK KEMBALI atas nama pemilik — dan SEKALIGUS tempat mencatat KE MANA kartunya pulang.
   *
   * `returnPlan` (opsional) menyimpan cara pengembalian, alamat tujuan, dan siapa yang menanggung
   * ongkir baliknya. Ia ditanyakan DI SINI karena inilah momen paling murah untuk menanyakannya:
   * orangnya sedang bicara dengan operator. Sesudah telepon ditutup, melengkapinya berarti
   * menelepon kembali — dan itulah bagaimana sebuah kartu berakhir tercatat "ditarik" selama
   * berminggu-minggu tanpa pernah dikirim ke mana pun.
   *
   * CUSTODY TIDAK DILEPAS DI SINI. Selama kartunya masih di rak, ia masih tanggung jawab Hoshi.
   * Pelepasannya ada di `POST :id/release`, yang menolak tanpa alamat/resi.
   */
  @Post(':id/withdraw')
  @ApiOperation({
    summary:
      'Tarik kembali atas nama pemilik (admin). Sama persis dengan rute pemiliknya sendiri. ' +
      'GRATIS — nol Rupiah bergerak di jalur ini, termasuk sesudah ongkir balik dicatat. ' +
      'Boleh membawa `returnPlan` (cara pengembalian + alamat + penanggung ongkir); mengirimnya ' +
      'lagi berarti MEMPERBARUI rencananya. TIDAK melepas custody: kartunya masih di rak Hoshi ' +
      'sampai serah-terimanya dicatat lewat :id/release.',
  })
  withdraw(
    @Param('id') id: string,
    @Body() dto: WithdrawConsignmentDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.requestWithdrawal(id, dto, admin);
  }

  /**
   * KARTUNYA FISIK KELUAR — dan untuk pengembalian ke pemilik, inilah tempat RESI dicatat.
   *
   * `WITHDRAWN` menuntut bukti yang sesuai dengan cara pengembaliannya: nama kurir + nomor resi
   * untuk COURIER, nama pengambil untuk PICKUP. Tanpa itu custody TIDAK dilepas — ditegakkan
   * berlapis: pemeriksaan service (yang menulis pesannya), predikat klaim
   * `withdrawnReleaseClaimWhere` (yang menyebut kolom alamat, jadi Postgres yang menolak), dan
   * CHECK `consignments_return_shape_chk` di tabelnya.
   *
   * `SHIPPED_TO_BUYER` TIDAK tersentuh aturan itu: pengiriman ke pembeli punya jalurnya sendiri
   * (`CardRedemption`), dan menumpangkan resinya di sini akan melahirkan dua tempat yang
   * menyimpan resi untuk satu kejadian.
   */
  @Post(':id/release')
  @ApiOperation({
    summary:
      'Kartunya FISIK keluar dari Hoshi (WITHDRAWN / SHIPPED_TO_BUYER). Menulis ' +
      'custodyReleasedAt, yang tidak pernah dihapus. Untuk WITHDRAWN: DITOLAK kalau cara ' +
      'pengembaliannya belum dicatat, alamatnya belum lengkap, resinya belum ada (COURIER), ' +
      'atau nama pengambilnya belum dicatat (PICKUP) — kartunya tetap tercatat di rak Hoshi. ' +
      'Boleh membawa `returnPlan` kalau alamatnya baru dicatat sekarang. Kartu HILANG punya ' +
      'rute sendiri.',
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

  /**
   * KOREKSI LABEL — satu-satunya rute di fitur ini yang MENIMPA kolom, dan garisnya tegas:
   * `conditionNote` dan foto adalah BUKTI (tetap tanpa rute update); `cardName` dan kawan-
   * kawannya adalah LABEL, dan label yang salah ketik menjadi JUDUL PUBLIK kartu orang lain.
   *
   * `PATCH` (bukan POST) dan bertetangga dengan `PATCH :id/price` dengan sengaja: keduanya
   * mengubah kolom yang bagian dari kesepakatan, keduanya WAJIB beralasan, dan keduanya menulis
   * baris audit di transaksi yang SAMA dengan perubahannya.
   */
  @Patch(':id/label')
  @ApiOperation({
    summary:
      'Koreksi label kartu (cardName, cardSet, cardNumber, certNumber, gradeLabel, gradeScore). ' +
      'Wajib beralasan; menyimpan nilai SEBELUM & SESUDAH sebagai baris audit LABEL_CORRECTION; ' +
      'judul listing yang MASIH ACTIVE ikut diperbaiki di transaksi yang sama. Catatan kondisi ' +
      'dan foto TIDAK bisa ditimpa lewat rute mana pun — keduanya bukti.',
  })
  correctLabel(
    @Param('id') id: string,
    @Body() dto: CorrectConsignmentLabelDto,
    @CurrentUser() admin: AuthUser,
  ) {
    return this.service.correctLabel(id, dto, admin);
  }
}
