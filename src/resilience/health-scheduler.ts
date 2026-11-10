/**
 * Proactive Endpoint Health Scheduler.
 *
 * Periodically probes quarantined / OPEN / HALF_OPEN RPC endpoints in the background
 * so recovered endpoints return to rotation without requiring a user request to pay
 * the initial recovery latency.
 *
 * Lifecycle Invariant:
 *   - `stop()` clears all timers and background probe handles immediately, ensuring
 *     zero dangling timers keep the Node.js process alive.
 */

import { CircuitBreaker } from './circuit-breaker.js';
import type { Logger } from '../types/index.js';

export interface HealthSchedulerOptions {
  /**
   * Interval in milliseconds between background health probes.
   * @default 5000
   */
  probeIntervalMs?: number;

  /**
   * Timeout in milliseconds for each probe request.
   * @default 3000
   */
  probeTimeoutMs?: number;

  /**
   * Probe function to evaluate endpoint viability.
   * Resolves true if endpoint is healthy, false otherwise.
   */
  probeFn?: (url: string) => Promise<boolean>;

  /**
   * Optional logger.
   */
  logger?: Logger;
}

export class HealthScheduler {
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly probeFn: (url: string) => Promise<boolean>;
  private readonly logger?: HealthSchedulerOptions['logger'];

  private readonly endpoints: Map<string, CircuitBreaker> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private inFlightProbes: Set<string> = new Set();
  private activeTimeouts: Set<NodeJS.Timeout> = new Set();

  constructor(opts: HealthSchedulerOptions = {}) {
    this.probeIntervalMs = Math.max(500, opts.probeIntervalMs ?? 5_000);
    this.probeTimeoutMs = Math.max(200, opts.probeTimeoutMs ?? 3_000);
    this.logger = opts.logger;

    this.probeFn = opts.probeFn ?? (async (url: string): Promise<boolean> => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.probeTimeoutMs);
      this.activeTimeouts.add(timeoutId);

      try {
        const targetUrl = new URL('/health', url.replace(/\/+$/, '') + '/');
        const res = await fetch(targetUrl.toString(), {
          method: 'GET',
          signal: controller.signal,
        });
        return res.ok || (res.status < 500 && res.status !== 404);
      } catch {
        return false;
      } finally {
        clearTimeout(timeoutId);
        this.activeTimeouts.delete(timeoutId);
      }
    });
  }

  /**
   * Register an endpoint with its corresponding circuit breaker for background probing.
   */
  register(url: string, breaker: CircuitBreaker): void {
    const normalized = url.replace(/\/+$/, '');
    this.endpoints.set(normalized, breaker);
  }

  /**
   * Unregister an endpoint from background probing.
   */
  unregister(url: string): void {
    const normalized = url.replace(/\/+$/, '');
    this.endpoints.delete(normalized);
  }

  /**
   * Start the background probing loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    this.timer = setInterval(() => {
      void this.probeQuarantinedEndpoints();
    }, this.probeIntervalMs);

    // Allow process to exit cleanly if this is the only active handle
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * Stop the background probing scheduler and clear all active timers.
   * Guarantees zero lingering handles.
   */
  stop(): void {
    this.isRunning = false;

    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }

    for (const timeoutId of this.activeTimeouts) {
      clearTimeout(timeoutId);
    }
    this.activeTimeouts.clear();
    this.inFlightProbes.clear();
  }

  /**
   * Trigger an immediate probe of all quarantined/open endpoints.
   */
  async probeQuarantinedEndpoints(): Promise<void> {
    if (!this.isRunning && this.timer !== null) return;
    const now = Date.now();

    const probePromises: Promise<void>[] = [];

    for (const [url, breaker] of this.endpoints.entries()) {
      const state = breaker.getState(now);

      // Only probe endpoints that are not CLOSED and are eligible for probe (HALF_OPEN or OPEN elapsed)
      if (state !== 'CLOSED') {
        if (breaker.canExecute(now)) {
          if (!this.inFlightProbes.has(url)) {
            probePromises.push(this.executeProbe(url, breaker));
          }
        }
      }
    }

    if (probePromises.length > 0) {
      await Promise.allSettled(probePromises);
    }
  }

  private async executeProbe(url: string, breaker: CircuitBreaker): Promise<void> {
    this.inFlightProbes.add(url);
    this.logger?.debug?.(`Probing endpoint health: ${url}`);

    try {
      const isHealthy = await this.probeFn(url);
      if (isHealthy) {
        this.logger?.info?.(`Endpoint recovered via background probe: ${url}`);
        breaker.recordSuccess();
      } else {
        this.logger?.debug?.(`Endpoint probe failed: ${url}`);
        breaker.recordFailure(Date.now(), 'background_probe_unhealthy');
      }
    } catch (err) {
      this.logger?.debug?.(`Endpoint probe error: ${url}`, { error: (err as Error)?.message });
      breaker.recordFailure(Date.now(), (err as Error)?.message ?? 'background_probe_error');
    } finally {
      this.inFlightProbes.delete(url);
    }
  }

  isActive(): boolean {
    return this.isRunning;
  }

  getRegisteredCount(): number {
    return this.endpoints.size;
  }
}
