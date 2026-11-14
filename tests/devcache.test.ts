/**
 * Dev-loop event cache: a fetched range is served from the cache on every later
 * run with zero calls to the underlying source, so an edit-restart-resync loop
 * stays off the network. Also covers gap-fill, filter-on-read, bigint/bytes
 * round-trip, and clear().
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createCachedSource, type CachedEventSource } from '../src/devcache.js';
import { createTestAdapter } from '../src/adapter.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

function ev(block: number, name = 'Transfer', contract = '0xpool', value = 0n): ChainEvent {
  return {
    chainId: 1, network: 'eth', blockNumber: block, blockHash: `0x${block}`,
    txHash: `0x${block}-${name}`, logIndex: 0, contractAddress: contract, eventName: name,
    eventRaw: new Uint8Array([block & 0xff, 0xab]), decoded: { value, who: `addr${block}` }, dataLength: 2,
  };
}

/** A source that records every fetch, so the test can assert on network hits. */
class CountingSource implements EventSource {
  queryCalls: Array<{ from: number; to: number }> = [];
  constructor(private readonly events: ChainEvent[]) {}
  async *queryStream(from: number, to: number, _f?: EventSourceFilters): AsyncIterable<ChainEvent> {
    this.queryCalls.push({ from, to });
    for (const e of this.events) if (e.blockNumber >= from && e.blockNumber <= to) yield e;
  }
  subscribe(): UnsubscribeFn { return () => {}; }
  get totalFetched(): number { return this.queryCalls.length; }
}

async function drain(src: CachedEventSource, from: number, to: number, f?: EventSourceFilters): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for await (const e of src.queryStream(from, to, f)) out.push(e);
  return out;
}

describe('CachedEventSource', () => {
  let inner: CountingSource;
  let cache: CachedEventSource;

  beforeEach(async () => {
    inner = new CountingSource([ev(1), ev(2), ev(5), ev(8), ev(10)]);
    cache = await createCachedSource(inner, { adapter: createTestAdapter() });
  });

  it('fetches once, then replays from cache with zero source calls', async () => {
    const first = await drain(cache, 0, 10);
    expect(first.map((e) => e.blockNumber)).toEqual([1, 2, 5, 8, 10]);
    expect(inner.queryCalls).toHaveLength(1);              // one gap fetch

    const second = await drain(cache, 0, 10);              // simulate restart / handler edit
    expect(second.map((e) => e.blockNumber)).toEqual([1, 2, 5, 8, 10]);
    expect(inner.queryCalls).toHaveLength(1);              // STILL one — replay hit cache, not source
  });

  it('round-trips bigint and byte fields exactly', async () => {
    inner = new CountingSource([ev(3, 'Swap', '0xp', 123456789012345678901234567890n)]);
    cache = await createCachedSource(inner, { adapter: createTestAdapter() });
    const [a] = await drain(cache, 0, 5);
    const [b] = await drain(cache, 0, 5);                  // from cache
    expect(a.decoded!['value']).toBe(123456789012345678901234567890n);
    expect(b.decoded!['value']).toBe(123456789012345678901234567890n);
    expect(typeof b.decoded!['value']).toBe('bigint');
    expect(Array.from(b.eventRaw)).toEqual([3, 0xab]);
    expect(b.eventRaw).toBeInstanceOf(Uint8Array);
  });

  it('round-trips the txEvents Map (sibling-event correlation) through the cache', async () => {
    const withMap = ev(4);
    withMap.txEvents = new Map([
      ['0xrouter', [{ type: 'Swap', raw: new Uint8Array([1, 2, 3]) }]],
      ['0xpool',   [{ type: 'Sync', raw: new Uint8Array([9]) }]],
    ]);
    inner = new CountingSource([withMap]);
    cache = await createCachedSource(inner, { adapter: createTestAdapter() });
    await drain(cache, 0, 5);                              // fetch + cache
    const [replayed] = await drain(cache, 0, 5);           // from cache
    expect(replayed.txEvents).toBeInstanceOf(Map);
    expect(replayed.txEvents!.get('0xrouter')).toEqual([{ type: 'Swap', raw: new Uint8Array([1, 2, 3]) }]);
    expect(replayed.txEvents!.get('0xrouter')![0].raw).toBeInstanceOf(Uint8Array);
    expect(replayed.txEvents!.get('0xpool')![0].raw).toEqual(new Uint8Array([9]));
  });

  it('passes subscribe straight through to the inner source (live is never cached)', async () => {
    let subscribedFrom = -1;
    const live: EventSource = {
      queryStream: inner.queryStream.bind(inner),
      subscribe(from) { subscribedFrom = from; return () => { subscribedFrom = -2; }; },
    };
    const c = await createCachedSource(live, { adapter: createTestAdapter() });
    const unsub = c.subscribe(42, async () => {});
    expect(subscribedFrom).toBe(42);                       // delegated to inner, not the cache
    unsub();
    expect(subscribedFrom).toBe(-2);                       // inner's unsubscribe is what we got back
  });

  it('only fetches the uncovered gap on an extended range', async () => {
    await drain(cache, 0, 5);
    expect(inner.queryCalls).toEqual([{ from: 0, to: 5 }]);
    const all = await drain(cache, 0, 10);                 // 0..5 cached, only 6..10 is new
    expect(all.map((e) => e.blockNumber)).toEqual([1, 2, 5, 8, 10]);
    expect(inner.queryCalls).toEqual([{ from: 0, to: 5 }, { from: 6, to: 10 }]);
  });

  it('serves a middle gap between two cached ranges', async () => {
    await drain(cache, 0, 2);
    await drain(cache, 8, 10);
    inner.queryCalls = [];
    await drain(cache, 0, 10);                             // only 3..7 missing
    expect(inner.queryCalls).toEqual([{ from: 3, to: 7 }]);
  });

  it('applies queryStream filters on read without re-fetching', async () => {
    inner = new CountingSource([ev(1, 'A', '0xaaa'), ev(2, 'B', '0xbbb'), ev(3, 'A', '0xaaa')]);
    cache = await createCachedSource(inner, { adapter: createTestAdapter() });
    await drain(cache, 0, 5);                              // cache everything, unfiltered
    const onlyA = await drain(cache, 0, 5, { eventNames: ['A'] });
    expect(onlyA.map((e) => e.blockNumber)).toEqual([1, 3]);
    const onlyBbb = await drain(cache, 0, 5, { contract: '0xBBB' });  // case-insensitive
    expect(onlyBbb.map((e) => e.blockNumber)).toEqual([2]);
    expect(inner.queryCalls).toHaveLength(1);             // filters never touched the source
  });

  it('clear() forces a cold re-fetch', async () => {
    await drain(cache, 0, 10);
    expect(inner.queryCalls).toHaveLength(1);
    await cache.clear();
    await drain(cache, 0, 10);
    expect(inner.queryCalls).toHaveLength(2);             // cache empty -> fetched again
  });

  it('reports stats (events, ranges, lifetime fetch count)', async () => {
    await drain(cache, 0, 5);
    await drain(cache, 6, 10);
    const s = await cache.stats();
    expect(s.events).toBe(5);
    expect(s.ranges).toEqual([{ lo: 0, hi: 10 }]);        // adjacent ranges merged
    expect(s.fetchedFromSource).toBe(5);
  });
});
