import { RpcClient } from '../rpc';
import { VeroError, VeroErrorCode } from '../errors';

const res = (status: number, body: unknown = {}): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

describe('RpcClient Resilience (Circuit Breaker & Health Scheduler)', () => {
  afterEach(() => {
    jest.clearAllTimers();
  });

  it('enables circuit breaker when opt-in option is provided', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(res(200, { data: 'ok' }));

    const client = new RpcClient({
      endpoints: ['https://primary.example', 'https://secondary.example'],
      fetchImpl,
      circuitBreaker: {
        failureThreshold: 1,
        resetTimeoutMs: 5000,
      },
    });

    const initialHealth = client.health();
    expect(initialHealth[0]?.circuitState).toBe('CLOSED');
    expect(initialHealth[1]?.circuitState).toBe('CLOSED');

    // First request trips primary endpoint breaker to OPEN and falls over to secondary
    const result = await client.request('/test');
    expect(result).toEqual({ data: 'ok' });

    const postHealth = client.health();
    expect(postHealth[0]?.circuitState).toBe('OPEN');
    expect(postHealth[0]?.healthy).toBe(false);
    expect(postHealth[1]?.circuitState).toBe('CLOSED');
    expect(postHealth[1]?.healthy).toBe(true);

    // Second request routes directly to secondary without trying primary while breaker is OPEN
    fetchImpl.mockClear();
    fetchImpl.mockResolvedValueOnce(res(200, { data: 'ok-2' }));

    const result2 = await client.request('/test');
    expect(result2).toEqual({ data: 'ok-2' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain('secondary.example');
  });

  it('resets circuit breakers when resetHealth is called', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = new RpcClient({
      endpoints: ['https://primary.example'],
      fetchImpl,
      circuitBreaker: { failureThreshold: 1 },
    });

    await expect(client.request('/test')).rejects.toThrow(VeroError);
    expect(client.health()[0]?.circuitState).toBe('OPEN');

    client.resetHealth();
    expect(client.health()[0]?.circuitState).toBe('CLOSED');
    expect(client.health()[0]?.healthy).toBe(true);
  });

  it('integrates background health scheduler and cleanly stops on client.stop()', async () => {
    const probeFn = jest.fn().mockResolvedValue(true);
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(res(200, { status: 'healthy' }));

    const client = new RpcClient({
      endpoints: ['https://primary.example'],
      fetchImpl,
      circuitBreaker: {
        failureThreshold: 1,
        resetTimeoutMs: 1000,
      },
      healthScheduler: {
        probeIntervalMs: 1000,
        probeFn,
      },
    });

    try {
      await expect(client.request('/test')).rejects.toMatchObject({
        code: VeroErrorCode.AllEndpointsFailed,
      });
      expect(client.health()[0]?.circuitState).toBe('OPEN');

      // Allow probe interval and reset timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Background scheduler should have probed and restored breaker
      expect(probeFn).toHaveBeenCalled();
      expect(client.health()[0]?.circuitState).toBe('CLOSED');
    } finally {
      client.stop();
    }
  });
});
