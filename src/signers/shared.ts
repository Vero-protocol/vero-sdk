import { VeroError, VeroErrorCode } from '../errors';

export function assertNetwork(expected: string, actual: string): void {
  if (actual !== expected) {
    throw new VeroError(
      VeroErrorCode.NetworkMismatch,
      'Wallet network does not match the transaction network',
    );
  }
}

export function unavailable(wallet: string): VeroError {
  return new VeroError(VeroErrorCode.WalletUnavailable, `${wallet} wallet is not available`);
}
