import { RpcClient } from '../rpc';
import { VeroError, VeroErrorCode } from '../errors';

/** Minimal Response stand-in — avoids depending on a DOM/undici Response. */
const res = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('RpcClient', () => {
  it('requires at least one endpoint', () => {
    expect(() => new RpcClient({ endpoints: [], fetchImpl: jest.fn() })).toThrow(VeroError);
  });

  it('validates endpoint URLs at construction', () => {
    expect(() => new RpcClient({ endpoints: ['http://evil.example'], fetchImpl: jest.fn() })).toThrow(
      VeroError,
    );
  });

  it('returns the parsed body on success', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(200, { ok: true }));
    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl });
    await expect(client.request('/accounts/GABC')).resolves.toEqual({ ok: true });
  });

  it('falls over to the next endpoint on transport failure', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(res(200, { via: 'second' }));

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl,
    });

    await expect(client.request('/x')).resolves.toEqual({ via: 'second' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats 5xx as a transport failure and fails over', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(res(503))
      .mockResolvedValueOnce(res(200, { via: 'second' }));

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl,
    });

    await expect(client.request('/x')).resolves.toEqual({ via: 'second' });
  });

  // Regression guard for vero-core-engine#182.
  it('does NOT penalise an endpoint for an application-level 4xx', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(404));
    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl,
      failureThreshold: 1,
    });

    await expect(client.request('/accounts/missing')).rejects.toMatchObject({
      code: VeroErrorCode.AccountNotFound,
    });

    // Only the first endpoint was tried, and it stays healthy.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.health().every((h) => h.healthy)).toBe(true);
  });

  it('quarantines an endpoint after the failure threshold', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new RpcClient({
      endpoints: ['https://a.example'],
      fetchImpl,
      failureThreshold: 2,
    });

    await expect(client.request('/x')).rejects.toThrow(VeroError);
    expect(client.health()[0]?.healthy).toBe(true); // 1 failure, below threshold

    await expect(client.request('/x')).rejects.toThrow(VeroError);
    expect(client.health()[0]?.healthy).toBe(false);
  });

  it('throws ALL_ENDPOINTS_FAILED when nothing succeeds', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example'],
      fetchImpl,
    });

    await expect(client.request('/x')).rejects.toMatchObject({
      code: VeroErrorCode.AllEndpointsFailed,
    });
  });

  it('resets a consecutive-failure count after a success', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(res(200, {}));

    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl });
    await expect(client.request('/x')).rejects.toThrow();
    await expect(client.request('/x')).resolves.toEqual({});
    expect(client.health()[0]?.consecutiveFailures).toBe(0);
  });

  // Regression guard for the SSRF pattern in vero-audit-guard#302.
  it('refuses a path that would escape the endpoint origin', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(200, {}));
    const client = new RpcClient({ endpoints: ['https://a.example'], fetchImpl });

    await expect(client.request('https://evil.example/steal')).rejects.toMatchObject({
      code: VeroErrorCode.InvalidUrl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('honours endpoint priority', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(res(200, {}));
    const client = new RpcClient({
      endpoints: [
        { url: 'https://low.example', priority: 10 },
        { url: 'https://high.example', priority: 1 },
      ],
      fetchImpl,
    });

    await client.request('/x');
    expect(fetchImpl.mock.calls[0][0]).toContain('high.example');
  });

  it('resetHealth clears quarantines', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new RpcClient({
      endpoints: ['https://a.example'],
      fetchImpl,
      failureThreshold: 1,
    });

    await expect(client.request('/x')).rejects.toThrow();
    expect(client.health()[0]?.healthy).toBe(false);

    client.resetHealth();
    expect(client.health()[0]?.healthy).toBe(true);
  });

  // Regression guard for #74: a fresh clock reading must be taken per
  // endpoint attempt so the *last* (most stale) endpoint isn't quarantined
  // into the past when the failover loop runs longer than `quarantineMs`.
  it('keeps the last attempted endpoint quarantined when the loop outlives quarantineMs (#74)', async () => {
    jest.useFakeTimers();
    let clock = 1_000_000;
    jest.setSystemTime(clock);

    const fetchImpl = jest.fn(async () => {
      clock += 20_000;
      jest.setSystemTime(clock);
      throw new Error('ECONNREFUSED');
    });

    const client = new RpcClient({
      endpoints: ['https://a.example', 'https://b.example', 'https://c.example'],
      fetchImpl,
      failureThreshold: 1,
      quarantineMs: 30_000,
    });

    await expect(client.request('/x')).rejects.toThrow(VeroError);

    const health = client.health();
    expect(health).toHaveLength(3);
    // The final endpoint was penalised last, when the clock was ~60s ahead of
    // the pre-loop timestamp. With the bug its quarantine (based on the stale
    // pre-loop clock) would already be in the past, so it would report
    // healthy again immediately after the request. Each earlier endpoint was
    // penalised earlier and may legitimately have already recovered.
    expect(health[2]?.healthy).toBe(false);

    jest.useRealTimers();
  });
});
