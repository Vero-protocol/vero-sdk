/**
 * Nonce/sequence management for Stellar transactions.
 *
 * Stellar uses sequence numbers to prevent replay attacks. Each account has a
 * monotonically-increasing sequence number; each transaction must use the next
 * number, and the network rejects stale or reused sequences.
 *
 * This module provides utilities for managing sequence reservations, particularly
 * the ability to release a sequence that was reserved but never submitted to the
 * network (e.g., due to a network error, timeout, or user rejection).
 *
 * See vero-core-engine#181 for the motivation: reserved sequences whose
 * transactions fail to submit are currently leaked, permanently desyncing the
 * account sequence cache.
 */

import { VeroError, VeroErrorCode } from '../errors';

/**
 * A reserved sequence number for an account.
 */
export interface SequenceReservation {
  /** The Stellar account address. */
  account: string;
  /** The reserved sequence number. */
  sequence: bigint;
}

/**
 * In-memory pool of reserved sequences per account.
 *
 * In a production system, this would be backed by a persistent store with
 * proper locking. For this SDK, we provide the interface without enforcing
 * persistence — the caller is responsible for storage and coordination.
 */
class SequencePool {
  private readonly reservations = new Map<string, Set<bigint>>();

  /** Reserve a sequence for an account. */
  reserve(account: string, sequence: bigint): void {
    let accountSet = this.reservations.get(account);
    if (!accountSet) {
      accountSet = new Set();
      this.reservations.set(account, accountSet);
    }
    accountSet.add(sequence);
  }

  /** Release a sequence back to the pool. */
  release(account: string, sequence: bigint): void {
    const accountSet = this.reservations.get(account);
    if (!accountSet || accountSet.size === 0) {
      throw new VeroError(
        VeroErrorCode.BadSequence,
        `No reservations found for account ${account}`,
      );
    }

    if (!accountSet.has(sequence)) {
      throw new VeroError(
        VeroErrorCode.BadSequence,
        `Sequence ${sequence} was not reserved for account ${account}`,
      );
    }

    accountSet.delete(sequence);

    // Clean up empty sets to avoid memory leaks
    if (accountSet.size === 0) {
      this.reservations.delete(account);
    }
  }

  /** Check if a sequence is currently reserved. */
  isReserved(account: string, sequence: bigint): boolean {
    const accountSet = this.reservations.get(account);
    return accountSet?.has(sequence) ?? false;
  }

  /** Reset all reservations (for testing). */
  reset(): void {
    this.reservations.clear();
  }
}

/**
 * Global sequence pool instance.
 *
 * In a real deployment, this would be replaced with a persistent, distributed
 * store. For SDK purposes, we provide a simple in-memory implementation.
 */
const globalPool = new SequencePool();

/**
 * Reset the global sequence pool.
 *
 * This is primarily intended for testing. In production, you would not
 * reset the pool as it would lose all active reservations.
 *
 * @internal
 */
export function _resetPoolForTesting(): void {
  // Access the private reservations map through the pool instance
  // We need to add a public method to SequencePool for this
  (globalPool as SequencePool & { reset: () => void }).reset();
}

/**
 * Release a reserved sequence number back to the pool.
 *
 * **IMPORTANT**: This function is only valid for sequences that were reserved
 * but never actually submitted to the network. Once a transaction reaches the
 * network, the sequence is consumed and cannot be reused — attempting to do so
 * will result in a `BAD_SEQUENCE` error from the network.
 *
 * Use this when:
 * - A transaction fails to submit due to network error
 * - A transaction times out before reaching the network
 * - A user rejects a signature prompt before submission
 *
 * Do NOT use this when:
 * - A transaction was submitted but failed for other reasons
 * - A transaction was submitted and is pending confirmation
 *
 * @param account The Stellar account address.
 * @param sequence The sequence number to release.
 * @throws {VeroError} If the sequence was not reserved or the account has no reservations.
 */
export function release(account: string, sequence: bigint): void {
  globalPool.release(account, sequence);
}

/**
 * Reserve a sequence number for an account.
 *
 * This is typically called internally by transaction builders. Public exposure
 * allows callers to implement custom reservation patterns.
 *
 * @param account The Stellar account address.
 * @param sequence The sequence number to reserve.
 */
export function reserve(account: string, sequence: bigint): void {
  globalPool.reserve(account, sequence);
}

/**
 * Execute a callback with automatic sequence reservation and cleanup.
 *
 * This helper reserves a sequence, runs the provided callback, and automatically
 * releases the sequence if the callback throws. If the callback succeeds, the
 * sequence remains reserved (assuming it was successfully submitted to the network).
 *
 * @param account The Stellar account address.
 * @param sequence The sequence number to reserve.
 * @param fn The callback to execute. If it throws, the sequence is released.
 * @returns The return value of the callback.
 * @throws Any error thrown by the callback (after releasing the sequence).
 *
 * @example
 * ```ts
 * try {
 *   await withReservation(account, sequence, async () => {
 *     const tx = await buildTransaction(account, sequence);
 *     await submitToNetwork(tx);
 *   });
 *   // If we reach here, the transaction was submitted successfully.
 *   // The sequence remains reserved and will be consumed.
 * } catch (err) {
 *   // If submission failed (network error, timeout, user rejection),
 *   // the sequence has been automatically released and can be reused.
 * }
 * ```
 */
export async function withReservation<T>(
  account: string,
  sequence: bigint,
  fn: () => Promise<T>,
): Promise<T> {
  reserve(account, sequence);

  try {
    return await fn();
  } catch (err) {
    // Release the sequence on any error — the transaction never reached the network
    try {
      release(account, sequence);
    } catch {
      // If release fails, we suppress it to avoid masking the original error
      // This shouldn't happen if we just reserved it, but we handle it defensively
    }
    throw err;
  }
  // If fn succeeds, we keep the sequence reserved — it was likely submitted
}

/**
 * Check if a sequence is currently reserved.
 *
 * Useful for debugging and diagnostics.
 *
 * @param account The Stellar account address.
 * @param sequence The sequence number to check.
 * @returns true if the sequence is reserved, false otherwise.
 */
export function isReserved(account: string, sequence: bigint): boolean {
  return globalPool.isReserved(account, sequence);
}
