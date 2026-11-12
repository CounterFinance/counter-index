/**
 * Operability primitives (M18): health-state machine, histogram, tracer, retry.
 * A fake clock makes the time-derived states (stalled/degraded) deterministic.
 */

import { describe, it, expect, vi } from 'vitest';
import { Lifecycle, Histogram, jsonTracer, noopTracer, withRetry } from '../src/lifecycle.js';

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('Lifecycle health states', () => {
  it('walks starting → backfilling → live as chains catch up', () => {
    const c = clock();
    const lc = new Lifecycle({ now: c.now, liveLagThreshold: 1, stallMs: 60_000 });
    expect(lc.state()).toBe('starting');

    lc.start();
    expect(lc.state()).toBe('backfilling');

    lc.recordBlock(1, 100, 110);          // 10 behind → still backfilling
    expect(lc.state()).toBe('backfilling');
    expect(lc.health().chains[0]).toMatchObject({ chainId: 1, lastBlock: 100, blocksBehind: 10 });

    lc.recordBlock(1, 110, 110);          // caught up
    expect(lc.state()).toBe('live');
  });

  it('reports stalled after no progress for stallMs', () => {
    const c = clock();
    const lc = new Lifecycle({ now: c.now, stallMs: 30_000 });
    lc.start();
    lc.recordBlock(1, 5, 5);
    expect(lc.state()).toBe('live');
    c.advance(30_001);
    expect(lc.state()).toBe('stalled');
    lc.recordBlock(1, 6, 6);              // progress resumes
    expect(lc.state()).toBe('live');
  });

  it('reports degraded after a recent error, then recovers', () => {
    const c = clock();
    const lc = new Lifecycle({ now: c.now, stallMs: 60_000, degradeMs: 10_000 });
    lc.start();
    lc.recordBlock(1, 5, 5);
    lc.recordError();
    expect(lc.state()).toBe('degraded');
    expect(lc.health().errors).toBe(1);
    c.advance(10_001);                    // error window passes
    expect(lc.state()).toBe('live');
  });

  it('only goes live when EVERY chain is caught up', () => {
    const c = clock();
    const lc = new Lifecycle({ now: c.now, liveLagThreshold: 0 });
    lc.start();
    lc.recordBlock(1, 10, 10);            // chain 1 caught up
    lc.recordBlock(137, 90, 100);         // chain 137 still behind
    expect(lc.state()).toBe('backfilling');
    lc.recordBlock(137, 100, 100);
    expect(lc.state()).toBe('live');
    expect(lc.health().chains.map((x) => x.chainId)).toEqual([1, 137]);
  });

  it('draining and stopped override derived states', () => {
    const c = clock();
    const lc = new Lifecycle({ now: c.now });
    lc.start(); lc.recordBlock(1, 1, 1);
    lc.draining();
    expect(lc.state()).toBe('draining');
    lc.stopped();
    expect(lc.state()).toBe('stopped');
    lc.recordBlock(1, 2, 2);              // ignored once stopped
    expect(lc.state()).toBe('stopped');
  });
});

describe('Histogram', () => {
  it('bins observations into cumulative le buckets with count + sum', () => {
    const h = new Histogram([1, 10, 100]);
    for (const ms of [0.5, 5, 5, 50, 500]) h.observe(ms);
    const s = h.snapshot();
    expect(s.count).toBe(5);
    expect(s.sum).toBeCloseTo(560.5);
    expect(s.buckets).toEqual([
      { le: 1, count: 1 },      // 0.5
      { le: 10, count: 3 },     // +5, +5
      { le: 100, count: 4 },    // +50
      { le: '+Inf', count: 5 }, // +500
    ]);
  });
});

describe('jsonTracer', () => {
  it('emits one line per finished span with duration + attributes', () => {
    const c = clock();
    const lines: Record<string, unknown>[] = [];
    const t = jsonTracer((l) => lines.push(l), c.now);
    const span = t.startSpan('block', { block: 7 });
    span.setAttribute('events', 3);
    c.advance(12);
    span.end();
    expect(lines).toEqual([{ span: 'block', duration_ms: 12, block: 7, events: 3 }]);
  });
  it('noopTracer does nothing and never throws', () => {
    const s = noopTracer.startSpan('x');
    s.setAttribute('a', 1); s.end();
    expect(true).toBe(true);
  });
});

describe('withRetry', () => {
  it('retries transient failures and eventually succeeds', async () => {
    let n = 0;
    const onRetry = vi.fn();
    const out = await withRetry(async () => {
      n++;
      if (n < 3) throw new Error('boom');
      return 'ok';
    }, { attempts: 5, sleep: async () => {}, rng: () => 0, onRetry });
    expect(out).toBe('ok');
    expect(n).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('gives up after `attempts` and throws the last error', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error(`fail-${n}`); },
      { attempts: 3, sleep: async () => {}, rng: () => 0 },
    )).rejects.toThrow('fail-3');
    expect(n).toBe(3);
  });

  it('does not retry when retryable() returns false', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('nope'); },
      { attempts: 5, sleep: async () => {}, retryable: () => false },
    )).rejects.toThrow('nope');
    expect(n).toBe(1);
  });

  it('backoff grows but is capped and jittered within [0, bound)', async () => {
    const delays: number[] = [];
    await withRetry(async () => { throw new Error('x'); }, {
      attempts: 5, baseMs: 100, maxMs: 400, rng: () => 0.999,
      sleep: async (ms) => { delays.push(ms); },
    }).catch(() => {});
    // bounds: 100, 200, 400, 400 (capped); full-jitter * 0.999 floored
    expect(delays).toEqual([99, 199, 399, 399]);
  });
});
