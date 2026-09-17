/**
 * Tipe request/response untuk CC Vault Shipping API (kirim kartu fisik keluar dari vault CC).
 *
 * SUMBER KEBENARAN: dokumen resmi "Shipping API | Collector Crypt". Bentuk di bawah MENGIKUTI
 * dokumen itu — bukan tebakan. Aturan yang dipakai di sini:
 *  - Field yang dokumennya SEBUT tipenya → diketik tegas.
 *  - Field yang dokumennya sebut NAMANYA saja (tipe tak disebut) → dibiarkan `unknown`.
 *  - Setiap respons tetap punya `[k: string]: unknown` — CC boleh menambah field tanpa membuat
 *    parsing kita gagal ("Other fields may appear; rely only on the ones listed here").
 *  - Yang KRITIS untuk jalur uang — `total` (estimate), `totalCost` (prepare), `outboundShipmentId`,
 *    `transactions` — diketik tegas dan tetap diverifikasi ulang di service, bukan dipercaya buta.
 *
 * AUTH (dokumen, bagian Authentication): hanya DUA kredensial yang ada —
 *  1. access token hasil wallet sign-in  → `Authorization: Bearer cca_...`
 *  2. API key                            → `Authorization: Bearer ccsk_...` + header `X-CC-Customer`
 * TIDAK ADA jalur "Privy identity token". Redemption Solana (burn) WAJIB memakai sesi wallet
 * sign-in (cca_): "Sending Solana transactions on a key is refused ... Solana redemptions still
 * need a wallet sign-in session." Karena itu token yang direlay backend ke CC selalu token SIWS.
 */

/**
 * Status shipment dari GET /outbound-shipment/:id.
 * Dokumen: "Statuses you will see: Pending (accepted) - Shipped - Delivered - Cancelled."
 * HANYA empat ini. Status lain (kalau CC menambah) ditangani sebagai "tak dikenal" di service.
 */
export type CcShipmentStatus =
  | 'Pending'
  | 'Shipped'
  | 'Delivered'
  | 'Cancelled';

/**
 * Body POST /shipping-address/create — WHITELIST KETAT.
 * Dokumen: "Any field not on this list returns a 400." Jangan menambah field (mis. `email`).
 *
 * WAJIB: streetAddress, city, state, country.
 *  - `state` wajib "even where the concept does not apply" (disimpan ternormalisasi: "CA" → "California").
 *  - `country` boleh alpha-2 (US), alpha-3 (USA), atau nama penuh.
 * OPSIONAL: fullName ("Send it — the carrier needs it"), apartment, zip ("Needed for correct US
 * rates"), phoneNumber, isDefault.
 */
export interface CcShippingAddressInput {
  streetAddress: string;
  city: string;
  state: string;
  country: string;
  fullName?: string;
  apartment?: string;
  zip?: string;
  phoneNumber?: string;
  isDefault?: boolean;
}

/** Respons /shipping-address/create — "Returns the created row; keep id as your shippingAddressId". */
export interface CcCreateAddressResponse {
  id: string;
  [k: string]: unknown;
}

/**
 * Body POST /redeem/estimate — taksiran ongkir (READ-ONLY, tidak membuat shipment).
 * Dokumen: "This endpoint accepts only these four fields. Reposting a /redeem/prepare body returns
 * a 400." Jadi: TIDAK ADA objek alamat di sini — hanya `shippingAddressId`.
 */
export interface CcEstimateRequest {
  /** "yes, at least 1" */
  nftAddresses: string[];
  shippingAddressId: string;
  deliveryCompany?: string;
  payCustomsDuties?: boolean;
}

/** Satu baris rincian harga. Dokumen: entri `breakdown.lines[]` = { code, label, amount, qty?, unitPrice? }. */
export interface CcBreakdownLine {
  code: string;
  label: string;
  amount: number;
  qty?: number;
  unitPrice?: number;
  [k: string]: unknown;
}

/**
 * `breakdown` dari estimate/prepare. Dokumen: RENDER GENERIK — iterasi `lines`, tampilkan
 * label+amount apa adanya; JANGAN switch exhaustive atas `code` dan JANGAN menyusun ulang total
 * dari sekumpulan code tetap ("more codes exist than any one order shows, and new ones are added
 * without notice. total is authoritative").
 */
export interface CcPriceBreakdown {
  /** "USA | Canada | Europe | AustraliaNewZealand | RestOfWorld" — string longgar, CC boleh nambah. */
  region?: string;
  declaredValue?: number;
  numberOfCards?: number;
  lines?: CcBreakdownLine[];
  notes?: unknown[];
  [k: string]: unknown;
}

/**
 * Respons /redeem/estimate. Angka OTORITATIF = `total` (BUKAN `totalCost`; field itu milik
 * /redeem/prepare). Semua angka = USD dolar penuh (seperti field harga CC lain — gacha & katalog
 * buy juga mengirim dolar penuh, bukan base unit) → dikonversi ke USDC base unit di service lewat
 * usdDollarsToUsdcBaseUnits.
 *
 * `customsDutiesEstimate` SELALU dikembalikan, ikut/tidak ikut opt-in — tampilkan di sebelah
 * kontrol opt-in.
 */
export interface CcEstimateResponse {
  total: number;
  price?: number;
  insurancePrice?: number;
  feesPrice?: number;
  shippingPrice?: number;
  numberOfCards?: number;
  customsDutiesEstimate?: number;
  breakdown?: CcPriceBreakdown;
  [k: string]: unknown;
}

/**
 * Body POST /redeem/prepare — membangun shipment + transaksi burn UNSIGNED.
 * Dokumen: "Calling prepare again with identical input returns the same shipment with fresh
 * transactions" → itulah pemulihan yang BENAR saat batch 15-menit/blockhash kedaluwarsa. Mengubah
 * alamat atau menyalakan payCustomsDuties SENGAJA membuat shipment BARU.
 *
 * TIDAK ADA field `insurance`: "insurance is automatic, and sending the field returns 400
 * ['property insurance should not exist']".
 */
export interface CcPrepareRequest {
  nftAddresses: string[];
  shippingAddressId: string;
  /** Default USDC bila tidak dikirim. */
  coin?: 'USDC' | 'USDT';
  /** Default crypto bila tidak dikirim. */
  paymentMethod?: 'crypto' | 'card';
  /** Default "ups" bila tidak dikirim. */
  deliveryCompany?: string;
  comment?: string;
  /** Wajib de-facto hanya bila paymentMethod='card' dan akun CC belum punya email. */
  email?: string;
  payCustomsDuties?: boolean;
}

/**
 * Respons /redeem/prepare — OTORITATIF untuk jalur uang. `totalCost` (USD) inilah yang akan didebit
 * dari USDC user saat burn, jadi angka INI (bukan estimate) yang dipakai untuk mendanai wallet user.
 *
 * Dokumen: `totalCost` = 0 untuk pembayaran kartu dan untuk shipment yang SUDAH dibayar — jangan
 * ditampilkan mentah-mentah sebagai "harga". Set transaksi ditahan 15 MENIT.
 */
export interface CcPrepareResponse {
  outboundShipmentId: string;
  /** base64 UNSIGNED — TANDATANGANI SEMUA. Instruksi biaya kirim ditempel di entri PERTAMA. */
  transactions: string[];
  /**
   * base64 UNSIGNED delist — biasanya []. Terisi bila kartu masih tertahan escrow marketplace luar
   * dan harus dilepas dulu: "Sign and submit these too; omit them and the burn legs fail on chain."
   */
  delistTransactions: string[];
  totalCost: number;
  /** "/blockchain/<outboundShipmentId>/burn" */
  submitUrl?: string;
  breakdown?: CcPriceBreakdown;
  [k: string]: unknown;
}

/**
 * Body POST /blockchain/:outboundShipmentId/burn — DUA ARRAY TERPISAH, masing-masing berisi salinan
 * DITANDATANGANI dari setiap entri yang dikembalikan prepare. Jangan digabung jadi satu array:
 * CC memvalidasi "the complete set this server issued" (403 bila ada leg hilang, dobel, atau
 * berasal dari panggilan prepare lain).
 */
export interface CcBurnRequest {
  transactions: string[];
  delistTransactions: string[];
}

/**
 * Satu elemen respons burn. `error === null` = leg itu mendarat; `error` non-null = leg itu GAGAL
 * (kecuali literal duplikat di bawah).
 */
export interface CcBurnResultEntry {
  error: string | null;
  transactionId?: string;
  transactionUrl?: string;
  [k: string]: unknown;
}

/**
 * Respons POST /blockchain/:id/burn — HTTP 200 dengan ARRAY JSON TELANJANG, kegagalan di depan:
 * `[{ error, transactionId, transactionUrl }]`. Dokumen: "There is no id, status or transactionUrls.
 * Inspect every element — a 200 with a non-null error on any element means that leg did not land."
 */
export type CcBurnResponse = CcBurnResultEntry[];

/**
 * Satu-satunya `error` yang BUKAN kegagalan: mengirim ulang body yang identik itu aman, dan leg
 * yang sudah tercatat kembali sebagai duplikat. Dokumen: "Do not read that as a failure."
 */
export const CC_BURN_DUPLICATE_ERROR = 'Duplicate transaction result';

/**
 * Respons GET /outbound-shipment/:id.
 *
 * Dokumen: SEMUA field biaya dan `numberOfCards` adalah STRING (bukan number). Field yang disebut:
 * id - customId - status - numberOfCards - cardIds - deliveryCompany - trackingIds - trackingUrls -
 * shippingCost - insuranceCost - feesCost - totalCost - typeCurrency - createdAt - updatedAt;
 * "Other fields may appear; rely only on the ones listed here".
 *
 * Id yang tidak dikenal TIDAK menghasilkan 404 melainkan 200 BODY KOSONG → di klien itu dipetakan
 * jadi `null` (lihat CcShippingClient.getShipment), bukan error.
 */
export interface CcShipmentResponse {
  id?: string;
  customId?: string;
  status: CcShipmentStatus | string;
  /** STRING menurut dokumen — jangan diperlakukan sebagai number. */
  numberOfCards?: string;
  /** Tipe elemen tidak didokumentasikan → dibiarkan longgar. */
  cardIds?: unknown;
  deliveryCompany?: string;
  /** Tipe elemen tidak didokumentasikan; divalidasi runtime di service (filter string non-kosong). */
  trackingIds?: unknown;
  trackingUrls?: unknown;
  /** STRING menurut dokumen. */
  shippingCost?: string;
  insuranceCost?: string;
  feesCost?: string;
  totalCost?: string;
  typeCurrency?: string;
  /** Format tidak didokumentasikan → longgar. */
  createdAt?: unknown;
  updatedAt?: unknown;
  [k: string]: unknown;
}

/**
 * Bentuk body error CC (dibaca defensif). Dokumen: "Error bodies are not uniform — branch on the
 * HTTP status, never on the presence of a field"; `message` selalu string dan untuk kegagalan
 * validasi / penolakan per-kartu ia berisi JSON di dalam string.
 */
export interface CcShippingErrorBody {
  message?: string;
  error?: string;
  details?: string;
}

/* ───────────── SINYAL TERSTRUKTUR dari body error CC (bukan prosa) ─────────────
 * MASALAH yang ini pecahkan: keputusan uang "CC menjamin NOL kartu terbakar" untuk kasus
 * 409 bergantung pada KEBERADAAN KUNCI `delistErrors` di body error — sementara pesan yang
 * dibentuk klien hanyalah `details ?? message ?? error` yang DIPOTONG 300 karakter. Untuk body
 * bergaya Nest — {"statusCode":409,"message":"De-list failed","error":"Conflict","delistErrors":[…]}
 * — pesan itu jadi "De-list failed" dan nama kuncinya HILANG. Menebak dari teks = cabang mati.
 *
 * Maka klien MELAMPIRKAN fakta mentah hasil parsing ke exception yang dilempar (di bawah), dan
 * service membaca fakta itu. Klien tetap TRANSPORT MURNI: ia hanya melaporkan apa yang ada di
 * body, TIDAK menilai artinya — penilaian (dan sikap fail-closed-nya) ada di service. */

/** Nama kunci yang dokumen CC pakai untuk kegagalan leg de-list: "409 with delistErrors". */
export const CC_SHIPPING_DELIST_ERRORS_KEY = 'delistErrors';

/**
 * Simbol GLOBAL (Symbol.for) tempat meta dilampirkan ke exception — non-enumerable, jadi tidak
 * pernah ikut terserialisasi ke respons HTTP/log JSON, dan tetap cocok walau modul ter-load dua
 * kali (jest/ts-node) karena Symbol.for berbagi registry lintas realm.
 */
export const CC_SHIPPING_ERROR_META: unique symbol = Symbol.for(
  'hoshi.cc-shipping.error-meta',
);

/** Fakta MENTAH tentang body error CC — tanpa interpretasi. */
export interface CcShippingErrorMeta {
  /** Status HTTP ASLI dari CC (klien memetakan 403 → UnauthorizedException/401, jadi ini perlu). */
  readonly status: number;
  /** true HANYA bila body error berhasil di-JSON.parse MENJADI OBJEK (bukan array/skalar/non-JSON). */
  readonly jsonBody: boolean;
  /** true HANYA bila objek itu BENAR-BENAR punya kunci `delistErrors` (own property). */
  readonly delistErrorsPresent: boolean;
  /** Isi `delistErrors` apa adanya (undefined bila kunci tidak ada) — untuk dinilai service. */
  readonly delistErrors: unknown;
}

/** Lampirkan meta ke exception yang akan dilempar klien. Mengembalikan exception yang sama. */
export function attachCcShippingErrorMeta<T extends object>(
  err: T,
  meta: CcShippingErrorMeta,
): T {
  Object.defineProperty(err, CC_SHIPPING_ERROR_META, {
    value: meta,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return err;
}

/**
 * Baca meta dari error apa pun. FAIL-CLOSED: null bila error bukan objek, meta tidak ada, atau
 * bentuknya tidak persis seperti yang diharapkan — pemanggil WAJIB memperlakukan null sebagai
 * "tidak terverifikasi".
 */
export function readCcShippingErrorMeta(
  err: unknown,
): CcShippingErrorMeta | null {
  if (err === null || typeof err !== 'object') return null;
  const raw = (err as Record<symbol, unknown>)[CC_SHIPPING_ERROR_META];
  if (raw === null || typeof raw !== 'object') return null;
  const meta = raw as Partial<CcShippingErrorMeta>;
  if (
    typeof meta.status !== 'number' ||
    typeof meta.jsonBody !== 'boolean' ||
    typeof meta.delistErrorsPresent !== 'boolean'
  ) {
    return null;
  }
  return meta as CcShippingErrorMeta;
}

/* ─────────────────────── SIWS (Sign-In With Solana) — Track B ───────────────────────
 * Handshake LOGIN wallet CC (dokumen bagian "Wallet sign-in"). nonce/verify/refresh adalah
 * PRA-AUTH: TIDAK membawa Authorization bearer (lihat requestNoAuth di client). Respons diketik
 * LONGGAR ([k:string]:unknown) — CC boleh menambah field tanpa membuat parsing kita gagal; field
 * yang kita andalkan tetap diketik tegas. */

/**
 * Body POST /auth/wallet/nonce (publik). `partnerAppId`/`domain`/`uri` DISUNTIK dari config oleh
 * service (client cuma transport) — frontend hanya mengirim wallet-nya.
 *  - wallet: alamat Solana base58.
 *  - partnerAppId: diterbitkan CC (nilai tak dikenal → 400 "Unknown partner").
 *  - domain: HOSTNAME TELANJANG — tanpa skema, tanpa port, tanpa path; harus ada di allowlist CC.
 *  - uri: URL absolut, di-echo ke dalam teks yang ditandatangani.
 */
export interface CcSiwsNonceRequest {
  wallet: string;
  partnerAppId: string;
  domain: string;
  uri: string;
}

/**
 * Respons /auth/wallet/nonce. `message` = teks SIWS KANONIK yang HARUS ditandatangani user
 * VERBATIM (byte demi byte; LF, tepat 11 baris, urutan field tetap) — JANGAN dibangun ulang di
 * sisi kita: ia memuat nilai yang tak bisa kita ketahui. Nonce SEKALI PAKAI dan berlaku 5 MENIT
 * (baris "Expiration Time" di dalam message menunjukkan jendela lebih panjang — yang berlaku
 * tetap nonce 5 menit).
 */
export interface CcSiwsNonceResponse {
  nonce: string;
  expiresAt: number;
  message: string;
  [k: string]: unknown;
}

/**
 * Body POST /auth/wallet/verify (publik).
 *  - message: teks PERSIS dari langkah nonce.
 *  - signature: base58 ed25519, 64 byte, atas UTF-8 bytes mentah dari `message`.
 */
export interface CcSiwsVerifyRequest {
  message: string;
  signature: string;
}

/**
 * Respons /auth/wallet/verify — accessToken (prefix cca_, 15 menit) + refreshToken (prefix ccr_,
 * 7 hari). Keduanya OPAQUE: jangan di-parse.
 */
export interface CcSiwsVerifyResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [k: string]: unknown;
}

/**
 * Body POST /auth/wallet/refresh — tukar refreshToken lama dengan pasangan token baru. Token lama
 * LANGSUNG MATI; replay → 401 "Refresh token not found or already used".
 */
export interface CcSiwsRefreshRequest {
  refreshToken: string;
}

/** Respons /auth/wallet/refresh — pasangan token baru (bentuk sama dengan verify). */
export interface CcSiwsRefreshResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [k: string]: unknown;
}
