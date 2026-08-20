/**
 * Tipe request/response untuk CC Vault Shipping API (kirim kartu fisik keluar dari vault CC).
 *
 * Kontraknya BELUM sepenuhnya terdokumentasi di sisi CC, jadi field yang tidak kritis dibuat
 * opsional/longgar (`[k: string]: unknown`) supaya penambahan field oleh CC tidak langsung
 * membuat parsing kita gagal. Yang KRITIS untuk jalur uang — `totalCost`, `outboundShipmentId`,
 * `transactions` — diketik tegas dan diverifikasi di service, bukan dipercaya buta.
 */

/** Status shipment dari GET /outbound-shipment/:id. */
export type CcShipmentStatus =
  | 'Created'
  | 'PaymentPending'
  | 'PaymentReceived'
  | 'Pending'
  | 'Processing'
  | 'Shipped'
  | 'Delivered'
  | 'ActionRequired'
  | 'Cancelled';

/** Body POST /shipping-address/create. Di-snapshot dari alamat user di Hoshi. */
export interface CcShippingAddressInput {
  fullName: string;
  country: string;
  streetAddress: string;
  apartment?: string;
  city: string;
  state?: string;
  zip: string;
  phoneNumber?: string;
  email?: string;
  isDefault?: boolean;
}

export interface CcCreateAddressResponse {
  id: string;
  [k: string]: unknown;
}

/** Body POST /redeem/estimate — taksiran ongkir (READ-ONLY, tidak membuat shipment). */
export interface CcEstimateRequest {
  nftAddresses: string[];
  shippingAddress: CcShippingAddressInput;
  deliveryCompany?: string;
}

/**
 * Respons /redeem/estimate. `totalCost` = USD (dolar penuh, seperti field harga CC lain — mesin
 * gacha & katalog buy sama-sama mengirim dolar penuh, bukan base unit). Dikonversi ke USDC base
 * unit di service lewat usdDollarsToUsdcBaseUnits.
 */
export interface CcEstimateResponse {
  totalCost: number;
  breakdown?: unknown;
  [k: string]: unknown;
}

/** Body POST /redeem/prepare — membangun shipment + transaksi burn UNSIGNED. Idempoten per (set, metode, alamat). */
export interface CcPrepareRequest {
  nftAddresses: string[];
  shippingAddressId: string;
  coin: 'USDC';
  deliveryCompany: string;
  comment?: string;
  email?: string;
  payCustomsDuties?: boolean;
  insurance?: boolean;
}

/**
 * Respons /redeem/prepare — OTORITATIF. `totalCost` (USD) inilah yang akan didebit dari USDC user
 * saat burn, jadi angka INI (bukan estimate) yang dipakai untuk mendanai wallet user.
 */
export interface CcPrepareResponse {
  outboundShipmentId: string;
  /** base64 UNSIGNED — hanya wallet user yang boleh menandatangani. */
  transactions: string[];
  /** base64 UNSIGNED delist (kartu dilepas dari listing sebelum burn), bila ada. */
  delistTransactions: string[];
  totalCost: number;
  submitUrl?: string;
  breakdown?: unknown;
  [k: string]: unknown;
}

/** Body POST /blockchain/:outboundShipmentId/burn — transaksi yang SUDAH ditandatangani user. */
export interface CcBurnRequest {
  transactions: string[];
}

/** Respons burn. CC menyiarkan + membakar + mengirim; signature-nya opsional (kalau ada, disimpan). */
export interface CcBurnResponse {
  signature?: string;
  success?: boolean;
  [k: string]: unknown;
}

/** Respons GET /outbound-shipment/:id. */
export interface CcShipmentResponse {
  status: CcShipmentStatus | string;
  trackingIds?: string[];
  trackingUrls?: string[];
  totalCost?: number;
  [k: string]: unknown;
}

/** Bentuk body error CC (tidak dijamin — dibaca defensif). */
export interface CcShippingErrorBody {
  message?: string;
  error?: string;
  details?: string;
}
