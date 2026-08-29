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

import { type ProcessedSet } from './processed-set.js';

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
  /**
   * Stable deduplication key. Required when a ProcessedSet is in use;
   * optional for callers that do not need deduplication.
   */
  id?: string;
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
  private readonly processedSet?: ProcessedSet;

  constructor(store: CursorStore, processedSet?: ProcessedSet) {
    this.store = store;
    this.processedSet = processedSet;
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
   * DEDUPLICATION: When a `ProcessedSet` is provided and `event.id` is a
   * non-empty string, the event is skipped (returns `undefined`) if its ID
   * is already in the set. The ID is added to the set only after both the
   * consumer resolves AND the cursor write succeeds. This ordering ensures
   * that a crash between steps can only cause safe re-delivery, never a
   * silent skip.
   *
   * Do NOT move cursor persistence before the consumer call — the regression
   * test in `src/__tests__/events.test.ts` fails if you do.
   * Do NOT move processedSet.add before store.set — that would recreate the
   * vero-core-engine#179 bug pattern for the deduplication path.
   *
   * @returns Whatever the consumer returned, or `undefined` if the event was
   *          skipped due to deduplication.
   * @throws Whatever the consumer threw (cursor untouched, id not added), or
   *         any error from persisting the cursor (consumer already ran; the
   *         event may be re-delivered, which is safe).
   */
  async process<T>(
    event: StreamEvent,
    consumer: (event: StreamEvent) => T | Promise<T>,
  ): Promise<T | undefined> {
    // 1. Deduplication check — skip if already processed
    if (this.processedSet != null && event.id) {
      if (await this.processedSet.has(event.id)) {
        return undefined;
      }
    }

    // 2. Consumer (throws → cursor untouched, id not added)
    const result = await consumer(event);

    // 3. Persist cursor (throws → id not added; event may re-deliver)
    await this.store.set(event.cursor);

    // 4. Record as processed — ONLY after store.set succeeds
    //    (add after store.set, not before — reversing this order recreates
    //    the vero-core-engine#179 silent-skip bug on the dedup path)
    if (this.processedSet != null && event.id) {
      await this.processedSet.add(event.id);
    }

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
      results.push(await this.process(event, consumer) as T);
    }
    return results;
  }

  /**
   * Unconditionally overwrite the persisted cursor to `cursor`.
   *
   * Used by `EventStream` during reorg rewinds. Not part of normal
   * event-processing flow — does not invoke the consumer or touch the
   * `ProcessedSet`.
   *
   * @param cursor - The cursor value to persist.
   */
  async reset(cursor: string): Promise<void> {
    await this.store.set(cursor);
  }
}
