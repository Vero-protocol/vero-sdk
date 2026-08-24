import { normalizeError, VeroErrorCode } from '../errors';
import { assertNetwork, unavailable } from './shared';
import type { Signer, SignTransactionRequest } from './types';

export interface RabetApi {
  connect(): Promise<{ publicKey: string }>;
  getNetwork(): Promise<string | { networkPassphrase: string }>;
  sign(transactionXdr: string, networkPassphrase: string): Promise<string | { xdr: string }>;
}

function globalRabet(): RabetApi | undefined {
  return (globalThis as typeof globalThis & { rabet?: RabetApi }).rabet;
}

/** Browser signer backed by the Rabet extension. */
export class RabetSigner implements Signer {
  readonly #api?: RabetApi;

  constructor(api: RabetApi | undefined = globalRabet()) {
    this.#api = api;
  }

  async getPublicKey(): Promise<string> {
    const api = this.#api;
    if (!api) throw unavailable('Rabet');
    try {
      return (await api.connect()).publicKey;
    } catch (error) {
      throw normalizeError(error, VeroErrorCode.Unknown);
    }
  }

  async signTransaction(request: SignTransactionRequest): Promise<string> {
    const api = this.#api;
    if (!api) throw unavailable('Rabet');
    try {
      const network = await api.getNetwork();
      assertNetwork(
        request.networkPassphrase,
        typeof network === 'string' ? network : network.networkPassphrase,
      );
      const result = await api.sign(request.transactionXdr, request.networkPassphrase);
      return typeof result === 'string' ? result : result.xdr;
    } catch (error) {
      throw normalizeError(error, VeroErrorCode.Unknown);
    }
  }
}
