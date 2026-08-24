/**
 * Tests for the account loader module
 */

import { AccountLoader } from '../loader';
import { AccountNotFoundError } from '../types';

// Mock the fetch function
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('AccountLoader', () => {
  let loader: AccountLoader;
  const mockHorizonUrl = 'https://horizon-testnet.stellar.org';

  beforeEach(() => {
    loader = new AccountLoader();
    loader.clearCache();
    jest.clearAllMocks();
  });

  describe('loadAccount', () => {
    it('should skip cache when skipCache is true', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: 'test123',
          sequence: '123',
          flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
          signers: [],
          thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
          balances: [],
          data: {},
          last_modified_ledger: 100,
        }),
      });

      await loader.loadAccount(mockHorizonUrl, 'test123', {
        cache: true,
        skipCache: true,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should use cache when enabled and skipCache is false', async () => {
      const mockAccount = {
        account_id: 'test456',
        sequence: '456',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockAccount,
      });

      // First call should fetch
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should not use cache when cache is disabled', async () => {
      const mockAccount = {
        account_id: 'test789',
        sequence: '789',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockAccount,
      });

      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should throw AccountNotFoundError for missing account', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      await expect(
        loader.loadAccount(mockHorizonUrl, 'missing123')
      ).rejects.toThrow(AccountNotFoundError);
    });

    it('should handle network errors', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        loader.loadAccount(mockHorizonUrl, 'test456')
      ).rejects.toThrow('Failed to load account test456');
    });

    it('should handle Horizon 500 error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(
        loader.loadAccount(mockHorizonUrl, 'test789')
      ).rejects.toThrow('Failed to load account test789');
    });
  });

  describe('cache management', () => {
    it('should evict specific account from cache', async () => {
      const mockAccount = {
        account_id: 'test999',
        sequence: '999',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockAccount,
      });

      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      loader.evict('test999');

      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should clear all cache', async () => {
      const mockAccount = {
        account_id: 'test111',
        sequence: '111',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockAccount,
      });

      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      loader.clearCache();

      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should refresh cache', async () => {
      const mockAccount = {
        account_id: 'test222',
        sequence: '222',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };
      const updatedAccount = {
        ...mockAccount,
        sequence: '223',
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockAccount,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => updatedAccount,
        });

      await loader.loadAccount(mockHorizonUrl, 'test222', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const result = await loader.refreshCache(mockHorizonUrl, 'test222');
      expect(result.sequence).toBe('223');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should expire cache after TTL', async () => {
      jest.useFakeTimers();
      const mockAccount = {
        account_id: 'test333',
        sequence: '333',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockAccount,
      });

      await loader.loadAccount(mockHorizonUrl, 'test333', { cache: true, cacheTTL: 100 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Advance time past TTL
      jest.advanceTimersByTime(150);

      await loader.loadAccount(mockHorizonUrl, 'test333', { cache: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      jest.useRealTimers();
    });
  });

  describe('normalizeAccount', () => {
    it('should handle missing fields gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          account_id: 'test444',
          // Missing sequence, flags, signers, thresholds, balances, data
        }),
      });

      const result = await loader.loadAccount(mockHorizonUrl, 'test444');
      expect(result.account_id).toBe('test444');
      expect(result.sequence).toBe('');
      expect(result.flags.auth_required).toBe(false);
      expect(result.signers).toEqual([]);
      expect(result.balances).toEqual([]);
      expect(result.data).toEqual({});
    });
  });
});
