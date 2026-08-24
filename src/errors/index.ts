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
  /**
   * @cause     The endpoint URL provided in configuration fails validation —
   *            the scheme is not `https://` (or explicitly opted-in `http://`
   *            for localhost), or the string is unparseable as a URL.
   * @retryable NO — the URL is invalid and retrying with the same value will
   *            always fail.
   * @handling Correct the URL in your configuration. Verify the scheme is
   *           `https://` and the host is reachable before retrying.
   */
  InvalidUrl = 'INVALID_URL',

  /**
   * @cause     Every RPC endpoint configured in the `RpcClient` either
   *            returned a transport-level error, timed out, or was already
   *            quarantined as unhealthy.
   * @retryable CONDITIONAL — safe to retry only after at least one endpoint
   *            has recovered; check `rpc.health()` to confirm an endpoint is
   *            back before attempting again.
   * @handling Inspect `rpc.health()` to see which endpoints are healthy. If
   *           all are down, wait for recovery or add additional backup
   *           endpoints.
   */
  AllEndpointsFailed = 'ALL_ENDPOINTS_FAILED',

  /**
   * @cause     A single RPC request returned a non-success HTTP status or a
   *            malformed response body. This is a request-level failure, not
   *            a transport-level one.
   * @retryable CONDITIONAL — retry only if the error is clearly transient
   *            (e.g. HTTP 429 rate-limit, HTTP 5xx). Do NOT retry on HTTP
   *            4xx client errors — fix the request payload first.
   * @handling Inspect the HTTP status code in the error. For 4xx errors,
   *           review the request parameters. For 5xx or 429, retry with
   *           exponential backoff.
   */
  RpcRequestFailed = 'RPC_REQUEST_FAILED',

  /**
   * @cause     The RPC request did not receive a response within the
   *            configured `timeoutMs` window. This is typically caused by
   *            network congestion or a slow ledger close.
   * @retryable YES — timeouts are transient; safe to retry immediately or
   *            with a short backoff.
   * @handling Retry the request. Consider increasing `timeoutMs` if timeouts
   *           are frequent, as the network may be under load.
   */
  RpcTimeout = 'RPC_TIMEOUT',

  /**
   * @cause     The Stellar account queried does not exist on the specified
   *            network. The account has not been funded or created.
   * @retryable NO — the account must be created and funded on-chain before
   *            any lookup will succeed.
   * @handling Fund or create the account on the target network before
   *           retrying. Verify the network passphrase matches the account's
   *           actual network.
   */
  AccountNotFound = 'ACCOUNT_NOT_FOUND',

  /**
   * @cause     The user explicitly declined or cancelled the signature prompt
   *            in their wallet extension (Freighter, Rabet, etc.).
   * @retryable NO — retrying immediately will prompt the user again and they
   *            will likely decline again. This is a user-intent signal, not a
   *            transient error.
   * @handling Surface the cancellation to the user and let them re-initiate
   *           the action when ready.
   */
  UserRejected = 'USER_REJECTED',

  /**
   * @cause     No browser wallet extension (Freighter, Rabet, etc.) was
   *            detected in the current environment. The wallet may not be
   *            installed, or the page is loaded in an unsupported context
   *            (e.g. incognito, iframe without proper permissions).
   * @retryable CONDITIONAL — safe to retry only after the user has installed
   *            or enabled the wallet extension.
   * @handling Prompt the user to install the required wallet extension and
   *           reload the page. Do not retry until the wallet is confirmed
   *           available.
   */
  WalletUnavailable = 'WALLET_UNAVAILABLE',

  /**
   * @cause     The Stellar network rejected the submitted transaction. This
   *            covers Soroban-specific failures (contract errors, resource
   *            limits) as well as classic transaction errors (insufficient
   *            fees, missing signers).
   * @retryable NO — retrying without inspecting the result risks
   *            double-submitting a transaction that may have partially
   *            succeeded on-chain. Inspect the `TransactionResult` first.
   * @handling Decode the transaction result XDR to determine the specific
   *           failure reason. Adjust the transaction parameters (fees,
   *           signers, contract args) before resubmitting.
   */
  TransactionFailed = 'TRANSACTION_FAILED',

  /**
   * @cause     The transaction's sequence number does not match the account's
   *            current on-chain sequence. Another transaction was likely
   *            submitted since this one was built, consuming the sequence.
   * @retryable CONDITIONAL — safe to retry only after fetching a fresh
   *            sequence number from the network and rebuilding the
   *            transaction.
   * @handling Re-read the account's current sequence number, rebuild the
   *           transaction, and resubmit. This typically indicates a
   *           concurrent submission or a stale cached sequence.
   */
  BadSequence = 'BAD_SEQUENCE',

  /**
   * @cause     The error does not match any known SDK error shape. This is a
   *            catch-all for unexpected failures from wallet adapters, RPC
   *            endpoints, or runtime exceptions.
   * @retryable NO — without knowing the root cause, retrying is unsafe.
   *            Inspect the error message and underlying `cause` to diagnose.
   * @handling Log the full error including the `cause` property. Investigate
   *           whether the failure is from the wallet, RPC layer, or your
   *           application code before deciding on a recovery strategy.
   */
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
