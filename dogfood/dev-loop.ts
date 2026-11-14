/**
 * Dogfood: the dev-loop event cache. Proves the thing that makes iteration feel
 * instant: the FIRST sync pays the network cost once, and a later run (a handler
 * edit + restart) replays the same blocks from the on-disk cache with ZERO
 * source fetches, so it finishes in a fraction of the time.
 *
 *   npx tsx dogfood/dev-loop.ts
 *
 * Run 1 indexes with a "count transfers" handler against a deliberately slow
 * source (simulated RPC latency). Run 2 simulates editing the handler to "track
 * balances" and restarting: same persistent cache file, fresh in-memory sink,
 * no network. We assert run 2 fetches nothing, is much faster, and produces the
 * correct new derived state.
 */

import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createIndexer, createCachedSource, openSqlite } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const fail = (m: string): never => { console.error(`[dogfood:dev-loop] FAIL — ${m}`); process.exit(1); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const schema = defineSchema({
  Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } },
  Stat:    { count: { type: 'int' } },
});

// 60 transfers across 60 blocks, deployer -> holder_i of (i+1) units.
const EVENTS: ChainEvent[] = Array.from({ length: 60 }, (_, i) => ({
  chainId: 1, network: 'eth', blockNumber: i + 1, blockHash: `0x${i + 1}`,
  txHash: `0x${i + 1}`, logIndex: 0, contractAddress: '0xtoken', eventName: 'Transfer',
  eventRaw: new Uint8Array(0), decoded: { to: `0xholder${i % 5}`, value: BigInt(i + 1) }, dataLength: 0,
}));

/** A source with per-fetch network latency, so "replay vs re-fetch" is visible in wall-clock. */
class SlowSource implements EventSource {
  fetched = 0;
  async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
    await sleep(120);                                   // simulated RPC round-trip for the range
    for (const e of EVENTS) if (e.blockNumber >= from && e.blockNumber <= to) { this.fetched++; await sleep(4); yield e; }
  }
  subscribe(): UnsubscribeFn { return () => {}; }
}

async function main(): Promise<void> {
  const cacheFile = join(tmpdir(), `counterindex-devloop-${process.pid}.db`);
  rmSync(cacheFile, { force: true });
  try {
    // ---- Run 1: cold. Pays the network cost once, fills the cache. ----
    const slow1 = new SlowSource();
    const cache1 = await createCachedSource(slow1, { path: cacheFile });
    const ix1 = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source: cache1 });
    let count = 0;
    ix1.on('Transfer', async (_e, ctx) => { count++; await ctx.store.set('Stat', 'transfers', { count }); });
    const t1 = Date.now();
    await ix1.sync(1, 60);
    const run1Ms = Date.now() - t1;
    if (slow1.fetched !== 60) fail(`run 1 should fetch all 60, got ${slow1.fetched}`);

    // ---- Run 2: simulate editing the handler + restarting. Same cache file, fresh sink. ----
    const slow2 = new SlowSource();
    const cache2 = await createCachedSource(slow2, { path: cacheFile });   // reopens the SAME on-disk cache
    const ix2 = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source: cache2 });
    // New handler: track running balances instead of just counting.
    ix2.on('Transfer', async (e, ctx) => {
      const to = e.decoded!['to'] as string, value = e.decoded!['value'] as bigint;
      const cur = await ctx.store.get('Balance', to);
      await ctx.store.set('Balance', to, { holder: to, amount: (cur ? (cur['amount'] as bigint) : 0n) + value });
    });
    const t2 = Date.now();
    await ix2.sync(1, 60);
    const run2Ms = Date.now() - t2;

    if (slow2.fetched !== 0) fail(`run 2 (replay) must fetch ZERO from source, got ${slow2.fetched}`);
    if (run2Ms >= run1Ms) fail(`run 2 (${run2Ms}ms) should be much faster than run 1 (${run1Ms}ms)`);

    // The new handler's derived state must be correct (sum of (i+1) for i%5 == bucket).
    // holder0 gets blocks 1,6,11,...,56 -> values 1+6+11+...+56.
    const expected0 = [1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 56].reduce((a, b) => a + BigInt(b), 0n);
    const bal0 = await ix2.store.get('Balance', '0xholder0');
    if (!bal0 || (bal0['amount'] as bigint) !== expected0) fail(`holder0 balance wrong: ${bal0?.['amount']} != ${expected0}`);
    if ((await ix2.store.count('Balance')) !== 5) fail('expected 5 holders');

    const s = await cache2.stats();
    const speedup = (run1Ms / Math.max(run2Ms, 1)).toFixed(1);
    console.log(`  run 1 (cold):   ${slow1.fetched} source fetches, ${run1Ms}ms`);
    console.log(`  run 2 (replay): ${slow2.fetched} source fetches, ${run2Ms}ms  (~${speedup}x faster, new handler)`);
    console.log(`  cache: ${s.events} events on disk, ranges ${JSON.stringify(s.ranges)}`);
    console.log('[dogfood:dev-loop] PASS — edit-restart-resync replays from cache with zero re-fetch.');
  } finally {
    rmSync(cacheFile, { force: true });
  }
}

void main();
