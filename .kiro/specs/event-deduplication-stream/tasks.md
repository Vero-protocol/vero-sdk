# Implementation Plan: event-deduplication-stream

## Overview

Extend `src/events/` with three additive, backward-compatible capabilities:
deduplication via `ProcessedSet`, an automated `EventStream` polling loop with
exponential back-off, and ledger-reorg rewind. All existing behaviour — the
no-skip guarantee from `vero-core-engine#179` — is preserved without
modification.

Implementation follows a strict dependency order: the `ProcessedSet` primitive
is built first, then `EventCursor` is updated to consume it, then `EventStream`
is built on top of both, and finally the barrel exports and tests are added.

---

## Tasks

- [x] 1. Create `ProcessedSet` interface and `InMemoryProcessedSet` class
  - [x] 1.1 Create `src/events/processed-set.ts` with `ProcessedSet` interface and `InMemoryProcessedSet` class
    - Define the `ProcessedSet` interface with `has(eventId: string): Promise<boolean> | boolean` and `add(eventId: string): Promise<void> | void`
    - Implement `InMemoryProcessedSet` using a `Map<string, null>` for O(1) insertion-order-preserving storage
    - Accept `maxSize` constructor parameter (positive integer, default `10_000`); throw `RangeError` for invalid values
    - Implement FIFO eviction: when `add` is called and `store.size >= maxSize`, delete `store.keys().next().value` before inserting
    - Make `add` idempotent: if the ID is already present, return without evicting or reinserting
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 2.4_

  - [ ]* 1.2 Write property test for `ProcessedSet` add–has round trip
    - **Property 3: `ProcessedSet` add–has round trip** — for any event ID `id`, after `processedSet.add(id)` completes, `processedSet.has(id)` shall return `true`
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 1.3 Write property test for `InMemoryProcessedSet` size invariant
    - **Property 4: `InMemoryProcessedSet` size invariant** — for any sequence of `add` operations on an `InMemoryProcessedSet` with `maxSize = N`, the number of distinct IDs for which `has` returns `true` shall never exceed `N`, and after inserting the `(N+1)`-th distinct ID the oldest ID shall no longer be present
    - **Validates: Requirements 2.2, 2.3, 2.4**

- [x] 2. Update `EventCursor` with deduplication logic and `reset()` method
  - [x] 2.1 Modify `src/events/cursor.ts`: add `id?: string` to `StreamEvent`, wire `ProcessedSet` into `EventCursor`
    - Add optional `id?: string` field to `StreamEvent` interface (backward-compatible; existing tests pass events without `id`)
    - Import `ProcessedSet` from `./processed-set.js`
    - Add optional `processedSet?: ProcessedSet` parameter to the `EventCursor` constructor; store as `private readonly`
    - Update `process()` return type to `Promise<T | undefined>` to accommodate the early-return `undefined` on deduplication skip
    - In `process()`, add deduplication check at step 1: if `this.processedSet != null && event.id` then `if (await this.processedSet.has(event.id)) return undefined`
    - After `store.set(event.cursor)` succeeds, call `await this.processedSet.add(event.id)` — `processedSet.add` MUST come after `store.set`, never before
    - Add `reset(cursor: string): Promise<void>` method that calls `await this.store.set(cursor)` — used by `EventStream` during reorg rewinds
    - Preserve all existing `consume()` and `position()` behaviour unchanged
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ]* 2.2 Write property test for deduplication idempotence
    - **Property 1: Deduplication idempotence** — for any event ID that has been successfully processed, re-delivering the same event ID shall return without invoking the consumer, regardless of how many times the event is re-delivered
    - **Validates: Requirements 3.1, 3.2**

  - [ ]* 2.3 Write property test for consumer-throw atomicity
    - **Property 2: Consumer-throw atomicity** — for any event for which the consumer throws, neither the cursor store nor the `ProcessedSet` shall contain evidence of a successful processing: `CursorStore.get()` shall return its pre-call value, and `processedSet.has(event.id)` shall return `false`
    - **Validates: Requirements 3.4, 7.3**

  - [ ]* 2.4 Write property test for no-skip contract preserved (regression guard)
    - **Property 5: No-skip contract preserved** — for any `EventCursor` constructed without a `ProcessedSet`, the cursor store is never advanced unless the consumer resolves successfully — identical behaviour to the pre-feature baseline (subsumes `vero-core-engine#179`)
    - **Validates: Requirement 3.5**

- [x] 3. Checkpoint — verify cursor layer
  - Ensure all existing `EventCursor` tests still pass, ask the user if questions arise.

- [x] 4. Create `EventStream` class with polling loop, back-off, and reorg recovery
  - [x] 4.1 Create `src/events/stream.ts` with `EventStreamConfig` interface and `EventStream` class
    - Define `EventStreamConfig<E extends StreamEvent>` interface with all fields: `cursor`, `fetch`, `consumer`, `resolveRewindTarget?`, `onReorgRewind?`, `isReorgError?`, `minDelayMs?` (default `500`), `maxDelayMs?` (default `30_000`), `signal?`
    - Import `EventCursor` and `StreamEvent` from `./cursor.js`
    - Implement `EventStream<E>` class with private fields: `stopped`, `sleepHandle`, `currentDelayMs`
    - Implement `start()`: set `stopped = false`, fire-and-forget `void this.loop()`
    - Implement `stop()`: set `stopped = true`, call `clearTimeout(this.sleepHandle)` and null the handle — no timer handles must remain after `stop()` returns
    - Implement `private sleep(ms)`: create a `Promise<void>` that stores the `setTimeout` handle in `this.sleepHandle` and nulls it on resolve
    - Implement `private isReorgError(err)`: delegate to `config.isReorgError` if provided, otherwise check `err instanceof Error && err.message.toLowerCase().includes('unresolvable')`
    - Implement `private async handleReorg(staleCursor)`: call `resolveRewindTarget` (or default to `null`), call `cursor.reset(newCursor)` if `newCursor !== null`, call `onReorgRewind?.(staleCursor, newCursor)`, reset `currentDelayMs` to `minDelayMs`
    - Implement `private async loop()`: at top of each iteration check `stopped` and `signal?.aborted`; on fetch error route to `handleReorg` or back-off; on empty page apply back-off; on non-empty page process each event through `cursor.process(event, config.consumer)` then reset delay and sleep `minDelayMs`
    - Back-off algorithm: `newDelay = min(currentDelay * 2, maxDelayMs)`, jitter `= Math.random() * newDelay * 0.1`, sleep `newDelay + jitter`, set `currentDelayMs = newDelay`
    - Check `stopped` and `signal?.aborted` before processing each event in a batch so stop() mid-batch is honoured immediately
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 4.2 Write property test for stop leaving no timer handles
    - **Property 7: Stop leaves no timer handles** — for any `EventStream` that has been started and then stopped, the number of active `setTimeout` handles attributable to the stream shall be zero immediately after `stop()` returns
    - **Validates: Requirements 4.3, 4.4**

  - [ ]* 4.3 Write property test for reorg rewind resumes correctly
    - **Property 6: Reorg rewind resumes correctly** — for any invocation of `EventStream` where `fetch` throws a reorg error with stale cursor `C_old`, after `handleReorg` completes the next call to `cursor.position()` shall return the value produced by `resolveRewindTarget(C_old)`
    - **Validates: Requirements 5.1, 5.2, 5.3**

- [x] 5. Update barrel exports
  - [x] 5.1 Modify `src/events/index.ts` to add `export * from './processed-set.js'` and `export * from './stream.js'`
    - Add `export * from './processed-set.js'` after the existing cursor export
    - Add `export * from './stream.js'` after the processed-set export
    - Preserve existing `export * from './decoder.js'` and `export * from './cursor.js'` lines unchanged
    - _Requirements: 1.3, 2.5, 6.1, 6.2_

- [x] 6. Add unit tests for all new behaviour
  - [x] 6.1 Add deduplication test group to `src/__tests__/events.test.ts`
    - Add `describe('EventCursor — deduplication (ProcessedSet)')` block
    - Test: skips consumer for an already-processed event ID (`processedSet.has` returns `true` → consumer called 0 times, cursor store unchanged)
    - Test: calls consumer exactly once on first delivery, skips on re-delivery (consumer called exactly once total)
    - _Requirements: 3.1, 3.2, 7.1_

  - [x] 6.2 Add consumer-throw atomicity test group to `src/__tests__/events.test.ts`
    - Add `describe('EventCursor — consumer throw with processedSet')` block
    - Test: when consumer throws, `processedSet.has(event.id)` is `false` and cursor store is unchanged
    - Verify the no-skip regression test (vero-core-engine#179) passes completely unchanged
    - _Requirements: 3.4, 7.2, 7.3_

  - [x] 6.3 Add `EventStream.stop()` timer-cleanup test group to `src/__tests__/events.test.ts`
    - Add `describe('EventStream.stop() — timer cleanup')` block
    - Use `jest.useFakeTimers()` / `jest.useRealTimers()` around the test
    - Test: after `stream.start()` then `stream.stop()`, `jest.getTimerCount()` equals `0`
    - _Requirements: 4.3, 4.4, 7.4_

  - [x] 6.4 Add reorg-rewind test group to `src/__tests__/events.test.ts`
    - Add `describe('EventStream — reorg rewind')` block
    - Test: `fetch` throws an error with message `'cursor unresolvable'`; assert `onReorgRewind` is called with `(oldCursor, 'rewind-target')` and the second `fetch` call receives `'rewind-target'` as position
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 7.5_

  - [x] 6.5 Add `InMemoryProcessedSet` eviction test group to `src/__tests__/events.test.ts`
    - Add `describe('InMemoryProcessedSet — bounded eviction')` block
    - Test: `new InMemoryProcessedSet(3)` — after adding `'a'`, `'b'`, `'c'`, `'d'`: `has('a')` is `false`, `has('d')` is `true`
    - Test: default `maxSize` of `10_000` — add `10_001` items; first item is evicted
    - _Requirements: 2.2, 2.3, 2.4, 7.6_

- [x] 7. Verification checkpoint — run full quality gates
  - Run `npm test` and confirm all tests pass (including the unchanged regression tests)
  - Run `npm run typecheck` and confirm zero type errors
  - Run `npm run lint` and confirm zero lint errors
  - Run `npm run build` and confirm the build succeeds
  - Ensure all tests pass, ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- The `id` field on `StreamEvent` is typed `string | undefined` (not `string`) to preserve backward compatibility — existing tests pass `{ cursor: 'x' }` with no `id`, and `EventCursor.process()` only performs the deduplication check when both `processedSet` and a non-empty `event.id` are present
- `processedSet.add` MUST always be called after `store.set`, never before — a crash between them causes a safe extra re-delivery; the reverse would cause a silent skip (the exact bug from `vero-core-engine#179`)
- `EventStream` uses self-scheduling `setTimeout` (not `setInterval`) so iterations cannot pile up if `fetch` is slow
- All intra-package imports must use `.js` extensions for ESM compatibility; `jest.config.js` strips them at test time via `moduleNameMapper`
- No new runtime dependencies are introduced — only built-in `Map`, `setTimeout`/`clearTimeout`, and `AbortSignal`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 4, "tasks": ["6.1", "6.2", "6.3", "6.4", "6.5"] }
  ]
}
```
