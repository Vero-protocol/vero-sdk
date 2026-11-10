/**
 * Endpoint Circuit Breaker with Progressive Backoff & Single-Probe Half-Open State.
 *
 * Implements a finite state machine:
 *   - CLOSED: Normal traffic flow. Failures increment failure counter.
 *   - OPEN: Quarantined. Calls fail fast or endpoint is excluded.
 *   - HALF_OPEN: Quarantined timeout elapsed. Allows a SINGLE probe request to test health.
 *     - If probe succeeds: transitions to CLOSED, restoring full traffic.
 *     - If probe fails: immediately returns to OPEN with progressive backoff, preventing full traffic exposure.
 */

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive transport failures before tripping the breaker.
   * @default 3
   */
  failureThreshold?: number;

  /**
   * Base duration in milliseconds to stay in OPEN state before testing HALF_OPEN.
   * @default 10000
   */
  resetTimeoutMs?: number;

  /**
   * Maximum backoff duration in milliseconds for repeated breaker trips.
   * @default 60000
   */
  maxResetTimeoutMs?: number;

  /**
   * Exponential backoff multiplier applied on consecutive breaker trips.
   * @default 2
   */
  backoffMultiplier?: number;

  /**
   * Optional callback emitted when the circuit breaker changes state.
   */
  onStateChange?: (from: CircuitState, to: CircuitState, metadata?: Record<string, unknown>) => void;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private tripCount = 0;
  private quarantinedUntil = 0;
  private probeInFlight = false;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly maxResetTimeoutMs: number;
  private readonly backoffMultiplier: number;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState, metadata?: Record<string, unknown>) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 3);
    this.resetTimeoutMs = Math.max(100, opts.resetTimeoutMs ?? 10_000);
    this.maxResetTimeoutMs = Math.max(this.resetTimeoutMs, opts.maxResetTimeoutMs ?? 60_000);
    this.backoffMultiplier = Math.max(1, opts.backoffMultiplier ?? 2);
    this.onStateChange = opts.onStateChange;
  }

  /**
   * Current lifecycle state of the circuit breaker.
   */
  getState(now = Date.now()): CircuitState {
    if (this.state === 'OPEN' && now >= this.quarantinedUntil) {
      this.transitionTo('HALF_OPEN', now, { reason: 'quarantine_elapsed' });
    }
    return this.state;
  }

  /**
   * Check whether a request can be dispatched through this circuit breaker.
   * In HALF_OPEN, allows exactly one probe execution at a time.
   */
  canExecute(now = Date.now()): boolean {
    const currentState = this.getState(now);

    if (currentState === 'CLOSED') {
      return true;
    }

    if (currentState === 'HALF_OPEN') {
      if (!this.probeInFlight) {
        this.probeInFlight = true;
        return true;
      }
      return false; // Probe already in flight, reject concurrent traffic until resolved
    }

    // OPEN state
    return false;
  }

  /**
   * Record a successful response or probe.
   * Closes the circuit and resets progressive failure counters.
   */
  recordSuccess(now = Date.now()): void {
    const prevState = this.state;
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
    this.tripCount = 0;
    this.quarantinedUntil = 0;

    if (prevState !== 'CLOSED') {
      this.transitionTo('CLOSED', now, { reason: 'success_probe' });
    }
  }

  /**
   * Record a transport failure.
   * Trips the breaker to OPEN or reopens with progressive backoff if in HALF_OPEN.
   */
  recordFailure(now = Date.now(), reason?: string): void {
    const prevState = this.state;
    this.consecutiveFailures += 1;
    this.probeInFlight = false;

    if (prevState === 'HALF_OPEN') {
      // Failing half-open probe reopens breaker with progressive backoff
      this.tripCount += 1;
      const timeout = this.calculateBackoffTimeout();
      this.quarantinedUntil = now + timeout;
      this.transitionTo('OPEN', now, { reason: reason ?? 'probe_failed', timeout, tripCount: this.tripCount });
      return;
    }

    if (prevState === 'CLOSED' && this.consecutiveFailures >= this.failureThreshold) {
      this.tripCount += 1;
      const timeout = this.calculateBackoffTimeout();
      this.quarantinedUntil = now + timeout;
      this.transitionTo('OPEN', now, { reason: reason ?? 'threshold_exceeded', timeout, tripCount: this.tripCount });
    }
  }

  /**
   * Calculate progressive quarantine duration with exponential backoff.
   */
  private calculateBackoffTimeout(): number {
    const exponent = Math.max(0, this.tripCount - 1);
    const duration = this.resetTimeoutMs * Math.pow(this.backoffMultiplier, exponent);
    return Math.min(duration, this.maxResetTimeoutMs);
  }

  /**
   * Transition state and notify listeners.
   */
  private transitionTo(newState: CircuitState, now: number, metadata?: Record<string, unknown>): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;
    if (this.onStateChange) {
      try {
        this.onStateChange(oldState, newState, { ...metadata, timestamp: now });
      } catch {
        // Logging or callback errors must never disrupt circuit breaker operation
      }
    }
  }

  /**
   * Fully reset circuit state and all metrics.
   */
  reset(): void {
    const oldState = this.state;
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.tripCount = 0;
    this.quarantinedUntil = 0;
    this.probeInFlight = false;
    if (oldState !== 'CLOSED') {
      this.onStateChange?.(oldState, 'CLOSED', { reason: 'manual_reset' });
    }
  }

  getConsecutiveFailures(): number {
    return this.consecutiveFailures;
  }

  getTripCount(): number {
    return this.tripCount;
  }

  getQuarantinedUntil(): number {
    return this.quarantinedUntil;
  }
}
