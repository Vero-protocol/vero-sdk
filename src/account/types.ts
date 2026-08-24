/**
 * Account module types for vero-sdk.
 *
 * Provides typed interfaces for Horizon account access, safe caching,
 * and balance handling.
 */

/**
 * Balance line type from Horizon
 */
export interface BalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  last_modified_ledger?: number;
}

/**
 * Account information from Horizon
 */
export interface HorizonAccount {
  /** The account ID (public key) */
  account_id: string;
  /** Current sequence number */
  sequence: string;
  /** Account flags */
  flags: {
    auth_required: boolean;
    auth_revocable: boolean;
    auth_immutable: boolean;
  };
  /** Signers for this account */
  signers: Array<{
    public_key: string;
    weight: number;
    key?: string;
  }>;
  /** Account thresholds */
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  /** Account balances */
  balances: BalanceLine[];
  /** Account data entries */
  data: Record<string, string>;
  /** Last modified ledger */
  last_modified_ledger: number;
  /** Last modified time (ISO string) */
  last_modified_time?: string;
}

/**
 * Options for loading an account
 */
export interface LoadAccountOptions {
  /** Whether to use cached data (default: false) */
  cache?: boolean;
  /** Whether to skip cache and always fetch from network (default: true for sequence-sensitive operations) */
  skipCache?: boolean;
  /** Time-to-live for cached account data in milliseconds (default: 60000) */
  cacheTTL?: number;
}

/**
 * Account data entry with typed value
 */
export interface AccountDataEntry {
  /** The key of the data entry */
  key: string;
  /** The raw base64-encoded value */
  raw: string;
  /** The decoded value as a string (UTF-8) */
  value: string;
  /** Whether the entry was valid UTF-8 */
  isValid: boolean;
}

/**
 * Account balance information
 */
export interface AccountBalance {
  /** The asset code (e.g., "XLM" for native) */
  assetCode: string;
  /** The asset issuer (null for native) */
  assetIssuer: string | null;
  /** The balance amount in stroops (as bigint) */
  amount: bigint;
  /** The balance amount in units (as a string) */
  amountUnits: string;
  /** Whether this is the native asset (XLM) */
  isNative: boolean;
}

/**
 * Reputation data from account data entries
 */
export interface ReputationData {
  /** The reputation score */
  score: number;
  /** The reputation tier */
  tier: 'bronze' | 'silver' | 'gold' | 'platinum' | 'unknown';
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Error thrown when an account is not found
 */
export class AccountNotFoundError extends Error {
  constructor(publicKey: string) {
    super(`Account not found: ${publicKey}`);
    this.name = 'AccountNotFoundError';
  }
}

/**
 * Error thrown when caching is enabled but cache is stale
 */
export class StaleCacheError extends Error {
  constructor(publicKey: string) {
    super(`Stale cache data for account: ${publicKey}`);
    this.name = 'StaleCacheError';
  }
}

/**
 * Error thrown when account data is malformed
 */
export class MalformedAccountDataError extends Error {
  constructor(key: string, reason: string) {
    super(`Malformed account data for key "${key}": ${reason}`);
    this.name = 'MalformedAccountDataError';
  }
}
