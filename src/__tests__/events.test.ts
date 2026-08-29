/**
 * Tests for the events module: decoder + cursor-based streaming.
 *
 * The decoder tests pin the on-chain topic abbreviations (`reg`, `wt_vote`,
 * `resolved` — see `vero-core-contracts/src/events.rs`) to their canonical
 * types, and the never-throw contract: a new contract event must not crash
 * an old consumer.
 *
 * The cursor tests guard the no-skip contract from vero-core-engine#179:
 * `EventPropagator.fetchAndEnqueue` advanced the cursor even when the enqueue
 * failed, silently losing events. The regression test below fails the moment
 * cursor persistence is moved before the consumer call.
 */

import {
  decodeEvent,
  normalizeTopic,
  TOPIC_ALIASES,
  type ConsensusResolvedEvent,
  type DecodedEvent,
  type RawContractEvent,
  type TaskRegisteredEvent,
  type UnknownEvent,
  type VoteCastEvent,
} from '../events';
import { EventCursor, type CursorStore, type StreamEvent } from '../events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Base64 XDR ScVal symbol encoding (int32 tag 15, u32 length, UTF-8 bytes). */
function scValSymbolBase64(name: string): string {
  const bytes = Buffer.byteLength(name, 'utf8');
  const buf = Buffer.alloc(8 + bytes);
  buf.writeInt32BE(15, 0); // SCV_SYMBOL
  buf.writeUInt32BE(bytes, 4);
  buf.write(name, 8, 'utf8');
  return buf.toString('base64');
}

/** A base64 XDR ScVal that is NOT a symbol (u64, tag 5) — for unknown-topic tests. */
function scValU64Base64(): string {
  const buf = Buffer.alloc(12);
  buf.writeInt32BE(5, 0); // SCV_U64
  buf.writeBigUInt64BE(42n, 4);
  return buf.toString('base64');
}

// ---------------------------------------------------------------------------
// normalizeTopic — abbreviation absorption
// ---------------------------------------------------------------------------

describe('normalizeTopic', () => {
  it('maps the on-chain abbreviations to canonical types', () => {
    expect(normalizeTopic('reg')).toBe('task_registered');
    expect(normalizeTopic('wt_vote')).toBe('vote_cast');
    expect(normalizeTopic('resolved')).toBe('consensus_resolved');
  });

  it('absorbs descriptive aliases consumers historically matched on', () => {
    for (const alias of TOPIC_ALIASES.task_registered) {
      expect(normalizeTopic(alias)).toBe('task_registered');
    }
    for (const alias of TOPIC_ALIASES.vote_cast) {
      expect(normalizeTopic(alias)).toBe('vote_cast');
    }
    for (const alias of TOPIC_ALIASES.consensus_resolved) {
      expect(normalizeTopic(alias)).toBe('consensus_resolved');
    }
  });

  it('decodes base64 XDR ScVal symbol topics', () => {
    expect(normalizeTopic(scValSymbolBase64('reg'))).toBe('task_registered');
    expect(normalizeTopic(scValSymbolBase64('wt_vote'))).toBe('vote_cast');
    expect(normalizeTopic(scValSymbolBase64('resolved'))).toBe('consensus_resolved');
  });

  it('returns null for unknown or blank names', () => {
    expect(normalizeTopic('bogus_event')).toBeNull();
    expect(normalizeTopic('')).toBeNull();
    expect(normalizeTopic('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — known events
// ---------------------------------------------------------------------------

describe('decodeEvent', () => {
  it('decodes task registration (reg) from a tuple payload', () => {
    const event = decodeEvent({
      topic: ['reg'],
      data: ['GADMIN', '42'],
      ledger: 1000,
      contractId: 'CCONTRACT',
      id: '1000-0',
    }) as TaskRegisteredEvent;

    expect(event.type).toBe('task_registered');
    expect(event.taskId).toBe(42n);
    expect(event.admin).toBe('GADMIN');
    expect(event.ledger).toBe(1000);
    expect(event.contractId).toBe('CCONTRACT');
    expect(event.id).toBe('1000-0');
  });

  it('decodes task registration from a base64 symbol topic', () => {
    const event = decodeEvent({
      topic: [scValSymbolBase64('reg')],
      data: ['GADMIN', '42'],
    }) as TaskRegisteredEvent;

    expect(event.type).toBe('task_registered');
    expect(event.taskId).toBe(42n);
  });

  it('decodes task registration from an object payload', () => {
    const event = decodeEvent({
      topic: ['reg'],
      data: { admin: 'GADMIN', task_id: '7' },
    }) as TaskRegisteredEvent;

    expect(event.type).toBe('task_registered');
    expect(event.taskId).toBe(7n);
    expect(event.admin).toBe('GADMIN');
  });

  it('decodes a weighted vote (wt_vote) with guardian-first tuple order', () => {
    const event = decodeEvent({
      topic: ['wt_vote'],
      data: ['GGUARDIAN', '99', '250'],
    }) as VoteCastEvent;

    expect(event.type).toBe('vote_cast');
    expect(event.guardian).toBe('GGUARDIAN');
    expect(event.taskId).toBe(99n);
    expect(event.weight).toBe(250n);
  });

  it('decodes a weighted vote from an object payload with native bigints', () => {
    const event = decodeEvent({
      topic: ['wt_vote'],
      data: { guardian: 'GGUARDIAN', taskId: 99n, weight: 250n },
    }) as VoteCastEvent;

    expect(event.type).toBe('vote_cast');
    expect(event.guardian).toBe('GGUARDIAN');
    expect(event.taskId).toBe(99n);
    expect(event.weight).toBe(250n);
  });

  it('decodes consensus resolution (resolved)', () => {
    const event = decodeEvent({
      topic: ['resolved'],
      data: ['123', '456'],
    }) as ConsensusResolvedEvent;

    expect(event.type).toBe('consensus_resolved');
    expect(event.taskId).toBe(123n);
    expect(event.totalWeight).toBe(456n);
  });

  it('decodes consensus resolution via the value alias and snake_case keys', () => {
    const event = decodeEvent({
      topic: ['resolved'],
      value: { task_id: '123', total_weight: '456' },
    }) as ConsensusResolvedEvent;

    expect(event.type).toBe('consensus_resolved');
    expect(event.taskId).toBe(123n);
    expect(event.totalWeight).toBe(456n);
  });

  it('coerces bigint, number, and numeric-string payload values', () => {
    expect((decodeEvent({ topic: ['reg'], data: ['GADMIN', 42n] }) as TaskRegisteredEvent).taskId).toBe(42n);
    expect((decodeEvent({ topic: ['reg'], data: ['GADMIN', 42] }) as TaskRegisteredEvent).taskId).toBe(42n);
    expect((decodeEvent({ topic: ['reg'], data: ['GADMIN', '42'] }) as TaskRegisteredEvent).taskId).toBe(42n);
  });
});

// ---------------------------------------------------------------------------
// decodeEvent — unknown events never throw
// ---------------------------------------------------------------------------

describe('decodeEvent — unknown events', () => {
  it('returns a typed unknown event for an unrecognised topic', () => {
    const raw: RawContractEvent = { topic: ['mystery_event'], data: 'x', ledger: 5 };
    const event = decodeEvent(raw) as UnknownEvent;

    expect(event.type).toBe('unknown');
    expect(event.name).toBe('mystery_event');
    expect(event.topic).toEqual(['mystery_event']);
    expect(event.data).toBe('x');
    expect(event.ledger).toBe(5);
  });

  it('treats a non-symbol base64 topic as unknown rather than crashing', () => {
    const event = decodeEvent({ topic: [scValU64Base64()], data: 'x' }) as UnknownEvent;

    expect(event.type).toBe('unknown');
    expect(event.topic).toEqual([scValU64Base64()]);
  });

  it('falls back to the raw string when base64 is malformed', () => {
    const event = decodeEvent({ topic: ['!!!not-base64'] }) as UnknownEvent;

    expect(event.type).toBe('unknown');
    expect(event.name).toBe('!!!not-base64');
  });

  it('returns unknown for an empty or missing topic', () => {
    expect(decodeEvent({}).type).toBe('unknown');
    expect(decodeEvent({ topic: [] }).type).toBe('unknown');
  });

  it('degrades a known topic with a missing payload to unknown (no throw)', () => {
    const event = decodeEvent({ topic: ['wt_vote'] }) as UnknownEvent;

    expect(event.type).toBe('unknown');
    expect(event.name).toBe('wt_vote');
  });

  it('degrades a known topic with an unparseable required field to unknown', () => {
    const event = decodeEvent({
      topic: ['reg'],
      data: ['GADMIN', 'not-a-number'],
    }) as UnknownEvent;

    expect(event.type).toBe('unknown');
    // Nothing is lost — the raw payload rides along.
    expect(event.data).toEqual(['GADMIN', 'not-a-number']);
  });

  it('never throws on garbage payloads', () => {
    const garbage: RawContractEvent[] = [
      { topic: ['reg'], data: null },
      { topic: ['reg'], data: 42 },
      { topic: ['wt_vote'], data: { guardian: 123 } },
      { topic: ['resolved'], data: [] },
      { topic: ['reg'], data: { admin: 'GADMIN', taskId: null } },
      { topic: ['wt_vote'], data: ['GGUARDIAN', '99', 'oops'] },
    ];

    for (const raw of garbage) {
      expect(() => decodeEvent(raw)).not.toThrow();
      expect(decodeEvent(raw).type).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// EventCursor — no-skip contract (vero-core-engine#179)
// ---------------------------------------------------------------------------

describe('EventCursor', () => {
  /** In-memory cursor store with an audit log of writes. */
  function makeStore(initial: string | null = null) {
    let cursor = initial;
    const writes: string[] = [];
    return {
      store: {
        get: () => cursor,
        set: async (c: string) => {
          cursor = c;
          writes.push(c);
        },
      } satisfies CursorStore,
      read: () => cursor,
      writes,
    };
  }

  it('persists the cursor only after the consumer resolves', async () => {
    const { store, read, writes } = makeStore();
    const cursor = new EventCursor(store);

    let consumerRan = false;
    const result = await cursor.process({ cursor: 'evt-1' }, async (event) => {
      consumerRan = true;
      // Mid-consumer the cursor must not have moved yet.
      expect(read()).toBeNull();
      return `handled:${event.cursor}`;
    });

    expect(consumerRan).toBe(true);
    expect(result).toBe('handled:evt-1');
    expect(read()).toBe('evt-1');
    expect(writes).toEqual(['evt-1']);
  });

  it('leaves the cursor untouched when the consumer throws (regression: vero-core-engine#179)', async () => {
    const { store, read, writes } = makeStore('evt-0');
    const cursor = new EventCursor(store);

    await expect(
      cursor.process({ cursor: 'evt-1' }, () => {
        throw new Error('enqueue failed');
      }),
    ).rejects.toThrow('enqueue failed');

    // The bug from vero-core-engine#179 advanced the cursor regardless;
    // here it must stay put so the event is re-delivered, not skipped.
    expect(read()).toBe('evt-0');
    expect(writes).toEqual([]);
  });

  it('re-delivers a failed event on retry instead of skipping it', async () => {
    const { store, read } = makeStore('evt-0');
    const cursor = new EventCursor(store);

    let attempts = 0;
    const consumer = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
    };

    await expect(cursor.process({ cursor: 'evt-1' }, consumer)).rejects.toThrow('transient');
    expect(read()).toBe('evt-0');

    // Retry succeeds — only now does the cursor move past the event.
    await cursor.process({ cursor: 'evt-1' }, consumer);
    expect(read()).toBe('evt-1');
    expect(attempts).toBe(2);
  });

  it('propagates cursor-store write failures (fails safe toward re-delivery)', async () => {
    const failing: CursorStore = {
      get: () => null,
      set: async () => {
        throw new Error('disk full');
      },
    };
    const cursor = new EventCursor(failing);

    let consumerRan = false;
    await expect(
      cursor.process({ cursor: 'evt-1' }, async () => {
        consumerRan = true;
      }),
    ).rejects.toThrow('disk full');

    // The consumer ran; the write failure surfaced rather than being
    // swallowed, so the caller knows the event may be re-delivered.
    expect(consumerRan).toBe(true);
  });

  it('position() reads the persisted cursor', async () => {
    const { store } = makeStore('evt-9');
    const cursor = new EventCursor(store);

    await expect(cursor.position()).resolves.toBe('evt-9');
    await expect(new EventCursor(makeStore().store).position()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// EventCursor.consume — batch streaming
// ---------------------------------------------------------------------------

describe('EventCursor.consume', () => {
  function makeStore(initial: string | null = null) {
    let cursor = initial;
    return {
      store: {
        get: () => cursor,
        set: async (c: string) => {
          cursor = c;
        },
      } satisfies CursorStore,
      read: () => cursor,
    };
  }

  it('processes a batch in order and ends with the last cursor', async () => {
    const { store, read } = makeStore();
    const cursor = new EventCursor(store);
    const handled: string[] = [];
    const events: StreamEvent[] = [
      { cursor: 'a' },
      { cursor: 'b' },
      { cursor: 'c' },
    ];

    const results = await cursor.consume(events, (event) => {
      handled.push(event.cursor);
      return event.cursor.toUpperCase();
    });

    expect(handled).toEqual(['a', 'b', 'c']);
    expect(results).toEqual(['A', 'B', 'C']);
    expect(read()).toBe('c');
  });

  it('stops at the first failure with the cursor at the last success (regression: vero-core-engine#179)', async () => {
    const { store, read } = makeStore();
    const cursor = new EventCursor(store);
    const handled: string[] = [];
    const events: StreamEvent[] = [
      { cursor: 'a' },
      { cursor: 'b' },
      { cursor: 'c' },
    ];

    await expect(
      cursor.consume(events, (event) => {
        handled.push(event.cursor);
        if (event.cursor === 'b') throw new Error('enqueue failed');
      }),
    ).rejects.toThrow('enqueue failed');

    // `b` and `c` were never delivered; the cursor sits at `a`, so the next
    // run resumes from `b` — nothing is skipped.
    expect(handled).toEqual(['a', 'b']);
    expect(read()).toBe('a');
  });

  it('returns an empty result for an empty batch', async () => {
    const { store, read } = makeStore('x');
    const cursor = new EventCursor(store);

    await expect(cursor.consume([], () => 'never')).resolves.toEqual([]);
    expect(read()).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Type-level sanity: DecodedEvent is a discriminated union.
// ---------------------------------------------------------------------------

describe('DecodedEvent union', () => {
  it('every decode result is one of the four event types', () => {
    const samples: DecodedEvent[] = [
      decodeEvent({ topic: ['reg'], data: ['GADMIN', '1'] }),
      decodeEvent({ topic: ['wt_vote'], data: ['GG', '1', '1'] }),
      decodeEvent({ topic: ['resolved'], data: ['1', '1'] }),
      decodeEvent({ topic: ['mystery'] }),
    ];
    const types = samples.map((e) => e.type).sort();
    expect(types).toEqual([
      'consensus_resolved',
      'task_registered',
      'unknown',
      'vote_cast',
    ]);
  });
});

import { InMemoryProcessedSet } from '../events';
import { EventStream } from '../events';

// ---------------------------------------------------------------------------
// EventCursor — deduplication (ProcessedSet)  [Requirement 3, 7.1]
// ---------------------------------------------------------------------------

describe('EventCursor — deduplication (ProcessedSet)', () => {
  function makeStore(initial: string | null = null) {
    let cursor = initial;
    const writes: string[] = [];
    return {
      store: {
        get: () => cursor,
        set: async (c: string) => {
          cursor = c;
          writes.push(c);
        },
      } satisfies CursorStore,
      read: () => cursor,
      writes,
    };
  }

  it('skips consumer for an already-processed event ID', async () => {
    const { store, read, writes } = makeStore('evt-0');
    const ps = new InMemoryProcessedSet();
    ps.add('id-1');
    const cursor = new EventCursor(store, ps);

    let consumerCalls = 0;
    const result = await cursor.process(
      { cursor: 'evt-1', id: 'id-1' },
      async () => {
        consumerCalls += 1;
      },
    );

    // Consumer must NOT have been called; cursor store must be untouched.
    expect(consumerCalls).toBe(0);
    expect(result).toBeUndefined();
    expect(read()).toBe('evt-0');
    expect(writes).toEqual([]);
  });

  it('calls consumer exactly once on first delivery, skips on re-delivery', async () => {
    const { store } = makeStore();
    const ps = new InMemoryProcessedSet();
    const cursor = new EventCursor(store, ps);

    let consumerCalls = 0;
    const event = { cursor: 'evt-1', id: 'id-1' };

    // First delivery — consumer runs.
    await cursor.process(event, async () => {
      consumerCalls += 1;
    });
    expect(consumerCalls).toBe(1);

    // Re-delivery — consumer must be skipped.
    await cursor.process(event, async () => {
      consumerCalls += 1;
    });
    expect(consumerCalls).toBe(1); // still 1 — second call was skipped
  });

  it('advances cursor and adds id on success', async () => {
    const { store, read } = makeStore();
    const ps = new InMemoryProcessedSet();
    const cursor = new EventCursor(store, ps);

    await cursor.process({ cursor: 'evt-1', id: 'id-1' }, async () => {});

    expect(read()).toBe('evt-1');
    expect(ps.has('id-1')).toBe(true);
  });

  it('behaves identically to baseline when no processedSet is provided', async () => {
    // No processedSet — pure no-skip behaviour, no dedup check.
    const { store, read, writes } = makeStore();
    const cursor = new EventCursor(store); // no processedSet

    const result = await cursor.process({ cursor: 'evt-1' }, async (ev) => `handled:${ev.cursor}`);

    expect(result).toBe('handled:evt-1');
    expect(read()).toBe('evt-1');
    expect(writes).toEqual(['evt-1']);
  });
});

// ---------------------------------------------------------------------------
// EventCursor — consumer throw with processedSet  [Requirement 3.4, 7.3]
// ---------------------------------------------------------------------------

describe('EventCursor — consumer throw with processedSet', () => {
  function makeStore(initial: string | null = null) {
    let cursor = initial;
    const writes: string[] = [];
    return {
      store: {
        get: () => cursor,
        set: async (c: string) => {
          cursor = c;
          writes.push(c);
        },
      } satisfies CursorStore,
      read: () => cursor,
      writes,
    };
  }

  it('does not add id to processedSet when consumer throws', async () => {
    const { store, read, writes } = makeStore('evt-0');
    const ps = new InMemoryProcessedSet();
    const cursor = new EventCursor(store, ps);

    await expect(
      cursor.process({ cursor: 'evt-1', id: 'id-1' }, () => {
        throw new Error('consumer failed');
      }),
    ).rejects.toThrow('consumer failed');

    // processedSet must NOT contain the id.
    expect(ps.has('id-1')).toBe(false);
    // Cursor store must be untouched (vero-core-engine#179 regression guard).
    expect(read()).toBe('evt-0');
    expect(writes).toEqual([]);
  });

  it('does not add id to processedSet when cursor store write throws', async () => {
    let storeWrites = 0;
    const failingStore: CursorStore = {
      get: () => null,
      set: async () => {
        storeWrites += 1;
        throw new Error('disk full');
      },
    };
    const ps = new InMemoryProcessedSet();
    const cursor = new EventCursor(failingStore, ps);

    await expect(
      cursor.process({ cursor: 'evt-1', id: 'id-1' }, async () => {}),
    ).rejects.toThrow('disk full');

    // Store write was attempted (consumer ran first).
    expect(storeWrites).toBe(1);
    // But id must NOT be in processedSet — store.set failed before add.
    expect(ps.has('id-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// InMemoryProcessedSet — bounded eviction  [Requirement 2, 7.6]
// ---------------------------------------------------------------------------

describe('InMemoryProcessedSet — bounded eviction', () => {
  it('never exceeds maxSize entries, evicts oldest on overflow', () => {
    const ps = new InMemoryProcessedSet(3);
    ps.add('a');
    ps.add('b');
    ps.add('c');

    // At capacity — adding 'd' must evict 'a' (FIFO)
    ps.add('d');

    expect(ps.has('a')).toBe(false); // evicted
    expect(ps.has('b')).toBe(true);
    expect(ps.has('c')).toBe(true);
    expect(ps.has('d')).toBe(true);
  });

  it('is idempotent: re-adding an existing id does not evict or change count', () => {
    const ps = new InMemoryProcessedSet(3);
    ps.add('a');
    ps.add('b');
    ps.add('c');
    ps.add('b'); // re-add — must be a no-op

    // 'a' must not have been evicted — we're still at capacity 3.
    expect(ps.has('a')).toBe(true);
    expect(ps.has('b')).toBe(true);
    expect(ps.has('c')).toBe(true);
  });

  it('evicts oldest first across multiple overflow insertions', () => {
    const ps = new InMemoryProcessedSet(3);
    ps.add('a');
    ps.add('b');
    ps.add('c');
    ps.add('d'); // evicts 'a'
    ps.add('e'); // evicts 'b'

    expect(ps.has('a')).toBe(false);
    expect(ps.has('b')).toBe(false);
    expect(ps.has('c')).toBe(true);
    expect(ps.has('d')).toBe(true);
    expect(ps.has('e')).toBe(true);
  });

  it('defaults to maxSize of 10_000', () => {
    const ps = new InMemoryProcessedSet();
    for (let i = 0; i < 10_001; i++) {
      ps.add(`id-${i}`);
    }
    // First entry 'id-0' must have been evicted.
    expect(ps.has('id-0')).toBe(false);
    // Last entry must be present.
    expect(ps.has('id-10000')).toBe(true);
  });

  it('throws RangeError for invalid maxSize', () => {
    expect(() => new InMemoryProcessedSet(0)).toThrow(RangeError);
    expect(() => new InMemoryProcessedSet(-1)).toThrow(RangeError);
    expect(() => new InMemoryProcessedSet(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// EventStream.stop() — timer cleanup  [Requirement 4.3, 4.4, 7.4]
// ---------------------------------------------------------------------------

describe('EventStream.stop() — timer cleanup', () => {
  function makeMinimalCursor(initial: string | null = null): EventCursor {
    let cursor = initial;
    const store: CursorStore = {
      get: () => cursor,
      set: async (c: string) => { cursor = c; },
    };
    return new EventCursor(store);
  }

  it('leaves no active timer handles after stop()', () => {
    jest.useFakeTimers();
    try {
      const cursor = makeMinimalCursor();
      // fetch never resolves synchronously — the stream will schedule a timer
      const fetch = jest.fn(() => new Promise<StreamEvent[]>(() => {}));
      const consumer = jest.fn(async () => {});

      const stream = new EventStream({ cursor, fetch, consumer, minDelayMs: 100 });
      stream.start();
      stream.stop();

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stop() is safe to call before start()', () => {
    jest.useFakeTimers();
    try {
      const cursor = makeMinimalCursor();
      const fetch = jest.fn(async () => [] as StreamEvent[]);
      const consumer = jest.fn(async () => {});
      const stream = new EventStream({ cursor, fetch, consumer });

      // Must not throw.
      expect(() => stream.stop()).not.toThrow();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// EventStream — reorg rewind  [Requirement 5, 7.5]
// ---------------------------------------------------------------------------

describe('EventStream — reorg rewind', () => {
  function makeTrackedCursor(initial: string | null = null) {
    let cursor = initial;
    const writes: string[] = [];
    const store: CursorStore = {
      get: () => cursor,
      set: async (c: string) => {
        cursor = c;
        writes.push(c);
      },
    };
    return { cursor: new EventCursor(store), read: () => cursor, writes };
  }

  it('calls onReorgRewind and rewinds cursor when fetch throws unresolvable error', async () => {
    const { cursor, read } = makeTrackedCursor('stale-cursor');

    const rewindTarget = 'rewind-target';
    const fetchCalls: Array<string | null> = [];
    const onReorgRewind = jest.fn();
    const resolveRewindTarget = jest.fn(async () => rewindTarget);

    // Use an AbortController so we can stop the stream after the reorg fires.
    const ac = new AbortController();
    let fetchCallCount = 0;

    const fetch = jest.fn(async (pos: string | null) => {
      fetchCalls.push(pos);
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        throw new Error('cursor unresolvable');
      }
      // After reorg handled, stop the stream so the loop doesn't spin.
      ac.abort();
      return [] as StreamEvent[];
    });

    const consumer = jest.fn(async () => {});

    const stream = new EventStream({
      cursor,
      fetch,
      consumer,
      resolveRewindTarget,
      onReorgRewind,
      signal: ac.signal,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    stream.start();

    // Wait for the async loop to process reorg + one more fetch then abort.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (fetchCallCount >= 2) { resolve(); return; }
        setImmediate(check);
      };
      check();
    });

    stream.stop();

    // onReorgRewind must have been called with old and new cursor
    expect(onReorgRewind).toHaveBeenCalledWith('stale-cursor', rewindTarget);
    // Cursor must have been rewound
    expect(read()).toBe(rewindTarget);
    // resolveRewindTarget must have been called with the stale cursor
    expect(resolveRewindTarget).toHaveBeenCalledWith('stale-cursor');
    // Second fetch must have used the rewound cursor position
    expect(fetchCalls[1]).toBe(rewindTarget);
  });

  it('rewinds to null when resolveRewindTarget is not provided', async () => {
    const { cursor, read } = makeTrackedCursor('stale-cursor');

    const onReorgRewind = jest.fn();
    const ac = new AbortController();
    let fetchCallCount = 0;

    const fetch = jest.fn(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        throw new Error('cursor is unresolvable');
      }
      ac.abort();
      return [] as StreamEvent[];
    });

    const consumer = jest.fn(async () => {});

    const stream = new EventStream({
      cursor,
      fetch,
      consumer,
      onReorgRewind,
      // No resolveRewindTarget — should default to null
      signal: ac.signal,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    stream.start();

    await new Promise<void>((resolve) => {
      const check = () => {
        if (fetchCallCount >= 2) { resolve(); return; }
        setImmediate(check);
      };
      check();
    });

    stream.stop();

    // onReorgRewind called with null as newCursor
    expect(onReorgRewind).toHaveBeenCalledWith('stale-cursor', null);
    // Cursor store not written (null rewind means no reset call)
    expect(read()).toBe('stale-cursor');
  });

  it('uses custom isReorgError predicate when provided', async () => {
    const { cursor } = makeTrackedCursor(null);

    const onReorgRewind = jest.fn();
    const ac = new AbortController();
    let fetchCallCount = 0;

    const fetch = jest.fn(async () => {
      fetchCallCount += 1;
      if (fetchCallCount === 1) {
        throw new Error('LEDGER_NOT_FOUND'); // not "unresolvable"
      }
      ac.abort();
      return [] as StreamEvent[];
    });

    const consumer = jest.fn(async () => {});

    const stream = new EventStream({
      cursor,
      fetch,
      consumer,
      onReorgRewind,
      isReorgError: (err) =>
        err instanceof Error && err.message.includes('LEDGER_NOT_FOUND'),
      signal: ac.signal,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    stream.start();

    await new Promise<void>((resolve) => {
      const check = () => {
        if (fetchCallCount >= 2) { resolve(); return; }
        setImmediate(check);
      };
      check();
    });

    stream.stop();

    // Custom predicate matched — rewind should have been triggered.
    expect(onReorgRewind).toHaveBeenCalled();
  });
});
