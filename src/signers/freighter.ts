import { normalizeError, VeroErrorCode } from '../errors';
import { assertNetwork, unavailable } from './shared';
import type { Signer, SignTransactionRequest } from './types';

export interface FreighterApi {
  getAddress(): Promise<{ address: string; error?: string }>;
  getNetworkDetails(): Promise<{ networkPassphrase: string; error?: string }>;
  signTransaction(
    transactionXdr: string,
    options: { networkPassphrase: string },
  ): Promise<{ signedTxXdr: string; error?: string }>;
}

function globalFreighter(): FreighterApi | undefined {
  return (globalThis as typeof globalThis & { freighterApi?: FreighterApi }).freighterApi;
}

/** Browser signer backed by the Freighter extension. */
export class FreighterSigner implements Signer {
  readonly #api?: FreighterApi;

  constructor(api: FreighterApi | undefined = globalFreighter()) {
    this.#api = api;
  }

  async getPublicKey(): Promise<string> {
    const api = this.#api;
    if (!api) throw unavailable('Freighter');
    try {
      const result = await api.getAddress();
      if (result.error) throw new Error(result.error);
      return result.address;
    } catch (error) {
      throw normalizeError(error, VeroErrorCode.Unknown);
    }
  }

  async signTransaction(request: SignTransactionRequest): Promise<string> {
    const api = this.#api;
    if (!api) throw unavailable('Freighter');
    try {
      const network = await api.getNetworkDetails();
      if (network.error) throw new Error(network.error);
      assertNetwork(request.networkPassphrase, network.networkPassphrase);
      const result = await api.signTransaction(request.transactionXdr, {
        networkPassphrase: request.networkPassphrase,
      });
      if (result.error) throw new Error(result.error);
      return result.signedTxXdr;
    } catch (error) {
      throw normalizeError(error, VeroErrorCode.Unknown);
    }
  }
}
