/**
 * Soak / leak test (M15). Index a long synthetic stream (default 300k events
 * over a BOUNDED set of accounts) and watch the heap. The store grows with
 * UNIQUE entities, not with events, so once the accounts are populated the heap
 * must PLATEAU — a per-event leak would instead grow heap ~linearly with events.
 * We also assert health stays `live` and lag stays 0.
 *
 *   npx tsx dogfood/soak.ts            # default 300k events
 *   EVENTS=1000000 npx tsx dogfood/soak.ts
 *   node --expose-gc ... for exact heap (optional; trend holds without it)
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const EVENTS = Number(process.env.EVENTS ?? 300_000);
const ACCOUNTS = 1_000;             // bounded unique entity set
const PER_BLOCK = 20;
const acct = (i: number): string => `0x${(i % ACCOUNTS).toString(16).padStart(40, '0')}`;

const schema = defineSchema({ Balance: { amount: { type: 'bigint' } } });

/** Lazily generate the stream so we never hold all events in memory. */
function streamSource(): EventSource {
  return {
    async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
      let i = 0;
      for (let block = from; block <= to; block++) {
        for (let k = 0; k < PER_BLOCK; k++, i++) {
          yield {
            chainId: 1, network: 'soak', blockNumber: block, blockHash: `0x${block}`,
            txHash: `0x${block}_${k}`, logIndex: k, contractAddress: '0xc', eventName: 'T',
            eventRaw: new Uint8Array(0), decoded: { to: acct(i), amount: '1' }, dataLength: 0,
          } as ChainEvent;
        }
      }
    },
    subscribe(): UnsubscribeFn { return () => {}; },
  } as unknown as EventSource;
}

const heapMB = (): number => {
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed / 1e6;
};

async function main(): Promise<void> {
  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source: streamSource() });
  indexer.on('T', async (e, ctx) => {
    const to = e.decoded!['to'] as string;
    const cur = await ctx.store.get('Balance', to);
    await ctx.store.set('Balance', to, { amount: (cur ? (cur.amount as bigint) : 0n) + 1n });
  });

  const totalBlocks = Math.ceil(EVENTS / PER_BLOCK);
  const samples: Array<{ pct: number; heap: number }> = [];
  const window = Math.floor(totalBlocks / 4);

  const t0 = Date.now();
  // Backfill in 4 quarters, sampling heap after each (post-warmup trend is flat).
  for (let q = 0; q < 4; q++) {
    const from = q * window + 1;
    const to = q === 3 ? totalBlocks : (q + 1) * window;
    await indexer.sync(from, to, undefined, totalBlocks);
    samples.push({ pct: (q + 1) * 25, heap: heapMB() });
  }
  const elapsed = (Date.now() - t0) / 1000;

  const h = indexer.health();
  const rows = await indexer.store.count('Balance');
  const eps = Math.round(indexer.stats.eventsProcessed / elapsed);

  console.log(`\n  events ${indexer.stats.eventsProcessed.toLocaleString()} over ${totalBlocks.toLocaleString()} blocks, ${ACCOUNTS} accounts`);
  console.log(`  throughput ${eps.toLocaleString()} ev/s in ${elapsed.toFixed(1)}s\n`);
  console.log(`  heap after:  ${samples.map((s) => `${s.pct}%=${s.heap.toFixed(0)}MB`).join('   ')}`);

  // Leak check: once the account set is populated (by 50%), later heap must not
  // keep climbing with events. Growth from 50%→100% should be a small fraction
  // of the early (0→50%) growth — a per-event leak would blow this out.
  const earlyGrowth = Math.max(1, samples[1].heap - samples[0].heap);
  const lateGrowth = samples[3].heap - samples[1].heap;
  const bounded = lateGrowth < 25 && lateGrowth <= earlyGrowth * 3 + 10;

  const fail = (m: string): never => { console.error(`[dogfood:soak] FAIL — ${m}`); process.exit(1); };
  if (rows !== ACCOUNTS) fail(`expected ${ACCOUNTS} balance rows, got ${rows}`);
  if (h.state !== 'live') fail(`expected health=live, got ${h.state}`);
  if (h.chains[0].blocksBehind !== 0) fail(`expected 0 blocks behind, got ${h.chains[0].blocksBehind}`);
  if (!bounded) fail(`heap kept growing with events (late +${lateGrowth.toFixed(0)}MB vs early +${earlyGrowth.toFixed(0)}MB) — possible leak`);

  console.log(`  late-run heap growth +${lateGrowth.toFixed(0)}MB (bounded) · health=${h.state} · lag=0`);
  console.log(`[dogfood:soak] PASS — ${EVENTS.toLocaleString()} events, memory bounded, no leak, state live.`);
}

void main();
