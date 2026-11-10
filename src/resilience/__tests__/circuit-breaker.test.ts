import { CircuitBreaker } from '../circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('initializes in CLOSED state and allows execution', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);
    expect(breaker.getConsecutiveFailures()).toBe(0);
  });

  it('trips to OPEN state after consecutive failures reach failureThreshold', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
    const now = 10000;

    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('CLOSED');
    expect(breaker.canExecute(now)).toBe(true);

    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('CLOSED');

    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('OPEN');
    expect(breaker.canExecute(now)).toBe(false);
    expect(breaker.getQuarantinedUntil()).toBe(now + 1000);
  });

  it('transitions to HALF_OPEN after resetTimeout elapses and allows exactly one probe', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 500 });
    let now = 1000;

    breaker.recordFailure(now);
    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('OPEN');
    expect(breaker.canExecute(now)).toBe(false);

    // Advance time past reset timeout
    now += 500;
    expect(breaker.getState(now)).toBe('HALF_OPEN');

    // First call in HALF_OPEN is allowed (the single probe)
    expect(breaker.canExecute(now)).toBe(true);

    // Concurrent/subsequent calls in HALF_OPEN are blocked while probe is in flight
    expect(breaker.canExecute(now)).toBe(false);
  });

  it('failing half-open probe immediately reopens breaker with progressive backoff without restoring traffic', () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 1000,
      backoffMultiplier: 2,
      maxResetTimeoutMs: 5000,
    });
    let now = 1000;

    breaker.recordFailure(now);
    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('OPEN');
    expect(breaker.getTripCount()).toBe(1);

    // Move to HALF_OPEN
    now += 1000;
    expect(breaker.canExecute(now)).toBe(true); // Probe dispatched
    expect(breaker.getState(now)).toBe('HALF_OPEN');

    // Probe fails!
    breaker.recordFailure(now, 'probe_500_server_error');
    expect(breaker.getState(now)).toBe('OPEN');
    expect(breaker.canExecute(now)).toBe(false);
    expect(breaker.getTripCount()).toBe(2);

    // Next backoff timeout should be 1000 * 2^(2-1) = 2000ms
    expect(breaker.getQuarantinedUntil()).toBe(now + 2000);

    // Advancing only 1000ms should still be OPEN
    now += 1000;
    expect(breaker.getState(now)).toBe('OPEN');
    expect(breaker.canExecute(now)).toBe(false);

    // Advancing full 2000ms enters HALF_OPEN again
    now += 1000;
    expect(breaker.getState(now)).toBe('HALF_OPEN');
    expect(breaker.canExecute(now)).toBe(true);
  });

  it('successful probe closes breaker and resets progressive failure counters', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000 });
    let now = 1000;

    breaker.recordFailure(now);
    breaker.recordFailure(now);
    expect(breaker.getState(now)).toBe('OPEN');

    now += 1000;
    expect(breaker.getState(now)).toBe('HALF_OPEN');
    expect(breaker.canExecute(now)).toBe(true);

    // Probe succeeds!
    breaker.recordSuccess(now);
    expect(breaker.getState(now)).toBe('CLOSED');
    expect(breaker.canExecute(now)).toBe(true);
    expect(breaker.getConsecutiveFailures()).toBe(0);
    expect(breaker.getTripCount()).toBe(0);
  });

  it('emits onStateChange listener callbacks on transitions', () => {
    const transitions: { from: string; to: string }[] = [];
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 500,
      onStateChange: (from, to) => transitions.push({ from, to }),
    });

    let now = 100;
    breaker.recordFailure(now);
    expect(transitions).toEqual([{ from: 'CLOSED', to: 'OPEN' }]);

    now += 500;
    breaker.getState(now);
    expect(transitions).toEqual([
      { from: 'CLOSED', to: 'OPEN' },
      { from: 'OPEN', to: 'HALF_OPEN' },
    ]);

    breaker.recordSuccess(now);
    expect(transitions).toEqual([
      { from: 'CLOSED', to: 'OPEN' },
      { from: 'OPEN', to: 'HALF_OPEN' },
      { from: 'HALF_OPEN', to: 'CLOSED' },
    ]);
  });

  it('manual reset returns breaker to CLOSED immediately', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure();
    expect(breaker.getState()).toBe('OPEN');

    breaker.reset();
    expect(breaker.getState()).toBe('CLOSED');
    expect(breaker.canExecute()).toBe(true);
  });
});
