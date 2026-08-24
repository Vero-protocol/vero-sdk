/**
 * Account loader module
 *
 * Handles loading Horizon accounts with safe caching.
 * Cache is off by default; must be explicitly enabled.
 * skipCache always reaches the network.
 */

import {
  HorizonAccount,
  LoadAccountOptions,
  BalanceLine,
} from './types.js';
import { validateUrl } from '../network/index.js';
import { VeroError, VeroErrorCode, normalizeError } from '../errors/index.js';

/**
 * Account cache entry
 */
interface CacheEntry {
  account: HorizonAccount;
  timestamp: number;
  ttl: number;
}

/**
 * Account loader class
 */
export class AccountLoader {
  private cache: Map<string, CacheEntry> = new Map();
  private readonly defaultTTL: number = 60000; // 1 minute

  /**
   * Load an account from Horizon or cache.
   *
   * @param horizonUrl - The Horizon URL
   * @param publicKey - The public key of the account to load
   * @param opts - Load options
   * @returns The Horizon account data
   * @throws {VeroError} If the URL is invalid, request fails, or account is not found
   */
  async loadAccount(
    horizonUrl: string,
    publicKey: string,
    opts: LoadAccountOptions = {}
  ): Promise<HorizonAccount> {
    const { cache = false, skipCache = false, cacheTTL = this.defaultTTL } = opts;

    // If skipCache is explicitly requested, bypass cache entirely
    if (skipCache) {
      return this.fetchAccount(horizonUrl, publicKey, opts);
    }

    // Check cache if enabled
    if (cache) {
      const cached = this.getCached(publicKey);
      if (cached) {
        return cached;
      }
    }

    // Fetch from network
    const account = await this.fetchAccount(horizonUrl, publicKey, opts);

    // Store in cache if enabled
    if (cache) {
      this.setCached(publicKey, account, cacheTTL);
    }

    return account;
  }

  /**
   * Fetch an account directly from Horizon (no cache)
   */
  private async fetchAccount(
    horizonUrl: string,
    publicKey: string,
    opts: LoadAccountOptions = {}
  ): Promise<HorizonAccount> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

    if (typeof fetchImpl !== 'function') {
      throw new VeroError(
        VeroErrorCode.RpcRequestFailed,
        'No fetch implementation available — pass fetchImpl explicitly'
      );
    }

    const baseUrl = validateUrl(horizonUrl, opts.urlOptions);
    const base = baseUrl.toString().endsWith('/') ? baseUrl.toString() : `${baseUrl.toString()}/`;
    const targetUrl = new URL(`accounts/${encodeURIComponent(publicKey)}`, base);

    if (targetUrl.origin !== baseUrl.origin) {
      throw new VeroError(
        VeroErrorCode.InvalidUrl,
        `Request path for public key "${publicKey}" would escape endpoint origin ${horizonUrl}`
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(targetUrl.toString(), {
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new VeroError(
            VeroErrorCode.AccountNotFound,
            `Account not found: ${publicKey}`
          );
        }
        throw new VeroError(
          VeroErrorCode.RpcRequestFailed,
          `Horizon error: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      return this.normalizeAccount(data);
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw new VeroError(
          VeroErrorCode.RpcTimeout,
          `Request timed out after ${timeoutMs}ms`,
          error
        );
      }
      throw normalizeError(error, VeroErrorCode.RpcRequestFailed);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get cached account if valid
   */
  private getCached(publicKey: string): HorizonAccount | null {
    const entry = this.cache.get(publicKey);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      // Cache expired
      this.cache.delete(publicKey);
      return null;
    }

    return entry.account;
  }

  /**
   * Store account in cache
   */
  private setCached(publicKey: string, account: HorizonAccount, ttl: number): void {
    this.cache.set(publicKey, {
      account,
      timestamp: Date.now(),
      ttl,
    });
  }

  /**
   * Force refresh of cached account
   */
  async refreshCache(
    horizonUrl: string,
    publicKey: string,
    opts: LoadAccountOptions = {}
  ): Promise<HorizonAccount> {
    const account = await this.fetchAccount(horizonUrl, publicKey, opts);
    this.cache.delete(publicKey);
    return account;
  }

  /**
   * Clear all cached accounts
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Remove a specific account from cache
   */
  evict(publicKey: string): void {
    this.cache.delete(publicKey);
  }

  /**
   * Normalize Horizon account response
   */
  private normalizeAccount(data: unknown): HorizonAccount {
    const d = data as Record<string, unknown>;
    const signers = d.signers as Array<{ public_key: string; weight: number; key?: string }> || [];
    const balances = d.balances as BalanceLine[] || [];
    const flags = d.flags as Record<string, boolean> | undefined;
    const thresholds = d.thresholds as Record<string, number> | undefined;

    return {
      account_id: d.account_id as string || '',
      sequence: d.sequence as string || '',
      flags: {
        auth_required: flags?.auth_required || false,
        auth_revocable: flags?.auth_revocable || false,
        auth_immutable: flags?.auth_immutable || false,
      },
      signers,
      thresholds: {
        low_threshold: thresholds?.low_threshold || 0,
        med_threshold: thresholds?.med_threshold || 0,
        high_threshold: thresholds?.high_threshold || 0,
      },
      balances,
      data: (d.data as Record<string, string>) || {},
      last_modified_ledger: (d.last_modified_ledger as number) || 0,
      last_modified_time: d.last_modified_time as string | undefined,
    };
  }
}

// Export a singleton instance
export const accountLoader = new AccountLoader();
