/**
 * Normalised error handling.
 *
 * Wallet adapters and RPC endpoints each throw their own shapes — Freighter
 * throws differently from Rabet, Horizon differently from Soroban RPC. Callers
 * shouldn't have to care. Everything leaving this SDK is a `VeroError` with a
 * stable `code`.
 */

/** Stable, switchable error codes. Add to this union rather than string-matching messages. */
export enum VeroErrorCode {
  /** Endpoint URL failed validation (bad scheme, unparseable). */
  InvalidUrl = 'INVALID_URL',
  /** Every configured RPC endpoint failed. */
  AllEndpointsFailed = 'ALL_ENDPOINTS_FAILED',
  /** A single RPC request failed. */
  RpcRequestFailed = 'RPC_REQUEST_FAILED',
  /** RPC request exceeded its timeout. */
  RpcTimeout = 'RPC_TIMEOUT',
  /** Account does not exist on the network. */
  AccountNotFound = 'ACCOUNT_NOT_FOUND',
  /** The user declined a signature prompt. */
  UserRejected = 'USER_REJECTED',
  /** No wallet extension detected. */
  WalletUnavailable = 'WALLET_UNAVAILABLE',
  /** The wallet is connected to a different Stellar network. */
  NetworkMismatch = 'NETWORK_MISMATCH',
  /** Transaction rejected by the network. */
  TransactionFailed = 'TRANSACTION_FAILED',
  /** Sequence number was already consumed. */
  BadSequence = 'BAD_SEQUENCE',
  /** Anything not otherwise classified. */
  Unknown = 'UNKNOWN',
}

/** Base error for everything this SDK throws. */
export class VeroError extends Error {
  readonly code: VeroErrorCode;
  /** The original thrown value, when there was one. */
  readonly cause?: unknown;

  constructor(code: VeroErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'VeroError';
    this.code = code;
    this.cause = cause;
    // Required for `instanceof` to work when targeting ES5.
    Object.setPrototypeOf(this, VeroError.prototype);
  }
}

/**
 * Coerce an unknown thrown value into a `VeroError`.
 *
 * Recognises the common wallet and Horizon shapes; anything unfamiliar becomes
 * `Unknown` rather than being swallowed.
 */
export function normalizeError(err: unknown, fallback = VeroErrorCode.Unknown): VeroError {
  if (err instanceof VeroError) return err;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : 'An unknown error occurred';

  const lower = message.toLowerCase();

  // Wallets signal user cancellation in several different ways.
  if (
    lower.includes('user declined') ||
    lower.includes('user rejected') ||
    lower.includes('request was rejected') ||
    lower.includes('denied')
  ) {
    return new VeroError(VeroErrorCode.UserRejected, 'Request was rejected in the wallet', err);
  }

  if (lower.includes('tx_bad_seq') || lower.includes('bad sequence')) {
    return new VeroError(
      VeroErrorCode.BadSequence,
      'Transaction used a stale sequence number',
      err,
    );
  }

  if (lower.includes('not found') && lower.includes('account')) {
    return new VeroError(VeroErrorCode.AccountNotFound, 'Account not found on this network', err);
  }

  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new VeroError(VeroErrorCode.RpcTimeout, 'Request timed out', err);
  }

  return new VeroError(fallback, message, err);
}
