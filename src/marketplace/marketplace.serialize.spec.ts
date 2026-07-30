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
    ]) {
      expect(detail).toHaveProperty(key);
    }
  });
});
