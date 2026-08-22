/**
 * Tests for the account loader module
 */

import { AccountLoader } from '../loader';
import { AccountNotFoundError } from '../types';

// Mock the fetch function
global.fetch = jest.fn();

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
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
      fetchSpy.mockResolvedValue({
        account_id: 'test123',
        sequence: '123',
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        signers: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        balances: [],
        data: {},
        last_modified_ledger: 100,
      });

      await loader.loadAccount(mockHorizonUrl, 'test123', {
        cache: true,
        skipCache: true,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      fetchSpy.mockRestore();
    });

    it('should use cache when enabled and skipCache is false', async () => {
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
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
      fetchSpy.mockResolvedValue(mockAccount);

      // First call should fetch
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Second call should use cache
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      fetchSpy.mockRestore();
    });

    it('should not use cache when cache is disabled', async () => {
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
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
      fetchSpy.mockResolvedValue(mockAccount);

      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      fetchSpy.mockRestore();
    });

    it('should throw AccountNotFoundError for missing account', async () => {
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
      fetchSpy.mockRejectedValue(new AccountNotFoundError('missing123'));

      await expect(
        loader.loadAccount(mockHorizonUrl, 'missing123')
      ).rejects.toThrow(AccountNotFoundError);

      fetchSpy.mockRestore();
    });
  });

  describe('cache management', () => {
    it('should evict specific account from cache', async () => {
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
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
      fetchSpy.mockResolvedValue(mockAccount);

      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      loader.evict('test999');

      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      fetchSpy.mockRestore();
    });

    it('should clear all cache', async () => {
      const fetchSpy = jest.spyOn(loader as any, 'fetchAccount');
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
      fetchSpy.mockResolvedValue(mockAccount);

      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      loader.clearCache();

      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);

      fetchSpy.mockRestore();
    });
  });
});
