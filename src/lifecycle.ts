/**
 * Operability primitives (M18): a health-state machine, a latency histogram, an
 * OpenTelemetry-shaped tracing hook, and a retry/backoff helper. Kept as one
 * small, dependency-free module so the indexer stays readable and these concerns
 * can be unit-tested with an injectable clock — no network, no real OTel SDK.
 */

// ---------------------------------------------------------------------------
// Health state machine
// ---------------------------------------------------------------------------

/**
 * Operational state, in rough lifecycle order:
 * - `starting`     — constructed, not yet syncing.
 * - `backfilling`  — catching up; blocksBehind above the live threshold.
 * - `live`         — caught up to the tip (blocksBehind ≤ threshold).
 * - `degraded`     — progressing, but a source error occurred recently.
 * - `stalled`      — no block progress for longer than `stallMs`.
 * - `draining`     — graceful shutdown in progress.
 * - `stopped`      — shut down.
 *
 * `degraded` and `stalled` are *derived* from the clock + counters at read time,
 * so health reflects "right now" without a background timer.
 */
export type HealthState =
  | 'starting' | 'backfilling' | 'live' | 'degraded' | 'stalled' | 'draining' | 'stopped';

export interface ChainHealth {
  chainId: number;
  lastBlock: number;
  tipBlock?: number;
  blocksBehind?: number;
  /** Milliseconds since this chain last committed a block. */
  idleMs: number;
}

export interface HealthReport {
  state: HealthState;
  uptimeMs: number;
  chains: ChainHealth[];
  reorgs: number;
  errors: number;
}

export interface LifecycleOptions {
  /** No block progress for longer than this ⇒ `stalled`. Default 60_000. */
  stallMs?: number;
  /** `live` once every chain's blocksBehind ≤ this. Default 1. */
  liveLagThreshold?: number;
  /** A source error within this window ⇒ `degraded`. Default = stallMs. */
  degradeMs?: number;
  /** Injectable clock (ms). Default `Date.now`. Tests pass a fake. */
  now?: () => number;
}

interface ChainProgress { lastBlock: number; tipBlock?: number; lastProgressAt: number; }

export class Lifecycle {
  private readonly stallMs: number;
  private readonly liveLag: number;
  private readonly degradeMs: number;
  private readonly now: () => number;

  private readonly startedAt: number;
  // Base lifecycle phase; `live`/`backfilling`/`degraded`/`stalled` are DERIVED
  // from lag + the clock in state(), so a newly-discovered lagging chain demotes
  // a `live` indexer back to `backfilling` automatically.
  private base: 'starting' | 'running' | 'draining' | 'stopped' = 'starting';
  private readonly chains = new Map<number, ChainProgress>();
  private lastErrorAt = -Infinity;
  reorgs = 0;
  errors = 0;

  constructor(opts: LifecycleOptions = {}) {
    this.stallMs = opts.stallMs ?? 60_000;
    this.liveLag = opts.liveLagThreshold ?? 1;
    this.degradeMs = opts.degradeMs ?? this.stallMs;
    this.now = opts.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Enter the running phase (catch-up). */
  start(): void {
    if (this.base === 'starting') this.base = 'running';
  }

  /** Record a committed block for a chain. */
  recordBlock(chainId: number, blockNumber: number, tipBlock?: number): void {
    if (this.base === 'draining' || this.base === 'stopped') return;
    if (this.base === 'starting') this.base = 'running';
    const prev = this.chains.get(chainId);
    this.chains.set(chainId, {
      lastBlock: blockNumber,
      tipBlock: tipBlock ?? prev?.tipBlock,
      lastProgressAt: this.now(),
    });
  }

  recordReorg(): void { this.reorgs++; }
  recordError(): void { this.errors++; this.lastErrorAt = this.now(); }

  draining(): void { if (this.base !== 'stopped') this.base = 'draining'; }
  stopped(): void { this.base = 'stopped'; }

  private blocksBehind(c: ChainProgress): number | undefined {
    return c.tipBlock === undefined ? undefined : Math.max(0, c.tipBlock - c.lastBlock);
  }

  private allCaughtUp(): boolean {
    if (this.chains.size === 0) return false;
    for (const c of this.chains.values()) {
      const behind = this.blocksBehind(c);
      if (behind === undefined || behind > this.liveLag) return false;
    }
    return true;
  }

  /** Resolve the live state from the base phase, lag, the clock, and recent errors. */
  state(): HealthState {
    if (this.base !== 'running') return this.base;   // starting | draining | stopped
    const now = this.now();
    // Stalled wins: the chain that progressed most recently is still past stallMs.
    let minIdle = Infinity;
    for (const c of this.chains.values()) minIdle = Math.min(minIdle, now - c.lastProgressAt);
    if (this.chains.size > 0 && minIdle > this.stallMs) return 'stalled';
    if (now - this.lastErrorAt < this.degradeMs) return 'degraded';
    return this.allCaughtUp() ? 'live' : 'backfilling';
  }

  health(): HealthReport {
    const now = this.now();
    const chains: ChainHealth[] = [];
    for (const [chainId, c] of this.chains) {
      chains.push({
        chainId,
        lastBlock: c.lastBlock,
        tipBlock: c.tipBlock,
        blocksBehind: this.blocksBehind(c),
        idleMs: now - c.lastProgressAt,
      });
    }
    chains.sort((a, b) => a.chainId - b.chainId);
    return {
      state: this.state(),
      uptimeMs: now - this.startedAt,
      chains,
      reorgs: this.reorgs,
      errors: this.errors,
    };
  }
}

// ---------------------------------------------------------------------------
// Latency histogram (Prometheus-style cumulative buckets)
// ---------------------------------------------------------------------------

export class Histogram {
  private readonly bounds: number[];
  private readonly counts: number[];   // per-bucket (non-cumulative), last = +Inf
  private sum = 0;
  private n = 0;

  constructor(boundsMs: number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000]) {
    this.bounds = [...boundsMs].sort((a, b) => a - b);
    this.counts = new Array<number>(this.bounds.length + 1).fill(0);
  }

  observe(ms: number): void {
    this.sum += ms;
    this.n++;
    let i = 0;
    while (i < this.bounds.length && ms > this.bounds[i]) i++;
    this.counts[i]++;
  }

  /** Cumulative `le` buckets, plus count + sum — the Prometheus histogram shape. */
  snapshot(): { buckets: Array<{ le: number | '+Inf'; count: number }>; count: number; sum: number } {
    const buckets: Array<{ le: number | '+Inf'; count: number }> = [];
    let cum = 0;
    for (let i = 0; i < this.bounds.length; i++) {
      cum += this.counts[i];
      buckets.push({ le: this.bounds[i], count: cum });
    }
    cum += this.counts[this.bounds.length];
    buckets.push({ le: '+Inf', count: cum });
    return { buckets, count: this.n, sum: this.sum };
  }

  reset(): void { this.counts.fill(0); this.sum = 0; this.n = 0; }
}

// ---------------------------------------------------------------------------
// Tracing hook — OpenTelemetry-SHAPED, SDK not bundled
// ---------------------------------------------------------------------------

/**
 * A minimal span contract that mirrors OpenTelemetry's `Span` closely enough to
 * bridge in one adapter (`span.end()`, attributes) WITHOUT pulling the heavy
 * `@opentelemetry/sdk-*` dependency into a library. The default tracer is a
 * no-op; `jsonTracer` emits one line per span for local dogfooding; wiring a
 * real OTel exporter is a thin `startSpan` → `tracer.startSpan` shim (see
 * docs/operations.md). This is deliberately a HOOK, not an OTel integration —
 * labelled honestly so nobody assumes spans reach a collector out of the box.
 */
export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  end(): void;
}
export interface Tracer {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): Span;
}

export const noopTracer: Tracer = {
  startSpan: () => ({ setAttribute: () => {}, end: () => {} }),
};

/** A tracer that emits one JSON line per finished span — for dogfooding/tests. */
export function jsonTracer(
  emit: (line: Record<string, unknown>) => void,
  now: () => number = Date.now,
): Tracer {
  return {
    startSpan(name, attributes = {}) {
      const start = now();
      const attrs: Record<string, string | number | boolean> = { ...attributes };
      return {
        setAttribute(k, v) { attrs[k] = v; },
        end() { emit({ span: name, duration_ms: now() - start, ...attrs }); },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Retry with exponential backoff + full jitter
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  /** Base backoff in ms (doubles each retry). Default 200. */
  baseMs?: number;
  /** Backoff ceiling in ms. Default 5000. */
  maxMs?: number;
  /** Called before each retry sleep (e.g. to count + log). */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Decide whether an error is retryable. Default: always. */
  retryable?: (err: unknown) => boolean;
  /** Injectable sleep + RNG for tests. */
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying transient failures with exponential backoff + full jitter. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 200;
  const maxMs = opts.maxMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  const rng = opts.rng ?? Math.random;
  const retryable = opts.retryable ?? ((): boolean => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !retryable(err)) break;
      const backoff = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const delay = Math.floor(rng() * backoff);   // full jitter: [0, backoff)
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
