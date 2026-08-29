# Design Document: event-deduplication-stream

## Overview

The `event-deduplication-stream` feature extends `src/events/` with three
capabilities that together make event consumption production-grade:

1. **Deduplication** — a `ProcessedSet` abstraction (with a bounded
   in-memory default) wired into `EventCursor.process()` ensures a consumer
   is never called twice for the same event, even after a crash between the
   consumer succeeding and the cursor write completing.

2. **Automated polling** — a new `EventStream` class owns the full polling
   loop: fetch-next-page → hand events to cursor → back-off → repeat. Callers
   no longer have to build that infrastructure themselves.

3. **Reorg recovery** — when a persisted cursor becomes unresolvable after a
   ledger reorganisation, `EventStream` rewinds to a known-good position and
   resumes, rather than stalling or propagating an unhandled error.

The changes are entirely additive and backward-compatible. All existing
behaviour — the no-skip guarantee from `vero-core-engine#179` — is preserved
without modification.

---

## Architecture

### Component Map

```
┌──────────────────────────────────────────────────────────────────────┐
│  Caller application                                                  │
│                                                                      │
│   const stream = new EventStream({                                   │
│     cursor, fetch, consumer,                                         │
│     resolveRewindTarget, onReorgRewind,                              │
│     minDelayMs, maxDelayMs, signal                                   │
│   });                                                                │
│   stream.start();          // begins polling loop                    │
│   stream.stop();           // graceful shutdown                      │
└───────────────────┬──────────────────────────────────────────────────┘
                    │ owns
                    ▼
┌───────────────────────────────────┐
│  EventStream  (stream.ts)         │
│  ─────────────────────────────── │
│  • polling loop (setTimeout)      │
│  • exponential back-off + jitter  │
│  • reorg detection & rewind       │
│  • AbortSignal / stop() wiring    │
└───────────────────┬───────────────┘
                    │ delegates per-event processing to
                    ▼
┌───────────────────────────────────┐
│  EventCursor  (cursor.ts)         │
│  ─────────────────────────────── │
│  • process(event, consumer)       │
│    1. check processedSet.has()    │
│    2. call consumer               │
│    3. store.set(cursor)           │
│    4. processedSet.add(id)        │
│  • consume(events, consumer)      │
│  • position()                     │
└──────┬─────────────┬──────────────┘
       │             │
       │ reads/writes│ reads/writes
       ▼             ▼
┌────────────┐  ┌──────────────────────────────────┐
│ CursorStore│  │ ProcessedSet  (processed-set.ts)  │
│ (interface)│  │ ──────────────────────────────── │
│  get()     │  │  has(id): Promise<bool>|bool      │
│  set()     │  │  add(id): Promise<void>|void      │
└────────────┘  └──────────┬───────────────────────┘
                            │ default impl
                            ▼
                ┌───────────────────────────┐
                │ InMemoryProcessedSet       │
                │ ────────────────────────  │
                │  Map<string, null>         │
                │  maxSize (default 10_000)  │
                │  FIFO eviction             │
                └───────────────────────────┘
```

### Sequence: Successful Event Processing (with deduplication)

```
Caller         EventStream          EventCursor      ProcessedSet   CursorStore
  │                │                    │                 │               │
  │ start()        │                    │                 │               │
  │────────────────▶                    │                 │               │
  │                │ fetch(position)    │                 │               │
  │                │──────────────────▶ RPC               │               │
  │                │ ◀── [event, ...]  │                 │               │
  │                │                    │                 │               │
  │                │ process(event, fn) │                 │               │
  │                │───────────────────▶                  │               │
  │                │                    │ has(event.id)   │               │
  │                │                    │────────────────▶│               │
  │                │                    │ ◀── false       │               │
  │                │                    │                 │               │
  │                │                    │ consumer(event) │               │
  │                │                    │──────────────── ▶ (caller fn)   │
  │                │                    │ ◀── result      │               │
  │                │                    │                 │               │
  │                │                    │ store.set(cursor)               │
  │                │                    │────────────────────────────────▶│
  │                │                    │ ◀── ok          │               │
  │                │                    │                 │               │
  │                │                    │ add(event.id)   │               │
  │                │                    │────────────────▶│               │
  │                │                    │ ◀── ok          │               │
  │                │ ◀── result         │                 │               │
  │                │                    │                 │               │
  │                │ [reset back-off, schedule next poll] │               │
```

### Sequence: Duplicate Delivery (re-delivered event, already processed)

```
EventCursor         ProcessedSet
    │                    │
    │ has(event.id)       │
    │────────────────────▶│
    │ ◀── true            │
    │                    │
    │ return early (no consumer call, no store.set, no add)
```

### Sequence: Reorg Detected

```
EventStream            CursorStore          Caller callback
    │                       │                    │
    │ fetch(staleCursor)     │                    │
    │──── ▶ RPC (throws "unresolvable")           │
    │                       │                    │
    │ resolveRewindTarget(staleCursor)            │
    │──── ▶ (inline or caller-supplied fn)        │
    │ ◀── newCursor                               │
    │                       │                    │
    │ store.set(newCursor)   │                    │
    │───────────────────────▶                    │
    │                       │                    │
    │ onReorgRewind(old, new)│                    │
    │────────────────────────────────────────────▶│
    │                       │                    │
    │ [schedule next poll from newCursor]         │
```

---

## File-by-File Design

---

### `src/events/processed-set.ts` — NEW

#### Purpose

Defines the `ProcessedSet` interface and its default `InMemoryProcessedSet`
implementation. The interface is intentionally thin so any backing store
(Redis, SQLite, PostgreSQL) can be substituted without touching `EventCursor`.

#### Interface: `ProcessedSet`

```typescript
/**
 * Tracks which event IDs have already been successfully processed.
 *
 * Implementations may be synchronous (in-memory) or asynchronous
 * (database, Redis). EventCursor always awaits both methods.
 */
export interface ProcessedSet {
  /**
   * Returns true if the given event ID has previously been added.
   * Must be idempotent and side-effect-free.
   */
  has(eventId: string): Promise<boolean> | boolean;

  /**
   * Records the given event ID as successfully processed.
   * Called only after the consumer AND the cursor write both succeed.
   */
  add(eventId: string): Promise<void> | void;
}
```

**Design notes**:
- Both methods return `Promise<…> | …` (i.e. `MaybePromise`) so in-memory
  implementations can be synchronous without wrapping in `Promise.resolve`.
  `EventCursor` always `await`s the result, which is a no-op for synchronous
  returns.
- The interface is intentionally minimal — no `delete`, no `size`, no
  iteration — to keep custom implementations trivial.

#### Class: `InMemoryProcessedSet`

```typescript
export class InMemoryProcessedSet implements ProcessedSet {
  private readonly store = new Map<string, null>();
  private readonly maxSize: number;

  constructor(maxSize = 10_000) {
    if (!Number.isInteger(maxSize) || maxSize < 1) {
      throw new RangeError(`maxSize must be a positive integer, got ${maxSize}`);
    }
    this.maxSize = maxSize;
  }

  has(eventId: string): boolean {
    return this.store.has(eventId);
  }

  add(eventId: string): void {
    if (this.store.has(eventId)) return; // idempotent
    if (this.store.size >= this.maxSize) {
      // Map preserves insertion order; the first key is the oldest.
      const oldest = this.store.keys().next().value as string;
      this.store.delete(oldest);
    }
    this.store.set(eventId, null);
  }
}
```

**Eviction strategy — FIFO via `Map` insertion order**:

`Map` in V8 (and per spec) preserves insertion order. `keys().next().value`
is O(1) amortised because V8's Map iterator starts from the head of an
internal doubly-linked list. Eviction therefore costs one `delete` + one
`set` — still O(1).

The alternative (LRU) would promote a hit to the back of the queue on
`has()`, preventing long-lived but frequently-seen IDs from being evicted.
LRU adds complexity with negligible benefit in this context: if an event ID
survives in the set beyond `maxSize` deliveries the cursor has long since
advanced past it, so the set would never be asked about it again. FIFO is
the right tradeoff.

**Memory bound**:
Each entry is one string (event ID) + 2 Map-overhead pointers ≈ 80–120 bytes
in V8. At `maxSize = 10_000`, peak footprint ≈ 1–1.2 MB — well within
budget for a long-running Node.js process.

---

### `src/events/cursor.ts` — MODIFIED

#### Changes

1. **`StreamEvent`** gains an `id: string` field.
2. **`EventCursor` constructor** gains an optional `processedSet?: ProcessedSet` parameter.
3. **`EventCursor.process()`** gains deduplication logic.

#### Updated `StreamEvent`

```typescript
/** An event in the stream. */
export interface StreamEvent {
  /**
   * Opaque position token persisted on success.
   * Used as the resume point for the next polling page.
   */
  cursor: string;
  /**
   * Stable event identifier used as the deduplication key.
   *
   * Must be globally unique and deterministic (same value on re-delivery).
   * Typically the event's paging token / ledger-sequence + event-index
   * pair (e.g. `"1234567-0"`).
   */
  id: string;
}
```

**Backward-compatibility note**: Adding a required `id` field is a breaking
change to the `StreamEvent` interface. However, because the existing tests
construct `StreamEvent` objects as bare `{ cursor: 'x' }` literals, we must
keep `id` optional on the interface while making it required for the
deduplication path. The solution: `id` is typed `string | undefined` on the
interface, but `EventCursor.process()` only performs the deduplication check
when `processedSet` is provided AND `event.id` is a non-empty string (see
logic below). This avoids breaking existing `consume()` callers who pass
events without `id`.

Wait — the requirements say `id: string` (required). Let's look at what the
tests do: the existing tests pass `{ cursor: 'evt-1' }` with no `id`. The
requirement also says existing tests must pass unchanged (Requirement 7.2).
Therefore we MUST make `id` optional on the interface. The tests that
exercise deduplication will supply `id`; the existing cursor-only tests will
not. We document this clearly.

**Final `StreamEvent` definition**:

```typescript
export interface StreamEvent {
  /** Opaque position token persisted on success. */
  cursor: string;
  /**
   * Stable deduplication key. Required when a ProcessedSet is in use;
   * optional for callers that do not need deduplication.
   */
  id?: string;
}
```

#### Updated `EventCursor` constructor

```typescript
export class EventCursor {
  private readonly store: CursorStore;
  private readonly processedSet?: ProcessedSet;

  constructor(store: CursorStore, processedSet?: ProcessedSet) {
    this.store = store;
    this.processedSet = processedSet;
  }
  // ...
}
```

#### Updated `EventCursor.process()` — deduplication flow

```
process(event, consumer):
  1. IF processedSet IS provided AND event.id IS a non-empty string:
       IF await processedSet.has(event.id) === true:
         RETURN undefined   ← skip; no consumer, no cursor write, no add
  2. result = await consumer(event)   ← throws → cursor untouched, no add
  3. await store.set(event.cursor)    ← throws → no add (re-delivery safe)
  4. IF processedSet IS provided AND event.id IS non-empty:
       await processedSet.add(event.id)
  5. RETURN result
```

The ordering is critical:
- `processedSet.add` is **after** `store.set`, not before. A crash between
  step 3 and step 4 means the cursor advanced but the ID is not yet in the
  set. On re-delivery the cursor check will deliver the event again —
  correctly. If we added to `processedSet` before the cursor write, a crash
  between step 4 and step 3 would mark the event as processed but leave the
  cursor un-advanced, causing a silent skip — exactly the bug
  `vero-core-engine#179` described.
- The `id` guard (`event.id` is a non-empty string) ensures backward
  compatibility: events without an `id` field behave as before.

```typescript
async process<T>(
  event: StreamEvent,
  consumer: (event: StreamEvent) => T | Promise<T>,
): Promise<T | undefined> {
  // 1. Deduplication check
  if (this.processedSet != null && event.id) {
    if (await this.processedSet.has(event.id)) {
      return undefined;
    }
  }

  // 2. Consumer (throws → cursor untouched, no add)
  const result = await consumer(event);

  // 3. Persist cursor (throws → no add; event may re-deliver)
  await this.store.set(event.cursor);

  // 4. Record as processed (only on full success)
  if (this.processedSet != null && event.id) {
    await this.processedSet.add(event.id);
  }

  return result;
}
```

**Return type change**: `process()` now returns `Promise<T | undefined>` to
accommodate the early-return `undefined` on deduplication skip. Callers that
need the consumer's return value must handle `undefined` (indicating the
event was skipped).

---

### `src/events/stream.ts` — NEW

#### Purpose

Owns the polling loop, exponential back-off, and reorg recovery. Callers
provide a `fetch` function, a `consumer` callback, and an `EventCursor`
instance; `EventStream` wires everything together.

#### Configuration Interface

```typescript
export interface EventStreamConfig<E extends StreamEvent = StreamEvent> {
  /**
   * EventCursor instance (with optional ProcessedSet already attached).
   * EventStream delegates per-event processing to cursor.process().
   */
  cursor: EventCursor;

  /**
   * Fetch the next page of events from the given position.
   *
   * @param position - The current cursor value, or null for start-of-stream.
   * @returns An array of events (empty array when caught up).
   * @throws An error with message containing "unresolvable" (or matching
   *         isReorgError) when the cursor points to a ledger that no longer
   *         exists.
   */
  fetch: (position: string | null) => Promise<E[]>;

  /**
   * Process a single event. Called inside cursor.process() so the cursor
   * advances only after this resolves.
   */
  consumer: (event: E) => Promise<void>;

  /**
   * Given a stale (unresolvable) cursor, return the rewind target.
   *
   * Return null to rewind to start-of-stream.
   * If not provided, always rewinds to null.
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
   * Custom predicate to detect reorg errors from the fetch function.
   * If not provided, errors whose message includes "unresolvable" are
   * treated as reorg errors.
   */
  isReorgError?: (err: unknown) => boolean;

  /**
   * Minimum polling interval in milliseconds (applied after a successful
   * page with events). Default: 500.
   */
  minDelayMs?: number;

  /**
   * Maximum polling interval in milliseconds (ceiling for back-off).
   * Default: 30_000.
   */
  maxDelayMs?: number;

  /**
   * AbortSignal to cancel the polling loop from outside the class.
   * Equivalent to calling stop(), but composable with AbortController.
   */
  signal?: AbortSignal;
}
```

#### Class: `EventStream<E>`

```typescript
export class EventStream<E extends StreamEvent = StreamEvent> {
  private readonly config: Required<
    Pick<EventStreamConfig<E>, 'minDelayMs' | 'maxDelayMs'>
  > &
    EventStreamConfig<E>;

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

  /** Begin the polling loop. Returns immediately; loop runs asynchronously. */
  start(): void { ... }

  /** Cancel all pending timers and stop the loop after the current iteration. */
  stop(): void { ... }

  // internal
  private async loop(): Promise<void> { ... }
  private sleep(ms: number): Promise<void> { ... }
  private isReorgError(err: unknown): boolean { ... }
  private async handleReorg(staleCursor: string | null): Promise<void> { ... }
}
```

#### Back-off Strategy

The back-off mirrors the pattern in `src/resilience/backoff.ts` but is
implemented inline in `EventStream` because:

- `retry()` is designed for a function that is retried up to `maxRetries`
  times before giving up. The polling loop has no maximum — it runs
  indefinitely until `stop()`.
- The delay management (doubling + jitter, reset on success) is a stateful
  property of the stream object, not a per-call concern.

Back-off algorithm:

```
on empty page or transient error:
  newDelay = min(currentDelay * 2, maxDelayMs)
  jitter   = Math.random() * newDelay * 0.1   // 10% jitter
  sleep(newDelay + jitter)
  currentDelay = newDelay

on non-empty page:
  currentDelay = minDelayMs
  sleep(minDelayMs)
```

The 10% jitter prevents thundering-herd if multiple streams are started
simultaneously against the same RPC endpoint.

#### Polling Loop (pseudocode)

```
PROCEDURE loop()
  WHILE NOT stopped AND NOT signal.aborted DO
    position ← await cursor.position()

    TRY
      events ← await fetch(position)
    CATCH err
      IF isReorgError(err) THEN
        await handleReorg(position)
        CONTINUE                  ← reorg handled; re-fetch from new position
      ELSE
        backOff()                 ← transient error; wait and retry
        CONTINUE
      END IF
    END TRY

    IF events.length = 0 THEN
      backOff()
      CONTINUE
    END IF

    FOR each event IN events DO
      IF stopped OR signal.aborted THEN RETURN
      await cursor.process(event, config.consumer)
    END FOR

    resetDelay()
    await sleep(minDelayMs)

  END WHILE
END PROCEDURE
```

**Self-scheduling with `setTimeout`** (not `setInterval`):

`setInterval` fires on a fixed wall-clock cadence regardless of how long each
iteration takes. If a `fetch` call takes longer than the interval, iterations
pile up. Instead, `EventStream` schedules the next iteration via `setTimeout`
only after the current one completes, using `await` throughout.

```typescript
private sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    this.sleepHandle = setTimeout(() => {
      this.sleepHandle = null;
      resolve();
    }, ms);
  });
}
```

`stop()` calls `clearTimeout(this.sleepHandle)` and sets `this.stopped =
true`. The loop checks `this.stopped` at the top of each iteration and before
processing each event in the batch, so it cannot get stuck mid-batch after
`stop()`.

#### Reorg Handling

```typescript
private async handleReorg(staleCursor: string | null): Promise<void> {
  const { resolveRewindTarget, onReorgRewind, cursor: cur } = this.config;

  const newCursor = resolveRewindTarget
    ? await resolveRewindTarget(staleCursor)
    : null;

  // Rewind the cursor store directly.
  // EventCursor.position() reads from the store, so the loop will
  // automatically pick up newCursor on the next iteration.
  if (newCursor !== null) {
    await (cur as unknown as { store: CursorStore }).store.set(newCursor);
  }
  // If newCursor is null, leave the store as-is; position() returns null
  // (start-of-stream) on the next call when the store has no value.
  // Alternative: expose a reset() method on EventCursor. See notes below.

  onReorgRewind?.(staleCursor, newCursor);

  // Reset back-off after reorg — we want to re-fetch immediately.
  this.currentDelayMs = this.config.minDelayMs;
}
```

**Note on `EventCursor` / `CursorStore` access**: `EventStream` needs to
write directly to the `CursorStore` for reorg rewinds (bypassing the
consumer-then-persist ordering that `EventCursor.process()` enforces). The
cleanest solution is to expose a `reset(cursor: string | null)` method on
`EventCursor` that writes `store.set(cursor)` if `cursor !== null` and does
nothing (leaving the persisted value as the "null" sentinel) otherwise.
Alternatively, the design can accept a `store` reference directly in the
`EventStreamConfig`. This design adds `reset()` to `EventCursor` — it avoids
reaching into private fields and makes the intent explicit.

**`EventCursor.reset()`** (added alongside the existing methods):

```typescript
/**
 * Unconditionally overwrite the persisted cursor to `cursor`.
 *
 * Used by EventStream during reorg rewinds. Not part of normal
 * event-processing flow.
 */
async reset(cursor: string): Promise<void> {
  await this.store.set(cursor);
}
```

For `null` rewinds (start-of-stream), the `EventStream` simply does not call
`reset()`, and `cursor.position()` returns whatever is in the store
(typically the last-known cursor). To truly reset to start-of-stream the
`CursorStore` must support deleting its value, which is outside this spec's
scope. The safe fallback is: if `resolveRewindTarget` returns `null`, call
`onReorgRewind(old, null)` and do not update the store — the next `fetch`
will use the current (stale) position again, which may loop until the
`resolveRewindTarget` returns something useful.

A better production approach: `CursorStore` gains an optional `delete()` or
the store accepts `set(null)`. This is noted as a future improvement; for the
initial implementation, `null` means "rewind to start" and the caller is
expected to provide a `resolveRewindTarget` that returns a meaningful value.

#### Reorg Detection

```typescript
private isReorgError(err: unknown): boolean {
  if (this.config.isReorgError) {
    return this.config.isReorgError(err);
  }
  return (
    err instanceof Error &&
    err.message.toLowerCase().includes('unresolvable')
  );
}
```

#### `start()` and `stop()`

```typescript
start(): void {
  this.stopped = false;
  // Fire-and-forget; errors inside loop() are absorbed (stream keeps running).
  // Consumer errors are re-thrown by cursor.process() and must be handled
  // by wrapping the loop iteration in a try/catch.
  void this.loop();
}

stop(): void {
  this.stopped = true;
  if (this.sleepHandle !== null) {
    clearTimeout(this.sleepHandle);
    this.sleepHandle = null;
  }
}
```

**Error isolation**: An unhandled consumer error in `loop()` would crash the
stream. The loop wraps the `cursor.process()` call in a try/catch: transient
consumer errors trigger back-off; persistent errors should be re-thrown so
the caller can detect them. The initial implementation applies back-off on
any error not caught as a reorg error, which is consistent with the
`retry()` pattern in `backoff.ts`.

---

### `src/events/index.ts` — MODIFIED

Re-export all new symbols alongside the existing exports:

```typescript
// Decoder — typed event decoding with topic-abbreviation absorption.
export * from './decoder.js';

// Cursor — no-skip cursor persistence (vero-core-engine#179).
export * from './cursor.js';

// ProcessedSet — deduplication interface and in-memory default.
export * from './processed-set.js';

// EventStream — automated polling loop with back-off and reorg recovery.
export * from './stream.js';
```

No selective re-exports are needed; all public symbols from each file are
exported. The `.js` extension is required for ESM-compatible builds (see
`tsconfig.esm.json`).

---

### `src/__tests__/events.test.ts` — MODIFIED

Six new test groups are added at the bottom of the existing file. All
existing tests remain unchanged (Requirement 7.2).

#### Test 1: Deduplication skip

```
describe('EventCursor — deduplication (ProcessedSet)') {
  it('skips consumer for an already-processed event ID')
    // Arrange: InMemoryProcessedSet with event.id pre-added
    // Act:     cursor.process({ cursor: 'evt-1', id: 'id-1' }, consumerMock)
    // Assert:  consumerMock called 0 times; cursor store unchanged
  
  it('calls consumer exactly once on first delivery, skips on re-delivery')
    // 1st call: consumer runs, store advances, id added to set
    // 2nd call: consumer skipped (already in set)
    // Assert:  consumerMock called exactly once total
}
```

#### Test 2: Consumer throw atomicity

```
describe('EventCursor — consumer throw with processedSet') {
  it('does not add id to processedSet when consumer throws')
    // Arrange: fresh InMemoryProcessedSet
    // Act:     consumer throws
    // Assert:  processedSet.has(event.id) === false
    //          cursor store unchanged
}
```

#### Test 3: No-skip regression unchanged

The existing `EventCursor` describe block already covers this. No new test
is needed — the requirement is that no existing test changes. Adding the
deduplication path must not alter any test outcome.

#### Test 4: `EventStream.stop()` timer cleanup

```
describe('EventStream.stop() — timer cleanup') {
  it('leaves no active timer handles after stop()')
    jest.useFakeTimers()
    // Start stream with a slow fetch (jest.fn that never resolves quickly)
    stream.start()
    stream.stop()
    expect(jest.getTimerCount()).toBe(0)
    jest.useRealTimers()
}
```

#### Test 5: Reorg rewind

```
describe('EventStream — reorg rewind') {
  it('calls onReorgRewind and resumes from rewound cursor')
    // fetch throws error with message 'cursor unresolvable'
    // resolveRewindTarget returns 'rewind-target'
    // Assert: onReorgRewind called with (oldCursor, 'rewind-target')
    //         second fetch call uses 'rewind-target' as position
}
```

#### Test 6: `InMemoryProcessedSet` eviction

```
describe('InMemoryProcessedSet — bounded eviction') {
  it('never exceeds maxSize entries')
    const set = new InMemoryProcessedSet(3)
    set.add('a'); set.add('b'); set.add('c')
    set.add('d')   // evicts 'a'
    expect(set.has('a')).toBe(false)
    expect(set.has('d')).toBe(true)
    // size == 3 (no public size accessor; verify via has checks)
  
  it('defaults to maxSize 10_000')
    // Construct with no arg; add 10_001 items; first is evicted
}
```

---

## Data-Flow: Full Happy Path

```
                   ┌─────────────────────────────────────────────┐
                   │  EventStream.loop() iteration N             │
                   │                                             │
  ┌──────┐         │  1. pos = await cursor.position()           │
  │Store │◀────────│     (reads CursorStore.get())               │
  └──────┘         │                                             │
                   │  2. events = await fetch(pos)               │
      RPC ◀────────│                                             │
      ───────────▶ │                                             │
                   │  3. [reset back-off delay]                  │
                   │                                             │
                   │  4. for each event:                         │
                   │       cursor.process(event, consumer)       │
                   │         a. processedSet.has(id)?  → skip    │
                   │         b. consumer(event)                  │
                   │         c. store.set(event.cursor)          │
                   │         d. processedSet.add(id)             │
                   │                                             │
                   │  5. await sleep(minDelayMs)                 │
                   │     (setTimeout handle stored for stop())   │
                   └─────────────────────────────────────────────┘
```

---

## Key Invariants

1. **No double-processing**: if `processedSet.has(id)` returns `true`, the
   consumer is never called for that ID.

2. **No silent skip**: if the consumer throws, neither the cursor nor the
   processed-set is updated. Re-delivery is guaranteed.

3. **ProcessedSet written last**: `store.set` always precedes
   `processedSet.add`. A crash between them causes an extra delivery, not a
   silent skip.

4. **Bounded memory**: `InMemoryProcessedSet` never holds more than `maxSize`
   entries. The oldest entry is evicted before any insertion that would exceed
   the cap.

5. **Clean shutdown**: `stop()` cancels the pending `setTimeout`, sets
   `stopped = true`. After `stop()` returns, no further `fetch` or `consumer`
   calls will be initiated.

6. **Reorg safety**: on an unresolvable cursor, the stream rewinds and
   continues from the new position. The error is never surfaced unhandled to
   the caller.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all
valid executions of a system — essentially, a formal statement about what the
system should do.*

### Property 1: Deduplication idempotence

For any event ID that has been successfully processed (consumer ran,
cursor written, `add` called), re-delivering the same event ID to
`EventCursor.process()` shall return without invoking the consumer,
regardless of how many times the event is re-delivered.

**Validates: Requirements 3.1, 3.2**

### Property 2: Consumer-throw atomicity

For any event for which the consumer throws, neither the cursor store nor
the `ProcessedSet` shall contain evidence of a successful processing:
`CursorStore.get()` shall return its pre-call value, and
`processedSet.has(event.id)` shall return `false`.

**Validates: Requirements 3.4, 7.3**

### Property 3: `ProcessedSet` add–has round trip

For any event ID `id`, after `processedSet.add(id)` completes,
`processedSet.has(id)` shall return `true`.

**Validates: Requirements 1.1, 1.2**

### Property 4: `InMemoryProcessedSet` size invariant

For any sequence of `add` operations on an `InMemoryProcessedSet` with
`maxSize = N`, the number of distinct IDs for which `has` returns `true`
shall never exceed `N`, and after inserting the `(N+1)`-th distinct ID the
oldest ID shall no longer be present.

**Validates: Requirements 2.2, 2.3, 2.4**

### Property 5: No-skip contract preserved (regression)

For any `EventCursor` constructed without a `ProcessedSet`, the cursor store
is never advanced unless the consumer resolves successfully — identical
behaviour to the pre-feature baseline. This property subsumes
`vero-core-engine#179`.

**Validates: Requirement 3.5**

### Property 6: Reorg rewind resumes correctly

For any invocation of `EventStream` where `fetch` throws a reorg error with
stale cursor `C_old`, after `handleReorg` completes the next call to
`cursor.position()` shall return the value produced by `resolveRewindTarget(C_old)`.

**Validates: Requirements 5.1, 5.2, 5.3**

### Property 7: Stop leaves no timer handles

For any `EventStream` that has been started and then stopped, the number of
active `setTimeout` handles attributable to the stream shall be zero
immediately after `stop()` returns.

**Validates: Requirements 4.3, 4.4**

---

## Implementation Notes

### TypeScript Generics in `EventStream`

`EventStream<E extends StreamEvent>` ensures the `fetch` return type, the
`consumer` parameter type, and the `cursor.process()` call are all typed to
the same concrete event type `E`. This lets callers use rich domain event
types (e.g. `StreamEvent & { taskId: bigint }`) throughout without casts.

### ESM Import Extensions

All intra-package imports use `.js` extensions as required by the ESM build
(`tsconfig.esm.json`). The Jest `moduleNameMapper` in `jest.config.js`
strips the `.js` extension when resolving under `ts-jest`, so tests work
with the same import paths used in source.

### No New Runtime Dependencies

The feature uses only:
- `Map` (built-in) for `InMemoryProcessedSet`
- `setTimeout` / `clearTimeout` (built-in Node.js timers) for back-off
- `AbortSignal` (built-in) for cancellation

No new entries in `package.json` are required.

### Jest Fake Timers Compatibility

`jest.useFakeTimers()` replaces `setTimeout` / `clearTimeout` with Jest's
controlled implementations. `EventStream.sleep()` uses only `setTimeout` and
stores the handle for `clearTimeout` — both are patched by Jest, so the
timer-cleanup test (Test 4) works correctly without any special
accommodation.

### Ordering of `ProcessedSet.add` vs `CursorStore.set`

The sequence `store.set` → `processedSet.add` (rather than the reverse)
is the critical correctness decision. A table of failure modes:

| Crash point                     | Effect                           | Safe? |
|----------------------------------|----------------------------------|-------|
| Before `consumer()`              | Event re-delivered               | ✅    |
| After `consumer()`, before `store.set` | Event re-delivered          | ✅    |
| After `store.set`, before `add`  | Event re-delivered (extra run)   | ✅    |
| After `add`, before `store.set`  | Event silently skipped (**BUG**) | ❌    |

The chosen order eliminates the only unsafe failure mode.

---

## Dependencies Between Files

```
stream.ts
  └── imports EventCursor, StreamEvent from ./cursor.js
  └── imports ProcessedSet (optional, not a hard dependency)

cursor.ts
  └── imports ProcessedSet from ./processed-set.js

processed-set.ts
  └── no intra-package imports

index.ts
  └── re-exports ./decoder.js, ./cursor.js, ./processed-set.js, ./stream.js
```

Circular imports: none. The dependency graph is a strict DAG.
