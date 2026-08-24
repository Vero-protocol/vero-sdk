/**
 * Tests for the account loader module.
 *
 * The loader calls global `fetch` directly (it has no injectable fetchImpl),
 * so these tests point `global.fetch` at the mock Horizon server from
 * `src/testing` and restore it afterwards.
 */

import { AccountLoader } from '../loader';
import { AccountNotFoundError } from '../types';
import { createMockServer, horizonAccountFixture, type MockServer } from '../../testing';

const originalFetch = global.fetch;

describe('AccountLoader', () => {
  let loader: AccountLoader;
  let server: MockServer;
  const mockHorizonUrl = 'https://horizon-testnet.stellar.org';

  beforeEach(() => {
    server = createMockServer();
    global.fetch = server.fetch;
    loader = new AccountLoader();
    loader.clearCache();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('loadAccount', () => {
    it('should skip cache when skipCache is true', async () => {
      await loader.loadAccount(mockHorizonUrl, 'test123', {
        cache: true,
        skipCache: true,
      });

      expect(server.requests).toHaveLength(1);
    });

    it('should use cache when enabled and skipCache is false', async () => {
      // First call should fetch
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(server.requests).toHaveLength(1);

      // Second call should use cache
      await loader.loadAccount(mockHorizonUrl, 'test456', { cache: true });
      expect(server.requests).toHaveLength(1);
    });

    it('should not use cache when cache is disabled', async () => {
      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(server.requests).toHaveLength(1);

      await loader.loadAccount(mockHorizonUrl, 'test789', { cache: false });
      expect(server.requests).toHaveLength(2);
    });

    it('should throw AccountNotFoundError for missing account', async () => {
      server.failNext(
        (url) => url.endsWith('/accounts/missing123'),
        { type: 'http', status: 404, body: { title: 'Resource Missing', status: 404 } },
      );

      await expect(
        loader.loadAccount(mockHorizonUrl, 'missing123')
      ).rejects.toThrow(AccountNotFoundError);
    });

    it('should handle network errors', async () => {
      server.failNext(
        (url) => url.endsWith('/accounts/test456'),
        { type: 'network', error: new Error('Network error') },
      );

      await expect(
        loader.loadAccount(mockHorizonUrl, 'test456')
      ).rejects.toThrow('Failed to load account test456');
    });

    it('should handle Horizon 500 error', async () => {
      server.failNext(
        (url) => url.endsWith('/accounts/test789'),
        { type: 'http', status: 500 },
      );

      await expect(
        loader.loadAccount(mockHorizonUrl, 'test789')
      ).rejects.toThrow('Failed to load account test789');
    });
  });

  describe('cache management', () => {
    it('should evict specific account from cache', async () => {
      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(server.requests).toHaveLength(1);

      loader.evict('test999');

      await loader.loadAccount(mockHorizonUrl, 'test999', { cache: true });
      expect(server.requests).toHaveLength(2);
    });

    it('should clear all cache', async () => {
      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(server.requests).toHaveLength(1);

      loader.clearCache();

      await loader.loadAccount(mockHorizonUrl, 'test111', { cache: true });
      expect(server.requests).toHaveLength(2);
    });

    it('should refresh cache', async () => {
      const first = await loader.loadAccount(mockHorizonUrl, 'test222', { cache: true });
      expect(server.requests).toHaveLength(1);

      const result = await loader.refreshCache(mockHorizonUrl, 'test222');
      // The mock server bumps the on-chain sequence on every fetch, so the
      // refresh must observe a newer sequence than the first load.
      expect(BigInt(result.sequence)).toBe(BigInt(first.sequence) + 1n);
      expect(server.requests).toHaveLength(2);
    });

    it('should expire cache after TTL', async () => {
      jest.useFakeTimers();
      try {
        await loader.loadAccount(mockHorizonUrl, 'test333', { cache: true, cacheTTL: 100 });
        expect(server.requests).toHaveLength(1);

        // Advance time past TTL
        jest.advanceTimersByTime(150);

        await loader.loadAccount(mockHorizonUrl, 'test333', { cache: true });
        expect(server.requests).toHaveLength(2);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('normalizeAccount', () => {
    it('should handle missing fields gracefully', async () => {
      server.handle(
        (url) => url.endsWith('/accounts/test444'),
        { account_id: 'test444' },
      );

      const result = await loader.loadAccount(mockHorizonUrl, 'test444');
      expect(result.account_id).toBe('test444');
      expect(result.sequence).toBe('');
      expect(result.flags.auth_required).toBe(false);
      expect(result.signers).toEqual([]);
      expect(result.balances).toEqual([]);
      expect(result.data).toEqual({});
    });

    it('should normalize a realistic Horizon account response', async () => {
      const fixture = horizonAccountFixture({ account_id: 'test555' });
      server.handle((url) => url.endsWith('/accounts/test555'), fixture);

      const result = await loader.loadAccount(mockHorizonUrl, 'test555');
      expect(result.account_id).toBe('test555');
      expect(result.sequence).toBe(fixture.sequence);
      expect(result.flags.auth_revocable).toBe(false);
      expect(result.balances.some((b) => b.asset_type === 'native')).toBe(true);
      expect(result.signers).toHaveLength(1);
    });
  });
});
