/**
 * Background prober for unhealthy RPC endpoints.
 *
 * Recovery today is passive: a quarantined endpoint only rejoins rotation
 * when a user request happens to retry it after the quarantine expires, so
 * the first request after an outage pays the latency cost of the failed
 * attempt. The scheduler flips that around — it probes endpoints that are
 * currently out of rotation on a timer and restores them the moment one
 * answers, before any user request needs it.
 *
 * Timer hygiene: `stop()` clears the pending timer, and timers are `unref`ed
 * while running so a started scheduler never keeps a process (or a jest run)
 * alive on its own.
 */

import type { Logger } from '../types';

export interface HealthSchedulerOptions {
  /** How often to probe candidates. @default 15000 */
  intervalMs?: number;
  /**
   * Safety net for probes that neither resolve nor reject. The underlying
   * probe keeps running when this fires; the round just stops waiting on it.
   * @default 5000
   */
  probeTimeoutMs?: number;
  /** URLs currently believed unhealthy and worth probing. */
  candidates: () => string[];
  /** Probe one candidate. Resolve = healthy again; reject = still down. */
  probe: (url: string) => Promise<void>;
  /** A candidate answered — clear its quarantine here. */
  onRecovery?: (url: string) => void;
  onError?: (url: string, err: unknown) => void;
  logger?: Logger;
}

type Timer = ReturnType<typeof setTimeout>;

export class HealthScheduler {
  private readonly opts: Required<Pick<HealthSchedulerOptions, 'intervalMs' | 'probeTimeoutMs'>> &
    HealthSchedulerOptions;
  private timer: Timer | null = null;
  private round: Promise<void> | null = null;
  private active = false;

  constructor(opts: HealthSchedulerOptions) {
    if (!opts.probe) throw new Error('HealthScheduler requires a probe function');
    if (!opts.candidates) throw new Error('HealthScheduler requires a candidates function');
    this.opts = {
      intervalMs: Math.max(1, opts.intervalMs ?? 15_000),
      probeTimeoutMs: Math.max(1, opts.probeTimeoutMs ?? 5_000),
      ...opts,
    };
  }

  get running(): boolean {
    return this.active;
  }

  /**
   * Begin probing on the configured interval. Idempotent. The first round
   * runs after one full interval; call {@link probeOnce} to nudge earlier.
   */
  start(): void {
    if (this.active) return;
    this.active = true;
    this.scheduleNext(this.opts.intervalMs);
    this.opts.logger?.debug?.('Health scheduler started', { intervalMs: this.opts.intervalMs });
  }

  /**
   * Stop scheduling. Clears the pending timer immediately — no dangling
   * handles keep the process alive — and a round already in flight will not
   * schedule another one.
   */
  stop(): void {
    this.active = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one probe round now, regardless of whether the scheduler is started.
   * Concurrent calls share the in-flight round.
   */
  probeOnce(): Promise<void> {
    if (this.round !== null) return this.round;

    this.round = this.runRound().finally(() => {
      this.round = null;
      // Chain only on behalf of a started scheduler; probeOnce() by itself
      // must not keep the cadence going.
      if (this.active && this.timer === null) {
        this.scheduleNext(this.opts.intervalMs);
      }
    });
    return this.round;
  }

  private scheduleNext(delayMs: number): void {
    const t = setTimeout(() => {
      this.timer = null;
      void this.probeOnce();
    }, delayMs);
    // Unrefed so a running scheduler never blocks process exit; stop() still
    // clears it explicitly.
    (t as { unref?: () => void }).unref?.();
    this.timer = t;
  }

  private async runRound(): Promise<void> {
    const urls = this.opts.candidates();
    // Sequential on purpose: a handful of sick endpoints don't need a burst
    // of concurrent traffic while they are struggling.
    for (const url of urls) {
      try {
        await this.withTimeout(this.opts.probe(url));
        this.opts.logger?.info?.('Endpoint probe succeeded', { url });
        this.opts.onRecovery?.(url);
      } catch (err) {
        this.opts.logger?.debug?.('Endpoint probe failed', {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
        this.opts.onError?.(url, err);
      }
    }
  }

  private withTimeout(pending: Promise<void>): Promise<void> {
    let timer: Timer | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`probe timed out after ${this.opts.probeTimeoutMs}ms`)),
        this.opts.probeTimeoutMs,
      );
      (timer as { unref?: () => void }).unref?.();
    });

    return Promise.race([pending, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }
}
