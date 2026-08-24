/**
 * RPC client with endpoint failover and health tracking.
 *
 * Replaces three separate implementations:
 *   - vero-core-engine/engine-bridge/src/rpc-client.ts
 *   - vero-relayer-service/src/services/rpc-factory.js
 *   - vero-guardian-dashboard/src/services/rpc.ts
 *
 * Design note on quarantining: an endpoint is only penalised for *transport*
 * failures (unreachable, timeout, 5xx). Application-level errors — a 404 for a
 * missing account, a 400 for a malformed request — say nothing about endpoint
 * health, and treating them as failures let a single bad request knock healthy
 * endpoints out of rotation. See vero-core-engine#182.
 */

import { VeroError, VeroErrorCode, normalizeError } from '../errors/index.js';
import { validateUrl, type ValidateUrlOptions } from '../network/index.js';
import type { Logger } from '../types/index.js';

export interface RpcEndpoint {
  url: string;
  /** Lower numbers are preferred. Ties are broken by declaration order. */
  priority?: number;
}

/** Configuration for the opt-in background health prober. */
export interface RpcHealthProbeOptions {
  /**
   * Path probed on the endpoint origin. Anything answering with a status
   * below 500 counts as alive. @default '/'
   */
  path?: string;
  /** How often quarantined endpoints are probed. @default 15000 */
  intervalMs?: number;
  /** Per-probe timeout. @default 5000 */
  probeTimeoutMs?: number;
}

export interface RpcClientOptions {
  endpoints: (string | RpcEndpoint)[];
  /** Per-request timeout in milliseconds. @default 10000 */
  timeoutMs?: number;
  /** How long a failing endpoint stays out of rotation. @default 30000 */
  quarantineMs?: number;
  /** Consecutive transport failures before quarantine. @default 3 */
  failureThreshold?: number;
  logger?: Logger;
  urlOptions?: ValidateUrlOptions;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Opt-in per-endpoint circuit breaker, replacing the flat quarantine for
   * eligibility decisions: repeated failures keep an endpoint dark for
   * progressively longer, and restoration goes through a single half-open
   * probe. When omitted the fixed-quarantine behaviour is unchanged.
   */
  breaker?: CircuitBreakerOptions;
  /**
   * Opt-in background probing of endpoints that are out of rotation, so
   * recovery does not wait for a user request to discover it. Inert until
   * `startHealthProbe()` is called; `stopHealthProbe()` clears every timer.
   */
  healthProbe?: RpcHealthProbeOptions;
}

interface EndpointState {
  url: string;
  priority: number;
  consecutiveFailures: number;
  quarantinedUntil: number;
  breaker?: CircuitBreaker;
}

/** Thrown per-endpoint internally; not exported. */
class TransportError extends Error {}

export class RpcClient {
  private readonly endpoints: EndpointState[];
  private readonly timeoutMs: number;
  private readonly quarantineMs: number;
  private readonly failureThreshold: number;
  private readonly logger?: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly breakerOptions?: CircuitBreakerOptions;
  private readonly healthProbeOptions?: RpcHealthProbeOptions;
  private scheduler?: HealthScheduler;

  constructor(opts: RpcClientOptions) {
    if (!opts.endpoints?.length) {
      throw new VeroError(VeroErrorCode.InvalidUrl, 'At least one RPC endpoint is required');
    }

    this.breakerOptions = opts.breaker;
    this.healthProbeOptions = opts.healthProbe;

    this.endpoints = opts.endpoints.map((e, i) => {
      const { url, priority } = typeof e === 'string' ? { url: e, priority: i } : e;
      validateUrl(url, opts.urlOptions);
      return {
        url: url.replace(/\/+$/, ''),
        priority: priority ?? i,
        consecutiveFailures: 0,
        quarantinedUntil: 0,
      };
    });

    if (opts.breaker) {
      for (const ep of this.endpoints) {
        ep.breaker = this.buildBreaker(opts.breaker, ep);
      }
    }

    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.quarantineMs = opts.quarantineMs ?? 30_000;
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.logger = opts.logger;

    const f = opts.fetchImpl ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new VeroError(
        VeroErrorCode.RpcRequestFailed,
        'No fetch implementation available — pass fetchImpl explicitly',
      );
    }
    this.fetchImpl = f;
  }

  /**
   * Each endpoint gets its own breaker. The caller's transition hook is
   * composed with an internal one that mirrors the open state into
   * `quarantinedUntil`, keeping `health()` and the probe scheduler's view of
   * "out of rotation" uniform across both policies.
   */
  private buildBreaker(base: CircuitBreakerOptions, ep: EndpointState): CircuitBreaker {
    return new CircuitBreaker({
      ...base,
      onTransition: (t: BreakerTransition) => {
        if (t.to === 'open') {
          ep.quarantinedUntil = t.at + (base.cooldownMs ?? 30_000);
        }
        base.onTransition?.(t);
      },
    });
  }

  /** Pure eligibility check; the half-open probe slot is only consumed later. */
  private isEligible(ep: EndpointState, now: number): boolean {
    return ep.breaker ? ep.breaker.eligible(now) : ep.quarantinedUntil <= now;
  }

  private penalise(ep: EndpointState, now: number, reason: string): void {
    ep.consecutiveFailures += 1;
    if (ep.breaker) {
      // The breaker owns eligibility in this mode; opening it mirrors into
      // quarantinedUntil via the transition hook.
      ep.breaker.recordFailure(now, reason);
      return;
    }
    if (ep.consecutiveFailures >= this.failureThreshold) {
      ep.quarantinedUntil = now + this.quarantineMs;
      this.logger?.warn('RPC endpoint quarantined', {
        url: ep.url,
        failures: ep.consecutiveFailures,
        forMs: this.quarantineMs,
        reason,
      });
    }
  }

  /**
   * Issue a request, falling through endpoints on transport failure.
   *
   * @param path Path appended to the endpoint origin, e.g. `/accounts/GABC`.
   * @throws {VeroError} `ALL_ENDPOINTS_FAILED` when no endpoint succeeded.
   */
  async request<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const now = Date.now();
    const eligible = this.endpoints.filter((e) => this.isEligible(e, now));
    // All endpoints out of rotation: try everything anyway rather than failing
    // outright — a stale quarantine shouldn't cause a total outage. In that
    // desperation mode breaker gates are bypassed too.
    const pool = [...(eligible.length > 0 ? eligible : this.endpoints)].sort(
      (a, b) => a.priority - b.priority,
    );
    const gated = eligible.length > 0;
    const failures: string[] = [];

    for (const ep of pool) {
      // Build via URL so a crafted `path` can't redirect to another host.
      // Naive concatenation is how vero-audit-guard#302 happened.
      const target = new URL(path.replace(/^\/+/, ''), ep.url + '/');
      if (target.origin !== new URL(ep.url).origin) {
        throw new VeroError(
          VeroErrorCode.InvalidUrl,
          `Request path "${path}" would escape endpoint origin ${ep.url}`,
        );
      }

      // Consumes the half-open probe slot when applicable — placed after the
      // origin check so a bad path can never burn the slot.
      if (gated && ep.breaker && !ep.breaker.canAttempt(now)) {
        failures.push(`${ep.url}: circuit open`);
        continue;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const res = await this.fetchImpl(target.toString(), {
          ...init,
          signal: controller.signal,
        });

        // 5xx means the endpoint itself is unhealthy; 4xx is the caller's problem.
        if (res.status >= 500) throw new TransportError(`HTTP ${res.status}`);

        ep.consecutiveFailures = 0;
        ep.breaker?.recordSuccess();

        if (!res.ok) {
          throw new VeroError(
            res.status === 404 ? VeroErrorCode.AccountNotFound : VeroErrorCode.RpcRequestFailed,
            `Request failed with HTTP ${res.status}`,
          );
        }

        return (await res.json()) as T;
      } catch (err) {
        // Application errors propagate untouched — no endpoint penalty.
        if (err instanceof VeroError) throw err;

        const aborted = err instanceof Error && err.name === 'AbortError';
        const reason = aborted ? 'timeout' : (err as Error)?.message ?? 'transport error';
        this.penalise(ep, now, reason);
        failures.push(`${ep.url}: ${reason}`);
      } finally {
        clearTimeout(timer);
      }
    }

    throw new VeroError(
      VeroErrorCode.AllEndpointsFailed,
      `All ${pool.length} RPC endpoint(s) failed. ${failures.join('; ')}`,
    );
  }

  /** Snapshot of endpoint health, for diagnostics and dashboards. */
  health(): { url: string; healthy: boolean; consecutiveFailures: number; breakerState?: BreakerState }[] {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      url: e.url,
      healthy: e.breaker ? e.breaker.state !== 'open' : e.quarantinedUntil <= now,
      consecutiveFailures: e.consecutiveFailures,
      ...(e.breaker ? { breakerState: e.breaker.state } : {}),
    }));
  }

  /** Clear all quarantines and breakers. Useful after a known blip resolves. */
  resetHealth(): void {
    for (const e of this.endpoints) {
      e.consecutiveFailures = 0;
      e.quarantinedUntil = 0;
      e.breaker?.reset();
    }
  }

  /**
   * Start probing endpoints that are out of rotation, restoring them without
   * waiting for a user request to discover recovery. No-op when `healthProbe`
   * was not configured; safe to call repeatedly.
   */
  startHealthProbe(): void {
    if (!this.healthProbeOptions || this.scheduler?.running) return;

    const probePath = this.healthProbeOptions.path ?? '/';
    this.scheduler ??= new HealthScheduler({
      intervalMs: this.healthProbeOptions.intervalMs,
      probeTimeoutMs: this.healthProbeOptions.probeTimeoutMs,
      candidates: () =>
        this.endpoints.filter((e) => e.quarantinedUntil > Date.now()).map((e) => e.url),
      probe: (url) => this.probeEndpoint(url, probePath),
      onRecovery: (url) => this.markRecovered(url),
      onError: (url, err) => {
        this.logger?.debug?.('RPC endpoint probe failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      },
      logger: this.logger,
    });
    this.scheduler.start();
  }

  /** Stop background probing and clear its timers. */
  stopHealthProbe(): void {
    this.scheduler?.stop();
  }

  private markRecovered(url: string): void {
    const ep = this.byUrl(url);
    if (!ep) return;
    ep.consecutiveFailures = 0;
    ep.quarantinedUntil = 0;
    ep.breaker?.recordSuccess();
    this.logger?.info?.('RPC endpoint recovered by probe', { url });
  }

  private byUrl(url: string): EndpointState | undefined {
    return this.endpoints.find((e) => e.url === url);
  }

  /** One manual probe round against currently quarantined endpoints. */
  async probeOnce(): Promise<void> {
    if (this.scheduler) {
      await this.scheduler.probeOnce();
      return;
    }
    if (!this.healthProbeOptions) return;
    const probePath = this.healthProbeOptions.path ?? '/';
    for (const url of this.endpoints.filter((e) => e.quarantinedUntil > Date.now()).map((e) => e.url)) {
      try {
        await this.probeEndpoint(url, probePath);
        this.markRecovered(url);
      } catch {
        // Recovery not confirmed; the next round will retry.
      }
    }
  }

  /** Transport-level liveness check: anything below HTTP 500 counts as alive. */
  private async probeEndpoint(url: string, path: string): Promise<void> {
    const target = new URL(path.replace(/^\/+/, ''), url + '/');
    if (target.origin !== new URL(url).origin) {
      throw new VeroError(
        VeroErrorCode.InvalidUrl,
        `Probe path "${path}" would escape endpoint origin ${url}`,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.healthProbeOptions?.probeTimeoutMs ?? 5_000,
    );
    try {
      const res = await this.fetchImpl(target.toString(), { signal: controller.signal });
      if (res.status >= 500) throw new Error(`probe got HTTP ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

export { normalizeError };
