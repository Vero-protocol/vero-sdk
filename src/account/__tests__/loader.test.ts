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

      const promise = loader.loadAccount(mockHorizonUrl, 'missing123');
      await expect(promise).rejects.toThrow(VeroError);
      await expect(promise).rejects.toMatchObject({
        code: VeroErrorCode.AccountNotFound,
      });
    });

    it('should handle network errors', async () => {
      server.failNext(
        (url) => url.endsWith('/accounts/test456'),
        { type: 'network', error: new Error('Network error') },
      );

      const promise = loader.loadAccount(mockHorizonUrl, 'test456');
      await expect(promise).rejects.toThrow(VeroError);
      await expect(promise).rejects.toMatchObject({
        code: VeroErrorCode.RpcRequestFailed,
      });
    });

    it('should handle Horizon 500 error', async () => {
      server.failNext(
        (url) => url.endsWith('/accounts/test789'),
        { type: 'http', status: 500 },
      );

      const promise = loader.loadAccount(mockHorizonUrl, 'test789');
      await expect(promise).rejects.toThrow(VeroError);
      await expect(promise).rejects.toMatchObject({
        code: VeroErrorCode.RpcRequestFailed,
      });
    });
  });

  describe('security and URL validation', () => {
    it('loadAccount("http://evil.example", ...) throws VeroError with code INVALID_URL', async () => {
      const promise = loader.loadAccount('http://evil.example', 'GABC123');
      await expect(promise).rejects.toThrow(VeroError);
      await expect(promise).rejects.toMatchObject({
        code: VeroErrorCode.InvalidUrl,
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('encodes publicKey so ../ledgers/1 does not escape /accounts/', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ account_id: '../ledgers/1', sequence: '1' }),
      });

      await loader.loadAccount(mockHorizonUrl, '../ledgers/1');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestedUrl = mockFetch.mock.calls[0][0];
      expect(requestedUrl).toBe(
        'https://horizon-testnet.stellar.org/accounts/..%2Fledgers%2F1'
      );
    });

    it('a stubbed fetch that never resolves causes loadAccount to reject within timeout', async () => {
      const neverEndingFetch = jest.fn((_url: string, init?: RequestInit) => {
        return new Promise((_, reject) => {
          if (init?.signal) {
            init.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      const promise = loader.loadAccount(mockHorizonUrl, 'GABC123', {
        timeoutMs: 50,
        fetchImpl: neverEndingFetch as unknown as typeof fetch,
      });

      await expect(promise).rejects.toThrow(VeroError);
      await expect(promise).rejects.toMatchObject({
        code: VeroErrorCode.RpcTimeout,
      });
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
