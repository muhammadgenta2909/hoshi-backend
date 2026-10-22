import { toCardDetailDto, toListingDto } from './marketplace.serialize';

/**
 * Guard untuk KONTRAK BENTUK bundel detail. `toCardDetailDto` tidak punya anotasi
 * return-type eksplisit (inferred), jadi menghapus sebuah field di return TIDAK
 * memicu error TypeScript — persis bagaimana `listing` pernah terhapus tanpa
 * ketahuan dan membuat halaman detail frontend crash (LeftColumn/RightColumn
 * mendestruktur `detail.listing`). Test ini mengunci field-field yang WAJIB ada.
 */
function makeRow(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 'listing-1',
    name: '2023 Fuecoco CGC 10 Pokemon Japanese',
    set: 'Old Maid',
    rarity: 'Common',
    image: 'https://cdn.example.com/fuecoco.png',
    imageBack: null,
    priceIdrx: 272_000,
    expectedValueIdrx: 272_000,
    buybackIdrx: 0,
    sellerAddress: '8P5iKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxgL8U',
    listedAt: new Date('2026-07-27T09:04:27.312Z'),
    grade: 'CGC 10',
    grader: 'CGC',
    gradeScore: 10,
    language: 'Japan',
    era: 'Scarlet & Violet',
    element: null,
    category: 'Pokemon',
    views: 3,
    status: 'ACTIVE',
    source: 'COLLECTORCRYPT',
    ccHasBuyback: false,
    ccNftAddress: 'JuJvHAXYrWeJGUvqUhrtVFiTWcTGbFtohQ75Y9kW6U8',
    certificate: '6179484013',
    vaultLocation: 'CollectorCrypt PWCC',
    contractAddress: null,
    cardNumber: null,
    variant: null,
    priceHistory: [272_000, 272_000],
    nft: null,
    offerRecords: [],
    ...overrides,
  };
  return base as unknown as Parameters<typeof toCardDetailDto>[0];
}

describe('toCardDetailDto', () => {
  it('menyertakan objek `listing` penuh yang didestruktur halaman detail frontend', () => {
    const detail = toCardDetailDto(makeRow(), []);
    // REGRESI: tanpa `listing`, `const { image } = detail.listing` melempar dan
    // halaman gagal load. Kunci keberadaannya + bentuknya (= toListingDto).
    expect(detail).toHaveProperty('listing');
    expect(detail.listing).toEqual(toListingDto(makeRow()));
    expect(detail.listing.image).toBe('https://cdn.example.com/fuecoco.png');
    expect(detail.listing.status).toBe('ACTIVE');
    expect(detail.listing.price).toBe(272_000);
  });

  it('judul = nama katalog CC mentah (identik H1 Vault), bukan UPPERCASE+suffix', () => {
    const detail = toCardDetailDto(makeRow(), []);
    expect(detail.title).toBe('2023 Fuecoco CGC 10 Pokemon Japanese');
  });

  it('mempertahankan field bundel lain yang dikonsumsi frontend', () => {
    const detail = toCardDetailDto(makeRow(), []);
    for (const key of [
      'listing',
      'title',
      'tags',
      'consignedBy',
      'certificate',
      'estMarketValueIdr',
      'vaultLocation',
      'contractAddress',
      'change30dPct',
      'priceHistory',
      'offers',
      'details',
      'collectionLabel',
      'related',
      // Kartu TITIPAN: frontend memakainya untuk memilih panel pemilik yang BENAR
      // ("Minta kartu saya kembali", bukan "Cancel listing" — yang servernya tolak).
      'consigned',
    ]) {
      expect(detail).toHaveProperty(key);
    }
  });
});

/**
 * ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
 * ║ KARTU TITIPAN di DTO. Dari luar, listing titipan TIDAK BISA dibedakan dari listing P2P:     ║
 * ║ keduanya punya penjual, dan `sellerId` tidak ada di DTO. Jadi ia butuh field sendiri.       ║
 * ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
 */
describe('toListingDto — kartu titipan', () => {
  const consigned = () =>
    makeRow({
      id: 'listing-consign-1',
      source: 'HOSHI',
      sellerId: 'user-7',
      sellable: false,
      // BENTUK YANG DIPAKU CHECK CONSTRAINT: titipan tidak punya aset on-chain dan tidak
      // pernah masuk escrow.
      ccNftAddress: null,
      escrowedAt: null,
      consignmentId: 'consign-1',
    });

  it('`consigned` true untuk baris titipan, false untuk semua yang lain', () => {
    expect(toListingDto(consigned()).consigned).toBe(true);
    expect(toListingDto(makeRow()).consigned).toBe(false);
    expect(
      toListingDto(makeRow({ sellerId: 'user-9', consignmentId: null })).consigned,
    ).toBe(false);
  });

  it('ARMED: titipan TIDAK ditandai `needsEscrowDeposit` — nasihat itu tidak bisa berhasil', () => {
    // Tanpa pengecualian ini, pemilik kartu titipan akan disuruh "pajang ulang untuk menitipkan
    // ke escrow" — untuk kartu yang tidak punya dan tidak akan pernah punya aset on-chain.
    // Kartunya sudah ada di rak Hoshi; itu penitipan terkuat yang dipunyai sistem ini.
    expect(
      toListingDto(consigned(), { p2pEscrowRequired: true }).needsEscrowDeposit,
    ).toBe(false);
    // Listing user BIASA tanpa escrow tetap ditandai — perilaku lama tidak berubah.
    expect(
      toListingDto(
        makeRow({ sellerId: 'user-9', ccNftAddress: null, escrowedAt: null }),
        { p2pEscrowRequired: true },
      ).needsEscrowDeposit,
    ).toBe(true);
  });

  it('`hoshiStock` tetap FALSE untuk titipan — kartunya bukan milik Hoshi', () => {
    // Kalau ini pernah true, kartu titipan akan ditawarkan lewat jalur beli stok Hoshi, yang
    // menyimpan 100% harga dan tidak membayar pemiliknya sepeser pun.
    expect(toListingDto(consigned()).hoshiStock).toBe(false);
  });

  it('`sellerConsigned` true untuk titipan MAUPUN P2P — jadi ia BUKAN pembeda keduanya', () => {
    const detailConsigned = toCardDetailDto(consigned(), []);
    const detailP2p = toCardDetailDto(makeRow({ sellerId: 'user-9' }), []);
    expect(detailConsigned.sellerConsigned).toBe(true);
    expect(detailP2p.sellerConsigned).toBe(true);
    // Yang membedakan adalah `consigned`.
    expect(detailConsigned.consigned).toBe(true);
    expect(detailP2p.consigned).toBe(false);
  });
});
