/**
 * Account data module
 *
 * Handles reading and decoding account data entries.
 * Reports what is on-chain without making authorization decisions.
 */

import { AccountDataEntry, ReputationData } from './types.js';

/**
 * Data key constants
 */
export const DataKey = {
  Reputation: 'reputation',
  Metadata: 'metadata',
  Profile: 'profile',
} as const;

export type DataKey = typeof DataKey[keyof typeof DataKey];

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

  try {
    // Decode base64
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    return {
      key,
      raw,
      value: decoded,
      isValid: true,
    };
  } catch {
    // Invalid base64 or non-UTF8 content
    return {
      key,
      raw,
      value: '',
      isValid: false,
    };
  }
}

/**
 * Read reputation data from account data.
 *
 * @param data - The account data map from Horizon
 * @returns The reputation data, or null if not found
 */
export function getReputation(data: Record<string, string>): ReputationData | null {
  const entry = readDataEntry(data, DataKey.Reputation);
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
  const entry = readDataEntry(data, DataKey.Metadata);
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
  const entry = readDataEntry(data, DataKey.Profile);
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
