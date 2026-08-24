/**
 * Cursor-based streaming with a hard no-skip guarantee.
 *
 * Background — vero-core-engine#179: `EventPropagator.fetchAndEnqueue`
 * advanced `this.cursor = raw.id` even when `queue.enqueue()` failed, so any
 * event that failed to enqueue was permanently skipped (only a warning was
 * logged). Because the cursor drives replay-from-last-known on restart, the
 * event was silently lost forever.
 *
 * This module is the shared, tested primitive that makes that bug impossible:
 * the cursor is persisted ONLY after the consumer callback resolves. If the
 * consumer throws, the stored cursor is left exactly where it was, the error
 * propagates, and the next poll re-delivers the failed event.
 *
 * The guarantee is at-least-once delivery: a crash or failure between the
 * consumer running and the cursor write can re-deliver an event, but a
 * success can never be skipped. Re-delivery is always safer than loss.
 */

/** Persistence for the stream cursor. Swap in a file, DB, or KV store. */
export interface CursorStore {
  /** Read the persisted cursor position, or `null` when none exists. */
  get(): Promise<string | null> | string | null;
  /** Persist a new cursor position. */
  set(cursor: string): Promise<void> | void;
}

/** An event in the stream; `cursor` is the position to persist on success. */
export interface StreamEvent {
  /** Opaque position token (e.g. the event's `id`/paging token). */
  cursor: string;
}

/**
 * Cursor-guarded event streaming.
 *
 * Usage: read the persisted position with {@link EventCursor.position}, fetch
 * the next page of events after it, and hand each one to
 * {@link EventCursor.process}. On a thrown consumer error, stop the batch —
 * the cursor is still at the last successfully handled event, so the next run
 * resumes there and nothing is skipped.
 */
export class EventCursor {
  private readonly store: CursorStore;

  constructor(store: CursorStore) {
    this.store = store;
  }

  /** Read the persisted cursor position, or `null` when none exists. */
  async position(): Promise<string | null> {
    return this.store.get();
  }

  /**
   * Run `consumer` for `event`, then persist the cursor — in that order.
   *
   * NO-SKIP CONTRACT (regression guard for vero-core-engine#179):
   * the cursor advances only after the consumer callback resolves
   * successfully. If the consumer throws, the stored cursor is left
   * untouched and the error propagates to the caller, so the event is
   * re-delivered on the next run rather than silently skipped.
   *
   * Do NOT move cursor persistence before the consumer call — the regression
   * test in `src/__tests__/events.test.ts` fails if you do.
   *
   * @returns Whatever the consumer returned.
   * @throws Whatever the consumer threw (cursor untouched), or any error
   *         from persisting the cursor (consumer already ran; the event may
   *         be re-delivered, which is safe).
   */
  async process<T>(
    event: StreamEvent,
    consumer: (event: StreamEvent) => T | Promise<T>,
  ): Promise<T> {
    const result = await consumer(event); // throws → cursor untouched
    await this.store.set(event.cursor); // only after success
    return result;
  }

  /**
   * Stream a batch in order: each event goes through
   * {@link EventCursor.process}, so the cursor advances event-by-event.
   *
   * Processing stops at the first consumer failure and the error propagates.
   * The stored cursor is then at the last successfully handled event — the
   * failed event (and everything after it) is re-delivered on the next run.
   *
   * @returns The consumer results, in event order.
   */
  async consume<T>(
    events: readonly StreamEvent[],
    consumer: (event: StreamEvent) => T | Promise<T>,
  ): Promise<T[]> {
    const results: T[] = [];
    for (const event of events) {
      results.push(await this.process(event, consumer));
    }
    return results;
  }
}
