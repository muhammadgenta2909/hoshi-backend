import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedMessage,
  VersionedTransaction,
  clusterApiUrl,
} from '@solana/web3.js';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { fetchAsset, mplCore, transferV1 } from '@metaplex-foundation/mpl-core';
import {
  createNoopSigner,
  keypairIdentity,
  publicKey,
  type Signer,
  type Transaction,
  type Umi,
} from '@metaplex-foundation/umi';
import { base58 } from '@metaplex-foundation/umi/serializers';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertSponsorWithinCaps,
  sponsorCaps,
  sponsorEnabled,
  SPONSOR_FALLBACK_SELLER_MIN_MARGIN_LAMPORTS,
  SPONSOR_LOCK_KEY,
  SPONSOR_WINDOW_MS,
  type SponsorCaps,
} from './escrow-fee-sponsor';
import { P2P_ERROR_CODE, p2pNoEffectError } from '../marketplace/p2p.errors';

/** Tunggu NFT benar-benar dimiliki escrow sebelum diteruskan keluar (broadcast != final). */
const OWNERSHIP_RETRIES = 10;
const POLL_MS = 3_000;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Transfer SUDAH disiarkan (lolos cek kepemilikan) tapi konfirmasi gagal/timeout → kartu
 * MUNGKIN sudah berpindah on-chain. Pemanggil WAJIB memperlakukan ini sebagai "mungkin
 * terkirim": JANGAN refund/rollback, cek on-chain dulu. Beda dari Error biasa (pra-kirim,
 * mis. escrow belum memiliki kartunya) yang aman untuk di-refund.
 */
export class EscrowTransferIndeterminateError extends Error {
  constructor(
    message: string,
    readonly assetAddress: string,
    readonly newOwner: string,
  ) {
    super(message);
    this.name = 'EscrowTransferIndeterminateError';
  }
}

/**
 * Wallet ESCROW Hoshi — pemegang sementara kartu USER yang sedang dijual (Flow B P2P).
 *
 * SENGAJA terpisah dari TreasuryService (yang megang USDC): kalau satu key bocor, yang lain
 * aman. Kunci dibaca dari `HOSHI_ESCROW_SECRET_KEY` (JSON byte array, sama format seperti
 * treasury/platform), lazy, dan TIDAK PERNAH muncul di log/error/response.
 *
 * Dua peran:
 *  1. `buildTransferToEscrowTx` — bangun transaksi (BELUM ditandatangani) yang MEMINDAHKAN kartu
 *     dari wallet PENJUAL ke escrow. Penjual yang menandatangani (dia pemilik on-chain-nya);
 *     escrow tidak. Dipakai saat listing.
 *  2. `transferCoreAssetTo` — escrow (pemilik saat kartu sudah dititip) MENGIRIM kartu ke
 *     pembeli (saat terjual) atau balik ke penjual (saat cancel). Escrow yang menandatangani.
 */
@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);
  private keypair: Keypair | null = null;
  private escrowUmi: Umi | null = null;

  private conn: Connection | null = null;

  constructor(
    private readonly config: ConfigService,
    // Ledger sponsor gas (C). Plafonnya HARUS selamat dari restart & dari banyak instance, jadi
    // ia dihitung dari tabel — sama seperti plafon 24 jam TreasuryService.fundUsdc, dan bukan
    // dari penghitung di memori proses yang akan ter-reset tiap deploy.
    private readonly prisma: PrismaService,
  ) {}

  isConfigured(): boolean {
    const raw = this.config.get<string>('HOSHI_ESCROW_SECRET_KEY');
    return typeof raw === 'string' && raw.trim().length > 0;
  }

  /** Alamat publik escrow — ke sinilah kartu penjual dipindahkan saat listing. */
  get publicKey(): string {
    return this.getKeypair().publicKey.toBase58();
  }

  /**
   * Bangun transaksi transfer kartu PENJUAL → ESCROW untuk ditandatangani wallet penjual.
   *
   * SIAPA MENANDATANGANI APA (C — ini inti perubahannya):
   *   • AUTHORITY selalu PENJUAL. Kartu tidak bisa berpindah tanpa tanda tangannya, titik.
   *     Itu tidak berubah dan tidak boleh berubah.
   *   • FEE PAYER sekarang WALLET ESCROW (kecuali HOSHI_ESCROW_SPONSOR_FEE=false).
   *
   * KENAPA: dulu penjual juga fee payer, dan itu membuat penjual pengguna Google — yang wallet
   * Privy embedded-nya bersaldo SOL NOL — SAMA SEKALI tidak bisa menitipkan kartu, jadi tidak
   * bisa menjual. Bukan "lambat", tapi mustahil. Memisahkan fee payer dari authority menutup itu
   * tanpa menyerahkan kendali apa pun atas kartunya: escrow hanya membayar gas.
   *
   * Hasilnya transaksi DUA tanda tangan. Escrow menandatangani DI SINI (partial), penjual
   * menambahkan miliknya di browser. Urutannya tidak penting — yang penting PESANNYA tetap: kalau
   * penjual mengubah isinya, tanda tangan escrow menjadi tidak sah dan jaringan menolaknya.
   * Jadi transaksi yang kami tandatangani tidak bisa dipakai untuk apa pun selain yang kami susun.
   *
   * SELURUH PLAFON DIPERIKSA SEBELUM TANDA TANGAN (lihat escrow-fee-sponsor.ts) dan keputusannya
   * DISERIALKAN (lihat `reserveSponsorship`). Sesudah baris ini mengembalikan base64 yang
   * bertanda tangan escrow, kewajibannya sudah terbit — karena itu ledger ditulis lebih dulu.
   *
   * JALUR MUNDUR "PENJUAL BAYAR GAS" — KEPUTUSAN YANG DIAMBIL SADAR:
   * Sponsor adalah KENYAMANAN, bukan SYARAT. Kalau ia tidak bisa berjalan (kuota penuh, saldo
   * escrow tipis, fee tak terbaca), penjual yang PUNYA SOL sendiri tidak ada urusannya dengan
   * itu — dan sebelum pass ini merekalah yang ikut terblokir. Maka: sponsor gagal + saldo
   * penjual TERBACA dan jelas cukup ⇒ transaksi dibangun ULANG dengan penjual sebagai fee payer
   * (nol tanda tangan escrow, NOL baris ledger, nol lamport escrow). Kalau saldo penjual tidak
   * cukup atau tidak terbaca ⇒ sebab sponsor yang SEBENARNYA yang dilaporkan, karena menukar
   * pesan jujur dengan kegagalan simulasi belakangan bukan perbaikan. Jalur ini tidak
   * melonggarkan satu plafon pun: yang lewat sini justru TIDAK memakai kuota sponsor.
   */
  async buildTransferToEscrowTx(params: {
    assetAddress: string;
    ownerWallet: string;
    /** Untuk ledger sponsor gas. Keduanya wajib saat sponsor menyala. */
    listingId: string;
    sellerId: string;
  }): Promise<string> {
    const umi = this.getEscrowUmi();
    const escrowPk = umi.identity.publicKey;
    const asset = publicKey(params.assetAddress);

    // Bertipe eksplisit (bukan inferensi `any`): sejak sponsor gas ada, variabel ini dipakai
    // sebagai SALAH SATU dari dua kandidat fee payer, dan `any` di posisi itu berarti kompiler
    // tidak lagi memeriksa siapa yang kita minta menandatangani.
    let sellerSigner: Signer;
    try {
      sellerSigner = createNoopSigner(publicKey(params.ownerWallet));
    } catch {
      throw new BadRequestException('Alamat pemilik kartu tidak valid.');
    }

    // Baca collection (transferV1 wajib collection kalau asset bagian koleksi) + pastikan
    // kartu memang dimiliki si penjual sebelum membangun transfer.
    const fetched = await fetchAsset(umi, asset);
    if (String(fetched.owner) !== String(sellerSigner.publicKey)) {
      throw new BadRequestException(
        'Kartu ini bukan milik wallet Anda (on-chain) — tidak bisa dilisting.',
      );
    }
    const collection =
      fetched.updateAuthority.type === 'Collection'
        ? (fetched.updateAuthority.address ?? undefined)
        : undefined;

    // SIAPA YANG MENANGGUNG GAS dipilih di SATU tempat, dan `payer` DAN `setFeePayer`
    // HARUS menunjuk signer yang sama.
    //
    // `transferV1` punya akun `payer` tersendiri (penyandang rent) yang defaultnya
    // `umi.payer` — yaitu wallet escrow — dan akun itu SIGNER. Jadi hanya memanggil
    // `setFeePayer(penjual)` menghasilkan transaksi yang TETAP menuntut tanda tangan escrow,
    // tanpa escrow pernah menandatanganinya: transaksi yang tidak mungkin disiarkan siapa pun.
    // (Itu juga yang terjadi pada mode lama `HOSHI_ESCROW_SPONSOR_FEE=false`.)
    const buildFor = (feePayer: Signer) =>
      transferV1(umi, {
        asset,
        newOwner: escrowPk,
        authority: sellerSigner, // penjual menandatangani pemindahan (dia pemilik)
        collection,
        payer: feePayer,
      })
        .setFeePayer(feePayer)
        .buildWithLatestBlockhash(umi);

    const sellerPays = async (): Promise<string> => {
      const tx = await buildFor(sellerSigner);
      return Buffer.from(umi.transactions.serialize(tx)).toString('base64');
    };

    // Sponsor MATI (HOSHI_ESCROW_SPONSOR_FEE=false) → penjual bayar gas, perilaku lama.
    if (!sponsorEnabled(this.config)) return sellerPays();

    // Sponsor NYALA → escrow (umi.identity) yang bayar gas.
    const tx = await buildFor(umi.identity);

    // ── PLAFON SPONSOR — semuanya PRA-TANDA-TANGAN (nol lamport bisa bergerak kalau menolak) ──
    // Pembacaan RPC (fee & saldo) dilakukan DI LUAR transaksi DB: keduanya tidak bergantung
    // pada ledger, dan menahan transaksi Postgres selama panggilan jaringan berarti kunci
    // serialisasi di bawah dipegang selama RPC — itu yang mengubah pagar jadi hambatan.
    const caps = sponsorCaps(this.config);
    const [feeLamports, escrowLamports] = await Promise.all([
      this.readFeeForTx(tx.serializedMessage),
      this.readEscrowLamports(),
    ]);

    let sponsoredBase64: string;
    try {
      sponsoredBase64 = await this.reserveSponsorship({
        caps,
        feeLamports,
        escrowLamports,
        listingId: params.listingId,
        sellerId: params.sellerId,
        assetAddress: params.assetAddress,
        // Tanda tangan dibuat DI DALAM transaksi keputusan plafon (lihat reserveSponsorship):
        // barisnya harus membawa NAMA transaksi yang menagihnya, dan nama itu baru ada setelah
        // ditandatangani. Operasinya murni in-memory (ed25519 lokal, nol IO), jadi ia tidak
        // menahan kunci serialisasi selama panggilan jaringan.
        signSponsored: () => this.signAsSponsor(umi, tx),
      });
    } catch (err) {
      // ── JALUR MUNDUR: PENJUAL BAYAR GAS SENDIRI ───────────────────────────────────────
      // Sponsor adalah KENYAMANAN (ia ada supaya penjual login-Google yang SOL-nya nol tetap
      // bisa menjual), bukan SYARAT. Penjual yang memang punya SOL tidak pernah membutuhkannya,
      // dan sebelum pass ini merekalah yang ikut terblokir setiap kali sponsor tidak bisa
      // berjalan — kuota penuh, saldo escrow tipis, atau RPC fee tak terbaca.
      //
      // Jalur mundur ini TIDAK MELONGGARKAN SATU PLAFON PUN: transaksinya tidak ditandatangani
      // escrow, TIDAK menulis baris ledger, dan nol lamport escrow bergerak karenanya. Justru
      // sebaliknya — setiap penitipan yang lewat jalur ini adalah penitipan yang TIDAK memakai
      // kuota sponsor.
      const fallback = await this.sellerCanPayOwnGas(
        params.ownerWallet,
        feeLamports,
        caps,
      );
      if (!fallback) throw err;
      this.logger.warn(
        `Sponsor gas escrow TIDAK TERSEDIA untuk listing ${params.listingId} (penjual ` +
          `${params.sellerId}): ${err instanceof Error ? err.message : String(err)}. ` +
          'Penjual punya SOL sendiri → transaksi dibangun ulang dengan penjual sebagai fee ' +
          'payer (nol lamport escrow, nol baris ledger, nol sponsorship yang bisa terpakai).',
      );
      return sellerPays();
    }

    this.logger.log(
      `Sponsor gas escrow: listing ${params.listingId} (penjual ${params.sellerId}), ` +
        `fee ${String(feeLamports)} lamports ditanggung escrow.`,
    );
    return sponsoredBase64;
  }

  /**
   * Tandatangani transaksi penitipan SEBAGAI SPONSOR dan kembalikan sekaligus NAMA-nya.
   *
   * Signature indeks 0 adalah signature FEE PAYER, dan fee payer transaksi ini adalah escrow —
   * jadi string itu ADALAH id transaksinya, persis yang dikembalikan RPC saat penjual
   * menyiarkannya nanti. Itulah yang membuat "sponsorship mana yang barusan dipakai?" bisa
   * dijawab TANPA menebak-nebak lewat listingId.
   *
   * Dua asumsinya DIPERIKSA, tidak diandaikan: kalau akun pertama pesan ternyata bukan escrow,
   * atau slot tanda tangannya masih kosong, kami MELEMPAR — reservasinya rollback dan penjual
   * jatuh ke jalur mundur "penjual bayar gas". Menerbitkan kewajiban yang namanya salah lebih
   * buruk daripada penitipan yang tertunda.
   */
  private async signAsSponsor(
    umi: Umi,
    tx: Transaction,
  ): Promise<{ signature: string; serializedBase64: string }> {
    const signed = await umi.identity.signTransaction(tx);
    const feePayer = signed.message.accounts[0];
    if (String(feePayer) !== String(umi.identity.publicKey)) {
      throw new Error(
        'Transaksi sponsor tidak ber-fee-payer escrow — tanda tangan tidak bisa dijadikan identitas.',
      );
    }
    const sig = signed.signatures[0];
    if (!sig || sig.every((b) => b === 0)) {
      throw new Error('Tanda tangan sponsor kosong setelah penandatanganan.');
    }
    return {
      signature: base58.deserialize(sig)[0],
      serializedBase64: Buffer.from(umi.transactions.serialize(signed)).toString(
        'base64',
      ),
    };
  }

  /**
   * F3 — PUTUSKAN DAN CATAT PLAFON SPONSOR SECARA SERIAL.
   *
   * Bentuk lamanya adalah baca-lalu-tulis tanpa pengaman apa pun: empat pembacaan paralel,
   * satu `assertSponsorWithinCaps`, lalu satu `create`. N permintaan bersamaan membaca agregat
   * yang SAMA (belum ada satu pun yang menulis), semuanya lolos, semuanya menulis — sehingga
   * plafon per-penjual, plafon global 24 jam, DAN cadangan SOL escrow semuanya bisa dilewati
   * bersamaan, dan angka paparan harian terburuk yang dilaporkan bukan plafon yang dijamin.
   *
   * KENAPA VERSI INI TIDAK BISA DI-RACE:
   *   1. Setiap keputusan mengambil `pg_advisory_xact_lock(SPONSOR_LOCK_KEY)` sebagai
   *      pernyataan PERTAMA di dalam transaksinya. Kunci itu eksklusif dan ber-cakupan
   *      transaksi: pemohon kedua BLOKIR sampai pemegangnya commit/rollback.
   *   2. Agregat dibaca DI DALAM transaksi yang sama, jadi ia selalu menyertakan setiap
   *      sponsorship yang sudah di-commit sebelumnya (Read Committed: snapshot per-pernyataan
   *      diambil SESUDAH kunci didapat).
   *   3. Baris ledger ditulis DI DALAM transaksi yang sama, jadi saat kunci dilepas barisnya
   *      sudah commit dan pasti terlihat oleh penunggu berikutnya.
   *   Hasilnya N permintaan bersamaan menjadi N keputusan berurutan: tidak ada dua pemohon yang
   *   pernah melihat total yang sama. Penolakan plafon me-rollback transaksinya, jadi ia tidak
   *   meninggalkan baris apa pun.
   *
   * KENAPA advisory lock, bukan pola lain: plafonnya AGREGAT (jumlah 24 jam, cacah 24 jam,
   * saldo dikurangi kewajiban), dan tidak ada satu baris atau satu unique constraint yang bisa
   * menyatakannya — conditional insert tidak bisa menyatakan "SUM(...) + fee <= plafon".
   * `pg_advisory_xact_lock` juga dilepas otomatis saat transaksi selesai, jadi proses yang mati
   * tidak bisa membuat sponsor macet selamanya (keberatan utama terhadap kunci ber-cakupan sesi,
   * dan alasan TreasurySwapLock tidak memakainya).
   */
  private async reserveSponsorship(input: {
    caps: SponsorCaps;
    feeLamports: number | null;
    escrowLamports: number | null;
    listingId: string;
    sellerId: string;
    assetAddress: string;
    /**
     * Menandatangani transaksinya DAN mengembalikan namanya. Dipanggil DI DALAM transaksi
     * keputusan, SESUDAH plafon lolos: barisnya harus lahir sudah membawa identitas transaksi
     * yang menagihnya, dan tanda tangannya tidak boleh pernah keluar dari proses ini kalau
     * barisnya gagal commit.
     */
    signSponsored: () => Promise<{ signature: string; serializedBase64: string }>;
  }): Promise<string> {
    const since = new Date(Date.now() - SPONSOR_WINDOW_MS);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // Konstanta compile-time, bukan input: tidak ada permukaan injeksi di sini.
          await tx.$executeRawUnsafe(
            `SELECT pg_advisory_xact_lock(${SPONSOR_LOCK_KEY})`,
          );
          // Berurutan, bukan Promise.all: transaksi interaktif Prisma berjalan di SATU
          // koneksi, jadi paralelisme di sini hanya menambah antrean tanpa menghemat apa pun.
          const issuedAgg = await tx.escrowFeeSponsorship.aggregate({
            _sum: { feeLamports: true },
            where: { issuedAt: { gte: since } },
          });
          const issuedBySeller = await tx.escrowFeeSponsorship.count({
            where: { sellerId: input.sellerId, issuedAt: { gte: since } },
          });
          // Kewajiban yang sudah terbit tapi belum disiarkan penjual — tetap akan menagih
          // saldo escrow, jadi ia dikurangkan dari saldo sebelum cadangan diperiksa.
          const outstandingAgg = await tx.escrowFeeSponsorship.aggregate({
            _sum: { feeLamports: true },
            where: { consumedAt: null, issuedAt: { gte: since } },
          });

          assertSponsorWithinCaps({
            caps: input.caps,
            feeLamports: input.feeLamports,
            issuedLamports24h: issuedAgg._sum.feeLamports ?? 0,
            issuedBySeller24h: issuedBySeller,
            escrowLamports: input.escrowLamports,
            outstandingLamports: outstandingAgg._sum.feeLamports ?? 0,
          });

          // TANDA TANGAN DAN LEDGER LAHIR BERSAMA, DI DALAM TRANSAKSI YANG SAMA.
          //
          // Urutan lamanya "ledger dulu, tanda tangan kemudian (di pemanggil)" menjaga hal yang
          // benar — kewajiban harus tercatat sebelum bisa ditagih — tapi ia menghasilkan baris
          // yang TIDAK TAHU transaksi mana yang menagihnya, sehingga konsumsinya terpaksa
          // ditebak lewat listingId. Menandatangani DI SINI menjaga janji yang sama dan
          // menambahkan identitasnya: tanda tangan yang gagal commit tidak pernah keluar dari
          // proses ini (pemanggil hanya menerima nilai kembalian transaksi yang SUDAH commit),
          // dan baris yang commit selalu membawa nama transaksinya.
          //
          // Menandatangani sambil memegang kunci serialisasi AMAN: ed25519 lokal, nol IO —
          // mikrodetik, bukan panggilan jaringan (itulah yang tetap dijauhkan dari sini).
          const signed = await input.signSponsored();

          await tx.escrowFeeSponsorship.create({
            data: {
              listingId: input.listingId,
              sellerId: input.sellerId,
              assetAddress: input.assetAddress,
              feeLamports: input.feeLamports as number,
              sponsoredTxSignature: signed.signature,
            },
          });
          return signed.serializedBase64;
        },
        // Penunggu kunci menunggu DI DALAM transaksi, jadi batas waktunya harus muat untuk
        // antrean pendek. Yang kehabisan waktu DITOLAK (fail-closed), tidak dilewatkan.
        { timeout: 15_000, maxWait: 10_000 },
      );
    } catch (err) {
      // Penolakan plafon SUDAH memakai kontrak error P2P — teruskan apa adanya, jangan
      // dibungkus ulang jadi pesan generik yang menyembunyikan kode & stage-nya.
      if (err instanceof HttpException) throw err;
      this.logger.error(
        `Sponsor gas escrow: keputusan plafon GAGAL dijalankan (pra-tanda-tangan, nol lamport ` +
          `bergerak, nol baris ledger): ${err instanceof Error ? err.message : String(err)}`,
      );
      throw p2pNoEffectError(
        HttpStatus.SERVICE_UNAVAILABLE,
        P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
        'Kuota biaya jaringan Hoshi sedang tidak bisa dipastikan. Coba lagi sebentar lagi — ' +
          'tidak ada yang berubah dan tidak ada biaya yang keluar.',
      );
    }
  }

  /**
   * Apakah PENJUAL sendiri jelas-jelas sanggup membayar gas penitipannya? Dipakai HANYA untuk
   * memutuskan apakah jalur mundur "penjual bayar gas" layak ditawarkan saat sponsor tidak
   * bisa berjalan.
   *
   * Jawaban "tidak tahu" (saldo tak terbaca) diperlakukan sebagai TIDAK: menukar sebab yang
   * jujur ("kuota Hoshi penuh") dengan simulasi yang gagal belakangan bukan perbaikan.
   * Fee yang tak terbaca memakai plafon per-transaksi sebagai batas atas yang konservatif.
   */
  private async sellerCanPayOwnGas(
    ownerWallet: string,
    feeLamports: number | null,
    caps: SponsorCaps,
  ): Promise<boolean> {
    const needed =
      feeLamports != null &&
      Number.isSafeInteger(feeLamports) &&
      feeLamports >= 0
        ? feeLamports
        : caps.maxFeeLamports;
    const balance = await this.readLamports(ownerWallet);
    if (balance == null) return false;
    return balance >= needed + SPONSOR_FALLBACK_SELLER_MIN_MARGIN_LAMPORTS;
  }

  /**
   * Tandai sponsorship yang transaksinya BARUSAN DISIARKAN sebagai terpakai.
   *
   * DICOCOKKAN LEWAT SIGNATURE, BUKAN listingId — dan itu inti perbaikannya. Versi lama mencari
   * `{ listingId, consumedAt: null }` terbaru, yang salah dalam dua keadaan yang benar-benar
   * terjadi:
   *
   *   • PENITIPAN TANPA SPONSOR. Kalau sponsor tidak bisa berjalan (kuota penuh / saldo escrow
   *     tipis / fee tak terbaca) transaksinya dibangun ULANG dengan PENJUAL sebagai fee payer
   *     dan NOL baris ledger ditulis. Menyiarkannya lalu menstempel baris sponsor yang masih
   *     menggantung berarti menandai kewajiban escrow sebagai "terpakai" oleh transaksi yang
   *     escrow TIDAK PERNAH membayarinya. Baris itu lalu keluar dari agregat KEWAJIBAN TERUTANG,
   *     dan lantai cadangan SOL escrow (saldo − terutang) jadi optimistis sebesar satu fee —
   *     lantai yang justru ada supaya escrow tidak pernah kehabisan SOL untuk MENYERAHKAN kartu.
   *   • DUA RESERVASI UNTUK SATU LISTING (penjual menekan "titipkan" dua kali, blockhash pertama
   *     kedaluwarsa): yang distempel belum tentu yang disiarkan.
   *
   * Sekarang: yang dicocokkan adalah NAMA transaksinya. Broadcast penjual-bayar tidak cocok
   * dengan baris mana pun → TIDAK menghabiskan apa pun. Kalau dua baris membawa nama yang sama
   * (dua permintaan dalam slot blockhash yang sama → pesan byte-identik), keduanya memang habis
   * oleh satu broadcast itu — jadi `updateMany`, bukan "satu baris pertama".
   *
   * Murni pembukuan: plafon TIDAK memakainya (ia menghitung yang DITERBITKAN), jadi ia tidak
   * boleh pernah menggagalkan penitipan yang SUDAH mendarat — pemanggil membungkusnya try/catch.
   */
  async noteSponsorshipConsumed(signature: string): Promise<void> {
    if (!signature) return;
    const rows = await this.prisma.escrowFeeSponsorship.findMany({
      where: { sponsoredTxSignature: signature, consumedAt: null },
      orderBy: { issuedAt: 'asc' },
      select: { id: true },
    });
    if (rows.length === 0) return;

    await this.prisma.escrowFeeSponsorship.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    // Kolom `signature` (= yang BENAR-BENAR disiarkan) @unique, jadi hanya SATU baris yang boleh
    // mengklaim satu broadcast. Kalau dua baris membawa nama transaksi yang sama, yang TERTUA
    // yang mencatatnya — keduanya tetap ditandai terpakai di atas, karena keduanya memang habis
    // oleh broadcast yang sama.
    const alreadyClaimed = await this.prisma.escrowFeeSponsorship.count({
      where: { signature },
    });
    if (alreadyClaimed === 0) {
      await this.prisma.escrowFeeSponsorship.updateMany({
        where: { id: rows[0].id, signature: null },
        data: { signature },
      });
    }
  }

  /**
   * Broadcast transaksi transfer-ke-escrow yang SUDAH ditandatangani penjual, lalu pastikan
   * escrow benar-benar memiliki kartunya. Kembalikan signature (base58).
   */
  async broadcastSignedToEscrow(signedBase64: string): Promise<string> {
    const umi = this.getEscrowUmi();

    // SIMULASI SEBELUM SIAR — batas aman/tak-aman yang sama dengan TreasuryService.fundUsdc.
    // Kegagalan di sini berarti transaksi DITOLAK sebelum disiarkan: NOL lamport keluar dari
    // wallet escrow (yang kini fee payer-nya), dan penjual boleh mencoba lagi dengan bersih.
    // Tanpa ini, transaksi yang pasti gagal tetap disiarkan dan fee-nya TETAP ditagihkan ke
    // escrow — itu persis bentuk kebocoran gas yang plafon sponsor ada untuk mencegahnya.
    // Simulasi yang TIDAK BISA DIJALANKAN (RPC error) juga ditolak: masih pra-siar → aman.
    await this.simulateBeforeBroadcast(signedBase64);

    let signature: Uint8Array;
    try {
      const tx = umi.transactions.deserialize(
        Buffer.from(signedBase64, 'base64'),
      );
      signature = await umi.rpc.sendTransaction(tx);
      await umi.rpc.confirmTransaction(signature, {
        strategy: {
          type: 'blockhash',
          ...(await umi.rpc.getLatestBlockhash()),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new ServiceUnavailableException(
        `Gagal menyiarkan transfer kartu ke escrow: ${msg}`,
      );
    }
    return base58.deserialize(signature)[0];
  }

  /**
   * Cek SEKALI (tanpa polling) apakah escrow sudah memiliki kartu ini on-chain. Dipakai untuk:
   *  • submit idempoten — kalau broadcast sudah sukses tapi flip DB gagal, retry cukup flip;
   *  • cancel cepat — hanya menarik kartu balik kalau escrow memang memegangnya (hindari poll 30s
   *    pada listing PENDING_ESCROW yang kartunya tak pernah dikirim).
   * Mengembalikan false (bukan throw) kalau kartu belum terindeks / gagal dibaca.
   */
  async ownsAsset(assetAddress: string): Promise<boolean> {
    return (await this.checkOwnsAsset(assetAddress)) === true;
  }

  /**
   * Sama seperti `ownsAsset` tapi MEMBEDAKAN "TERBUKTI tidak dipegang" dari "TIDAK TERBACA".
   *
   *   true  — escrow memegang kartunya (terbaca on-chain).
   *   false — escrow TERBUKTI tidak memegangnya: aset terbaca, pemiliknya orang lain.
   *   null  — tidak bisa dibaca (RPC gagal / aset belum terindeks / alamat tak valid).
   *
   * KENAPA PEMBEDAAN INI ADA SEBAGAI METODE TERSENDIRI: `ownsAsset` menelan error menjadi
   * `false`, dan itu SAH untuk pemanggilnya (cancel & submit idempoten memakainya hanya untuk
   * memutuskan "perlukah saya mencoba menarik kartu?" — salah baca di sana paling buruk berarti
   * satu percobaan transfer yang gagal). Tapi ada keputusan lain yang memakai jawaban ini untuk
   * MENGHAPUS FAKTA `escrowedAt`, dan di sana `false` karena RPC sedang buruk berarti menghapus
   * satu-satunya petunjuk bahwa kartu penjual tertinggal di escrow. Keputusan seperti itu wajib
   * memakai metode ini dan memperlakukan `null` sebagai TIDAK BOLEH.
   */
  async checkOwnsAsset(assetAddress: string): Promise<boolean | null> {
    const umi = this.getEscrowUmi();
    const escrowPk = String(umi.identity.publicKey);
    try {
      const fetched = await fetchAsset(umi, publicKey(assetAddress));
      return String(fetched.owner) === escrowPk;
    } catch {
      return null;
    }
  }

  /**
   * Seperti ownsAsset tapi MENUNGGU (poll) sampai escrow terlihat memiliki kartu, menyerap lag
   * indeks RPC setelah broadcast transfer→escrow. Dipakai submitEscrow untuk MEMVERIFIKASI kartu
   * benar-benar masuk escrow SEBELUM listing di-ACTIVE-kan — mencegah penjual mengaktifkan listing
   * dengan menyiarkan transaksi lain yang bukan transfer kartunya. Mengembalikan false kalau setelah
   * semua percobaan escrow tetap bukan pemilik.
   */
  async ownsAssetWithRetry(assetAddress: string): Promise<boolean> {
    const umi = this.getEscrowUmi();
    const escrowPk = String(umi.identity.publicKey);
    const asset = publicKey(assetAddress);
    for (let i = 0; i < OWNERSHIP_RETRIES; i++) {
      try {
        const fetched = await fetchAsset(umi, asset);
        if (String(fetched.owner) === escrowPk) return true;
      } catch {
        /* belum terindeks / gagal baca — coba lagi */
      }
      await sleep(POLL_MS);
    }
    return false;
  }

  /**
   * Transfer kartu yang SEDANG dimiliki escrow ke pemilik baru (pembeli saat terjual, atau
   * balik ke penjual saat cancel). Escrow yang menandatangani. Broadcast via RPC Hoshi sendiri.
   * Tunggu kartu benar-benar di escrow dulu (jaga-jaga belum final). Kembalikan signature base58.
   */
  async transferCoreAssetTo(params: {
    assetAddress: string;
    newOwner: string;
  }): Promise<string> {
    const umi = this.getEscrowUmi();
    const escrowPk = String(umi.identity.publicKey);
    const asset = publicKey(params.assetAddress);

    let newOwnerPk: ReturnType<typeof publicKey>;
    try {
      newOwnerPk = publicKey(params.newOwner);
    } catch {
      throw new BadRequestException('Alamat penerima kartu tidak valid.');
    }

    let collection: ReturnType<typeof publicKey> | undefined;
    let owned = false;
    for (let i = 0; i < OWNERSHIP_RETRIES; i++) {
      try {
        const fetched = await fetchAsset(umi, asset);
        if (String(fetched.owner) === escrowPk) {
          collection =
            fetched.updateAuthority.type === 'Collection'
              ? (fetched.updateAuthority.address ?? undefined)
              : undefined;
          owned = true;
          break;
        }
      } catch {
        /* belum terindeks / belum final — coba lagi */
      }
      await sleep(POLL_MS);
    }
    if (!owned) {
      throw new Error(
        `Kartu ${params.assetAddress} belum dimiliki escrow — transfer ditunda.`,
      );
    }

    // Sudah lolos cek kepemilikan → mulai KIRIM. Kegagalan di sini INDETERMINATE (tx bisa saja
    // sudah landing) → sinyalkan supaya pemanggil TIDAK refund/rollback.
    try {
      const { signature } = await transferV1(umi, {
        asset,
        newOwner: newOwnerPk,
        collection,
      }).sendAndConfirm(umi);
      return base58.deserialize(signature)[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Escrow KRITIS: transfer ${params.assetAddress} → ${params.newOwner} GAGAL/INDETERMINATE: ` +
          `${msg}. Kartu MUNGKIN sudah pindah — CEK ON-CHAIN sebelum refund/kredit ulang.`,
      );
      throw new EscrowTransferIndeterminateError(
        msg,
        params.assetAddress,
        params.newOwner,
      );
    }
  }

  /* --- internal --- */

  /** Connection RPC web3.js untuk hal-hal yang umi tidak sediakan (fee, saldo, simulasi). */
  private getConnection(): Connection {
    if (this.conn) return this.conn;
    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    this.conn = new Connection(endpoint, 'confirmed');
    return this.conn;
  }

  /**
   * Fee JARINGAN untuk pesan yang PERSIS akan disiarkan. Mengembalikan null kalau tidak bisa
   * dibaca — dan null DITOLAK di hulu, bukan diganti tebakan: menandatangani kewajiban yang
   * nominalnya tidak diketahui adalah persis yang plafon ini ada untuk mencegah.
   */
  private async readFeeForTx(
    serializedMessage: Uint8Array,
  ): Promise<number | null> {
    try {
      // `VersionedMessage.deserialize`, BUKAN `Message.from`. umi membangun pesan v0
      // (`TransactionBuilder` default `version: 0`, dan tak ada yang memanggil
      // `setVersion('legacy')`), yang byte pertamanya bertanda versi (0x80). Parser legacy
      // MELEMPAR untuk byte itu — jadi versi lama fungsi ini mengembalikan null untuk SETIAP
      // transaksi, pemeriksaan plafon nomor 1 menolak semuanya, dan tidak ada satu pun listing
      // yang pernah bisa dititipkan ke escrow. Parser versioned menangani v0 DAN legacy
      // (ia mendelegasikan ke `Message.from` sendiri kalau tak ada tanda versi), jadi ia tetap
      // benar kalau suatu saat builder-nya dipindah ke `setVersion('legacy')`.
      const message = VersionedMessage.deserialize(
        Buffer.from(serializedMessage),
      );
      const res = await this.getConnection().getFeeForMessage(
        message,
        'confirmed',
      );
      return typeof res.value === 'number' ? res.value : null;
    } catch (err) {
      this.logger.error(
        `Sponsor gas escrow: gagal membaca fee jaringan (pra-tanda-tangan, nol lamport bergerak): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /** Saldo SOL wallet escrow (lamports). null = tidak terbaca → ditolak di hulu. */
  private async readEscrowLamports(): Promise<number | null> {
    return this.readLamports(this.getKeypair().publicKey);
  }

  /** Saldo SOL sebuah wallet (lamports). null = tidak terbaca — JANGAN ditebak sebagai 0. */
  private async readLamports(
    address: PublicKey | string,
  ): Promise<number | null> {
    try {
      const pk = typeof address === 'string' ? new PublicKey(address) : address;
      return await this.getConnection().getBalance(pk, 'confirmed');
    } catch (err) {
      this.logger.error(
        `Sponsor gas escrow: gagal membaca saldo SOL (pra-tanda-tangan): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Simulasi transaksi yang SUDAH lengkap tanda tangannya, SEBELUM disiarkan. MELEMPAR (bukan
   * mengembalikan boolean) supaya tidak ada pemanggil yang bisa mengabaikannya diam-diam.
   *
   * `sigVerify:false` disengaja: yang kita cari di sini adalah kegagalan tingkat PROGRAM (kartu
   * sudah bukan milik penjual, collection salah, akun tidak ada) — bukan verifikasi kriptografis,
   * yang toh akan ditegakkan jaringan saat siar. `replaceRecentBlockhash:false` juga disengaja:
   * blockhash yang kedaluwarsa MEMANG alasan sah untuk menolak, karena siarnya pasti gagal.
   */
  private async simulateBeforeBroadcast(signedBase64: string): Promise<void> {
    let failure: string;
    try {
      const vtx = VersionedTransaction.deserialize(
        Buffer.from(signedBase64, 'base64'),
      );
      const sim = await this.getConnection().simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: false,
        commitment: 'confirmed',
      });
      if (!sim.value.err) return;
      failure = JSON.stringify(sim.value.err);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    this.logger.error(
      `Penitipan escrow DITOLAK pra-siar (simulasi gagal, nol lamport bergerak): ${failure}`,
    );
    throw p2pNoEffectError(
      HttpStatus.UNPROCESSABLE_ENTITY,
      P2P_ERROR_CODE.SPONSOR_UNAVAILABLE,
      'Transaksi penitipan kartu tidak bisa diproses jaringan. Coba ulangi dari awal — ' +
        'tidak ada kartu yang berpindah dan tidak ada biaya yang keluar.',
    );
  }

  private getKeypair(): Keypair {
    if (this.keypair) return this.keypair;
    const secretRaw = this.config.get<string>('HOSHI_ESCROW_SECRET_KEY');
    if (!secretRaw || secretRaw.trim().length === 0) {
      throw new ServiceUnavailableException(
        'Wallet escrow Hoshi belum dikonfigurasi. Set HOSHI_ESCROW_SECRET_KEY ' +
          '(JSON byte array, lihat .env.example).',
      );
    }
    let secret: Uint8Array;
    try {
      secret = Uint8Array.from(JSON.parse(secretRaw) as number[]);
    } catch {
      throw new InternalServerErrorException(
        'HOSHI_ESCROW_SECRET_KEY harus JSON byte array (bukan base58).',
      );
    }
    let keypair: Keypair;
    try {
      keypair = Keypair.fromSecretKey(secret);
    } catch {
      throw new InternalServerErrorException(
        'HOSHI_ESCROW_SECRET_KEY bukan secret key Solana yang sah (harus 64 byte).',
      );
    }
    this.keypair = keypair;
    this.logger.log(`Escrow siap (${keypair.publicKey.toBase58()})`);
    return keypair;
  }

  private getEscrowUmi(): Umi {
    if (this.escrowUmi) return this.escrowUmi;
    const endpoint =
      this.config.get<string>('SOLANA_RPC_URL') ?? clusterApiUrl('devnet');
    const umi = createUmi(endpoint).use(mplCore());
    const umiKeypair = umi.eddsa.createKeypairFromSecretKey(
      this.getKeypair().secretKey,
    );
    umi.use(keypairIdentity(umiKeypair));
    this.escrowUmi = umi;
    return umi;
  }
}
