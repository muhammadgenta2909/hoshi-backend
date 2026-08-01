import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { CcBuyClient } from './cc-buy.client';
import { CcMarketClient } from './cc-market.client';
import { TreasuryService } from './treasury.service';
import {
  ResellerPostBuyError,
  ResellerSettlementService,
} from './reseller-settlement.service';

// TreasuryService menarik @solana/web3.js → rantai ESM v1 (rpc-websockets→uuid) yang bikin jest
// gagal parse. Sama seperti payments.service.spec, kita mock @solana/web3.js: di sini TreasuryService
// hanya dipakai sebagai TOKEN DI (selalu di-override mock), jadi tak ada kelas web3 yang benar-benar dipakai.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
  clusterApiUrl: () => 'http://localhost:8899',
}));

// Pembongkaran byte transaksi CC (assertCcBuyTxMatchesQuote) diuji terpisah — butuh tx base64
// asli. Di sini di-stub supaya kita bisa menguji ORKESTRASI settle: urutan beli → sign →
// broadcast → transfer, plafon harga, dan BATAS kegagalan pre-buy vs post-buy.
jest.mock('./cc-buy.verify', () => ({
  assertCcBuyTxMatchesQuote: jest.fn(),
}));

describe('ResellerSettlementService', () => {
  let service: ResellerSettlementService;
  let buyClient: { buildBuyTx: jest.Mock; broadcast: jest.Mock };
  let marketClient: { browse: jest.Mock };
  let treasury: {
    publicKey: string;
    sign: jest.Mock;
    transferCoreAssetToBuyer: jest.Mock;
  };

  const NFT = 'CcNftAddrBase58';
  const BUYER = 'BuyerWalletBase58';
  const SELLER = 'SellerWalletBase58';
  const TREASURY = 'TreasuryWalletBase58';

  const browseCard = (listingOver: Record<string, unknown> = {}) => ({
    filterNFtCard: [
      {
        nftAddress: NFT,
        owner: { wallet: SELLER },
        listing: { price: 40, marketplace: 'CC', currency: 'USDC', ...listingOver },
      },
    ],
  });

  beforeEach(async () => {
    buyClient = {
      buildBuyTx: jest.fn().mockResolvedValue({
        transactions: ['BASE64TX'],
        fundingSource: 'wallet',
      }),
      broadcast: jest
        .fn()
        .mockResolvedValue({ success: true, signature: 'BUYSIG' }),
    };
    marketClient = { browse: jest.fn().mockResolvedValue(browseCard()) };
    treasury = {
      publicKey: TREASURY,
      sign: jest.fn().mockReturnValue('SIGNEDTX'),
      transferCoreAssetToBuyer: jest.fn().mockResolvedValue('XFERSIG'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ResellerSettlementService,
        { provide: CcBuyClient, useValue: buyClient },
        { provide: CcMarketClient, useValue: marketClient },
        { provide: TreasuryService, useValue: treasury },
      ],
    }).compile();
    service = moduleRef.get(ResellerSettlementService);
  });

  it('happy: beli sebagai TREASURY → sign → broadcast → transfer ke pembeli', async () => {
    const res = await service.settle({
      nftAddress: NFT,
      buyerWallet: BUYER,
      maxPriceUsdcBaseUnits: 100_000_000, // plafon $100 > live $40
    });

    // Beli atas nama TREASURY (bukan pembeli) — pembeli tak pegang USDC.
    expect(buyClient.buildBuyTx).toHaveBeenCalledWith({
      wallet: TREASURY,
      nftAddress: NFT,
      price: 40,
    });
    expect(treasury.sign).toHaveBeenCalledWith('BASE64TX');
    expect(buyClient.broadcast).toHaveBeenCalledWith({
      wallet: TREASURY,
      signedTransaction: 'SIGNEDTX',
      nftAddress: NFT,
    });
    // Lalu NFT diteruskan ke pembeli.
    expect(treasury.transferCoreAssetToBuyer).toHaveBeenCalledWith({
      assetAddress: NFT,
      newOwner: BUYER,
    });
    expect(res).toEqual({
      buySignature: 'BUYSIG',
      transferSignature: 'XFERSIG',
      priceUsdc: 40,
    });
  });

  it('harga live CC > plafon order → TOLAK sebelum beli (nol belanja)', async () => {
    await expect(
      service.settle({
        nftAddress: NFT,
        buyerWallet: BUYER,
        maxPriceUsdcBaseUnits: 30_000_000, // $30 < live $40
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(buyClient.buildBuyTx).not.toHaveBeenCalled();
    expect(treasury.sign).not.toHaveBeenCalled();
    expect(buyClient.broadcast).not.toHaveBeenCalled();
    expect(treasury.transferCoreAssetToBuyer).not.toHaveBeenCalled();
  });

  it('transfer gagal SESUDAH broadcast beli → ResellerPostBuyError (USDC sudah keluar)', async () => {
    treasury.transferCoreAssetToBuyer.mockRejectedValue(new Error('rpc down'));

    const err = await service
      .settle({
        nftAddress: NFT,
        buyerWallet: BUYER,
        maxPriceUsdcBaseUnits: 100_000_000,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResellerPostBuyError);
    expect((err as ResellerPostBuyError).buySignature).toBe('BUYSIG');
    // Broadcast beli SUDAH terjadi (uang keluar) — inilah kenapa ini bukan refund biasa.
    expect(buyClient.broadcast).toHaveBeenCalledTimes(1);
  });

  it('broadcast beli GAGAL → ResellerPostBuyError (INDETERMINATE; tx mungkin sudah landing)', async () => {
    // Timeout/5xx SETELAH CC menyiarkan tx = USDC mungkin sudah keluar → JANGAN diperlakukan
    // sebagai pre-buy (refund). Harus ResellerPostBuyError supaya pemanggil tidak auto-refund.
    buyClient.broadcast.mockRejectedValue(new Error('timeout 30000ms'));

    const err = await service
      .settle({
        nftAddress: NFT,
        buyerWallet: BUYER,
        maxPriceUsdcBaseUnits: 100_000_000,
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResellerPostBuyError);
    expect(buyClient.broadcast).toHaveBeenCalledTimes(1);
    // Transfer TIDAK dijalankan (broadcast gagal duluan).
    expect(treasury.transferCoreAssetToBuyer).not.toHaveBeenCalled();
  });

  it('kartu dijual di marketplace lain (bukan CC) → tolak sebelum beli', async () => {
    marketClient.browse.mockResolvedValue(browseCard({ marketplace: 'MAGICEDEN' }));

    await expect(
      service.settle({
        nftAddress: NFT,
        buyerWallet: BUYER,
        maxPriceUsdcBaseUnits: 100_000_000,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(buyClient.buildBuyTx).not.toHaveBeenCalled();
  });
});
