# Requirements Document

## Introduction

The `event-deduplication-stream` feature extends the existing `src/events/` module to make event processing fully idempotent and operationally resilient. Today the `EventCursor` already provides a no-skip delivery guarantee (cursor advances only after a consumer succeeds), but there is no defence against duplicate deliveries — a crash between the consumer succeeding and the cursor write means the same event arrives a second time and the consumer runs again. Additionally, there is no automated polling loop, and no handling of ledger reorganisations that invalidate a persisted cursor.

This feature adds:
1. A `ProcessedSet` abstraction that records which event IDs have already been handled.
2. Deduplication logic wired into `EventCursor.process()` so that a re-delivered event is silently skipped without calling the consumer twice.
3. An `EventStream` class that owns the polling loop, pagination, back-off, and cursor persistence so callers do not have to build that infrastructure themselves.
4. Ledger-reorg detection inside `EventStream`: when the persisted cursor points to a no-longer-existing ledger/event, the stream rewinds to the last known-good ledger rather than stalling or skipping ahead.

---

## Glossary

- **EventCursor**: The existing class in `src/events/cursor.ts` that wraps a `CursorStore` and guarantees the cursor only advances after the consumer resolves.
- **CursorStore**: Interface for reading and writing the persisted stream position (`get` / `set`).
- **StreamEvent**: Interface for an event in the stream; carries an opaque `cursor` position token and an `id` string used for deduplication.
- **ProcessedSet**: Interface for a set of already-handled event IDs; implementations may be in-memory (default) or persistent (e.g., database).
- **InMemoryProcessedSet**: Default bounded in-memory implementation of `ProcessedSet`, capacity-capped to prevent unbounded memory growth.
- **EventStream**: New class in `src/events/stream.ts` that manages the full polling loop, pagination, exponential back-off, and cursor persistence for a stream of `StreamEvent` objects.
- **Consumer**: A caller-supplied async callback `(event: StreamEvent) => Promise<void>` that processes a single event.
- **Ledger Reorg**: A chain reorganisation that removes or replaces a block/ledger, making a previously valid cursor position unresolvable.
- **Rewind**: The act of resetting the cursor to a known-good position (e.g., the start of the last valid ledger) so polling can resume after a reorg.
- **AbortSignal**: A standard `AbortSignal` used to cancel the polling loop started by `EventStream.start()`.

---

## Requirements

### Requirement 1: ProcessedSet Interface

**User Story:** As an SDK integrator, I want a well-defined interface for tracking processed event IDs, so that I can substitute a persistent store (e.g., Redis, database) in place of the default in-memory set without changing any other code.

#### Acceptance Criteria

1. THE `ProcessedSet` interface SHALL expose a `has(eventId: string): Promise<boolean> | boolean` method that returns `true` when the given event ID has previously been added to the set.
2. THE `ProcessedSet` interface SHALL expose an `add(eventId: string): Promise<void> | void` method that records the given event ID as processed.
3. THE `ProcessedSet` interface SHALL be exported from `src/events/index.ts` so that integrators can implement custom persistent backends.

---

### Requirement 2: InMemoryProcessedSet — Bounded Default Implementation

**User Story:** As an SDK integrator, I want a ready-to-use in-memory `ProcessedSet` that does not leak memory, so that I can adopt deduplication without any external dependencies.

#### Acceptance Criteria

1. THE `InMemoryProcessedSet` SHALL implement the `ProcessedSet` interface.
2. THE `InMemoryProcessedSet` constructor SHALL accept a `maxSize` parameter (a positive integer) that caps the number of event IDs retained in memory.
3. WHEN `add` is called and the set has reached `maxSize`, THE `InMemoryProcessedSet` SHALL evict the oldest entry before inserting the new one, so that the set size never exceeds `maxSize`.
4. THE `InMemoryProcessedSet` SHALL default to a `maxSize` of `10_000` when no value is provided.
5. THE `InMemoryProcessedSet` SHALL be exported from `src/events/index.ts`.

---

### Requirement 3: EventCursor Deduplication Integration

**User Story:** As an SDK integrator, I want the `EventCursor` to skip events that have already been successfully processed, so that a re-delivered event after a crash does not cause double-processing side-effects.

#### Acceptance Criteria

1. THE `EventCursor` constructor SHALL accept an optional `processedSet` parameter of type `ProcessedSet`.
2. WHEN `EventCursor.process()` is called and `processedSet.has(event.id)` returns `true`, THE `EventCursor` SHALL skip the consumer invocation and return without updating the cursor store.
3. WHEN `EventCursor.process()` is called and the event has not been processed, THE `EventCursor` SHALL invoke the consumer, then call `processedSet.add(event.id)` and persist the cursor — in that order — only after the consumer resolves successfully; `processedSet.add` SHALL NOT be called unless the cursor store write also completes successfully.
4. IF the consumer throws during `EventCursor.process()`, THEN THE `EventCursor` SHALL NOT call `processedSet.add(event.id)` and SHALL NOT update the cursor store, so that the event is re-delivered on the next run.
5. WHEN no `processedSet` is provided to `EventCursor`, THE `EventCursor` SHALL behave exactly as it did before this feature (no-skip contract preserved, no deduplication check performed).
6. THE `StreamEvent` interface SHALL include an `id` field of type `string` (used as the deduplication key), in addition to the existing `cursor` position token.

---

### Requirement 4: EventStream — Polling Loop Management

**User Story:** As an SDK integrator, I want an `EventStream` class that manages the polling loop for me, so that I do not have to build retry, back-off, and pagination logic in every application that consumes contract events.

#### Acceptance Criteria

1. THE `EventStream` class SHALL accept a configuration object at construction time that includes: a `fetch` function for retrieving the next page of events, a `consumer` callback, an `EventCursor` instance, and optional back-off parameters.
2. THE `EventStream.start()` method SHALL begin polling for new events using the provided `fetch` function and hand each event to the `EventCursor.process()` method.
3. THE `EventStream.stop()` method SHALL cancel all active timers and terminate any pending polling iteration so that no further `fetch` or `consumer` calls are made after `stop()` returns.
4. WHEN `EventStream.stop()` is called, THE `EventStream` SHALL leave no active `setTimeout` or `setInterval` handles that would prevent the Node.js process from exiting cleanly.
5. THE `EventStream` SHALL apply exponential back-off with jitter between polling iterations when the `fetch` function returns an empty page or throws a transient error.
6. THE `EventStream` SHALL accept an optional `AbortSignal` so that the polling loop can be cancelled from outside the class.

---

### Requirement 5: Ledger-Reorg Rewind

**User Story:** As an SDK integrator, I want the `EventStream` to recover automatically from ledger reorganisations, so that a reorg does not stall or corrupt the event stream.

#### Acceptance Criteria

1. WHEN the `fetch` function signals that the persisted cursor points to a ledger or event that no longer exists (an unresolvable cursor condition), THE `EventStream` SHALL catch that condition rather than propagating the error to the caller unhandled.
2. WHEN an unresolvable cursor is detected, THE `EventStream` SHALL rewind the cursor to the last known-good ledger position by calling `CursorStore.set` with the rewind target.
3. WHEN an unresolvable cursor is detected, THE `EventStream` SHALL resume polling from the rewound cursor position on the next iteration.
4. THE `EventStream` configuration SHALL accept a `onReorgRewind` callback that is invoked with the old (unresolvable) cursor and the new (rewound) cursor whenever a rewind occurs, so that the integrator can log or audit the event.
5. IF no `resolveRewindTarget` function is provided in the configuration, THEN THE `EventStream` SHALL rewind to a `null` cursor (start of stream) as a safe fallback.

---

### Requirement 6: Updated Exports

**User Story:** As an SDK integrator, I want all new types and classes to be importable from the top-level events index, so that I do not need to reach into internal file paths.

#### Acceptance Criteria

1. THE `src/events/index.ts` module SHALL export `ProcessedSet`, `InMemoryProcessedSet`, and `EventStream` in addition to all existing exports.
2. THE `src/events/index.ts` module SHALL re-export all updated `EventCursor`, `CursorStore`, and `StreamEvent` types reflecting the new `id` field on `StreamEvent`.

---

### Requirement 7: Unit-Test Coverage

**User Story:** As a maintainer, I want comprehensive unit tests for every new behaviour, so that regressions are caught in CI without manual review.

#### Acceptance Criteria

1. THE test suite SHALL verify that re-delivering an event whose ID is already in the `ProcessedSet` does NOT invoke the consumer a second time.
2. THE test suite SHALL verify that the existing no-skip regression test (vero-core-engine#179) passes completely unchanged after the deduplication changes.
3. THE test suite SHALL verify that when the consumer throws, the event ID is NOT added to the `ProcessedSet` and the cursor store is NOT updated.
4. THE test suite SHALL verify that calling `EventStream.stop()` leaves no active timer handles (detectable via `jest.useFakeTimers()` and confirming no pending timers remain).
5. THE test suite SHALL verify that an unresolvable cursor causes `EventStream` to invoke its rewind path and resume polling from the rewound cursor.
6. THE test suite SHALL verify that `InMemoryProcessedSet` does not retain more than `maxSize` entries, and that the oldest entry is evicted when the cap is reached.
