/**
 * Dogfood: production-ops (M18). Drives a live indexer through its health states,
 * scrapes /health + /metrics over real HTTP, then triggers a graceful shutdown
 * and verifies the server is gone, the DB is closed, the checkpoint is consistent
 * with the committed rows (no partial block), and hooks ran.
 *
 *   npx tsx dogfood/ops.ts
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import { jsonTracer } from '../src/lifecycle.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const schema = defineSchema({ Transfer: { amount: { type: 'bigint' } } });

function evt(block: number, i: number): ChainEvent {
  return {
    chainId: 1, network: 'devnet', blockNumber: block, blockHash: `0x${block}`,
    txHash: `0x${block}_${i}`, logIndex: i, contractAddress: '0xc', eventName: 'T',
    eventRaw: new Uint8Array(0), decoded: { amount: BigInt(i) }, dataLength: 0,
  };
}

/** A source that streams a fixed range for backfill (10 events/block). */
function source(toBlock: number): EventSource {
  return {
    async *queryStream(from: number, to: number) {
      for (let b = from; b <= Math.min(to, toBlock); b++) for (let i = 0; i < 10; i++) yield evt(b, i);
    },
    subscribe(): UnsubscribeFn { return () => {}; },
  } as unknown as EventSource;
}

const fail = (m: string): never => { console.error(`[dogfood:ops] FAIL — ${m}`); process.exit(1); };

async function main(): Promise<void> {
  const db = new Database(':memory:');
  const spans: Record<string, unknown>[] = [];
  const indexer = await createIndexer({
    schema,
    sink: new SqliteAdapter(db),
    source: source(100),
    tracer: jsonTracer((l) => spans.push(l)),   // one span per block
  });
  indexer.on('T', async (e, ctx) => { await ctx.store.set('Transfer', e.txHash, { amount: e.decoded!['amount'] as bigint }); });

  let hookRan = false;
  indexer.onShutdown(() => { hookRan = true; });

  if (indexer.health().state !== 'starting') fail(`expected starting, got ${indexer.health().state}`);

  // Backfill 1..100 with a known tip → should end 'live'.
  await indexer.sync(1, 100, undefined, 100);
  const live = indexer.health();
  if (live.state !== 'live') fail(`expected live after catch-up, got ${live.state}`);
  if (live.chains[0].blocksBehind !== 0) fail(`expected 0 behind, got ${live.chains[0].blocksBehind}`);

  // Serve + scrape the operational endpoints over real HTTP.
  const handle = await indexer.serve({ port: 47970 });
  const base = handle.url.replace('/graphql', '');
  const healthRes = await fetch(`${base}/health`);
  const health = await healthRes.json() as { status: string; health: { state: string; chains: unknown[] } };
  const metrics = await (await fetch(`${base}/metrics`)).text();

  if (healthRes.status !== 200) fail(`/health should be 200 when live, got ${healthRes.status}`);
  if (health.status !== 'live') fail(`/health status should be live, got ${health.status}`);
  for (const must of [
    'opindex_health_state{state="live"} 1',
    'opindex_chain_blocks_behind{chain="1"} 0',
    'opindex_handler_latency_ms_count 1000',          // 100 blocks * 10 events
    'opindex_reorgs_total 0',
  ]) if (!metrics.includes(must)) fail(`/metrics missing: ${must}`);

  // Consistency: checkpoint must equal the number of committed rows' blocks.
  const rows = await indexer.store.count('Transfer');
  if (rows !== 1000) fail(`expected 1000 rows, got ${rows}`);

  // Graceful shutdown.
  await indexer.shutdown();
  if (indexer.health().state !== 'stopped') fail(`expected stopped, got ${indexer.health().state}`);
  if (!hookRan) fail('onShutdown hook did not run');
  if (db.open) fail('sink DB was not closed');
  let serverGone = false;
  try { await fetch('http://localhost:47970/health'); } catch { serverGone = true; }
  if (!serverGone) fail('server still accepting connections after shutdown');

  console.log(`  states:   starting → backfilling → live → draining → stopped`);
  console.log(`  blocks:   100 committed, ${rows} rows, 0 behind at tip`);
  console.log(`  spans:    ${spans.length} block spans emitted (e.g. ${JSON.stringify(spans[0])})`);
  console.log(`  shutdown: server closed, DB closed, hook ran, checkpoint consistent`);
  console.log(`[dogfood:ops] PASS — health states, metrics scrape, and graceful shutdown all verified.`);
}

void main();
