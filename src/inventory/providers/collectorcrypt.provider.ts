import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { normalizeRarity } from '../../packs/packs.catalog';
import type {
  DeliveryRecipient,
  InventoryCard,
  InventoryDelivery,
  InventoryHold,
  InventoryProvider,
} from '../inventory.types';

/**
 * ⚠️ DEPRECATED — JANGAN DIPAKAI, JANGAN DIJADIKAN CONTOH. Endpoint yang dipanggil
 * file ini TIDAK ADA di API CollectorCrypt yang sebenarnya.
 *
 * Integrasi yang benar & hidup: **src/collectorcrypt/** (CcGachaClient + GachaService).
 *
 * Yang salah di sini, setelah kontrak resmi mereka diverifikasi:
 * - `/gacha/pool`, `/gacha/reserve`, `/gacha/settle`, `/gacha/release` semuanya KARANGAN → 404.
 * - TIDAK ADA primitif reserve/hold/release. Pack dibeli putus; tidak ada cara membatalkan.
 * - Undian BUKAN milik kita. CollectorCrypt yang mengundi lewat VRF on-chain
 *   (program ccvrfu3fSpbnPLiUqdWAt85Zn9nq96ekwGTbHqGtdgQ) dan user bisa memverifikasinya
 *   sendiri. Rarity mereka 4 tier (Common|Uncommon|Rare|Epic), bukan 5 tier Hoshi.
 * - Auth-nya header `x-api-key`, BUKAN `Authorization: Bearer` seperti di bawah.
 * - Bentuk interface `deliver()` mustahil dipenuhi: alur asli mereka wajib melewati
 *   TANDA TANGAN WALLET USER di tengah jalan —
 *     generatePack → USER MENANDATANGANI di browser → submitTransaction → openPack
 *   sedangkan `deliver()` adalah satu panggilan sinkron dari server. Backend kita
 *   non-kustodial: ia tidak pernah memegang private key user, jadi langkah itu tidak
 *   akan pernah bisa dikerjakan dari sini.
 *
 * Dibiarkan hidup HANYA supaya InventoryModule/InventoryService tetap kompilasi
 * (keduanya meng-import kelas ini). Inert selama INVENTORY_PROVIDER != 'collectorcrypt'
 * dan selama COLLECTORCRYPT_API_* kosong — `credentials()` di bawah melempar 503.
 *
 * ⚠️ Mengisi COLLECTORCRYPT_API_BASE_URL + COLLECTORCRYPT_API_KEY akan MELUCUTI penjaga itu
 * dan membuat stub ini benar-benar menembak endpoint karangan tadi. Var gacha yang asli
 * sengaja dinamai lain (COLLECTORCRYPT_GACHA_BASE_URL / COLLECTORCRYPT_GACHA_API_KEY)
 * supaya keduanya tidak pernah saling menyalakan. Biarkan var lama ini KOSONG.
 */

// Bentuk respons API CollectorCrypt (ASUMSI — dan asumsi ini sudah TERBUKTI SALAH;
// lihat blok deprecation di atas. Bentuk wire yang benar ada di
// src/collectorcrypt/cc-gacha.types.ts).
interface CcPoolItem {
  assetId: string;
  name: string;
  rarity: string;
  image?: string;
  marketValueIdr: number;
}
interface CcPoolResponse {
  items: CcPoolItem[];
}
interface CcReserveResponse {
  holdId: string;
}
interface CcSettleResponse {
  assetAddress: string;
  txSignature?: string;
}

/**
 * Adapter CollectorCrypt — STUB terkontrol. Semua method sudah berbentuk final
 * (reserve→deliver→release 2-fase) tetapi menolak jalan sampai kredensial diisi.
 * Saat COLLECTORCRYPT_API_BASE_URL & COLLECTORCRYPT_API_KEY di-set, tinggal
 * pastikan path endpoint di bawah sesuai kontrak resmi mereka.
 *
 * Inilah satu-satunya tempat yang berubah saat kerja sama CollectorCrypt jadi —
 * sisa sistem (PacksService, controller, frontend) tidak tersentuh.
 */
@Injectable()
export class CollectorCryptProvider implements InventoryProvider {
  readonly source = 'collectorcrypt' as const;
  private readonly logger = new Logger(CollectorCryptProvider.name);

  constructor(private readonly config: ConfigService) {}

  async listAvailable(packId: string): Promise<InventoryCard[]> {
    // TODO(integrasi): GET /gacha/pool?packId=... → map pNFT ke InventoryCard.
    const res = await this.request<CcPoolResponse>(
      'GET',
      `/gacha/pool?packId=${encodeURIComponent(packId)}`,
    );
    return res.items.map((i) => ({
      source: this.source,
      ref: i.assetId,
      name: i.name,
      rarity: normalizeRarity(i.rarity),
      imageUrl: i.image,
      valueIdr: i.marketValueIdr,
    }));
  }

  async reserve(card: InventoryCard): Promise<InventoryHold> {
    // TODO(integrasi): POST /gacha/reserve { assetId } → hold ber-TTL.
    const res = await this.request<CcReserveResponse>(
      'POST',
      '/gacha/reserve',
      {
        assetId: card.ref,
      },
    );
    return { source: this.source, holdId: res.holdId, card };
  }

  async deliver(
    hold: InventoryHold,
    recipient: DeliveryRecipient,
  ): Promise<InventoryDelivery> {
    // TODO(integrasi): POST /gacha/settle → CollectorCrypt transfer pNFT ke wallet user.
    const res = await this.request<CcSettleResponse>('POST', '/gacha/settle', {
      holdId: hold.holdId,
      recipient: recipient.ownerAddress,
    });
    return {
      source: this.source,
      card: hold.card,
      assetAddress: res.assetAddress,
      txSignature: res.txSignature,
    };
  }

  async release(hold: InventoryHold): Promise<void> {
    // TODO(integrasi): POST /gacha/release { holdId } — lepas hold bila draw batal.
    await this.request('POST', '/gacha/release', { holdId: hold.holdId });
  }

  /** Kredensial API — melempar error jelas selama belum dikonfigurasi. */
  private credentials(): { baseUrl: string; apiKey: string } {
    const baseUrl = this.config.get<string>('COLLECTORCRYPT_API_BASE_URL');
    const apiKey = this.config.get<string>('COLLECTORCRYPT_API_KEY');
    if (!baseUrl || !apiKey) {
      throw new ServiceUnavailableException(
        'Provider CollectorCrypt not configured. Set COLLECTORCRYPT_API_BASE_URL and ' +
          'COLLECTORCRYPT_API_KEY lalu verifikasi path endpoint ke docs.collectorcrypt.com.',
      );
    }
    return { baseUrl, apiKey };
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { baseUrl, apiKey } = this.credentials();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      this.logger.error(
        `CollectorCrypt ${method} ${path} → HTTP ${res.status}`,
      );
      throw new ServiceUnavailableException(
        `CollectorCrypt ${method} ${path} failed (HTTP ${res.status}).`,
      );
    }
    return (await res.json()) as T;
  }
}
