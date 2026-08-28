/**
 * Account data module
 *
 * Handles reading and decoding account data entries.
 * Reports what is on-chain without making authorization decisions.
 */

import { AccountDataEntry, ReputationData } from './types.js';

/**
 * Horizon account data-entry names.
 *
 * Named `AccountDataKey` so it does not collide with the contract storage
 * `DataKey` in `src/types` when both are re-exported from the package root.
 */
export const AccountDataKey = {
  Reputation: 'reputation',
  Metadata: 'metadata',
  Profile: 'profile',
} as const;

export type AccountDataKey = typeof AccountDataKey[keyof typeof AccountDataKey];

/**
 * Strip trailing base64 padding so two equivalent encodings compare equal.
 */
function stripPadding(s: string): string {
  return s.replace(/=+$/, '');
}

/**
 * Read and decode an account data entry.
 *
 * @param data - The account data map from Horizon
 * @param key - The key to look up
 * @returns The decoded entry, or null if not found
 */
export function readDataEntry(
  data: Record<string, string>,
  key: string
): AccountDataEntry | null {
  const raw = data[key];
  if (raw === undefined) {
    return null;
  }

  // `Buffer.from(raw, 'base64')` is lossy: it silently discards characters
  // that are not valid base64 and never throws. Re-encode the decoded bytes
  // and compare against the input to prove `raw` was genuinely valid base64
  // before trusting it. Without this, the validity flag was always `true`.
  const decoded = Buffer.from(raw, 'base64');
  const isBase64 = stripPadding(decoded.toString('base64')) === stripPadding(raw);

  if (!isBase64) {
    return { key, raw, value: '', isValid: false };
  }

  // Even valid base64 may encode bytes that are not valid UTF-8. `toString`
  // would silently substitute U+FFFD, so decode with a fatal TextDecoder and
  // treat lossy output as invalid.
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    return { key, raw, value, isValid: true };
  } catch {
    return { key, raw, value: '', isValid: false };
  }
}

/**
 * Read reputation data from account data.
 *
 * @param data - The account data map from Horizon
 * @returns The reputation data, or null if not found
 */
export function getReputation(data: Record<string, string>): ReputationData | null {
  const entry = readDataEntry(data, AccountDataKey.Reputation);
  if (!entry || !entry.isValid) {
    return null;
  }

  try {
    const parsed = JSON.parse(entry.value);
    const score = typeof parsed.score === 'number' ? parsed.score : 0;
    
    return {
      score,
      tier: getReputationTier(score),
      metadata: parsed.metadata || {},
    };
  } catch {
    // Invalid JSON, treat as malformed
    return null;
  }
}

/**
 * Get reputation tier based on score.
 */
function getReputationTier(score: number): 'bronze' | 'silver' | 'gold' | 'platinum' | 'unknown' {
  if (score >= 1000) return 'platinum';
  if (score >= 500) return 'gold';
  if (score >= 100) return 'silver';
  if (score >= 10) return 'bronze';
  return 'unknown';
}

/**
 * Read metadata from account data.
 */
export function getMetadata(data: Record<string, string>): Record<string, unknown> | null {
  const entry = readDataEntry(data, AccountDataKey.Metadata);
  if (!entry || !entry.isValid) {
    return null;
  }

  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}

/**
 * Read profile data from account data.
 */
export function getProfile(data: Record<string, string>): Record<string, unknown> | null {
  const entry = readDataEntry(data, AccountDataKey.Profile);
  if (!entry || !entry.isValid) {
    return null;
  }

  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}

/**
 * Check if an account has a specific data entry.
 */
export function hasDataEntry(data: Record<string, string>, key: string): boolean {
  return data[key] !== undefined;
}

/**
 * List all data entries with decoded values.
 */
export function listDataEntries(data: Record<string, string>): AccountDataEntry[] {
  return Object.keys(data)
    .map((key) => readDataEntry(data, key))
    .filter((entry): entry is AccountDataEntry => entry !== null);
}

/**
 * Check if an account is a validator (has validator data).
 */
export function isValidator(data: Record<string, string>): boolean {
  return hasDataEntry(data, 'validator') || hasDataEntry(data, 'is_validator');
}
