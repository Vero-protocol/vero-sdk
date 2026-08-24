/** Input shared by every transaction signer. */
export interface SignTransactionRequest {
  /** Base64-encoded Stellar transaction envelope XDR. */
  transactionXdr: string;
  /** Stellar network passphrase the transaction was built for. */
  networkPassphrase: string;
}

/** A wallet or server-side identity capable of signing Stellar transactions. */
export interface Signer {
  getPublicKey(): Promise<string>;
  signTransaction(request: SignTransactionRequest): Promise<string>;
}
