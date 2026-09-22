import { plainToInstance } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  ValidateIf,
  MinLength,
  validateSync,
} from 'class-validator';
// Konstanta-saja, TANPA import lain (lihat cc-shipping-mock.mount.ts): validasi env jalan paling
// awal saat boot dan tidak boleh menarik Nest/@solana/web3.js hanya untuk sebuah string.
import { CC_SHIPPING_MOCK_MOUNT } from '../collectorcrypt/cc-shipping-mock.mount';
// Idem — file tanpa import sama sekali, SENGAJA, supaya aturan baca plafon sponsor gas yang
// dipakai saat boot adalah aturan yang SAMA dengan yang dipakai saat memutuskan sponsor.
import { sponsorCapEnvProblems } from '../escrow/sponsor-cap-env';
// Idem — src/payments/idrx-mint-bounds.ts TIDAK mengimpor apa pun, dengan sengaja. Batas yang
// dipakai saat boot untuk menolak ongkir domestik yang mustahil ditagih WAJIB batas yang SAMA
// dengan yang dipakai saat menerbitkan mint-request IDRX.
import {
  IDRX_MAX_MINT_IDR,
  IDRX_MIN_MINT_IDR,
} from '../payments/idrx-mint-bounds';
// Idem — src/payments/biteship-rate-env.ts TIDAK mengimpor apa pun, dengan sengaja. Aturan baca
// konfigurasi tarif kurir yang dipakai saat BOOT wajib aturan yang SAMA dengan yang dipakai saat
// benar-benar memanggil API-nya, bukan dua salinan yang bisa menyimpang diam-diam.
import { biteshipConfigProblems } from '../payments/biteship-rate-env';

/**
 * Skema validasi environment. Dipanggil ConfigModule saat boot — kalau ada yang
 * salah/ kurang, aplikasi gagal start dengan pesan jelas (fail fast).
 */
class EnvironmentVariables {
  @IsString()
  @MinLength(1, { message: 'DATABASE_URL wajib diisi' })
  DATABASE_URL!: string;

  // HS256 → butuh entropi >= 256-bit. Generate: openssl rand -hex 32.
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET minimal 32 karakter (openssl rand -hex 32)',
  })
  JWT_SECRET!: string;

  // Wajib bersatuan biar tidak ambigu (mis. "7d", "30m", "12h"). Cegah misconfig diam-diam.
  @IsOptional()
  @Matches(/^\d+(\.\d+)?(ms|s|m|h|d|w|y)$/, {
    message: 'JWT_EXPIRES_IN harus durasi bersatuan, mis. 7d / 30m / 12h',
  })
  JWT_EXPIRES_IN?: string;

  @IsOptional()
  @IsInt()
  PORT?: number;

  @IsOptional()
  @IsString()
  FRONTEND_ORIGIN?: string;

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     ALAMAT KEMBALI SETELAH BAYAR — didaftarkan supaya salah ketiknya ketahuan saat BOOT.

     Dibaca `requiredConfig` di TIGA jalur penerbitan tagihan, termasuk satu-satunya rail yang
     menerbitkan tagihan untuk kartu TITIPAN. `requiredConfig` melempar saat DIPANGGIL, bukan
     saat start — jadi sebelum ini: var-nya salah ketik atau terhapus saat menyunting
     backend.env di droplet → boot BERHASIL, log bersih, dashboard hijau, dan kegagalannya baru
     muncul di depan PEMBELI PERTAMA yang menekan tombol Beli.

     DUA PERLAKUAN, DAN PERBEDAANNYA DISENGAJA:

       nilai ADA tapi CACAT  → DITOLAK KERAS di sini. Konfigurasi cacat tidak pernah bisa jalan,
                               jadi tidak ada yang dipertukarkan dengan menolaknya, dan boot
                               adalah titik termurah untuk memperbaikinya.

       nilai HILANG/KOSONG   → PERINGATAN saja (`warnIfPaymentReturnUrlMissing` di bawah), backend
                               TETAP menyala. Alasannya ditulis lengkap di fungsi itu; singkatnya,
                               menolak start akan menukar checkout yang rusak dengan SELURUH situs
                               yang mati.

     `@ValidateIf` di bawah itulah yang memisahkan keduanya. Ia perlu karena `@IsOptional()` saja
     tidak cukup: `HOSHI_PAYMENT_RETURN_URL=` (baris ada, nilainya kosong) adalah cara paling wajar
     orang "menghapus" sebuah var di backend.env, dan bagi @IsOptional itu nilai yang ADA — lalu
     @IsUrl menolaknya sebagai cacat, dan boot mati justru di kasus yang paling sering terjadi.
     ══════════════════════════════════════════════════════════════════════════════════════════ */
  @ValidateIf(
    (o: EnvironmentVariables) =>
      typeof o.HOSHI_PAYMENT_RETURN_URL === 'string' &&
      o.HOSHI_PAYMENT_RETURN_URL.trim().length > 0,
  )
  @IsUrl(
    { require_tld: false, require_protocol: true },
    {
      message:
        'HOSHI_PAYMENT_RETURN_URL harus URL lengkap berikut protokolnya, mis. ' +
        'https://hoshimarket.xyz/open-packs — ini alamat yang dibuka pembeli setelah membayar.',
    },
  )
  HOSHI_PAYMENT_RETURN_URL?: string;

  @IsOptional()
  @IsString()
  SOLANA_RPC_URL?: string;

  @IsOptional()
  @IsIn(['devnet', 'testnet', 'mainnet-beta'], {
    message: 'SOLANA_CLUSTER harus salah satu: devnet | testnet | mainnet-beta',
  })
  SOLANA_CLUSTER?: string;

  // Opsional saat boot: endpoint mint akan memberi error jelas bila belum diisi.
  @IsOptional()
  @IsString()
  PLATFORM_SECRET_KEY?: string;

  @IsOptional()
  @IsString()
  DEFAULT_METADATA_URI?: string;

  // Sumber inventory default untuk Open Packs (default 'hoshi-vault').
  @IsOptional()
  @IsIn(['hoshi-vault', 'collectorcrypt', 'mock'])
  INVENTORY_PROVIDER?: string;

  // Opsional (WAJIB kalau INVENTORY_PROVIDER=collectorcrypt) — kredensial API CollectorCrypt.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_API_BASE_URL?: string;

  @IsOptional()
  @IsString()
  COLLECTORCRYPT_API_KEY?: string;

  // Opsional — fallback secret untuk admin login POC (kalau backend belum punya admin user).
  @IsOptional()
  @IsString()
  ADMIN_SECRET?: string;

  // Opsional — base URL API KATALOG PUBLIK CollectorCrypt Marketplace (tanpa key).
  // Default: https://api.collectorcrypt.com — dipakai POST /admin/cc-sync untuk
  // menarik produk mereka ke marketplace kita. Terpisah dari GACHA_* (host beda,
  // auth beda) dan dari COLLECTORCRYPT_API_* lama yang deprecated.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_MARKET_BASE_URL?: string;

  // Opsional — "true" untuk MENGAKTIFKAN pembelian kartu katalog CollectorCrypt
  // (POST /marketplace/:id/cc-buy/*). Default MATI: jalur ini menyuruh wallet user
  // menandatangani transaksi USDC sungguhan di jaringan yang ditunjuk
  // COLLECTORCRYPT_MARKET_BASE_URL. Nyalakan hanya setelah diuji — mulai dari
  // https://dev-api.collectorcrypt.com (katalog & USDC devnet).
  @IsOptional()
  @IsString()
  HOSHI_CC_BUY_ENABLED?: string;

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     RESELLER CC — SATU-SATUNYA JALUR DI REPO INI YANG MEMBELANJAKAN USDC TREASURY SENDIRI.

     Keduanya dipakai di `PaymentsService.fulfilListing` tapi tidak pernah terdaftar di sini,
     jadi tidak ada satu pun tempat yang menuliskan artinya — padahal yang kedua adalah BATAS
     BELANJA.

     `HOSHI_CC_RESELL_ENABLED` dibaca sebagai `.trim().toLowerCase() === 'true'`, jadi "1",
     "yes", "TRUE " tidak menyalakannya. Itu memang disengaja untuk saklar belanja: satu-satunya
     cara menyalakannya adalah mengetik persis kata itu, dan tidak ada nilai yang "kira-kira
     menyala".

     `HOSHI_CC_MAX_CARD_PRICE_USDC` dalam BASE UNIT USDC (6 desimal) — $100 = 100000000.
     Dibaca `intConfig`, yang MELEMPAR untuk nilai cacat (bagus, fail-closed) dan hanya memakai
     bawaan kalau var-nya TIDAK ADA. Jadi bahayanya bukan salah ketik; bahayanya BAWAANNYA
     SENDIRI: 5_000_000_000 = $5.000 PER KARTU. Itu bukan plafon yang pernah diputuskan siapa
     pun, dan ia berkali-kali lipat di atas float treasury yang wajar untuk fase ini.

     Tidak diubah di sini, karena mengubah batas belanja diam-diam sama salahnya dengan
     mewarisinya diam-diam. Yang ditambahkan: ia sekarang PUNYA NAMA di berkas ini, dan boot
     BERTERIAK kalau jalur belanjanya diarmed sementara plafonnya tidak pernah diisi — lihat
     `warnIfResellCapUnset`.
     ══════════════════════════════════════════════════════════════════════════════════════════ */
  @IsOptional()
  @IsString()
  HOSHI_CC_RESELL_ENABLED?: string;

  @IsOptional()
  @IsString()
  HOSHI_CC_MAX_CARD_PRICE_USDC?: string;

  // Opsional — kurs USD→IDR untuk mengubah harga katalog CC menjadi harga display
  // IDRX saat listing PERTAMA dibuat (re-sync tidak menyentuh harga). String
  // (bukan @IsInt) mengikuti pola HOSHI_PACK_MARGIN_BPS: salah ketik tidak boleh
  // diam-diam berubah jadi angka. Default 16000; MarketSyncService memvalidasi
  // rentang 1000–1000000.
  @IsOptional()
  @IsString()
  HOSHI_USD_IDR_RATE?: string;

  // Opsional — markup reseller Hoshi di atas harga CollectorCrypt, basis point ("1000" = 10%).
  // KEBIJAKAN PM: CC = STANDARD tanpa markup → default & yang dianjurkan = 0 (harga jual = harga CC
  // × kurs). String (bukan @IsInt) mengikuti pola BPS lain agar salah ketik tak jadi angka diam-diam;
  // MarketSyncService memvalidasi rentang 0..CC_MARGIN_BPS_MAX & pakai 0 kalau ngawur.
  @IsOptional()
  @IsString()
  HOSHI_CC_MARGIN_BPS?: string;

  // Opsional (WAJIB kalau fitur gacha CollectorCrypt dipakai) — kredensial API gacha.
  // SENGAJA terpisah dari COLLECTORCRYPT_API_* di atas: var lama itu milik inventory
  // provider lama; mengisinya akan "mempersenjatai" provider tsb ke endpoint yang belum
  // terverifikasi. Base URL devnet: https://dev-gacha.collectorcrypt.com
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_GACHA_BASE_URL?: string;

  // Dikirim sebagai header `x-api-key` (BUKAN bearer token). Key ini yang menurunkan
  // `slug` kita, dan slug jadi prefix memo tiap transaksi → dasar bagi hasil 50%.
  // Kunci ini TIDAK BOLEH sampai ke browser: semua panggilan CC tetap server-side.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_GACHA_API_KEY?: string;

  // Opsional saat boot (WAJIB kalau gacha treasury dipakai) — secret key dompet
  // treasury Hoshi sebagai JSON byte array, format sama persis dengan
  // PLATFORM_SECRET_KEY. Dompet inilah yang MEMEGANG USDC ASLI dan membayar setiap
  // pack: user Indonesia bayar rupiah, treasury yang menandatangani on-chain.
  // Sengaja @IsOptional() supaya app tetap bisa start tanpa treasury — TreasuryService
  // memberi error jelas saat pertama kali dipakai, bukan mematikan boot semua deploy.
  // RAHASIA TERBESAR di sistem ini: siapa pun yang bisa membacanya bisa menguras treasury.
  @IsOptional()
  @IsString()
  HOSHI_TREASURY_SECRET_KEY?: string;

  // Opsional — plafon harga SATU pack yang treasury mau tandatangani (USDC base unit,
  // 6 desimal; $100 = 100000000). Default 100000000. Harga pack di-snapshot dari
  // /api/machines milik CollectorCrypt, jadi nominal yang kita bayar ditentukan RESPONS
  // MEREKA — dan di jalur treasury tidak ada lagi popup wallet yang bisa menahannya.
  // Plafon ini yang memastikan satu respons harga yang jahat/salah tidak berubah jadi
  // tanda tangan treasury senilai puluhan ribu dolar.
  @IsOptional()
  @IsInt()
  GACHA_MAX_PACK_PRICE_USDC?: number;

  // Opsional — plafon belanja treasury dalam 24 jam berjalan (USDC base unit).
  // Default 500000000 ($500). SELAMA GERBANG PEMBAYARAN RUPIAH BELUM ADA, inilah
  // satu-satunya batas nominal antara seorang user login dan isi treasury: identitas
  // itu gratis (/auth/nonce meng-upsert user untuk alamat Solana apa pun), jadi
  // rate-limit per-user bisa dikalahkan Sybil sementara plafon ini berlaku untuk
  // SELURUH treasury. Turunkan sesuai isi dompet panas — jangan dinaikkan.
  @IsOptional()
  @IsInt()
  GACHA_TREASURY_DAILY_CAP_USDC?: number;

  // ── IDRX (on-ramp rupiah) ────────────────────────────────────────────────
  // Semua @IsOptional(): deploy yang belum memakai pembayaran rupiah harus tetap bisa boot.
  // Konsekuensinya, konfigurasi IDRX yang kurang baru ketahuan saat order pertama dibuat —
  // PaymentsService yang wajib memberi error jelas di titik itu, sama seperti TreasuryService.

  // Opsional — base URL API IDRX. Default: https://idrx.co
  @IsOptional()
  @IsString()
  IDRX_API_BASE?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — dikirim sebagai header `idrx-api-key`.
  @IsOptional()
  @IsString()
  IDRX_API_KEY?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — secret HMAC-SHA256 dalam BASE64.
  // Nilai paling sensitif kedua setelah HOSHI_TREASURY_SECRET_KEY: ia yang membuktikan
  // bahwa panggilan mint-request & verifikasi riwayat transaksi benar-benar dari kita.
  // JANGAN pernah di-log, dikembalikan lewat API, atau ikut masuk ke pesan error.
  @IsOptional()
  @IsString()
  IDRX_API_SECRET?: string;

  // Opsional (WAJIB kalau pembayaran rupiah dipakai) — chain id Solana versi IDRX, string.
  // Nilainya diberikan saat onboarding IDRX; JANGAN ditebak. Salah chain = IDRX ter-mint di
  // jaringan lain dan treasury Solana kita tidak pernah menerimanya.
  @IsOptional()
  @IsString()
  IDRX_NETWORK_CHAIN_ID?: string;

  // Opsional — margin Hoshi dalam basis point, sebagai string ("500" = 5%). Ditambahkan di atas
  // harga pack hasil konversi rates() sebelum jadi harga rupiah yang dibayar user.
  // String (bukan @IsInt) supaya enableImplicitConversion tidak diam-diam mengubah nilai
  // salah ketik jadi angka; PaymentsService yang mem-parse & memvalidasi rentangnya.
  @IsOptional()
  @IsString()
  HOSHI_PACK_MARGIN_BPS?: string;

  // IDRX MOCK (staging/devnet). "1" mengaktifkan mock IDRX: mint-request & verifikasi
  // dijawab lokal + halaman bayar palsu, tanpa akun/kredensial IDRX. HANYA berlaku bila
  // deployment tidak terlihat produksi (lihat detectProductionSignal) — di mainnet, flag
  // ini diabaikan total. Biarkan kosong/tidak diisi di produksi.
  @IsOptional()
  @IsString()
  IDRX_MOCK?: string;

  // Base URL publik backend ini — dipakai IDRX mock membangun paymentUrl halaman bayar
  // palsu (mis. https://hoshi-backend-staging.onrender.com). Default http://localhost:3001.
  @IsOptional()
  @IsString()
  IDRX_MOCK_PUBLIC_URL?: string;

  // Interval penyapu order tersangkut, dalam milidetik. Default 120000; lantai 30000; PLAFON
  // 600000 (dijepit + ERROR kalau dilewati, lihat payments-reconcile.scheduler.ts).
  // KENAPA TERDAFTAR DI SINI: ini BUKAN tuning. Nilainya adalah batas atas seberapa lama sebuah
  // pembayaran yang callback-nya hilang bisa tidak terdeteksi. Dulu variabel ini tidak ada di
  // skema mana pun, jadi salah ketik NAMANYA gagal diam-diam (jatuh ke default, masih aman) tapi
  // salah isi NILAINYA menurunkan jaminan deteksi uang tanpa gejala. Sekarang terlihat saat boot.
  @IsOptional()
  @IsString()
  PAYMENTS_RECONCILE_INTERVAL_MS?: string;

  // CC MOCK (staging/devnet). "1" mengaktifkan mock CollectorCrypt gacha: katalog mesin +
  // buka pack dijawab lokal dengan kartu palsu — tanpa API key CC, tanpa treasury ber-USDC,
  // tanpa transaksi on-chain. HANYA berlaku bila deployment tidak terlihat produksi
  // (detectProductionSignal). Biarkan kosong di produksi.
  @IsOptional()
  @IsString()
  CC_MOCK?: string;

  // ── Flow B: jual-beli antar USER (P2P + escrow) ──────────────────────────
  // Opsional (WAJIB kalau P2P REAL dipakai) — secret key wallet ESCROW Hoshi sebagai JSON byte
  // array (format sama PLATFORM_SECRET_KEY / HOSHI_TREASURY_SECRET_KEY). Wallet ini memegang
  // SEMENTARA kartu USER yang sedang dijual. SENGAJA terpisah dari treasury: kalau satu key bocor,
  // yang lain aman. @IsOptional supaya boot tak mati tanpanya — EscrowService memberi error jelas
  // saat pertama dipakai. Rahasia: siapa pun yang membacanya bisa memindah kartu titipan penjual.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SECRET_KEY?: string;

  // Opsional — pubkey Solana dompet ESCROW (read-only, BUKAN secret key). Dipakai dashboard admin
  // untuk membaca saldo SOL escrow SERVER-SIDE (GET /admin/treasury → escrowSol) lewat RPC backend,
  // menggantikan pembacaan via RPC browser yang rapuh. Tidak di-set → escrowConfigured=false &
  // escrowSol=null. Aman dipisah dari HOSHI_ESCROW_SECRET_KEY: hanya alamat publik, tak bisa menandatangani.
  @IsOptional()
  @IsString()
  ESCROW_ADDRESS?: string;

  // Opsional — "true" MENGAKTIFKAN settlement P2P REAL: listing menaruh kartu penjual ke escrow,
  // dan saat terjual escrow memindah kartu ke pembeli + saldo penjual dikredit. Default MATI:
  // listing user tetap langsung ACTIVE (tanpa escrow) & order P2P di-refund manual. Nyalakan HANYA
  // setelah wallet escrow didanai SOL gas dan alur diuji. String (bukan boolean) mengikuti pola
  // flag lain supaya salah ketik tidak diam-diam jadi truthy.
  @IsOptional()
  @IsString()
  HOSHI_P2P_ENABLED?: string;

  // ── C: SPONSOR GAS PENITIPAN ESCROW ──────────────────────────────────────
  // Opsional — "false" MEMATIKAN sponsor gas, sehingga PENJUAL kembali membayar fee transaksi
  // penitipan kartu ke escrow. Default NYALA, dan itu disengaja: dengan sponsor mati, penjual
  // yang masuk lewat Google (wallet Privy embedded, saldo SOL NOL) SAMA SEKALI tidak bisa
  // menitipkan kartu — jadi tidak bisa menjual. Sponsor memisahkan FEE PAYER (escrow) dari
  // AUTHORITY (penjual): kartu tetap tidak bisa berpindah tanpa tanda tangan penjual.
  // Ini TIDAK menyalakan apa pun sendiri — seluruh jalur escrow tetap mati sampai
  // HOSHI_P2P_ENABLED=true. Plafonnya: empat env di bawah (lihat src/escrow/escrow-fee-sponsor.ts).
  //
  // CATATAN: mematikannya BUKAN satu-satunya cara penjual membayar gasnya sendiri. Kalau
  // sponsor menyala tapi tidak bisa berjalan (kuota penuh / saldo escrow tipis / fee tak
  // terbaca), penjual yang saldonya cukup otomatis dapat transaksi penjual-bayar. Flag ini
  // untuk mematikan sponsor SECARA SADAR & menyeluruh, bukan sebagai penanganan kegagalan.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SPONSOR_FEE?: string;

  // ATURAN BACA KEEMPAT PLAFON DI BAWAH (src/escrow/sponsor-cap-env.ts, dipakai saat boot DAN
  // saat memutuskan sponsor — satu aturan, bukan dua salinan):
  //   • tidak di-set / kosong → default bawaan;
  //   • "0" → NOL, dan itu disengaja: inilah rem tangan operator di tengah insiden (plafon nol =
  //     tidak ada transaksi yang disponsori) tanpa perlu deploy. Dulu "0" diam-diam jadi default,
  //     jadi operator yang meminta NOL justru mendapat 0,02 SOL/hari;
  //   • apa pun yang lain ("off", "-1", "1e5", "5.5") → BACKEND MENOLAK START. Batas belanja yang
  //     salah ketik tidak boleh diam-diam kembali ke default.
  // (Mematikan sponsor SELURUHNYA tetap lewat HOSHI_ESCROW_SPONSOR_FEE=false di atas.)

  // Opsional — plafon fee untuk SATU transaksi penitipan (lamports). Default 50.000 (≈10× fee
  // transfer Core normal). Fee sesungguhnya dibaca dari getFeeForMessage, bukan ditebak; env ini
  // hanya batas atas yang membuat satu transaksi tak wajar ditolak SEBELUM ditandatangani.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SPONSOR_MAX_FEE_LAMPORTS?: string;

  // Opsional — plafon GLOBAL 24 jam untuk sponsor gas (lamports). Default 20.000.000 (0,02 SOL
  // ≈ 4.000 penitipan/hari). Dihitung dari tabel escrow_fee_sponsorships (yang DITERBITKAN),
  // bukan dari penghitung di memori — supaya selamat dari restart & multi-instance.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS?: string;

  // Opsional — plafon 24 jam PER PENJUAL (jumlah transaksi). Default 20. Ini rem anti-Sybil yang
  // sesungguhnya: plafon global saja bisa dihabiskan satu akun, dan throttle per-IP tak menolong
  // karena identitas di sistem ini gratis.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SPONSOR_MAX_PER_SELLER_24H?: string;

  // Opsional — SOL yang WAJIB TERSISA di wallet escrow sesudah menanggung satu fee (lamports).
  // Default 10.000.000 (0,01 SOL). Bukan cadangan sopan-santun: escrow yang kehabisan SOL tidak
  // bisa lagi MENYERAHKAN kartu ke pembeli atau MENGEMBALIKANNYA ke penjual.
  @IsOptional()
  @IsString()
  HOSHI_ESCROW_SPONSOR_RESERVE_LAMPORTS?: string;

  // Opsional — komisi Hoshi untuk penjualan P2P dalam basis point ("500" = 5%), diambil dari sisi
  // PENJUAL (pembeli tetap bayar harga + fee QRIS). Default 500. PaymentsService meng-clamp 0..100%.
  // String (bukan @IsInt), sama seperti HOSHI_PACK_MARGIN_BPS, agar salah ketik tak jadi angka diam2.
  @IsOptional()
  @IsString()
  HOSHI_MARKETPLACE_FEE_BPS?: string;

  // ── KIRIM DOMESTIK (stok fisik Hoshi, kurir lokal Indonesia) ──────────────
  // Opsional — ongkir FLAT NASIONAL dalam Rupiah UTUH, mis. "30000".
  //
  // INI LAPIS KELIMA, BUKAN SUMBER UTAMA. Sumber utamanya baris `domestic_shipping_rates` yang
  // diubah admin TANPA deploy (PUT /api/admin/shipping/domestic-rates) — di situlah TIER
  // PER-WILAYAH (Jawa / luar Jawa / lebih halus) ditetapkan. Env ini FLAT NASIONAL: ia tidak
  // mengenal wilayah, jadi ia hanya dipakai kalau TIDAK ADA satu pun baris tarif aktif. Kalau env
  // ini pun kosong, jalur bayar memakai TIER PENAMPUNG di
  // src/payments/domestic-shipping-rate.ts (DOMESTIC_DEFAULT_TIERS).
  //
  // Nilainya WAJIB di dalam batas mint IDRX (Rp 20.000–Rp 1.000.000.000) — di bawah minimum IDRX,
  // invoice ongkirnya tidak akan pernah bisa terbit. String (bukan @IsInt), mengikuti pola
  // HOSHI_PACK_MARGIN_BPS: salah ketik tidak boleh diam-diam jadi angka. Batasnya ditegakkan SAAT
  // BOOT (assertDomesticShippingRateSane di bawah) supaya salah ketik gagal di depan orang yang
  // mengetiknya, BUKAN di depan pembeli pertama yang menekan "Bayar ongkir".
  //
  // TIDAK ADA hubungannya dengan treasury: jalur domestik tidak pernah mendanai USDC.
  @IsOptional()
  @IsString()
  HOSHI_DOMESTIC_SHIPPING_FLAT_IDR?: string;

  /* ══════════════════════════════════════════════════════════════════════════════════════════
     TARIF ONGKIR NYATA DARI KURIR (BITESHIP) — LAPIS 0, DI ATAS KELIMA LAPIS DI ATAS.

     Kelimanya di bawah ini OPSIONAL, dan SATU-SATUNYA saklarnya BITESHIP_API_KEY. Kosong = lapis
     tarif kurir DIAM SEPENUHNYA dan ongkir diresolusi persis seperti sebelum lapis ini ada
     (baris DB → env flat → tier penampung). Itu keadaan produksi HARI INI: tidak boleh ada satu
     pun var di blok ini yang, dengan dibiarkan kosong, mengubah perilaku apa pun.

     ┌──── KENAPA BLOK INI MEMPERINGATKAN DAN TIDAK PERNAH MENOLAK START ──────────────────────┐
     │ `assertDomesticShippingRateSane` di bawah MENOLAK START untuk ongkir env yang cacat, dan │
     │ itu benar: nilainya adalah NOMINAL YANG DITAGIHKAN, jadi yang salah di sana berarti      │
     │ menagih pembeli angka yang tidak pernah diputuskan siapa pun.                            │
     │                                                                                          │
     │ Var di blok ini tidak begitu. Tidak satu pun dari mereka ADALAH sebuah harga: mereka     │
     │ menentukan apakah kita BERTANYA ke kurir. Kalau salah satunya cacat, yang terjadi adalah │
     │ lapis 0 diam dan ongkir kembali ke tarif tier — yaitu PERSIS keadaan produksi hari ini,  │
     │ yang jelas tidak rusak. Menolak start karenanya berarti menukar "fitur tambahan mati"    │
     │ dengan api.hoshimarket.xyz MATI SELURUHNYA (di droplet, migrasi dan server dirantai `&&` │
     │ dalam satu CMD). Itu bukan perbaikan — alasannya sama persis dengan                      │
     │ `warnIfPaymentReturnUrlMissing`.                                                          │
     │                                                                                          │
     │ Gantinya: `warnIfBiteshipConfigIncomplete` MENCETAK KERAS setiap masalahnya saat boot,   │
     │ dan klien tarifnya melog ulang saat jalan. Diam adalah satu-satunya arah gagal yang      │
     │ benar-benar berbahaya di sini — seseorang memasang kunci API, mengira tarif nyata sudah  │
     │ menyala, dan tidak pernah tahu bahwa yang ditagihkan masih angka penampung.              │
     └──────────────────────────────────────────────────────────────────────────────────────────┘

     Aturan pembacaan semua var ini hidup di src/payments/biteship-rate-env.ts — file TANPA
     import sama sekali, SENGAJA, supaya aturan yang dipakai saat BOOT adalah aturan yang SAMA
     dengan yang dipakai saat benar-benar memanggil API-nya.
     ══════════════════════════════════════════════════════════════════════════════════════════ */

  // Kunci API Biteship ("biteship_live.…" / "biteship_test.…"). RAHASIA: tidak pernah dikirim ke
  // browser, dan setiap teks yang dilog jalur tarif disaring lebih dulu (redactApiKey).
  // KOSONG = lapis tarif kurir MATI TOTAL, tanpa satu baris log pun.
  @IsOptional()
  @IsString()
  BITESHIP_API_KEY?: string;

  // Kode pos GUDANG HOSHI (asal kiriman), TEPAT 5 digit, mis. "12440". Wajib diisi kalau
  // BITESHIP_API_KEY diisi — tanpa asal, tarif tidak bisa dihitung sama sekali.
  @IsOptional()
  @IsString()
  BITESHIP_ORIGIN_POSTAL_CODE?: string;

  // Kode kurir yang benar-benar kita pakai, dipisah koma, mis. "jne,sicepat,jnt". Kosong = bawaan
  // di kode. SATU kode kurir yang tidak dikenal membuat Biteship menolak SELURUH request.
  @IsOptional()
  @IsString()
  BITESHIP_COURIERS?: string;

  // Berat satu kiriman dalam GRAM, mis. "250" (satu slab + kemasan). Kosong/cacat = bawaan di
  // kode. String (bukan @IsInt) mengikuti pola HOSHI_PACK_MARGIN_BPS: salah ketik tidak boleh
  // diam-diam jadi angka — di sini ia dilaporkan lalu bawaan yang dipakai.
  @IsOptional()
  @IsString()
  BITESHIP_WEIGHT_GRAMS?: string;

  // Base URL API Biteship. Kosong = https://api.biteship.com. Ada supaya staging bisa diarahkan
  // ke mock tanpa kunci sungguhan — sama seperti COLLECTORCRYPT_SHIPPING_BASE_URL.
  @IsOptional()
  @IsString()
  BITESHIP_BASE_URL?: string;

  // ── CC Vault Shipping: kirim kartu fisik keluar dari vault CC ─────────────
  // Opsional — "true" MENGAKTIFKAN jalur REAL kirim kartu fisik: user bayar ongkir Rupiah, treasury
  // MENDANAI USDC ongkir ke wallet user, user menandatangani burn+ship CC. Default MATI: redemption
  // tetap RECORD-ONLY (NFT tak di-burn; pemenuhan fisik manual admin). Nyalakan HANYA setelah treasury
  // didanai & alur diuji. String (bukan boolean) mengikuti pola flag lain agar salah ketik tak jadi truthy.
  @IsOptional()
  @IsString()
  HOSHI_CC_SHIPPING_ENABLED?: string;

  // Opsional — base URL CC Vault Shipping API. Devnet default: https://dev-api.collectorcrypt.com,
  // produksi: https://api.collectorcrypt.com. Di mainnet, dev-api DITOLAK (assertMainnetConsistency).
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_SHIPPING_BASE_URL?: string;

  // CC SHIPPING MOCK (staging/devnet). "1" MENYALAKAN mock CC Vault Shipping di dalam backend ini
  // sendiri, di /api/cc-shipping-mock — supaya alur kirim kartu fisik bisa ditelusuri lewat browser
  // TANPA kredensial CC dan tanpa uang asli (Render tidak bisa menjangkau localhost:4010, jadi mock
  // proses-terpisah tidak menolong di staging). Arahkan COLLECTORCRYPT_SHIPPING_BASE_URL ke
  // <URL backend publik>/api/cc-shipping-mock untuk memakainya.
  // HANYA berlaku bila deployment tidak terlihat produksi (detectProductionSignal) — sama seperti
  // IDRX_MOCK/CC_MOCK. BEDANYA: flag ini juga masuk interlock cutover mainnet di bawah, jadi
  // SOLANA_CLUSTER=mainnet-beta + flag ini menyala = backend MENOLAK START. Biarkan kosong di produksi.
  @IsOptional()
  @IsString()
  CC_SHIPPING_MOCK?: string;

  // Opsional — User-Agent yang dikirim ke CC Shipping (CC menolak sebagian request tanpa UA).
  // Client punya fallback non-kosong bila ini tidak di-set.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_SHIPPING_USER_AGENT?: string;

  // Opsional — plafon pendanaan USDC ongkir dalam 24 jam berjalan (base unit, 6 desimal;
  // 5000000000 = $5000). Default 5000000000. Batas nominal treasury→user untuk ongkir; turunkan
  // sesuai isi dompet panas. @IsInt (bukan string) sama seperti GACHA_TREASURY_DAILY_CAP_USDC.
  @IsOptional()
  @IsInt()
  HOSHI_SHIPPING_FUND_DAILY_CAP_USDC?: number;

  // ── CC SIWS (Track B — login wallet Phantom ke CC) ───────────────────────
  // Ketiganya OPSIONAL saat boot: deploy yang belum memakai Track B tetap harus bisa start.
  // Kalau kosong, endpoint /redemptions/siws/nonce menolak dengan 503 "SIWS not configured"
  // (CcShippingService.siwsConfig) — TIDAK memanggil CC dengan partnerAppId/domain/uri undefined.

  // partnerAppId yang DITERBITKAN CC (email support@collectorcrypt.com) — dikirim ke
  // /auth/wallet/nonce. Nilai yang tidak dikenal CC dijawab 400 "Unknown partner".
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_PARTNER_APP_ID?: string;

  // Hostname BARE untuk pesan SIWS (tanpa skema/port), mis. "hoshimarket.xyz". Masuk ke domain.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_SIWS_DOMAIN?: string;

  // URL origin aplikasi untuk pesan SIWS, mis. "https://hoshimarket.xyz". Masuk ke uri.
  @IsOptional()
  @IsString()
  COLLECTORCRYPT_SIWS_URI?: string;

  // ── Email notifikasi (Resend) ────────────────────────────────────────────
  // Keduanya OPSIONAL: fitur email GELAP sampai di-provision. Tanpa RESEND_API_KEY,
  // MailService jadi no-op (satu debug log) — aksi bisnis (offer/pesan) tetap jalan.
  // Isi RESEND_API_KEY untuk mengaktifkan; salah ketik tidak boleh mematikan boot.
  @IsOptional()
  @IsString()
  RESEND_API_KEY?: string;

  // Alamat pengirim untuk email Resend, mis. "Hoshi <no-reply@hoshimarket.xyz>".
  // Default dipakai MailService bila kosong. Domainnya harus terverifikasi di Resend.
  @IsOptional()
  @IsString()
  MAIL_FROM?: string;

  // ── GEO proxy (countrystatecity.in) ──────────────────────────────────────
  // Opsional — API key untuk https://api.countrystatecity.in (header X-CSCAPI-KEY).
  // GELAP sampai diisi: tanpa key, GET /api/geo/* menjawab 503 "Geo lookup not
  // configured" dan frontend jatuh ke input teks bebas (address form tetap jalan).
  // Dibaca LAZY oleh GeoService — key TIDAK PERNAH sampai ke browser (proxy server-side).
  @IsOptional()
  @IsString()
  CSC_API_KEY?: string;
}

/**
 * Interlock cutover mainnet. Begitu SOLANA_CLUSTER=mainnet-beta, SELURUH konfigurasi
 * uang-asli harus konsisten. Kalau setengah jadi — cluster mainnet tapi masih menunjuk
 * dev-gacha, RPC devnet, RPC publik yang kena rate-limit, atau treasury address kosong —
 * backend MENOLAK START, bukan diam-diam melayani transaksi uang asli di config yang salah.
 *
 * Ini pelengkap assertDemoOnly (yang mematikan jalur GRATIS di produksi): yang ini menjamin
 * begitu kamu memutuskan mainnet, kamu benar-benar sepenuhnya di mainnet. Cek TIDAK berlaku
 * saat devnet, jadi demo yang sedang berjalan tidak terpengaruh sama sekali.
 */
function assertMainnetConsistency(config: Record<string, unknown>): void {
  const str = (k: string) => {
    const v = config[k];
    return (typeof v === 'string' ? v : '').trim();
  };
  const cluster = (str('SOLANA_CLUSTER') || 'devnet').toLowerCase();
  if (cluster !== 'mainnet-beta') return;

  const problems: string[] = [];
  const rpc = str('SOLANA_RPC_URL').toLowerCase();
  if (!rpc) {
    problems.push(
      'SOLANA_RPC_URL wajib diisi di mainnet (RPC berbayar — endpoint publik akan kena rate-limit).',
    );
  } else if (rpc.includes('devnet') || rpc.includes('testnet')) {
    problems.push(
      `SOLANA_RPC_URL menunjuk non-mainnet (${str('SOLANA_RPC_URL')}) padahal cluster mainnet-beta.`,
    );
  } else if (rpc.includes('api.mainnet-beta.solana.com')) {
    problems.push(
      'SOLANA_RPC_URL memakai endpoint publik mainnet — akan kena rate-limit untuk transaksi uang asli. Pakai RPC berbayar.',
    );
  }

  const cc = str('COLLECTORCRYPT_GACHA_BASE_URL').toLowerCase();
  if (!cc) {
    problems.push(
      'COLLECTORCRYPT_GACHA_BASE_URL wajib diisi di mainnet (produksi: https://gacha.collectorcrypt.com).',
    );
  } else if (cc.includes('dev-gacha')) {
    problems.push(
      `COLLECTORCRYPT_GACHA_BASE_URL masih dev-gacha (${str('COLLECTORCRYPT_GACHA_BASE_URL')}) di mainnet — user membayar ASLI untuk kartu TEST.`,
    );
  }

  if (!str('HOSHI_TREASURY_ADDRESS')) {
    problems.push(
      'HOSHI_TREASURY_ADDRESS wajib diisi di mainnet (verifikasi pembayaran + tujuan mint).',
    );
  }

  // CC Vault Shipping: kalau jalur real diaktifkan di mainnet, base URL-nya TIDAK boleh dev-api
  // (user membayar ASLI + treasury mendanai USDC ASLI untuk shipment yang dibuat di lingkungan test).
  const shipBase = str('COLLECTORCRYPT_SHIPPING_BASE_URL').toLowerCase();
  if (shipBase.includes('dev-api.collectorcrypt.com')) {
    problems.push(
      `COLLECTORCRYPT_SHIPPING_BASE_URL masih dev-api (${str('COLLECTORCRYPT_SHIPPING_BASE_URL')}) di mainnet — pakai https://api.collectorcrypt.com.`,
    );
  }

  // MOCK CC SHIPPING DI MAINNET — dua kesalahan yang berbeda, dua-duanya ditolak.
  //
  // Kenapa flag ini masuk interlock padahal IDRX_MOCK/CC_MOCK tidak: dua mock itu cuma MENGGANTI
  // jawaban di dalam proses, jadi kalau kepencet di mainnet double-gate-nya diam-diam
  // mengabaikannya dan jalur asli tetap jalan. Yang ini dituju lewat sebuah BASE URL. Kalau
  // flag-nya menyala di mainnet, double-gate membuat /cc-shipping-mock menjawab 404 — dan yang
  // kelihatan oleh operator bukan "mock mati", melainkan setiap panggilan shipping gagal 404
  // sesudah treasury mendanai USDC ASLI. Gagal saat BOOT jauh lebih murah daripada gagal di
  // tengah jalur uang, jadi ketidakcocokan ini dibuat mustahil, bukan sekadar tidak berbahaya.
  if (str('CC_SHIPPING_MOCK') === '1') {
    problems.push(
      'CC_SHIPPING_MOCK=1 (mock CC Vault Shipping) menyala di mainnet — kosongkan variabelnya. ' +
        'Mock ini hanya untuk staging/devnet dan TIDAK PERNAH boleh melayani jalur uang asli.',
    );
  }
  // Belah yang kedua: flag sudah dimatikan tapi base URL-nya masih menunjuk mock. Tanpa cek ini
  // backend start dengan senang hati lalu menembak endpoint yang dijamin 404 — kegagalan yang
  // muncul PERSIS setelah dana keluar.
  if (shipBase.includes(`/${CC_SHIPPING_MOCK_MOUNT}`)) {
    problems.push(
      `COLLECTORCRYPT_SHIPPING_BASE_URL masih menunjuk mock internal (${str('COLLECTORCRYPT_SHIPPING_BASE_URL')}) di mainnet — pakai https://api.collectorcrypt.com.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      'Cutover mainnet TIDAK konsisten — backend menolak start supaya uang asli tidak jalan di config setengah jadi:\n' +
        problems.map((p) => `  • ${p}`).join('\n'),
    );
  }
}

export function validateEnv(config: Record<string, unknown>) {
  const validated = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });
  const errors = validateSync(validated, { skipMissingProperties: false });
  if (errors.length > 0) {
    throw new Error(
      'Konfigurasi environment tidak valid:\n' +
        errors
          .map((e) => Object.values(e.constraints ?? {}).join(', '))
          .join('\n'),
    );
  }
  assertSponsorCapsReadable(config);
  assertDomesticShippingRateSane(config);
  assertMainnetConsistency(config);
  warnIfPaymentReturnUrlMissing(config);
  warnIfResellCapUnset(config);
  warnIfBiteshipConfigIncomplete(config);
  return validated;
}

/**
 * PLAFON BELANJA RESELLER — berteriak HANYA ketika ia benar-benar berbahaya.
 *
 * `HOSHI_CC_MAX_CARD_PRICE_USDC` punya bawaan $5.000 PER KARTU. Selama jalur reseller MATI
 * (keadaan default), angka itu tidak membelanjakan apa pun dan tidak perlu diributkan — memaksa
 * orang mengisinya untuk fitur yang tidak mereka pakai adalah cara melatih peringatan diabaikan.
 *
 * Tapi begitu `HOSHI_CC_RESELL_ENABLED=true`, jalur itu membeli kartu dengan USDC treasury
 * SUNGGUHAN, dan plafon yang tidak pernah diisi berarti setiap pembelian diadili oleh angka yang
 * tidak pernah diputuskan siapa pun. Di situlah — dan hanya di situlah — ini layak berteriak.
 *
 * Tidak menolak start, alasan yang sama dengan tetangganya: plafon bawaan tetap sebuah plafon,
 * dan mematikan seluruh backend karena satu var yang belum diisi menukar risiko sempit dengan
 * situs yang mati. Yang menahan belanja sungguhan tetap saldo treasury dan gerbang di kodenya.
 */
function warnIfResellCapUnset(config: Record<string, unknown>): void {
  // `typeof === 'string'` dulu, bukan `String(...)`: nilai non-string tidak pernah bisa menjadi
  // 'true' lewat jalur aslinya (ConfigService membaca env sebagai string), dan memaksanya jadi
  // string di sini hanya menciptakan cara kedua sebuah saklar belanja bisa terbaca menyala.
  const flag = config.HOSHI_CC_RESELL_ENABLED;
  const armed =
    typeof flag === 'string' && flag.trim().toLowerCase() === 'true';
  if (!armed) return;

  const cap = config.HOSHI_CC_MAX_CARD_PRICE_USDC;
  const terisi = typeof cap === 'string' ? cap.trim() !== '' : cap != null;
  if (terisi) return;

  // console, bukan Logger Nest: validateEnv berjalan SEBELUM aplikasi (dan logger-nya) berdiri.
  console.error(
    '[ENV] HOSHI_CC_RESELL_ENABLED=true TAPI HOSHI_CC_MAX_CARD_PRICE_USDC TIDAK DIISI. ' +
      'Jalur reseller akan membeli kartu dengan USDC treasury SUNGGUHAN, dan plafon per-kartunya ' +
      'jatuh ke bawaan 5000000000 base unit = $5.000 PER KARTU — angka yang tidak pernah ' +
      'diputuskan siapa pun. Isi HOSHI_CC_MAX_CARD_PRICE_USDC di backend.env dengan plafon yang ' +
      'memang kamu maksud (base unit USDC, 6 desimal: $100 = 100000000), atau matikan lagi ' +
      'HOSHI_CC_RESELL_ENABLED sampai plafonnya diputuskan.',
  );
}

/**
 * TARIF KURIR NYATA (Biteship) — MEMPERINGATKAN saat boot, tidak pernah menolak start.
 *
 * Alasan lengkap kenapa blok ini memperingatkan alih-alih menolak ada di atas, di deklarasi
 * var-nya. Singkatnya: tidak satu pun var di sini ADALAH sebuah harga — mereka menentukan apakah
 * kita BERTANYA ke kurir — jadi yang cacat cuma mengembalikan ongkir ke tarif tier, yaitu keadaan
 * produksi hari ini. Menolak start karenanya akan mematikan seluruh api.hoshimarket.xyz demi
 * sebuah lapis tambahan.
 *
 * Yang DITUTUP fungsi ini adalah arah gagal yang sesungguhnya berbahaya: DIAM. Seseorang memasang
 * BITESHIP_API_KEY di droplet, mengira tarif nyata sudah menyala, dan tidak pernah tahu bahwa
 * kode pos gudangnya salah ketik sehingga setiap pembeli masih ditagih angka PENAMPUNG.
 */
function warnIfBiteshipConfigIncomplete(config: Record<string, unknown>): void {
  const problems = biteshipConfigProblems((key) => {
    const raw = config[key];
    return typeof raw === 'string' ? raw : undefined;
  });
  if (problems.length === 0) return;
  // console, bukan Logger Nest: validateEnv berjalan SEBELUM aplikasi (dan logger-nya) berdiri.
  console.error(
    '[ENV] TARIF KURIR NYATA (Biteship) TIDAK AKAN DIPAKAI sepenuhnya — backend tetap menyala ' +
      'dan ongkir domestik jatuh ke tarif tier/penampung (Rp 25.000 / Rp 50.000), yang BUKAN ' +
      'tarif kurir sungguhan:\n' +
      problems.map((p) => `  • ${p}`).join('\n'),
  );
}

/**
 * ALAMAT KEMBALI SETELAH BAYAR — MEMPERINGATKAN saat boot, tidak menolak start.
 *
 * `HOSHI_PAYMENT_RETURN_URL` dibaca `requiredConfig` di TIGA jalur penerbitan tagihan, termasuk
 * satu-satunya rail yang menerbitkan tagihan untuk kartu TITIPAN. `requiredConfig` melempar saat
 * DIPANGGIL, bukan saat start — jadi var yang terhapus saat menyunting backend.env menghasilkan
 * boot yang berhasil, log bersih, dan kegagalan yang baru muncul di depan pembeli pertama.
 *
 * ┌──── KENAPA INI MEMPERINGATKAN, PADAHAL TETANGGANYA DI ATAS MENOLAK START ─────────────────┐
 * │ `assertDomesticShippingRateSane` dan interlock mainnet menolak start karena yang mereka   │
 * │ jaga adalah BATAS BELANJA dan KONSISTENSI JARINGAN: menyala dengan nilai yang salah di    │
 * │ sana berarti membelanjakan uang dengan batas yang tidak pernah diminta siapa pun.         │
 * │                                                                                            │
 * │ Var ini tidak begitu. Kalau ia hilang, yang rusak HANYA penerbitan tagihan. Menolak start │
 * │ justru menukar kerusakan sempit itu dengan kerusakan total: di droplet, migrasi dan server │
 * │ dirantai `&&` dalam satu CMD, jadi boot yang gagal berarti api.hoshimarket.xyz MATI —     │
 * │ marketplace, vault, riwayat, semuanya — bukan cuma checkout-nya.                          │
 * │                                                                                            │
 * │ Menukar checkout yang rusak dengan situs yang mati bukan perbaikan.                        │
 * └────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Bentuk nilainya tetap DIVALIDASI KERAS di atas (`@IsUrl`): nilai yang ADA tapi cacat ditolak,
 * karena di situ tidak ada pertukaran apa pun — konfigurasi yang cacat tidak pernah bisa jalan.
 */
function warnIfPaymentReturnUrlMissing(config: Record<string, unknown>): void {
  const raw = config.HOSHI_PAYMENT_RETURN_URL;
  const ada = typeof raw === 'string' && raw.trim().length > 0;
  if (ada) return;
  // console, bukan Logger Nest: validateEnv berjalan SEBELUM aplikasi (dan logger-nya) berdiri.
  console.error(
    '[ENV] HOSHI_PAYMENT_RETURN_URL TIDAK TERISI. Backend tetap menyala, tetapi SETIAP ' +
      'penerbitan tagihan akan gagal — pack, stok Hoshi, dan kartu TITIPAN. Pembeli akan ' +
      'melihat kegagalan di tombol Beli, bukan di sini. Isi var ini di backend.env, mis. ' +
      'HOSHI_PAYMENT_RETURN_URL=https://hoshimarket.xyz/open-packs',
  );
}

/**
 * PLAFON SPONSOR GAS YANG TIDAK BISA DIBACA = BACKEND MENOLAK START.
 *
 * Keempat env ini adalah BATAS BELANJA, dan sebelum ini nilai yang tidak terbaca — termasuk "0",
 * "-1", dan "off" — diam-diam berubah menjadi default bawaan. Untuk sebuah batas belanja itu arah
 * yang salah: operator yang mengetik `HOSHI_ESCROW_SPONSOR_DAILY_CAP_LAMPORTS=0` untuk menghentikan
 * sponsor di tengah insiden justru mendapat 0,02 SOL/hari. Sekarang "0" berarti NOL (lihat
 * src/escrow/sponsor-cap-env.ts) dan yang benar-benar tidak terbaca ditolak DI SINI.
 *
 * KENAPA MENOLAK START, bukan melempar saat dipakai seperti plafon treasury: plafon ini dibaca di
 * jalur yang punya JALAN MUNDUR ("penjual bayar gas"), jadi melempar saat dipakai akan ikut
 * mematikan jalan mundur itu untuk penjual yang tidak ada urusannya dengan salah ketik kita —
 * sementara diam-diam memakai default berarti membelanjakan SOL dengan batas yang tidak pernah
 * diminta siapa pun. Gagal saat boot tidak punya dua kerugian itu, dan alasannya sama dengan
 * interlock cutover mainnet di bawah: gagal saat BOOT jauh lebih murah daripada gagal — atau
 * membelanjakan — di tengah jalur uang.
 */
/**
 * ONGKIR DOMESTIK dari env — DITOLAK SAAT BOOT kalau nominalnya mustahil ditagih.
 *
 * ┌──── KENAPA SAAT BOOT DAN BUKAN SAAT DIPAKAI ────────────────────────────────────────────────┐
 * │ Batas bawahnya BUKAN angka karangan: ia MINIMUM MINT IDRX (Rp 20.000). Sebuah nilai di      │
 * │ bawahnya menghasilkan konfigurasi yang kelihatan benar di mana-mana — env terisi, dashboard │
 * │ tenang, log bersih — lalu GAGAL pertama kali seorang pembeli menekan "Bayar ongkir",        │
 * │ karena gateway menolak mint-request-nya. Itu kegagalan yang muncul di depan USER, berjam-   │
 * │ jam atau berhari-hari sesudah salah ketiknya, dan yang menanggungnya orang yang sudah       │
 * │ membeli kartu.                                                                              │
 * │                                                                                             │
 * │ Menolaknya saat BOOT memindahkan kegagalan itu ke depan orang yang MENGETIKNYA, detik itu   │
 * │ juga, dengan pesan yang menyebut batasnya. Var ini OPSIONAL — tidak diisi = tidak ada yang  │
 * │ dicek — jadi aturan ini tidak bisa menjatuhkan deploy yang tidak memakainya.                 │
 * └─────────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Yang di DB (tabel `domestic_shipping_rates`) divalidasi di dua titik lain dengan batas yang
 * SAMA: saat admin menulis (assertSaneRate di AdminService) dan saat jalur bayar membaca
 * (fail-closed di resolveDomesticShippingIdr). Boot tidak bisa mengeceknya — DATABASE_URL belum
 * tentu terjangkau saat validasi env, dan satu blip DB tidak boleh menggagalkan start.
 */
function assertDomesticShippingRateSane(config: Record<string, unknown>): void {
  // `typeof === 'string'` dulu, bukan `String(...)`: alasan sama dengan warnIfResellCapUnset —
  // nilai non-string tidak pernah datang dari env, dan memaksanya jadi string di sini hanya
  // menciptakan cara kedua sebuah TARIF bisa terbaca "terisi". (Juga membersihkan
  // @typescript-eslint/no-base-to-string di baris ini.)
  const v = config.HOSHI_DOMESTIC_SHIPPING_FLAT_IDR;
  const raw =
    typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!raw) return; // tidak diisi = pakai tarif dashboard / tier penampung. Sah.
  const parsed = Number(raw);
  if (
    !Number.isInteger(parsed) ||
    parsed < IDRX_MIN_MINT_IDR ||
    parsed > IDRX_MAX_MINT_IDR
  ) {
    throw new Error(
      `HOSHI_DOMESTIC_SHIPPING_FLAT_IDR="${raw}" bukan ongkir yang bisa ditagihkan. Nilainya ` +
        `harus bilangan bulat Rupiah UTUH antara ${IDRX_MIN_MINT_IDR} dan ${IDRX_MAX_MINT_IDR} ` +
        '(batas mint IDRX). Di bawah minimum itu, invoice ongkirnya DITOLAK gateway dan jalur ' +
        'kirim domestik mati di pembelian pertama — jadi backend menolak start alih-alih ' +
        'membiarkan kegagalannya muncul di depan pembeli. Kosongkan var ini untuk memakai tarif ' +
        'dari dashboard admin (PUT /api/admin/shipping/domestic-rates).',
    );
  }
}

function assertSponsorCapsReadable(config: Record<string, unknown>): void {
  const problems = sponsorCapEnvProblems(config);
  if (problems.length > 0) {
    throw new Error(
      'Plafon sponsor gas escrow tidak bisa dibaca — backend menolak start supaya batas belanja ' +
        'tidak diam-diam kembali ke default:\n' +
        problems.map((p) => `  • ${p}`).join('\n'),
    );
  }
}
