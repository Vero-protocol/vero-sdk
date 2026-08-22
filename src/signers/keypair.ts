import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { normalizeError, VeroErrorCode } from '../errors';
import type { Signer, SignTransactionRequest } from './types';

/** Server-side signer whose secret is held only inside an ECMAScript private field. */
export class KeypairSigner implements Signer {
  readonly #keypair: Keypair;

  constructor(secret: string) {
    try {
      this.#keypair = Keypair.fromSecret(secret);
    } catch {
      // Do not retain the input or attach an SDK error that might echo it.
      throw normalizeError(new Error('Invalid Stellar secret key'), VeroErrorCode.Unknown);
    }
  }

  async getPublicKey(): Promise<string> {
    return this.#keypair.publicKey();
  }

  async signTransaction(request: SignTransactionRequest): Promise<string> {
    try {
      const transaction = TransactionBuilder.fromXDR(
        request.transactionXdr,
        request.networkPassphrase,
      );
      transaction.sign(this.#keypair);
      return transaction.toXDR();
    } catch {
      // Deliberately omit the cause: dependency errors must never capture secret state.
      throw normalizeError(new Error('Unable to sign Stellar transaction'), VeroErrorCode.Unknown);
    }
  }

  toString(): string {
    return '[KeypairSigner REDACTED]';
  }

  toJSON(): { type: string; secret: string } {
    return { type: 'KeypairSigner', secret: '[REDACTED]' };
  }
}
