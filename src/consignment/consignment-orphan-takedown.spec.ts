import { ConflictException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ConsignmentPhotoKind, ConsignmentStatus } from '@prisma/client';
import type { AuthUser } from '../auth/jwt.strategy';
import type { BalanceService } from '../balance/balance.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ConsignmentNotifyService } from './consignment-notify.service';
import { ConsignmentService } from './consignment.service';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ BARIS YATIM: Consignment LISTED, tapi baris Listing-nya SUDAH TIDAK ADA.                     ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * File spec TERPISAH dengan sengaja — `consignment.service.spec.ts` sedang disentuh pekerjaan
 * lain, dan satu-satunya hal yang diuji di sini adalah SATU cabang: `requestWithdrawal` untuk
 * baris yang kehilangan listing-nya.
 *
 * KENAPA KEADAAN INI ADA. `DELETE /admin/listings/:id` dulu menerima baris titipan apa adanya.
 * Yang tersisa sesudahnya adalah catatan titipan berstatus LISTED dengan `listing = null`, dan
 * SEMUA jalan keluarnya buntu: `requestWithdrawal` melempar "data tidak konsisten", dan
 * `createListingFor` menolak karena `listClaimWhere` menuntut IN_CUSTODY. Artinya KARTU FISIK
 * MILIK ORANG LAIN terkunci permanen di rak Hoshi, hanya bisa dibebaskan lewat UPDATE tangan ke
 * database produksi.
 *
 * Rute penghapusannya SEKARANG DITOLAK di backend (lihat `admin.service.spec.ts`), jadi baris
 * seperti ini tidak bisa lahir lagi. Tapi yang SUDAH TERLANJUR ada di produksi tetap harus punya
 * jalan pulang — dan melempar error kepada PEMILIK KARTU adalah menjadikan kerusakan data milik
 * Hoshi sebagai hukuman baginya.
 */
describe('ConsignmentService.requestWithdrawal — penyelamatan baris LISTED yang listing-nya hilang', () => {
  const ID = 'consign-yatim';
  const ACCEPTED = new Date('2026-09-01T00:00:00.000Z');

  const consignor: AuthUser = {
    id: 'user-7',
    walletAddress: 'ConsignorWalletBase58',
    displayName: 'Budi',
    role: 'USER',
  };

  type Mock = jest.Mock;
  let prisma: {
    consignment: { findUnique: Mock; updateMany: Mock };
    consignmentEvent: { create: Mock };
    listing: { updateMany: Mock };
    offer: { updateMany: Mock };
    activity: { create: Mock };
    domesticShippingRate: { findMany: Mock };
    $transaction: Mock;
  };
  let service: ConsignmentService;

  const rowWith = (over: Record<string, unknown> = {}) => ({
    id: ID,
    consignorId: consignor.id,
    consignorNameAtIntake: 'Budi',
    consignorPhoneAtIntake: '+62811',
    receivedById: 'admin-1',
    cardName: 'Charizard',
    cardSet: 'Base',
    askPriceIdr: 1_000_000,
    commissionBps: 500,
    // INTI FIXTURE-nya: LISTED, custody masih terpegang, tapi TIDAK ADA baris listing.
    status: ConsignmentStatus.LISTED,
    custodyAcceptedAt: ACCEPTED,
    custodyReleasedAt: null,
    withdrawRequestedAt: null,
    returnMethod: null,
    returnRecipientName: null,
    returnPhoneNumber: null,
    returnStreet: null,
    returnCity: null,
    returnState: null,
    returnZip: null,
    returnCountry: null,
    photos: [
      { id: 'p1', kind: ConsignmentPhotoKind.FRONT },
      { id: 'p2', kind: ConsignmentPhotoKind.BACK },
    ],
    listing: null as Record<string, unknown> | null,
    events: [],
    ...over,
  });

  beforeEach(() => {
    prisma = {
      consignment: {
        findUnique: jest.fn().mockResolvedValue(rowWith()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      consignmentEvent: { create: jest.fn().mockResolvedValue({}) },
      listing: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      offer: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      activity: { create: jest.fn().mockResolvedValue({}) },
      domesticShippingRate: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((cb: (tx: typeof prisma) => unknown) => cb(prisma)),
    };
    service = new ConsignmentService(
      prisma as unknown as PrismaService,
      { credit: jest.fn() } as unknown as BalanceService,
      {
        notifyListed: jest.fn(),
        notifySold: jest.fn(),
        notifyLost: jest.fn(),
      } as unknown as ConsignmentNotifyService,
      { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService,
    );
  });

  it('TIDAK melempar "data tidak konsisten" — pemiliknya tetap bisa meminta kartunya kembali', async () => {
    await expect(
      service.requestWithdrawal(ID, {}, consignor),
    ).resolves.toBeDefined();
  });

  it('mengembalikan titipannya ke IN_CUSTODY lewat KLAIM ATOMIK yang sama, bukan update buta', async () => {
    await service.requestWithdrawal(ID, {}, consignor);

    expect(prisma.consignment.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        // `takeDownClaimWhere` — predikat yang sama dengan cabang normal: LISTED + custody
        // belum dilepas. Balapan dengan settlement tetap diselesaikan `count !== 1`.
        where: expect.objectContaining({
          id: ID,
          status: ConsignmentStatus.LISTED,
          custodyReleasedAt: null,
        }) as unknown,
        data: expect.objectContaining({
          status: ConsignmentStatus.IN_CUSTODY,
          withdrawRequestedAt: expect.any(Date) as unknown,
        }) as unknown,
      }),
    );
  });

  it('CUSTODY TIDAK DILEPAS — kartunya masih di rak sampai serah-terimanya dicatat', async () => {
    await service.requestWithdrawal(ID, {}, consignor);

    const writes = (
      prisma.consignment.updateMany.mock.calls as [
        { data: Record<string, unknown> },
      ][]
    ).map(([a]) => a.data);
    for (const data of writes) {
      expect(data).not.toHaveProperty('custodyReleasedAt');
    }
  });

  it('TIDAK menyentuh baris listing / offer / activity — tidak ada listing untuk disentuh', async () => {
    await service.requestWithdrawal(ID, {}, consignor);

    expect(prisma.listing.updateMany).not.toHaveBeenCalled();
    expect(prisma.offer.updateMany).not.toHaveBeenCalled();
    // `LISTING_CANCELED` untuk listing yang sudah tidak ada adalah baris feed yang berbohong.
    expect(prisma.activity.create).not.toHaveBeenCalled();
  });

  it('meninggalkan JEJAK: satu ConsignmentEvent TAKE_DOWN yang menyebut ini pemulihan', async () => {
    await service.requestWithdrawal(ID, {}, consignor);

    expect(prisma.consignmentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          consignmentId: ID,
          kind: 'TAKE_DOWN',
          fromStatus: ConsignmentStatus.LISTED,
          toStatus: ConsignmentStatus.IN_CUSTODY,
          // Pemiliknya berhak membaca riwayatnya sendiri; "PEMULIHAN" adalah kata yang
          // membedakan baris ini dari penarikan biasa saat seseorang menelusurinya nanti.
          note: expect.stringContaining('PEMULIHAN') as unknown,
        }) as unknown,
      }),
    );
  });

  it('kalah balapan (klaim cocok 0 baris) tetap gagal keras — bukan sukses palsu', async () => {
    prisma.consignment.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.requestWithdrawal(ID, {}, consignor)).rejects.toThrow(
      ConflictException,
    );
  });
});
