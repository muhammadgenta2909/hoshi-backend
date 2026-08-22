import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/jwt.strategy';
import { RedemptionController } from './redemption.controller';
import type { RedemptionService } from './redemption.service';

// RedemptionController → RedemptionService → CcShippingService → TreasuryService menarik
// @solana/web3.js (rantai ESM yang bikin jest gagal parse). Kita cuma menguji guard di
// controller, jadi mock @solana/web3.js — sama seperti cc-shipping.service.spec.ts.
jest.mock('@solana/web3.js', () => ({
  Keypair: class Keypair {},
  Transaction: class Transaction {},
  VersionedTransaction: class VersionedTransaction {},
  PublicKey: class PublicKey {
    constructor(readonly value: string) {}
  },
  clusterApiUrl: () => 'http://localhost:8899',
}));

describe('RedemptionController — SIWS wallet-match guard', () => {
  const user: AuthUser = {
    id: 'user-1',
    walletAddress: 'HoshiUserWalletBase58',
    displayName: null,
    role: 'USER',
  };

  const make = (): {
    controller: RedemptionController;
    service: { siwsNonce: jest.Mock };
  } => {
    const service = {
      siwsNonce: jest
        .fn()
        .mockResolvedValue({ nonce: 'n', expiresAt: 1, message: 'm' }),
      siwsVerify: jest.fn(),
      siwsRefresh: jest.fn(),
    };
    const controller = new RedemptionController(
      service as unknown as RedemptionService,
    );
    return { controller, service };
  };

  it('rejects SIWS for a wallet that is not the logged-in user (403) without calling the service', () => {
    const { controller, service } = make();

    expect(() =>
      controller.siwsNonce({ wallet: 'SomeoneElseWallet' }, user),
    ).toThrow(ForbiddenException);
    expect(service.siwsNonce).not.toHaveBeenCalled();
  });

  it('allows a user to SIWS their OWN wallet and delegates to the service', async () => {
    const { controller, service } = make();

    await controller.siwsNonce({ wallet: user.walletAddress }, user);

    expect(service.siwsNonce).toHaveBeenCalledWith(user.walletAddress);
  });
});
