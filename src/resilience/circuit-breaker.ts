/**
 * Per-endpoint circuit breaker with progressive states.
 *
 * Complements the fixed-quarantine policy in RpcClient: where quarantine is a
 * flat "down for N ms", the breaker distinguishes closed (normal), open
 * (refusing traffic) and half-open (exactly one probe allowed). An endpoint
 * that keeps failing while probes are attempted therefore stays dark for
 * progressively longer, instead of rejoining rotation every cooldown as if
 * nothing had happened.
 *
 * Contract: every granted attempt (`canAttempt` returned true) must eventually
 * record exactly one outcome via `recordSuccess`/`recordFailure`. Callers that
 * abandon attempts without recording them will wedge the half-open probe slot.
 */

import type { Logger } from '../types';

export type BreakerState = 'closed' | 'open' | 'half-open';

export type BreakerTransitionReason =
  | 'failure-threshold'
  | 'cooldown-elapsed'
  | 'probe-succeeded'
  | 'probe-failed'
  | 'manual-reset';

export interface BreakerTransition {
  from: BreakerState;
  to: BreakerState;
  reason: BreakerTransitionReason;
  /** Epoch ms at which the transition occurred. */
  at: number;
}

export interface CircuitBreakerOptions {
  /** Consecutive transport failures before opening. @default 3 */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing a single probe. @default 30000 */
  cooldownMs?: number;
  logger?: Logger;
  /** Observability hook — every state change is reported here. */
  onTransition?: (transition: BreakerTransition) => void;
}

/** Timestamps are injectable so tests don't have to fake the clock. */
type Now = number;

export class CircuitBreaker {
  private state_: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly logger?: Logger;
  private readonly onTransition?: (t: BreakerTransition) => void;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, opts.failureThreshold ?? 3);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 30_000);
    this.logger = opts.logger;
    this.onTransition = opts.onTransition;
  }

  get state(): BreakerState {
    return this.state_;
  }

  /**
   * Whether an attempt *may* be possible, without side effects. Safe to call
   * for pool filtering; use {@link canAttempt} immediately before dispatching.
   *
   * An open breaker becomes eligible once its cooldown has elapsed, but it
   * does not become half-open until an attempt is actually granted — probing
   * is triggered by traffic (or a health scheduler), never by the clock alone.
   */
  eligible(now: Now = Date.now()): boolean {
    switch (this.state_) {
      case 'closed':
        return true;
      case 'half-open':
        return !this.probeInFlight;
      case 'open':
        return now - this.openedAt >= this.cooldownMs;
    }
  }

  /**
   * Gate an attempt. Unlike {@link eligible} this has side effects: an open
   * breaker whose cooldown elapsed moves to half-open, and in half-open the
   * single probe slot is consumed. Exactly one caller gets `true`.
   */
  canAttempt(now: Now = Date.now()): boolean {
    if (!this.eligible(now)) return false;

    if (this.state_ === 'open') {
      this.transition('half-open', 'cooldown-elapsed', now);
    }
    if (this.state_ === 'half-open') {
      if (this.probeInFlight) return false;
      this.probeInFlight = true;
    }
    return true;
  }

  /** Record a completed attempt that succeeded. Any state → closed. */
  recordSuccess(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.state_ !== 'closed') {
      this.transition('closed', 'probe-succeeded', Date.now());
    }
  }

  /**
   * Record a completed attempt that failed.
   *
   * A failure in half-open reopens the breaker immediately — the probe did
   * not earn restoration of full traffic, and the cooldown restarts from now.
   */
  recordFailure(now: Now = Date.now(), reason?: string): void {
    if (this.state_ === 'open') return;

    if (this.state_ === 'half-open') {
      this.probeInFlight = false;
      this.open(now, 'probe-failed');
      this.logger?.warn('Circuit reopened after failed probe', {
        reason,
        cooldownMs: this.cooldownMs,
      });
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open(now, 'failure-threshold');
      this.logger?.warn('Circuit opened', {
        threshold: this.failureThreshold,
        cooldownMs: this.cooldownMs,
        reason,
      });
    }
  }

  /** Force closed. Used by explicit health resets, not by traffic. */
  reset(): void {
    this.probeInFlight = false;
    this.consecutiveFailures = 0;
    if (this.state_ !== 'closed') {
      this.transition('closed', 'manual-reset', Date.now());
    }
  }

  private open(at: Now, reason: BreakerTransitionReason): void {
    // The cooldown restarts from every opening, including a failed probe —
    // an endpoint that just failed probing has earned no head start.
    this.openedAt = at;
    this.consecutiveFailures = 0;
    this.transition('open', reason, at);
  }

  private transition(to: BreakerState, reason: BreakerTransitionReason, at: number): void {
    if (this.state_ === to) return;
    const t: BreakerTransition = { from: this.state_, to, reason, at };
    this.state_ = to;
    if (to === 'closed') this.openedAt = 0;
    this.onTransition?.(t);
  }
}
