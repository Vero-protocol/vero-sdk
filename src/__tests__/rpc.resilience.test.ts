import { RpcClient } from '../rpc';
import { VeroError } from '../errors';

/**
 * Integration coverage for the opt-in resilience features. The no-opt-in
 * behaviour itself is pinned by rpc.test.ts — these tests additionally assert
 * that the default path creates no timers at all.
 */

const res = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

const failingEndpoint = 'https://sick.example';
const healthyEndpoint = 'https://well.example';

describe('RpcClient resilience integration', () => {
  describe('default behaviour (no opt-in)', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('leaves no timers behind after requests', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(res(200, {}));
      const client = new RpcClient({ endpoints: [failingEndpoint], fetchImpl });

      await client.request('/x');

      expect(jest.getTimerCount()).toBe(0);
    });

    it('creates no timers when healthProbe is configured but never started', async () => {
      const fetchImpl = jest.fn().mockResolvedValue(res(200, {}));
      new RpcClient({ endpoints: [failingEndpoint], fetchImpl, healthProbe: {} });

      await jest.advanceTimersByTimeAsync(60_000 * 60);

      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('circuit breaker', () => {
    it('keeps a repeatedly-failing endpoint dark past the fixed quarantine window', async () => {
      const fetchImpl = jest
        .fn()
        // First request: sick endpoint fails over to the healthy one.
        .mockImplementationOnce(() => Promise.reject(new Error('ECONNREFUSED')))
        .mockResolvedValue(res(200, {}));

      const client = new RpcClient({
        endpoints: [{ url: failingEndpoint }, { url: healthyEndpoint, priority: 10 }],
        fetchImpl,
        quarantineMs: 10, // legacy policy would restore it almost immediately…
        breaker: { failureThreshold: 1, cooldownMs: 60_000 }, // …the breaker does not
      });

      await client.request('/x');
      const callsAfterFirstRound = 2;
      expect(fetchImpl).toHaveBeenCalledTimes(callsAfterFirstRound);

      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 100);
      try {
        await client.request('/y');
        // Past quarantineMs, so without the breaker the sick endpoint would
        // have been retried first; the breaker keeps it out.
        const urls = fetchImpl.mock.calls.slice(callsAfterFirstRound).map((c) => c[0]);
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.every((u) => String(u).includes(healthyEndpoint))).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    });

    it('spends exactly one request on the half-open probe and reopens on failure', async () => {
      let sickDown = true;
      const fetchImpl = jest.fn((url: string | URL | Request) => {
        if (String(url).includes(failingEndpoint)) {
          return sickDown ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(res(200));
        }
        return Promise.resolve(res(200, { via: 'healthy' }));
      });

      const cooldownMs = 5_000;
      const client = new RpcClient({
        endpoints: [{ url: failingEndpoint }, { url: healthyEndpoint, priority: 10 }],
        fetchImpl,
        breaker: { failureThreshold: 1, cooldownMs },
      });

      await client.request('/x'); // opens A's circuit
      const callsBeforeProbe = fetchImpl.mock.calls.length;

      const realNow = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(realNow + cooldownMs + 1);
      try {
        await client.request('/y'); // half-open: exactly one probe to A, then B serves
        const probeCalls = fetchImpl.mock.calls
          .slice(callsBeforeProbe)
          .filter((c) => String(c[0]).includes(failingEndpoint));
        expect(probeCalls).toHaveLength(1);

        await client.request('/z'); // reopened by the failed probe: A untouched
        expect(
          fetchImpl.mock.calls
            .slice(callsBeforeProbe)
            .filter((c) => String(c[0]).includes(failingEndpoint)),
        ).toHaveLength(1);
      } finally {
        nowSpy.mockRestore();
        sickDown = false;
      }
    });

    it('restores full traffic through a successful half-open probe', async () => {
      const fetchImpl = jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(res(200, {}));
      const cooldownMs = 1_000;
      const client = new RpcClient({
        endpoints: [failingEndpoint],
        fetchImpl,
        breaker: { failureThreshold: 1, cooldownMs },
      });

      await expect(client.request('/x')).rejects.toBeInstanceOf(VeroError);
      expect(client.health()[0]?.breakerState).toBe('open');

      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + cooldownMs + 1);
      try {
        await expect(client.request('/x')).resolves.toEqual({});
        expect(client.health()[0]?.breakerState).toBe('closed');
        expect(client.health()[0]?.healthy).toBe(true);
      } finally {
        nowSpy.mockRestore();
      }
    });
  });

  describe('health probing', () => {
    it('returns a recovered endpoint to rotation without any user request triggering it', async () => {
      let sickUp = false;
      const fetchMock = jest.fn((url: string | URL | Request): Promise<Response> => {
        if (String(url).includes(failingEndpoint)) {
          return sickUp ? Promise.resolve(res(200)) : Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve(res(200, { via: 'healthy' }));
      });

      const client = new RpcClient({
        endpoints: [{ url: failingEndpoint }, { url: healthyEndpoint, priority: 10 }],
        fetchImpl: fetchMock as unknown as typeof fetch,
        breaker: { failureThreshold: 1, cooldownMs: 3_600_000 },
        healthProbe: {},
      });

      await client.request('/x'); // sick endpoint fails over; circuit opens
      expect(client.health()[0]?.healthy).toBe(false);

      // The endpoint came back on its own; nobody has made a user request since.
      sickUp = true;
      await client.probeOnce();

      expect(client.health()[0]?.healthy).toBe(true);
      expect(client.health()[0]?.breakerState).toBe('closed');
      expect(fetchMock.mock.calls.some((c) => String(c[0]) === `${failingEndpoint}/`)).toBe(true);

      // And rotation reflects it immediately: the formerly-sick endpoint is
      // preferred again by priority.
      await client.request('/y');
      expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(failingEndpoint);
    });

    it('startHealthProbe/stopHealthProbe control the scheduler lifecycle', async () => {
      jest.useFakeTimers();
      try {
        const fetchImpl = jest.fn().mockResolvedValue(res(200, {}));
        const client = new RpcClient({
          endpoints: [failingEndpoint],
          fetchImpl,
          healthProbe: {},
        });

        client.startHealthProbe();
        expect(jest.getTimerCount()).toBeGreaterThan(0);

        client.startHealthProbe(); // idempotent
        expect(jest.getTimerCount()).toBe(1);

        client.stopHealthProbe();
        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('resetHealth clears breakers alongside quarantines', async () => {
      const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const client = new RpcClient({
        endpoints: [failingEndpoint],
        fetchImpl,
        breaker: { failureThreshold: 1, cooldownMs: 60_000 },
      });

      await expect(client.request('/x')).rejects.toBeInstanceOf(VeroError);
      expect(client.health()[0]?.healthy).toBe(false);

      client.resetHealth();
      expect(client.health()[0]?.healthy).toBe(true);
      expect(client.health()[0]?.breakerState).toBe('closed');
    });
  });
});
