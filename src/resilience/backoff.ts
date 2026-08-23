import { VeroError, VeroErrorCode } from '../errors';

export interface RetryOptions {
  /**
   * Maximum number of retry attempts (excluding the initial attempt).
   * @default 3
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds.
   * @default 100
   */
  baseDelayMs?: number;
  /**
   * Maximum delay in milliseconds between retries.
   * @default 10000
   */
  maxDelayMs?: number;
  /**
   * Predicate to determine if an error is retryable.
   * Defaults to retrying transport errors (e.g., timeouts, all endpoints failed, network errors).
   */
  isRetryable?: (err: unknown) => boolean;
  /**
   * AbortSignal to cancel mid-retry.
   */
  signal?: AbortSignal;
}

/**
 * Default predicate for retryable errors.
 * Retries network-level and transport-related errors, but skips caller cancellations.
 */
export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof VeroError) {
    return (
      err.code === VeroErrorCode.RpcTimeout ||
      err.code === VeroErrorCode.AllEndpointsFailed
    );
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') {
      return false; // Explicit cancellation should not be retried
    }
    // Consider typical native errors (like fetch's TypeError on network failure) as transport errors
    return true;
  }
  return false;
}

/**
 * Execute a function with jittered exponential backoff.
 * 
 * @param fn The async function to execute.
 * @param opts Options configuring the backoff behavior.
 * @returns The resolved value of `fn`.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 100;
  const maxDelayMs = opts.maxDelayMs ?? 10000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const signal = opts.signal;

  let attempt = 0;

  while (true) {
    if (signal?.aborted) {
      throw signal.reason;
    }

    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }

      attempt++;

      // Exponential delay: baseDelay * 2^(attempt - 1)
      const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
      // Full jitter: random between 0 and the exponential delay
      const jitteredDelay = Math.random() * exponentialDelay;
      // Cap at max delay
      const delayMs = Math.min(jitteredDelay, maxDelayMs);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }, delayMs);

        const onAbort = () => {
          clearTimeout(timeout);
          signal?.removeEventListener('abort', onAbort);
          reject(signal?.reason ?? new Error('Aborted'));
        };

        if (signal) {
          signal.addEventListener('abort', onAbort);
        }
      });
    }
  }
}
