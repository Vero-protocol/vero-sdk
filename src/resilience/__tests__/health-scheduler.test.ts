import { CircuitBreaker } from '../circuit-breaker.js';
import { HealthScheduler } from '../health-scheduler.js';

describe('HealthScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('manages endpoint registration and unregistration', () => {
    const scheduler = new HealthScheduler();
    const breaker = new CircuitBreaker();

    expect(scheduler.getRegisteredCount()).toBe(0);

    scheduler.register('https://rpc1.vero.network', breaker);
    expect(scheduler.getRegisteredCount()).toBe(1);

    // Register with trailing slash normalizes to same key
    scheduler.register('https://rpc1.vero.network/', breaker);
    expect(scheduler.getRegisteredCount()).toBe(1);

    scheduler.unregister('https://rpc1.vero.network');
    expect(scheduler.getRegisteredCount()).toBe(0);
  });

  it('controls start and stop lifecycle cleanly without dangling timers', () => {
    const scheduler = new HealthScheduler({ probeIntervalMs: 2000 });
    expect(scheduler.isActive()).toBe(false);

    scheduler.start();
    expect(scheduler.isActive()).toBe(true);

    // Starting again is idempotent
    scheduler.start();
    expect(scheduler.isActive()).toBe(true);

    scheduler.stop();
    expect(scheduler.isActive()).toBe(false);
  });

  it('does not probe healthy CLOSED endpoints', async () => {
    const probeFn = jest.fn().mockResolvedValue(true);
    const scheduler = new HealthScheduler({ probeFn, probeIntervalMs: 1000 });
    const breaker = new CircuitBreaker({ failureThreshold: 2 });

    scheduler.register('https://rpc1.vero.network', breaker);
    scheduler.start();

    // Advance timer to trigger interval
    await jest.advanceTimersByTimeAsync(1000);

    expect(probeFn).not.toHaveBeenCalled();
    expect(breaker.getState()).toBe('CLOSED');
    scheduler.stop();
  });

  it('probes endpoints in HALF_OPEN state and restores them to CLOSED on success', async () => {
    const probeFn = jest.fn().mockResolvedValue(true);
    const scheduler = new HealthScheduler({ probeFn, probeIntervalMs: 1000 });
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 2000 });

    scheduler.register('https://rpc1.vero.network', breaker);

    // Trip the breaker to OPEN
    breaker.recordFailure(Date.now());
    expect(breaker.getState(Date.now())).toBe('OPEN');

    scheduler.start();

    // Advance time past reset timeout (2000ms) + interval (1000ms)
    await jest.advanceTimersByTimeAsync(3000);

    expect(probeFn).toHaveBeenCalledWith('https://rpc1.vero.network');
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);
    scheduler.stop();
  });

  it('failing background probe re-quarantines the endpoint with backoff', async () => {
    const probeFn = jest.fn().mockResolvedValue(false);
    const scheduler = new HealthScheduler({ probeFn, probeIntervalMs: 1000 });
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 2000,
      backoffMultiplier: 2,
    });

    scheduler.register('https://rpc1.vero.network', breaker);

    // Trip the breaker to OPEN
    const tripTime = Date.now();
    breaker.recordFailure(tripTime);
    expect(breaker.getState(tripTime)).toBe('OPEN');
    expect(breaker.getTripCount()).toBe(1);

    scheduler.start();

    // Advance time past reset timeout so it enters HALF_OPEN and interval triggers
    await jest.advanceTimersByTimeAsync(3000);

    expect(probeFn).toHaveBeenCalledWith('https://rpc1.vero.network');
    // Failed probe increases trip count and returns to OPEN
    expect(breaker.getState()).toBe('OPEN');
    expect(breaker.getTripCount()).toBe(2);
    scheduler.stop();
  });

  it('handles probeFn rejection gracefully and trips breaker', async () => {
    const probeFn = jest.fn().mockRejectedValue(new Error('Network offline'));
    const scheduler = new HealthScheduler({ probeFn, probeIntervalMs: 1000 });
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 2000 });

    scheduler.register('https://rpc1.vero.network', breaker);
    breaker.recordFailure(Date.now());

    scheduler.start();
    await jest.advanceTimersByTimeAsync(3000);

    expect(probeFn).toHaveBeenCalled();
    expect(breaker.getState()).toBe('OPEN');
    scheduler.stop();
  });

  it('uses default probe function with fetch and handles healthy response', async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const scheduler = new HealthScheduler({ probeIntervalMs: 1000, probeTimeoutMs: 1500 });
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

      scheduler.register('https://rpc1.vero.network', breaker);
      breaker.recordFailure(Date.now());

      scheduler.start();
      await jest.advanceTimersByTimeAsync(2000);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://rpc1.vero.network/health',
        expect.objectContaining({ method: 'GET' })
      );
      expect(breaker.getState()).toBe('CLOSED');
      scheduler.stop();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
