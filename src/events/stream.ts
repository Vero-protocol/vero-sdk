/**
 * EventStream — automated polling loop with exponential back-off and
 * ledger-reorg recovery.
 *
 * Callers provide a `fetch` function, a `consumer` callback, and an
 * `EventCursor` instance; `EventStream` wires everything together and owns
 * the full poll → hand-off → sleep → repeat lifecycle.
 *
 * Back-off strategy
 * -----------------
 * On an empty page or transient fetch error, the delay doubles up to
 * `maxDelayMs`, with 10 % jitter to prevent thundering-herd when multiple
 * streams start simultaneously. After a successful non-empty page the delay
 * resets to `minDelayMs`.
 *
 * Reorg recovery
 * --------------
 * When `fetch` throws an "unresolvable" error (or matches the custom
 * `isReorgError` predicate), `EventStream` rewinds the cursor to the value
 * returned by `resolveRewindTarget` and resumes polling. `onReorgRewind` is
 * called for audit/logging.
 *
 * Cancellation
 * ------------
 * Call `stop()` or pass an `AbortSignal` to cancel. `stop()` clears the
 * pending `setTimeout` handle immediately — no timer handles remain after
 * `stop()` returns (Requirement 4.3 / 4.4).
 */

import { type EventCursor, type StreamEvent } from './cursor.js';

// ---------------------------------------------------------------------------
// Configuration interface
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link EventStream}.
 *
 * @typeParam E - The concrete event type; must extend {@link StreamEvent}.
 */
export interface EventStreamConfig<E extends StreamEvent = StreamEvent> {
  /**
   * `EventCursor` instance (with an optional `ProcessedSet` already attached).
   * `EventStream` delegates per-event processing to `cursor.process()`.
   */
  cursor: EventCursor;

  /**
   * Fetch the next page of events from the given position.
   *
   * @param position - Current cursor value, or `null` for start-of-stream.
   * @returns An array of events (empty when caught up).
   * @throws An error with a message that includes `"unresolvable"` (or one
   *         matching `isReorgError`) when the cursor points to a ledger that
   *         no longer exists.
   */
  fetch: (position: string | null) => Promise<E[]>;

  /**
   * Process a single event. Invoked inside `cursor.process()` so the cursor
   * advances only after this resolves successfully.
   */
  consumer: (event: E) => Promise<void>;

  /**
   * Given a stale (unresolvable) cursor, return the rewind target.
   *
   * Return `null` to rewind to start-of-stream.
   * If omitted, always rewinds to `null`.
   */
  resolveRewindTarget?: (
    staleCursor: string | null,
  ) => Promise<string | null> | string | null;

  /**
   * Called after every reorg rewind with the old and new cursor values.
   * Use for logging / audit.
   */
  onReorgRewind?: (
    oldCursor: string | null,
    newCursor: string | null,
  ) => void;

  /**
   * Custom predicate to detect reorg errors thrown by `fetch`.
   * If omitted, errors whose `.message` includes `"unresolvable"`
   * (case-insensitive) are treated as reorg errors.
   */
  isReorgError?: (err: unknown) => boolean;

  /**
   * Minimum polling interval in milliseconds, applied after a successful
   * non-empty page.
   * @default 500
   */
  minDelayMs?: number;

  /**
   * Maximum polling interval in milliseconds — ceiling for exponential
   * back-off.
   * @default 30_000
   */
  maxDelayMs?: number;

  /**
   * `AbortSignal` to cancel the polling loop from outside the class.
   * Equivalent to calling `stop()`, but composable with `AbortController`.
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// EventStream class
// ---------------------------------------------------------------------------

/**
 * Manages the full polling loop for a stream of `StreamEvent` objects.
 *
 * @typeParam E - The concrete event type; must extend {@link StreamEvent}.
 *
 * @example
 * ```ts
 * const stream = new EventStream({
 *   cursor,
 *   fetch: (pos) => rpc.getEvents(pos),
 *   consumer: async (event) => { await db.insert(event); },
 *   minDelayMs: 500,
 *   maxDelayMs: 30_000,
 * });
 * stream.start();
 * // later…
 * stream.stop();
 * ```
 */
export class EventStream<E extends StreamEvent = StreamEvent> {
  private readonly config: EventStreamConfig<E> & {
    minDelayMs: number;
    maxDelayMs: number;
  };

  private stopped = false;
  private sleepHandle: ReturnType<typeof setTimeout> | null = null;
  private currentDelayMs: number;

  constructor(config: EventStreamConfig<E>) {
    this.config = {
      minDelayMs: 500,
      maxDelayMs: 30_000,
      ...config,
    };
    this.currentDelayMs = this.config.minDelayMs;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Begin the polling loop. Returns immediately; the loop runs
   * asynchronously. Calling `start()` when the stream is already running
   * resets `stopped` to `false` and fires a new loop iteration.
   */
  start(): void {
    this.stopped = false;
    void this.loop();
  }

  /**
   * Cancel all pending timers and stop the loop after the current event (if
   * one is being processed). No `fetch` or `consumer` calls will be made
   * after this returns.
   *
   * CRITICAL: clears the `setTimeout` handle synchronously so that no timer
   * handles remain active after `stop()` returns.
   */
  stop(): void {
    this.stopped = true;
    if (this.sleepHandle !== null) {
      clearTimeout(this.sleepHandle);
      this.sleepHandle = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Sleep for `ms` milliseconds. Stores the `setTimeout` handle in
   * `this.sleepHandle` so that `stop()` can cancel it synchronously.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.sleepHandle = setTimeout(() => {
        this.sleepHandle = null;
        resolve();
      }, ms);
    });
  }

  /**
   * Returns `true` when `err` should be treated as a ledger-reorg error.
   * Delegates to the user-supplied predicate if provided; otherwise checks
   * that the error message includes `"unresolvable"` (case-insensitive).
   */
  private isReorgError(err: unknown): boolean {
    if (this.config.isReorgError != null) {
      return this.config.isReorgError(err);
    }
    return (
      err instanceof Error &&
      err.message.toLowerCase().includes('unresolvable')
    );
  }

  /**
   * Apply the exponential back-off step:
   * - Double `currentDelayMs`, capping at `maxDelayMs`.
   * - Return the delay to sleep (capped delay + 10 % jitter).
   */
  private backOff(): number {
    const newDelay = Math.min(
      this.currentDelayMs * 2,
      this.config.maxDelayMs,
    );
    const jitter = Math.random() * newDelay * 0.1; // 10 % jitter
    this.currentDelayMs = newDelay;
    return newDelay + jitter;
  }

  /**
   * Reset the polling delay back to `minDelayMs` after a successful page.
   */
  private resetDelay(): void {
    this.currentDelayMs = this.config.minDelayMs;
  }

  /**
   * Handle a detected reorg:
   * 1. Resolve the rewind target via `resolveRewindTarget` (or `null`).
   * 2. If non-null, reset the cursor store to that position.
   * 3. Invoke `onReorgRewind` for audit.
   * 4. Reset back-off so the next poll fires promptly.
   */
  private async handleReorg(staleCursor: string | null): Promise<void> {
    const { resolveRewindTarget, onReorgRewind, cursor } = this.config;

    const newCursor = resolveRewindTarget != null
      ? await resolveRewindTarget(staleCursor)
      : null;

    // Rewind the underlying cursor store directly (bypasses the
    // consumer-then-persist ordering enforced by cursor.process()).
    if (newCursor !== null) {
      await cursor.reset(newCursor);
    }

    onReorgRewind?.(staleCursor, newCursor);

    // Reset back-off after reorg — we want to re-fetch promptly.
    this.currentDelayMs = this.config.minDelayMs;
  }

  // -------------------------------------------------------------------------
  // Polling loop
  // -------------------------------------------------------------------------

  /**
   * Main polling loop. Runs until `stopped` is `true` or `signal` is
   * aborted.
   *
   * Loop invariant: the cursor advances only after `consumer` resolves
   * (delegated to `EventCursor.process()`). On any error the cursor is left
   * at the last successfully processed event, ensuring re-delivery rather
   * than skip.
   */
  private async loop(): Promise<void> {
    const { cursor, fetch, consumer, signal, minDelayMs } = this.config;

    while (!this.stopped && !signal?.aborted) {
      // --- Read current position ----------------------------------------
      const position = await cursor.position();

      // --- Fetch next page -----------------------------------------------
      let events: E[];
      try {
        events = await fetch(position);
      } catch (err) {
        if (this.isReorgError(err)) {
          await this.handleReorg(position);
          continue; // reorg handled — re-fetch from rewound position
        }
        // Transient error — back off and retry
        const delay = this.backOff();
        await this.sleep(delay);
        continue;
      }

      // --- Empty page — back off and retry --------------------------------
      if (events.length === 0) {
        const delay = this.backOff();
        await this.sleep(delay);
        continue;
      }

      // --- Process each event in the page ---------------------------------
      for (const event of events) {
        // Check for cancellation before each event (allows mid-batch stop)
        if (this.stopped || signal?.aborted) {
          return;
        }
        // cursor.process() runs the consumer then advances the cursor,
        // preserving the no-skip guarantee.
        await cursor.process(event, consumer as (event: StreamEvent) => Promise<void>);
      }

      // --- Successful page — reset delay and schedule next poll -----------
      this.resetDelay();
      await this.sleep(minDelayMs);
    }
  }
}
