/**
 * ProcessedSet — deduplication interface and bounded in-memory default.
 *
 * Tracks which event IDs have already been successfully processed so that
 * `EventCursor.process()` can skip re-delivered events without invoking the
 * consumer a second time.
 *
 * The interface is intentionally thin: any backing store (Redis, SQLite,
 * PostgreSQL) can be substituted without touching `EventCursor`.
 */

/**
 * Tracks which event IDs have already been successfully processed.
 *
 * Implementations may be synchronous (in-memory) or asynchronous
 * (database, Redis). `EventCursor` always `await`s both methods.
 */
export interface ProcessedSet {
  /**
   * Returns `true` if the given event ID has previously been added.
   * Must be idempotent and side-effect-free.
   */
  has(eventId: string): Promise<boolean> | boolean;

  /**
   * Records the given event ID as successfully processed.
   * Called only after the consumer AND the cursor write both succeed.
   * Must be idempotent: calling `add` for an already-present ID is a no-op.
   */
  add(eventId: string): Promise<void> | void;
}

/**
 * Bounded in-memory implementation of {@link ProcessedSet}.
 *
 * Uses a `Map<string, null>` for O(1) lookup and insertion. Map preserves
 * insertion order, enabling FIFO eviction: when the store is at capacity the
 * oldest entry (first key) is removed before the new one is inserted.
 *
 * Memory budget (default `maxSize = 10_000`):
 * Each entry is one string + ~2 Map-overhead pointers ≈ 80–120 bytes in V8.
 * Peak footprint at default cap ≈ 1–1.2 MB — well within budget for a
 * long-running Node.js process.
 */
export class InMemoryProcessedSet implements ProcessedSet {
  private readonly store = new Map<string, null>();
  private readonly maxSize: number;

  /**
   * @param maxSize - Maximum number of event IDs to retain in memory.
   *   Must be a positive integer. Defaults to `10_000`.
   * @throws {RangeError} When `maxSize` is not a positive integer.
   */
  constructor(maxSize = 10_000) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(
        `maxSize must be a positive integer, got ${maxSize}`,
      );
    }
    this.maxSize = maxSize;
  }

  /** Returns `true` if the event ID is already in the set. */
  has(eventId: string): boolean {
    return this.store.has(eventId);
  }

  /**
   * Records the event ID as processed.
   *
   * Idempotent: if the ID is already present, returns without evicting or
   * reinserting. When the store is at capacity, the oldest (first-inserted)
   * entry is evicted before the new ID is added (FIFO eviction).
   */
  add(eventId: string): void {
    if (this.store.has(eventId)) return; // idempotent — no eviction on hit

    if (this.store.size >= this.maxSize) {
      // Map preserves insertion order; the first key is the oldest entry.
      // keys().next().value is O(1) amortised via V8's internal linked list.
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }

    this.store.set(eventId, null);
  }
}
