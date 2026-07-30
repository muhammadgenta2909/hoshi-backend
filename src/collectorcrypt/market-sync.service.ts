import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ListingSource, Prisma } from '@prisma/client';
import { IDRX_MAX } from '../marketplace/marketplace.constants';
import { PrismaService } from '../prisma/prisma.service';
import { eraFromYear, mapGrader, parseGradeScore } from './cc-card-facts';
import { CcMarketClient } from './cc-market.client';
import type { CcMarketCard } from './cc-market.types';

/** Kurs default USD→IDR untuk harga display marketplace (POC; override via env). */
const DEFAULT_USD_IDR_RATE = 16_000;

/** Batas wajar kurs supaya salah ketik env (mis. "16" atau "16000000") ketahuan. */
const RATE_MIN = 1_000;
const RATE_MAX = 1_000_000;

/** Ukuran halaman default saat menarik katalog CC (maks 100 di sisi mereka). */
const DEFAULT_STEP = 50;

export interface CcSyncOptions {
  /** CSV kategori CC, mis. "Pokemon" / "Pokemon,One Piece". Default "Pokemon". */
  categories?: string;
  /** Berapa halaman katalog ditarik (per kategori-set). Default 1. */
  maxPages?: number;
  /** Item per halaman (maks 100). Default 50. */
  step?: number;
  listPriceMin?: number;
  listPriceMax?: number;
  /**
   * Setelah upsert, tandai kartu yang punya buyback offer aktif di CC
   * (pass kedua dengan filter ccBuyback=true). Default true.
   */
  markBuyback?: boolean;
}

export interface CcSyncResult {
  pagesFetched: number;
  found: number;
  created: number;
  updated: number;
  skipped: {
    /** gradingCompany di luar PSA/CGC/Beckett → tidak muat di enum Grader kita. */
    grader: number;
    /** Tanpa listing aktif / harga tidak valid / overflow IDRX Int32. */
    price: number;
    /** Data wajib hilang (nftAddress/nama/grade). */
    invalid: number;
  };
  /** Jumlah listing COLLECTORCRYPT yang ditandai punya buyback offer aktif CC. */
  buybackMarked: number;
  usdIdrRate: number;
}

/**
 * Sync katalog CollectorCrypt → tabel Listing kita, model "harga di atas katalog":
 *
 * - CREATE: seluruh metadata + harga awal = harga CC × kurs. `source=COLLECTORCRYPT`,
 *   kunci upsert `ccNftAddress` (@unique ⇒ re-sync tidak pernah menduplikasi).
 * - UPDATE: HANYA metadata (nama, gambar, grade, vault, snapshot harga CC, dll).
 *   `priceIdrx` / `expectedValueIdrx` / `buybackIdrx` TIDAK PERNAH disentuh saat
 *   update — itulah "kita tinggal edit harga di atasnya": harga jual milik admin
 *   Hoshi, metadata milik CC. Status juga tidak disentuh (SOLD tidak di-resurrect).
 *
 * Keputusan mapping (kompromi enum/format kita vs data mereka — komentari di sini,
 * bukan tersebar):
 * - Grader: PSA→PSA, CGC→CGC, Beckett→BGS. Selain itu SKIP (enum Grader kita cuma
 *   tiga; menambah nilai enum = migrasi + UI. Mayoritas kartu Pokemon CC ber-PSA.)
 *   Logikanya tinggal di cc-card-facts.ts, dipakai bersama jalur kartu hasil pull —
 *   satu kartu tidak boleh punya dua jawaban grade tergantung halaman yang membuka.
 * - Rarity: KOSONG. CC tidak punya konsep rarity untuk kartu tunggal; dulu di sini
 *   ada heuristik harga→tier ("$2.000+ ⇒ Legendary Rare") yang tampil di UI seolah
 *   atribut kartu padahal karangan kita sendiri.
 * - Era: dari TAHUN kartu; tahun tak diketahui ⇒ kosong (bukan 'Classic').
 */
@Injectable()
export class MarketSyncService {
  private readonly logger = new Logger(MarketSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ccMarket: CcMarketClient,
    private readonly config: ConfigService,
  ) {}

  async sync(opts: CcSyncOptions): Promise<CcSyncResult> {
    const rate = this.usdIdrRate();
    const categories = opts.categories?.trim() || 'Pokemon';
    const maxPages = opts.maxPages ?? 1;
    const step = Math.min(opts.step ?? DEFAULT_STEP, 100);

    const result: CcSyncResult = {
      pagesFetched: 0,
      found: 0,
      created: 0,
      updated: 0,
      skipped: { grader: 0, price: 0, invalid: 0 },
      buybackMarked: 0,
      usdIdrRate: rate,
    };

    // Alamat CC yang benar-benar tersentuh sync ini (create ATAU update). Dipakai
    // markBuyback() supaya reset flag buyback DIBATASI ke kartu run ini saja —
    // sync 'One Piece' tidak boleh menghapus badge buyback kartu 'Pokemon'.
    const syncedAddresses = new Set<string>();

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.ccMarket.browse({
        page,
        step,
        categories,
        // Hanya listing native CC dengan harga aktif — bukan agregasi Magic Eden,
        // supaya "harga dari CollectorCrypt" benar-benar harga mereka.
        marketplaceSource: 'CC',
        marketplaceStatus: 'Buy now',
        listPriceMin: opts.listPriceMin,
        listPriceMax: opts.listPriceMax,
      });
      result.pagesFetched++;

      const cards = res.filterNFtCard ?? [];
      result.found += cards.length;
      await this.upsertCards(cards, rate, result, syncedAddresses);

      if (page >= res.totalPages || cards.length === 0) break;
    }

    if (opts.markBuyback !== false) {
      result.buybackMarked = await this.markBuyback(
        { categories, step, maxPages, ...opts },
        syncedAddresses,
      );
    }

    this.logger.log(
      `Sync CC selesai: ${result.created} baru, ${result.updated} update, ` +
        `skip ${JSON.stringify(result.skipped)}, buyback ${result.buybackMarked}`,
    );
    return result;
  }

  /* --- Internal --- */

  private async upsertCards(
    cards: CcMarketCard[],
    rate: number,
    result: CcSyncResult,
    syncedAddresses: Set<string>,
  ): Promise<void> {
    if (cards.length === 0) return;

    // Satu query untuk membedakan create vs update (upsert Prisma tidak melaporkan
    // mana yang terjadi, dan kita butuh angkanya untuk laporan admin).
    const addresses = cards
      .map((c) => c.nftAddress)
      .filter((a): a is string => typeof a === 'string' && a.length > 0);
    const existing = new Set(
      (
        await this.prisma.listing.findMany({
          where: { ccNftAddress: { in: addresses } },
          select: { ccNftAddress: true },
        })
      ).map((r) => r.ccNftAddress),
    );

    for (const card of cards) {
      const mapped = this.mapCard(card, rate, result);
      if (!mapped) continue;

      if (existing.has(card.nftAddress)) {
        await this.prisma.listing.update({
          where: { ccNftAddress: card.nftAddress },
          data: mapped.update,
        });
        result.updated++;
      } else {
        try {
          await this.prisma.listing.create({ data: mapped.create });
          result.created++;
          // Cegah P2002 kalau alamat yang sama muncul dua kali dalam satu batch:
          // penampakan berikutnya akan masuk jalur update.
          existing.add(card.nftAddress);
        } catch (err) {
          // Baris tercipta di antara findMany dan create ini (sync yang tumpang
          // tindih / retry): perlakukan sebagai update, jangan gagalkan run.
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2002'
          ) {
            await this.prisma.listing.update({
              where: { ccNftAddress: card.nftAddress },
              data: mapped.update,
            });
            result.updated++;
            existing.add(card.nftAddress);
          } else {
            throw err;
          }
        }
      }
      syncedAddresses.add(card.nftAddress);
    }
  }

  /**
   * null ⇒ kartu dilewati (alasan tercatat di result.skipped).
   * Mengembalikan payload create dan update sekaligus supaya kebijakan
   * "harga tidak disentuh saat update" terlihat di satu tempat.
   */
  private mapCard(
    card: CcMarketCard,
    rate: number,
    result: CcSyncResult,
  ): {
    create: Prisma.ListingCreateInput;
    update: Prisma.ListingUpdateInput;
  } | null {
    if (!card.nftAddress || !card.itemName) {
      result.skipped.invalid++;
      return null;
    }

    const grader = mapGrader(card.gradingCompany);
    if (!grader) {
      result.skipped.grader++;
      return null;
    }

    const gradeScore = parseGradeScore(card);
    if (gradeScore === null) {
      result.skipped.invalid++;
      return null;
    }

    const priceUsd = Number(card.listing?.price);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      result.skipped.price++;
      return null;
    }
    const priceIdrx = Math.round(priceUsd * rate);
    if (priceIdrx > IDRX_MAX) {
      result.skipped.price++;
      return null;
    }

    const insuredUsd = Number(card.insuredValue);
    const evUsd =
      Number.isFinite(insuredUsd) && insuredUsd > 0 ? insuredUsd : priceUsd;
    const expectedValueIdrx = Math.min(Math.round(evUsd * rate), IDRX_MAX);

    const image = card.images?.frontM ?? card.frontImage ?? '';
    if (!image) {
      result.skipped.invalid++;
      return null;
    }
    const imageBack = card.images?.backM ?? card.backImage ?? null;

    // Metadata milik CC — di-refresh setiap sync. Harga TIDAK ada di sini.
    const metadata = {
      name: card.itemName,
      set: card.set ?? card.category ?? '',
      // CC TIDAK punya konsep rarity untuk kartu tunggal. Dulu di sini ada
      // heuristik harga→tier ("$2000+ ⇒ Legendary Rare") — itu label karangan
      // kita, bukan atribut kartunya. Kosong = jujur; frontend menyembunyikan
      // badge rarity yang kosong.
      rarity: '',
      image,
      imageBack,
      grade: `${grader} ${gradeScore}`,
      grader,
      gradeScore,
      // Bahasa yang tidak disebut CC tidak otomatis "English" — kartu Jepang yang
      // field-nya kosong akan salah label. Kosongkan saja.
      language: card.language ?? '',
      era: eraFromYear(card.year),
      element: '',
      // Kategori kita dipakai sebagai badge bebas — nama franchise CC ("Pokemon")
      // informatif di sana walau listing lokal memakainya untuk jenis ilustrasi.
      category: card.category ?? '',
      certificate: card.gradingID ?? null,
      vaultLocation: card.vault
        ? `CollectorCrypt ${card.vault}`
        : 'CollectorCrypt',
      cardNumber: card.serial ?? null,
      // Alamat asset asli di Solana — link explorer di halaman detail tetap benar
      // walau kartunya belum pernah kita mint ulang.
      contractAddress: card.nftAddress,
      ccPriceUsd: priceUsd,
      ccSyncedAt: new Date(),
    };

    return {
      create: {
        ...metadata,
        source: ListingSource.COLLECTORCRYPT,
        ccNftAddress: card.nftAddress,
        // Harga awal = harga CC × kurs. Setelah ini harga milik admin Hoshi.
        priceIdrx,
        expectedValueIdrx,
        // buyback manual Hoshi tidak berlaku untuk kartu vault CC — badge buyback
        // mereka dirender dari ccHasBuyback, bukan angka IDRX ini.
        buybackIdrx: 0,
        sellerAddress: 'collectorcrypt',
        priceHistory: [expectedValueIdrx, priceIdrx],
        offers: [],
      },
      update: metadata,
    };
  }

  /**
   * Pass kedua: tandai kartu yang punya buyback offer AKTIF di CC.
   *
   * Tiga properti penting (masing-masing menutup bug nyata):
   * 1. FETCH DULU, TULIS BELAKANGAN. Semua halaman ccBuyback=true ditarik lebih
   *    dulu ke sebuah Set; baru setelah itu DB disentuh. Kalau CC down di tengah
   *    jalan, exception naik sebelum ada penulisan — flag lama tetap utuh (bukan
   *    ter-reset jadi false semua).
   * 2. PAGINASI penuh (bukan cuma halaman 1) sampai maxPages/totalPages, jadi
   *    kartu ber-buyback di luar halaman pertama tidak kehilangan badge.
   * 3. RESET DIBATASI ke `syncedAddresses` (kartu run ini), di dalam satu
   *    transaksi bersama set-true. Sync 'One Piece' tak menghapus badge 'Pokemon',
   *    dan pembaca marketplace tidak pernah melihat jendela "semua false".
   */
  private async markBuyback(
    opts: {
      categories: string;
      step: number;
      maxPages: number;
      listPriceMin?: number;
      listPriceMax?: number;
    },
    syncedAddresses: Set<string>,
  ): Promise<number> {
    if (syncedAddresses.size === 0) return 0;

    // (1)+(2): kumpulkan seluruh alamat ber-buyback SEBELUM menyentuh DB.
    const buybackAddresses = new Set<string>();
    for (let page = 1; page <= opts.maxPages; page++) {
      const res = await this.ccMarket.browse({
        page,
        step: opts.step,
        categories: opts.categories,
        marketplaceSource: 'CC',
        marketplaceStatus: 'Buy now',
        listPriceMin: opts.listPriceMin,
        listPriceMax: opts.listPriceMax,
        ccBuyback: true,
      });
      const cards = res.filterNFtCard ?? [];
      for (const c of cards) {
        if (typeof c.nftAddress === 'string' && c.nftAddress.length > 0) {
          buybackAddresses.add(c.nftAddress);
        }
      }
      if (page >= res.totalPages || cards.length === 0) break;
    }

    // Hanya tandai kartu yang benar-benar kita sync di run ini (irisan).
    const toMark = [...buybackAddresses].filter((a) => syncedAddresses.has(a));
    const syncedList = [...syncedAddresses];

    // (3): reset (dibatasi ke kartu run ini) + set-true dalam satu transaksi.
    const [, marked] = await this.prisma.$transaction([
      this.prisma.listing.updateMany({
        where: {
          source: ListingSource.COLLECTORCRYPT,
          ccNftAddress: { in: syncedList },
          ccHasBuyback: true,
        },
        data: { ccHasBuyback: false },
      }),
      this.prisma.listing.updateMany({
        where: { ccNftAddress: { in: toMark } },
        data: { ccHasBuyback: true },
      }),
    ]);
    return marked.count;
  }

  private usdIdrRate(): number {
    const raw = this.config.get<string>('HOSHI_USD_IDR_RATE');
    if (raw === undefined || raw === '') return DEFAULT_USD_IDR_RATE;
    const rate = Number(raw);
    if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX) {
      // Fail loud: kurs salah diam-diam ⇒ seluruh harga marketplace salah kelas.
      throw new BadRequestException(
        `HOSHI_USD_IDR_RATE tidak masuk akal (${raw}); harus ${RATE_MIN}–${RATE_MAX}.`,
      );
    }
    return rate;
  }
}
