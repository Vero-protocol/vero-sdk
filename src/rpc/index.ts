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
}

interface EndpointState {
  url: string;
  priority: number;
  consecutiveFailures: number;
  quarantinedUntil: number;
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

  constructor(opts: RpcClientOptions) {
    if (!opts.endpoints?.length) {
      throw new VeroError(VeroErrorCode.InvalidUrl, 'At least one RPC endpoint is required');
    }

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

  /** Endpoints currently eligible, best first. */
  private available(now: number): EndpointState[] {
    const live = this.endpoints.filter((e) => e.quarantinedUntil <= now);
    // All quarantined: try everything anyway rather than failing outright — a
    // stale quarantine shouldn't cause a total outage.
    const pool = live.length > 0 ? live : this.endpoints;
    return [...pool].sort((a, b) => a.priority - b.priority);
  }

  private penalise(ep: EndpointState, now: number, reason: string): void {
    ep.consecutiveFailures += 1;
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
    const pool = this.available(now);
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
  health(): { url: string; healthy: boolean; consecutiveFailures: number }[] {
    const now = Date.now();
    return this.endpoints.map((e) => ({
      url: e.url,
      healthy: e.quarantinedUntil <= now,
      consecutiveFailures: e.consecutiveFailures,
    }));
  }

  /** Clear all quarantines. Useful after a known network blip resolves. */
  resetHealth(): void {
    for (const e of this.endpoints) {
      e.consecutiveFailures = 0;
      e.quarantinedUntil = 0;
    }
  }
}

export { normalizeError };
