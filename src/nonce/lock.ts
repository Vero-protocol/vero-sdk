/**
 * Per-account async mutex for nonce reservation.
 *
 * Addresses the check-then-act race documented in:
 *   - vero-core-engine#164  (reserve() race)
 *   - vero-core-engine#183  (refresh() bypasses the per-account lock)
 *   - vero-relayer-service#198 (cached sequence inside the lock)
 *
 * Design goals:
 *   - Keys are arbitrary strings (Stellar public keys in practice).
 *   - Different keys run in parallel; the same key serialises callers FIFO.
 *   - The lock is always released, even when the callback throws.
 *   - An optional acquisition timeout rejects with a VeroError rather than
 *     hanging forever, without leaving the lock held for the next waiter.
 */

import { VeroError, VeroErrorCode } from '../errors/index.js';

interface Waiter {
  resolve: () => void;
  reject: (err: VeroError) => void;
}

/**
 * Minimal FIFO async mutex keyed by an arbitrary string.
 *
 * Each key maintains its own independent queue, so different accounts never
 * block each other while the same account's reservations are serialised.
 */
export class AccountLockManager {
  /** Maps account key → FIFO queue of waiters. Absent entry = unlocked. */
  private readonly locked = new Map<string, Waiter[]>();

  /**
   * Acquire the lock for `key`, run `fn`, then release — guaranteed.
   *
   * @param key       Arbitrary string identifying the exclusive resource.
   * @param fn        Async (or sync) callback to run while the lock is held.
   * @param timeoutMs Optional maximum time to wait for acquisition.
   *                  Resolves immediately if the lock is free; only starts
   *                  counting once the lock is contended.
   * @returns         Whatever `fn` returns.
   * @throws          VeroError(RPC_TIMEOUT) if acquisition exceeds `timeoutMs`.
   */
  async withLock<T>(key: string, fn: () => T | Promise<T>, timeoutMs?: number): Promise<T> {
    await this.acquire(key, timeoutMs);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /**
   * Acquire the lock for `key`.
   *
   * If the key is free the call returns synchronously (within the microtask
   * queue). Otherwise the caller is enqueued and awaits its turn.
   */
  private acquire(key: string, timeoutMs?: number): Promise<void> {
    const queue = this.locked.get(key);

    if (queue === undefined) {
      // Lock is free — claim it by creating an empty queue.
      this.locked.set(key, []);
      return Promise.resolve();
    }

    // Lock is held — enqueue this caller and wait.
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      queue.push(waiter);

      if (timeoutMs !== undefined && timeoutMs >= 0) {
        const timer = setTimeout(() => {
          // Remove this waiter from the queue so it does not hold the lock
          // once the timeout fires.
          const currentQueue = this.locked.get(key);
          if (currentQueue) {
            const idx = currentQueue.indexOf(waiter);
            if (idx !== -1) currentQueue.splice(idx, 1);
          }
          reject(
            new VeroError(
              VeroErrorCode.RpcTimeout,
              `Timed out waiting for account lock on key "${key}" after ${timeoutMs} ms`,
            ),
          );
        }, timeoutMs);

        // Replace the resolve so we clear the timer on success.
        waiter.resolve = () => {
          clearTimeout(timer);
          resolve();
        };
      }
    });
  }

  /**
   * Release the lock for `key` and wake the next waiter, if any.
   */
  private release(key: string): void {
    const queue = this.locked.get(key);
    if (!queue) return; // Should never happen, but be defensive.

    const next = queue.shift();
    if (next) {
      // Hand the lock directly to the next waiter.
      next.resolve();
    } else {
      // No waiters — remove the key entirely to indicate the lock is free.
      this.locked.delete(key);
    }
  }

  /**
   * Whether the lock for `key` is currently held.
   * Intended for testing only.
   */
  isLocked(key: string): boolean {
    return this.locked.has(key);
  }
}
