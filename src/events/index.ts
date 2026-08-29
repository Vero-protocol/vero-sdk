/**
 * Events module for vero-sdk.
 *
 * Typed contract-event decoding and cursor-based streaming with a hard
 * no-skip delivery guarantee. Consolidates the ad-hoc event handling that
 * previously lived separately in vero-core-engine/engine-bridge and the
 * guardian dashboard.
 */

// Decoder — typed event decoding with topic-abbreviation absorption.
export * from './decoder.js';

// Cursor — no-skip cursor persistence (vero-core-engine#179).
export * from './cursor.js';

// ProcessedSet — deduplication interface and in-memory default.
export * from './processed-set.js';

// EventStream — automated polling loop with back-off and reorg recovery.
export * from './stream.js';
