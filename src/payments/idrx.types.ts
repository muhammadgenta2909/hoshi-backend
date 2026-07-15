/**
 * Tipe wire IDRX API — cerminan 1:1 dari kontrak resmi (docs.idrx.co).
 *
 * ATURAN (sama seperti cc-gacha.types.ts): file ini HANYA boleh berisi bentuk yang
 * benar-benar ada di dokumentasi. Jangan menambah field karangan sendiri. Kalau tipe
 * sebuah field tidak dipastikan dokumentasi, biarkan longgar (`string | number`) dan
 * biarkan PEMANGGIL yang mempersempit lewat parse eksplisit — jangan berbohong soal
 * bentuk data uang.
 */

/** Mint SPL IDRX di Solana. Mint LAMA (idrxTdNft...) sudah deprecated — jangan dipakai. */
export const IDRX_SOLANA_MINT = 'idrxZcP8xiKkYk6XGD4uz1dxEYCWSgKDHqgjsBbwDur';

/* --- Union status (satu-satunya sumber kebenaran soal "sudah dibayar") --- */

export type IdrxPaymentStatus = 'PAID' | 'WAITING_FOR_PAYMENT' | 'EXPIRED';

export type IdrxMintStatus =
  | 'NOT_AVAILABLE'
  | 'PROCESSING'
  | 'MINTED'
  | 'FAILED'
  | 'REJECTED'
  | 'REFUND';

export type IdrxTransactionType = 'MINT' | 'BURN' | 'BRIDGE' | 'DEPOSIT_REDEEM';

/** Default IDRX: 'idrx'. */
export type IdrxRequestType = 'idrx' | 'usdt';

/** Hanya WAJIB untuk DIRECT flow. Hosted flow (paymentUrl) mengosongkannya. */
export type IdrxPaymentMethod = 'VA' | 'QRIS';

/** Bentuk body error IDRX saat non-2xx (dipakai meneruskan pesan aslinya, bukan 500 mentah). */
export interface IdrxErrorBody {
  message?: string;
  error?: string;
}

/* --- POST /api/transaction/mint-request (ON-RAMP) --- */

export interface IdrxCustomerDetail {
  firstName: string;
  lastName: string;
  email: string;
}

export interface IdrxMintRequestInput {
  /**
   * WAJIB, dalam RUPIAH penuh sebagai string (IDRX 1:1 IDR).
   * Batas IDRX: min 20.000, maks 1.000.000.000.
   */
  toBeMinted: string;
  /**
   * WAJIB. Ini alamat TREASURY HOSHI di Solana, BUKAN wallet user: user membayar rupiah
   * dan treasury yang membelanjakan USDC. Kalau ini pernah diisi dari input user, kita
   * mencetak IDRX ke wallet mereka dan tetap membayari packnya.
   */
  destinationWalletAddress: string;
  /** WAJIB, string (bukan number) — chain id jaringan tujuan mint. */
  networkChainId: string;
  /** WAJIB untuk hosted flow. */
  returnUrl: string;
  requestType?: IdrxRequestType;
  /** Menit. Default IDRX: 120. Menentukan kapan invoice kedaluwarsa. */
  expiryPeriod?: number;
  /** Maks 255 karakter. */
  productDetails?: string;
  customerDetail?: IdrxCustomerDetail;
  /** Isi HANYA untuk DIRECT flow. Dikosongkan → hosted flow (paymentUrl, cakupan terluas). */
  paymentMethod?: IdrxPaymentMethod;
  /** Isi HANYA untuk DIRECT flow. */
  channelId?: string;
}

export interface IdrxMintRequestData {
  /** Dokumentasi tidak memastikan tipenya. Jangan diasumsikan number. */
  id: string | number;
  /**
   * DITERBITKAN OLEH IDRX, bukan oleh kita. Inilah join key satu-satunya untuk callback,
   * verifikasi history, dan rekonsiliasi. Wajib dipersist apa adanya.
   */
  merchantOrderId: string;
  merchantCode: string | number;
  reference: string;
  /** Hosted flow saja. */
  paymentUrl?: string;
  /** VA saja. */
  virtualAccountNo?: string;
  /** QRIS saja. */
  qrContent?: string;
  /** Nominal SETELAH fee. Tipe tidak dipastikan dokumentasi — parse eksplisit di pemanggil. */
  amount: string | number;
  statusCode: string | number;
  statusMessage: string;
}

export interface IdrxMintRequestResponse {
  statusCode: number;
  message: string;
  data: IdrxMintRequestData;
}

/* --- GET /api/transaction/user-transaction-history (THE VERIFIER) --- */

export interface IdrxTransactionHistoryQuery {
  /** WAJIB. */
  transactionType: IdrxTransactionType;
  page?: number;
  take?: number;
  merchantOrderId?: string;
  paymentStatus?: IdrxPaymentStatus;
  userMintStatus?: IdrxMintStatus;
  txHash?: string;
}

/**
 * Satu baris transaksi IDRX. INI SATU-SATUNYA BUKTI yang boleh kita percaya — body callback
 * tidak ditandatangani dan hanya berstatus pemicu.
 *
 * SUKSES = paymentStatus === 'PAID' DAN userMintStatus === 'MINTED'. Keduanya, bukan salah satu.
 *
 * Field di bawah `merchantOrderId` didokumentasikan pada payload callback tapi DIELIDE oleh
 * dokumentasi history ("..."), jadi di sini sengaja OPSIONAL: kita tidak boleh mengarang
 * jaminan bahwa mereka selalu ada. Verifier WAJIB memperlakukan ketidakhadirannya sebagai
 * GAGAL VERIFIKASI (fail-closed), bukan sebagai lolos — tanpa pin destinationWalletAddress,
 * sebuah record yang mencetak ke wallet ORANG LAIN tetap lolos cek "ada record PAID+MINTED".
 */
export interface IdrxTransactionRecord {
  id: string | number;
  merchantOrderId: string;
  paymentStatus: IdrxPaymentStatus;
  userMintStatus: IdrxMintStatus;
  burnStatus?: string;
  bridgeStatus?: string;
  txHash?: string;
  /** Pin ke alamat treasury kita. */
  destinationWalletAddress?: string;
  /** Pin ke Solana. */
  chainId?: string | number;
  /** Pin ke 'idrx'. */
  requestType?: IdrxRequestType;
  /** Bandingkan >= nominal rupiah yang kita snapshot di order. */
  toBeMinted?: string | number;
  paymentAmount?: string | number;
}

export interface IdrxPaginationMetadata {
  page: number;
  perPage: number;
  pageCount: number;
  totalCount: number;
}

export interface IdrxTransactionHistoryResponse {
  statusCode: number;
  message: string;
  metadata: IdrxPaginationMetadata;
  records: IdrxTransactionRecord[];
}

/* --- GET /api/transaction/rates (FX) --- */

export interface IdrxRatesExpectedResult {
  min: string | number;
  max: string | number;
}

export interface IdrxRatesQuote {
  expectedResult: IdrxRatesExpectedResult;
}

export interface IdrxRatesData {
  price: string | number;
  /**
   * IDRX yang didapat untuk usdtAmount yang diminta. Karena IDRX 1:1 IDR, inilah HARGA
   * RUPIAH dari pack. Tipe tidak dipastikan dokumentasi — parse ke Int, jangan ke float.
   */
  buyAmount: string | number;
  chainId: string | number;
  quote: IdrxRatesQuote;
}

export interface IdrxRatesResponse {
  statusCode: number;
  message: string;
  data: IdrxRatesData;
}

/* --- Callback (webhook) --- */

/**
 * Payload callback mint IDRX (top-level, sesuai dokumentasi).
 *
 * BACA INI SEBELUM MEMAKAINYA: webhook ini TIDAK DITANDATANGANI dan TIDAK PERNAH di-retry.
 * Bentuk ini ada supaya field yang masuk bisa DIKENALI, BUKAN supaya bisa DIPERCAYA.
 * Satu-satunya field yang boleh dibaca dari sini adalah `merchantOrderId`; sisanya wajib
 * diambil ulang lewat GET /api/transaction/user-transaction-history. Membaca `paymentStatus`
 * dari body ini = siapa pun yang tahu URL callback bisa mengklaim pack senilai ~$50 gratis.
 *
 * Field bersarang (TransactionHistory, MintRequestTransactionFees, usdtRequest) bentuknya
 * tidak didokumentasikan → `unknown`, dan memang tidak ada alasan kita membacanya.
 */
export interface IdrxMintCallbackPayload {
  id?: string | number;
  paymentAmount?: string | number;
  toBeMinted?: string | number;
  /** SATU-SATUNYA field yang boleh dipakai — dan hanya sebagai kunci lookup. */
  merchantOrderId?: string;
  destinationWalletAddress?: string;
  chainId?: string | number;
  paymentStatus?: string;
  userMintStatus?: string;
  adminMintStatus?: string;
  txHash?: string;
  reference?: string;
  requestType?: string;
  customerVaName?: string;
  paymentProviderId?: string | number;
  returnUrl?: string;
  expiryTimestamp?: string | number;
  isApproved?: boolean;
  reportStatus?: string;
  createdAt?: string;
  updatedAt?: string;
  TransactionHistory?: unknown;
  MintRequestTransactionFees?: unknown;
  usdtRequest?: unknown;
}
