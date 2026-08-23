/** Fetches the last on-network sequence for an account. */
export interface SequenceFetcher {
  fetchSequence(account: string): Promise<bigint>;
}

/** Configures the sequence source used by NonceManager. */
export interface SequenceReader {
  fetcher: SequenceFetcher;
}

type LegacySequenceReader = (account: string) => Promise<bigint>;

interface AccountState {
  nextSequence?: bigint;
  lock: Promise<void>;
}

/** Coordinates sequence reservations for accounts. */
export class NonceManager {
  private readonly accounts = new Map<string, AccountState>();
  private readonly readSequence: LegacySequenceReader;
  private readonly usesLastSequence: boolean;

  constructor(reader: LegacySequenceReader | SequenceReader) {
    if (typeof reader === 'function') {
      this.readSequence = reader;
      this.usesLastSequence = false;
    } else {
      this.readSequence = (account) => reader.fetcher.fetchSequence(account);
      this.usesLastSequence = true;
    }
  }

  /** Reserve the next sequence number for an account. */
  async reserve(account: string): Promise<bigint> {
    return this.withLock(account, async () => {
      let state = this.accounts.get(account);
      if (!state || state.nextSequence === undefined) {
        const nextSequence = await this.readSequence(account);
        if (!state) {
          state = { lock: Promise.resolve() };
          this.accounts.set(account, state);
        }
        state.nextSequence = this.usesLastSequence ? nextSequence + 1n : nextSequence;
      }

      const sequence = state.nextSequence;
      state.nextSequence += 1n;
      return sequence;
    });
  }

  /**
   * Resynchronize an account with the authoritative network sequence.
   * Reservations made before this refresh are discarded because they may no
   * longer be valid after a failed submission or fee bump.
   */
  async refresh(account: string): Promise<void> {
    await this.withLock(account, async () => {
      const networkSequence = await this.readSequence(account);
      const state = this.accounts.get(account);
      if (state) {
        state.nextSequence = networkSequence + 1n;
      } else {
        this.accounts.set(account, {
          nextSequence: networkSequence + 1n,
          lock: Promise.resolve(),
        });
      }
    });
  }

  /** Return the most recently reserved or refreshed sequence for an account. */
  cached(account: string): bigint | undefined {
    const nextSequence = this.accounts.get(account)?.nextSequence;
    if (nextSequence === undefined) {
      return undefined;
    }

    return this.usesLastSequence ? nextSequence - 1n : nextSequence;
  }

  /** Clear the cached sequence for an account. */
  invalidate(account: string): void {
    this.accounts.delete(account);
  }

  private async withLock<T>(account: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.accounts.get(account)?.lock ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    const state = this.accounts.get(account);
    if (state) {
      state.lock = current;
    } else {
      this.accounts.set(account, { lock: current });
    }

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
/**
 * NonceManager — atomic sequence-number reservation for Stellar accounts.
 *
 * Consolidates three diverging implementations:
 *   - vero-core-engine/engine-bridge/src/nonce-manager.ts
 *   - vero-relayer-service/src/relayer/nonceManager.js
 *   - ad-hoc handling in vero-guardian-dashboard
 *
 * Known bugs in those implementations this class fixes:
 *   - vero-core-engine#164  check-then-act race in reserve()
 *   - vero-core-engine#183  refresh() bypasses the per-account lock
 *   - vero-relayer-service#198  cached sequence served from inside the lock
 */

import { AccountLockManager } from './lock';

/** Minimal interface for fetching the on-chain sequence number of an account. */
export interface SequenceFetcher {
  /**
   * Return the current on-chain sequence number for `account`.
   *
   * The returned value is the *last used* sequence; the next valid transaction
   * sequence is `fetchSequence(account) + 1`.
   */
  fetchSequence(account: string): Promise<bigint>;
}

export interface NonceManagerOptions {
  /** How to fetch the live on-chain sequence number. */
  fetcher: SequenceFetcher;
  /**
   * Maximum time (ms) to wait to acquire the per-account lock.
   * @default undefined (wait indefinitely)
   */
  lockTimeoutMs?: number;
}

/**
 * Thread-safe sequence-number manager.
 *
 * Each account maintains an independent counter that is bumped atomically
 * inside the per-account lock, eliminating the check-then-act race.
 */
export class NonceManager {
  private readonly lock = new AccountLockManager();
  private readonly fetcher: SequenceFetcher;
  private readonly lockTimeoutMs: number | undefined;

  /** Per-account in-memory sequence counters. */
  private readonly sequences = new Map<string, bigint>();

  constructor(opts: NonceManagerOptions) {
    this.fetcher = opts.fetcher;
    this.lockTimeoutMs = opts.lockTimeoutMs;
  }

  /**
   * Reserve the next sequence number for `account`.
   *
   * The read-increment-return is performed atomically inside the per-account
   * lock, so two concurrent callers for the same account always receive
   * distinct, gapless sequence numbers regardless of awaited I/O in between.
   *
   * Callers for *different* accounts do not block each other.
   *
   * @throws {VeroError} RPC_TIMEOUT if lock acquisition exceeds `lockTimeoutMs`.
   */
  async reserve(account: string): Promise<bigint> {
    return this.lock.withLock(
      account,
      async () => {
        let seq = this.sequences.get(account);
        if (seq === undefined) {
          // First reservation — fetch the on-chain baseline.
          // Note: we fetch inside the lock to avoid the cached-sequence race
          // documented in vero-relayer-service#198.
          seq = await this.fetcher.fetchSequence(account);
        }
        const next = seq + 1n;
        this.sequences.set(account, next);
        return next;
      },
      this.lockTimeoutMs,
    );
  }

  /**
   * Refresh the cached sequence for `account` from on-chain state.
   *
   * Must be called when a transaction receives `tx_bad_seq` — the local cache
   * has drifted from the ledger. Acquiring the lock first prevents a concurrent
   * `reserve()` from sneaking through with a stale sequence during the refresh,
   * fixing vero-core-engine#183.
   *
   * @throws {VeroError} RPC_TIMEOUT if lock acquisition exceeds `lockTimeoutMs`.
   */
  async refresh(account: string): Promise<void> {
    await this.lock.withLock(
      account,
      async () => {
        const seq = await this.fetcher.fetchSequence(account);
        this.sequences.set(account, seq);
      },
      this.lockTimeoutMs,
    );
  }

  /**
   * Return the cached sequence for `account`, or `undefined` if no reservation
   * has been made yet. Intended for diagnostics and testing.
   */
  cached(account: string): bigint | undefined {
    return this.sequences.get(account);
  }

  /**
   * Discard the cached sequence for `account`, forcing the next `reserve()` to
   * fetch from the chain. Useful after a known account reset.
   */
  invalidate(account: string): void {
    this.sequences.delete(account);
  }
}
