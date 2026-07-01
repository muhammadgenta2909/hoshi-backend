import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CollectorCryptProvider } from './providers/collectorcrypt.provider';
import { HoshiVaultProvider } from './providers/hoshi-vault.provider';
import { MockInventoryProvider } from './providers/mock.provider';
import type { InventoryProvider, InventorySource } from './inventory.types';

/**
 * Registry provider inventory. Memilih provider berdasarkan `source`; default
 * aktif diambil dari env INVENTORY_PROVIDER (fallback 'hoshi-vault'). PacksService
 * cukup memanggil `resolve()` — tidak tahu-menahu provider konkretnya.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);
  private readonly providers: Map<InventorySource, InventoryProvider>;
  private readonly active: InventorySource;

  constructor(
    hoshiVault: HoshiVaultProvider,
    mock: MockInventoryProvider,
    collectorCrypt: CollectorCryptProvider,
    config: ConfigService,
  ) {
    this.providers = new Map<InventorySource, InventoryProvider>([
      [hoshiVault.source, hoshiVault],
      [mock.source, mock],
      [collectorCrypt.source, collectorCrypt],
    ]);
    this.active =
      (config.get<string>('INVENTORY_PROVIDER') as InventorySource) ??
      'hoshi-vault';
    this.logger.log(`Inventory source aktif: ${this.active}`);
  }

  /** Provider untuk `source`, atau provider aktif bila tak disebut. */
  resolve(source?: InventorySource): InventoryProvider {
    const key = source ?? this.active;
    const provider = this.providers.get(key);
    if (!provider) {
      throw new BadRequestException(
        `Inventory source tidak dikenal: ${key}. Pilihan: ${[...this.providers.keys()].join(', ')}.`,
      );
    }
    return provider;
  }

  get activeSource(): InventorySource {
    return this.active;
  }

  sources(): InventorySource[] {
    return [...this.providers.keys()];
  }
}
