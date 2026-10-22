import { isDomesticShippableStock } from './hoshi-domestic-shipping';
import { isHoshiSellableStock } from './hoshi-stock';
import {
  listingKindOf,
  isConsignedListing,
  type ListingKind,
} from './listing-kind';

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ EMPAT JENIS LISTING TIDAK BOLEH BISA TERTUKAR — dan yang PALING mudah tertukar adalah        ║
 * ║ TITIPAN dengan P2P, karena keduanya punya `sellerId != null`.                                ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Salah menebak jenis berarti memilih jalur settlement yang salah, dan jalur settlement yang salah
 * gagal SESUDAH pembeli membayar. Itu mode kegagalan paling mahal di repo ini, dan sudah pernah
 * terjadi lebih dari sekali.
 */
describe('listingKindOf', () => {
  const base = {
    consignmentId: null as string | null,
    source: 'HOSHI',
    sellerId: null as string | null,
    sellable: false,
  };

  const row = (over: Partial<typeof base>) => ({ ...base, ...over });

  it('TITIPAN dijawab DULU, walau bentuknya identik dengan listing P2P', () => {
    // Inilah jebakan yang seluruh file ini ada untuk menutupnya: kartu titipan punya penjual
    // sungguhan (harus — kalau tidak, tidak ada yang bisa dikredit saat terjual) TAPI tidak punya
    // NFT di escrow. Pertanyaan bentuk apa pun yang diajukan lebih dulu akan menjawab USER_P2P,
    // dan jalur itu menyerahkan kartu DARI WALLET ESCROW yang tidak memegang apa pun.
    expect(
      listingKindOf(row({ consignmentId: 'c-1', sellerId: 'user-7' })),
    ).toBe<ListingKind>('CONSIGNMENT');
  });

  it('TITIPAN tetap TITIPAN walau kolom lain dimanipulasi ke bentuk jenis mana pun', () => {
    for (const over of [
      { source: 'COLLECTORCRYPT' },
      { sellable: true },
      { sellerId: null },
      { source: 'COLLECTORCRYPT', sellerId: null, sellable: true },
    ]) {
      expect(listingKindOf(row({ consignmentId: 'c-1', ...over }))).toBe(
        'CONSIGNMENT',
      );
    }
  });

  it('KATALOG CC: source CC tanpa penjual user', () => {
    expect(listingKindOf(row({ source: 'COLLECTORCRYPT' }))).toBe('CC_CATALOG');
  });

  it('kartu CC yang di-PULL lalu dipajang seorang user tetap USER_P2P (perilaku lama, tidak diubah)', () => {
    expect(
      listingKindOf(row({ source: 'COLLECTORCRYPT', sellerId: 'user-3' })),
    ).toBe('USER_P2P');
  });

  it('STOK HOSHI: tanpa penjual, bukan CC, DAN ditandai sellable', () => {
    expect(listingKindOf(row({ sellable: true }))).toBe('HOSHI_STOCK');
  });

  it('baris seed/placeholder (sellable=false) jatuh ke NOT_SELLABLE — fail-closed', () => {
    // `source=HOSHI, sellerId=null` adalah bentuk DEFAULT setiap baris listing, termasuk baris
    // chart-filler yang tidak punya kartu fisik di belakangnya.
    expect(listingKindOf(row({}))).toBe('NOT_SELLABLE');
  });

  it('LISTING USER biasa: punya penjual, bukan titipan', () => {
    expect(listingKindOf(row({ sellerId: 'user-9' }))).toBe('USER_P2P');
  });

  it('isConsignedListing membaca KOLOM, bukan bentuk', () => {
    expect(isConsignedListing({ consignmentId: 'c-1' })).toBe(true);
    expect(isConsignedListing({ consignmentId: null })).toBe(false);
  });

  it('`isHoshiSellableStock` TIDAK DIMODIFIKASI: baris titipan gagal di syarat sellerId == null', () => {
    // Itu jawaban yang BENAR — kartu titipan bukan stok Hoshi. Konsekuensinya baris titipan
    // otomatis tersingkir dari `listUnsellableStock` dan dari rute admin `setListingsSellable`
    // tanpa satu baris pun perubahan di sana.
    expect(
      isHoshiSellableStock({
        source: 'HOSHI',
        sellerId: 'user-7',
        sellable: true,
      }),
    ).toBe(false);
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ "DIKIRIM LEWAT MANA" ADALAH PERTANYAAN YANG BERBEDA DARI "BOLEH DIBELI LEWAT MANA".         ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 */
describe('isDomesticShippableStock', () => {
  const base = {
    consignmentId: null as string | null,
    source: 'HOSHI',
    sellerId: null as string | null,
    sellable: false,
  };
  const row = (over: Partial<typeof base>) => ({ ...base, ...over });

  it('kartu TITIPAN bisa dikirim kurir domestik — tanpa ini, pembelinya terkunci selamanya', () => {
    // Bug yang ditutupnya: gerbang target POST /redemptions dulu memakai `isHoshiSellableStock`,
    // yang menuntut `sellerId == null`. Kartu titipan selalu punya penjual, jadi pembelinya
    // MEMBAYAR RUPIAH LALU TIDAK PERNAH BISA MEMINTA PENGIRIMAN.
    expect(
      isDomesticShippableStock(
        row({ consignmentId: 'c-1', sellerId: 'user-7' }),
      ),
    ).toBe(true);
  });

  it('stok Hoshi tetap bisa dikirim — perilaku lama tidak berubah', () => {
    expect(isDomesticShippableStock(row({ sellable: true }))).toBe(true);
  });

  it('SECARA SADAR LEBIH LUAS dari gerbang BELI: superset sejati `isHoshiSellableStock`', () => {
    const rows = [
      row({}),
      row({ sellable: true }),
      row({ sellerId: 'u' }),
      row({ source: 'COLLECTORCRYPT' }),
      row({ consignmentId: 'c-1', sellerId: 'u' }),
      row({ consignmentId: 'c-1', sellerId: 'u', source: 'COLLECTORCRYPT' }),
    ];
    // Setiap baris yang boleh DIBELI sebagai stok Hoshi juga boleh DIKIRIM. Kebalikannya TIDAK.
    for (const r of rows) {
      if (isHoshiSellableStock(r))
        expect(isDomesticShippableStock(r)).toBe(true);
    }
    const widerSomewhere = rows.some(
      (r) => isDomesticShippableStock(r) && !isHoshiSellableStock(r),
    );
    expect(widerSomewhere).toBe(true);
  });

  it('listing P2P biasa dan katalog CC TETAP DITOLAK — fisiknya bukan di rak Hoshi', () => {
    expect(isDomesticShippableStock(row({ sellerId: 'user-9' }))).toBe(false);
    expect(isDomesticShippableStock(row({ source: 'COLLECTORCRYPT' }))).toBe(
      false,
    );
    // Baris seed/placeholder juga tetap ditolak.
    expect(isDomesticShippableStock(row({}))).toBe(false);
  });

  it('TIDAK BOLEH dipakai sebagai gerbang BELI: ia meloloskan baris yang settle-nya BERBEDA TOTAL', () => {
    // Kalau seseorang memakainya sebagai gerbang beli, kartu titipan akan mendarat di
    // `fulfilHoshiInventory` — Hoshi menyimpan 100%, pemilik kartunya tidak dibayar sepeser pun.
    const consigned = row({ consignmentId: 'c-1', sellerId: 'user-7' });
    expect(isDomesticShippableStock(consigned)).toBe(true);
    expect(isHoshiSellableStock(consigned)).toBe(false);
    expect(listingKindOf(consigned)).toBe('CONSIGNMENT');
  });
});
