/**
 * Typed event decoding for Vero contract events.
 *
 * Every consumer of contract events — vero-core-engine/engine-bridge, the
 * guardian dashboard — used to decode raw topics its own way, duplicating
 * fragile string-matching in three places. The on-chain topic names are terse
 * abbreviations (`reg`, `wt_vote`, `resolved` — see
 * `vero-core-contracts/src/events.rs`), so any consumer that hard-codes one
 * spelling breaks the moment the contract (or its consumer) picks another.
 *
 * This module is the single place that absorbs the abbreviations: every topic
 * name seen in the wild normalises to one canonical event type, and the raw
 * topic (base64 XDR ScVal symbol or plain string) is decoded here.
 *
 * Contract: decoding NEVER throws. A topic we do not recognise — e.g. a new
 * event added in a contract upgrade — decodes to an `UnknownEvent` carrying
 * the raw topic, so an old consumer keeps running instead of crashing.
 * A known topic whose payload cannot be parsed also degrades to
 * `UnknownEvent` rather than throwing.
 */

/** Canonical event types. Consumers switch on `type`, never on topic text. */
export type EventType =
  | 'task_registered'
  | 'vote_cast'
  | 'consensus_resolved'
  | 'unknown';

/** The three known event types, without the `unknown` catch-all. */
export type KnownEventType = Exclude<EventType, 'unknown'>;

/**
 * A raw contract event, normalised to plain JS values.
 *
 * The SDK deliberately has no `@stellar/stellar-sdk` dependency, so ScVal
 * XDR decoding of the payload is the caller's job: pass the already-decoded
 * `value` (a tuple array, or an object keyed by field name) as `data`.
 * The *topic name* is decoded here, from either a plain string or the
 * base64 XDR ScVal symbol that Soroban RPC returns.
 */
export interface RawContractEvent {
  /**
   * Topic segments as emitted on-chain; `topic[0]` is the event name.
   * Accepts plain strings or base64 XDR ScVal symbols (what
   * `raw.topic.map(t => t.toXDR('base64'))` produces).
   */
  topic?: readonly unknown[];
  /**
   * The event payload. Either a tuple array in on-chain field order or an
   * object with named keys.
   */
  data?: unknown;
  /** Alias for `data` — Soroban RPC calls the payload `value`. */
  value?: unknown;
  /** Ledger the event was emitted on. */
  ledger?: number;
  /** Emitting contract id. */
  contractId?: string;
  /** Event id / paging token (used as the stream cursor). */
  id?: string;
}

/** Metadata carried on every decoded event. */
export interface EventMeta {
  ledger?: number;
  contractId?: string;
  id?: string;
}

/** A task was registered on-chain. Topic: `reg`, data: `(admin, task_id)`. */
export interface TaskRegisteredEvent extends EventMeta {
  type: 'task_registered';
  /** Contract-side task identifier. */
  taskId: bigint;
  /** Address of the caller that registered the task. */
  admin?: string;
}

/** A Guardian cast a weighted vote. Topic: `wt_vote`, data: `(guardian, task_id, weight)`. */
export interface VoteCastEvent extends EventMeta {
  type: 'vote_cast';
  /** Stellar account of the voting Guardian. */
  guardian: string;
  /** Contract-side task identifier. */
  taskId: bigint;
  /** Weight contributed, derived from the Guardian's reputation. */
  weight?: bigint;
}

/** A task reached consensus. Topic: `resolved`, data: `(task_id, total_weight)`. */
export interface ConsensusResolvedEvent extends EventMeta {
  type: 'consensus_resolved';
  /** Contract-side task identifier. */
  taskId: bigint;
  /** Total accrued vote weight at resolution. */
  totalWeight?: bigint;
}

/** A topic we do not recognise (or a known topic with an unparseable payload). */
export interface UnknownEvent extends EventMeta {
  type: 'unknown';
  /** The topic name, decoded to a plain string when possible. */
  name: string;
  /** The full raw topic, preserved verbatim for diagnostics. */
  topic: readonly unknown[];
  /** The raw payload, when present. */
  data?: unknown;
}

export type DecodedEvent =
  | TaskRegisteredEvent
  | VoteCastEvent
  | ConsensusResolvedEvent
  | UnknownEvent;

/**
 * Every spelling of a topic name that maps to a canonical event type.
 * The on-chain abbreviations (`reg`, `wt_vote`, `resolved`) come first;
 * the descriptive aliases are the spellings consumers have historically
 * matched on. Extend this table rather than teaching consumers new names.
 */
export const TOPIC_ALIASES: Record<KnownEventType, readonly string[]> = {
  task_registered: [
    'reg',
    'task_registered',
    'task_reg',
    'register_task',
    'task_created',
    'TaskRegistered',
  ],
  vote_cast: ['wt_vote', 'vote_cast', 'vote', 'cast_vote', 'weighted_vote', 'VoteCast'],
  consensus_resolved: [
    'resolved',
    'consensus_resolved',
    'consensus',
    'task_resolved',
    'ConsensusResolved',
  ],
};

/**
 * Map a topic name to its canonical event type.
 *
 * Accepts plain strings and base64 XDR ScVal symbols (what Soroban RPC
 * returns for `topic[0]`).
 *
 * @returns The canonical type, or `null` when the name is unknown or blank.
 */
export function normalizeTopic(name: string): KnownEventType | null {
  // Decode base64 XDR ScVal symbols (raw RPC `topic[0]`) before matching;
  // plain strings pass through unchanged.
  const decoded = decodeScValSymbol(name) ?? name;
  const trimmed = decoded.trim();
  if (trimmed === '') return null;
  for (const [type, aliases] of Object.entries(TOPIC_ALIASES) as [
    KnownEventType,
    readonly string[],
  ][]) {
    if (aliases.includes(trimmed)) return type;
  }
  return null;
}

/**
 * Decode a raw contract event into a typed object.
 *
 * Never throws. Unknown topics and unparseable known topics both produce an
 * `UnknownEvent` with the raw topic preserved.
 */
export function decodeEvent(raw: RawContractEvent): DecodedEvent {
  const topic = raw.topic ?? [];
  const name = topic.length > 0 ? decodeTopicName(topic[0]) : '';

  switch (normalizeTopic(name)) {
    case 'task_registered':
      return decodeTaskRegistered(raw);
    case 'vote_cast':
      return decodeVoteCast(raw);
    case 'consensus_resolved':
      return decodeConsensusResolved(raw);
    default:
      return toUnknown(raw);
  }
}

// ---------------------------------------------------------------------------
// Topic-name decoding
// ---------------------------------------------------------------------------

/** XDR `SCValType` discriminant for symbols (see Stellar-contract.x). */
const SCV_SYMBOL = 15;

/**
 * Decode a base64 XDR ScVal symbol to its string form.
 *
 * A symbol ScVal is: int32 tag `SCV_SYMBOL` (15), u32 byte length, then
 * UTF-8 bytes. Returns `undefined` for anything that is not exactly that
 * shape, so callers can fall back to treating the input as a plain string.
 */
function decodeScValSymbol(base64: string): string | undefined {
  // Cheap reject of obviously-not-base64 input before touching a Buffer.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return undefined;

  let buf: Buffer;
  try {
    buf = Buffer.from(base64, 'base64');
  } catch {
    return undefined;
  }
  if (buf.length < 8) return undefined;
  if (buf.readInt32BE(0) !== SCV_SYMBOL) return undefined;
  const len = buf.readUInt32BE(4);
  // Symbols are capped at 32 bytes on-chain (SCSYMBOL_LIMIT).
  if (len > 32 || buf.length !== 8 + len) return undefined;
  return buf.subarray(8, 8 + len).toString('utf8');
}

/** Coerce `topic[0]` to a plain-string topic name, decoding base64 symbols. */
function decodeTopicName(value: unknown): string {
  if (typeof value === 'string') {
    return decodeScValSymbol(value) ?? value;
  }
  return value === null || value === undefined ? '' : String(value);
}

// ---------------------------------------------------------------------------
// Payload extraction
// ---------------------------------------------------------------------------

/** The payload to decode from, honouring `data` over the `value` alias. */
function payloadOf(raw: RawContractEvent): unknown {
  return raw.data !== undefined ? raw.data : raw.value;
}

interface FieldSpec {
  /** Position in a tuple-form payload. */
  index?: number;
  /** Key(s) to try on an object-form payload, in order. */
  keys?: readonly string[];
}

/** Extract a field from a tuple array or a named-key object. */
function pickField(payload: unknown, spec: FieldSpec): unknown {
  if (Array.isArray(payload)) {
    return spec.index !== undefined ? payload[spec.index] : undefined;
  }
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of spec.keys ?? []) {
      if (key in record) return record[key];
    }
  }
  return undefined;
}

function asBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return undefined;
    return BigInt(value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      return BigInt(value.trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

// ---------------------------------------------------------------------------
// Per-event decoders
// ---------------------------------------------------------------------------

function decodeTaskRegistered(raw: RawContractEvent): DecodedEvent {
  const payload = payloadOf(raw);
  const admin = asString(pickField(payload, { index: 0, keys: ['admin'] }));
  const taskId = asBigInt(pickField(payload, { index: 1, keys: ['taskId', 'task_id'] }));
  if (taskId === undefined) return toUnknown(raw);
  return { type: 'task_registered', taskId, admin, ...metaOf(raw) };
}

function decodeVoteCast(raw: RawContractEvent): DecodedEvent {
  const payload = payloadOf(raw);
  const guardian = asString(pickField(payload, { index: 0, keys: ['guardian'] }));
  const taskId = asBigInt(pickField(payload, { index: 1, keys: ['taskId', 'task_id'] }));
  const weight = asBigInt(pickField(payload, { index: 2, keys: ['weight'] }));
  if (guardian === undefined || taskId === undefined) return toUnknown(raw);
  return { type: 'vote_cast', guardian, taskId, weight, ...metaOf(raw) };
}

function decodeConsensusResolved(raw: RawContractEvent): DecodedEvent {
  const payload = payloadOf(raw);
  const taskId = asBigInt(pickField(payload, { index: 0, keys: ['taskId', 'task_id'] }));
  const totalWeight = asBigInt(
    pickField(payload, { index: 1, keys: ['totalWeight', 'total_weight'] }),
  );
  if (taskId === undefined) return toUnknown(raw);
  return { type: 'consensus_resolved', taskId, totalWeight, ...metaOf(raw) };
}

function toUnknown(raw: RawContractEvent): UnknownEvent {
  const topic = raw.topic ?? [];
  const name = topic.length > 0 ? decodeTopicName(topic[0]) : '';
  return { type: 'unknown', name, topic, data: payloadOf(raw), ...metaOf(raw) };
}

function metaOf(raw: RawContractEvent): EventMeta {
  return { ledger: raw.ledger, contractId: raw.contractId, id: raw.id };
}
