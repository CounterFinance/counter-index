/**
 * Dogfood: OHLCV candles. Aggregate a synthetic swap stream into 1m candles with
 * defineCandles, then serve them and run the DEX's #1 query — a time-range of
 * candles — over GraphQL (SQL range pushdown on the indexed `bucket`, M17).
 *
 *   npx tsx dogfood/candles.ts
 */

import Database from 'better-sqlite3';
import { createIndexer, defineCandles, candleEntity, candleBucket } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const schema = defineSchema({ Swap: { price: { type: 'float' }, amount: { type: 'float' } }, Candle1m: candleEntity() });

const BASE = 1_700_000_040;                       // 60-aligned
function swap(slot: number, tsSec: number, price: number, amount: number): ChainEvent {
  return {
    chainId: 1, network: 'devnet', blockNumber: slot, blockHash: `0x${slot}`, blockTimestamp: tsSec,
    txHash: `0x${slot}`, logIndex: 0, contractAddress: '0xpool', eventName: 'Swap',
    eventRaw: new Uint8Array(0), decoded: { price, amount }, dataLength: 0,
  };
}

const fail = (m: string): never => { console.error(`[dogfood:candles] FAIL — ${m}`); process.exit(1); };

async function main(): Promise<void> {
  // 180 swaps over 3 minutes: a sine-ish price so OHLC is non-trivial.
  const events: ChainEvent[] = [];
  for (let i = 0; i < 180; i++) {
    const price = 100 + 10 * Math.sin(i / 10);
    events.push(swap(i + 1, BASE + i, Number(price.toFixed(2)), 1 + (i % 5)));
  }
  const source: EventSource = {
    async *queryStream(from, to) { for (const e of events) if (e.blockNumber >= from && e.blockNumber <= to) yield e; },
    subscribe(): UnsubscribeFn { return () => {}; },
  };

  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source });
  defineCandles(indexer, {
    entity: 'Candle1m', on: 'Swap', intervalSec: 60,
    price: (e) => e.decoded!['price'] as number,
    volume: (e) => e.decoded!['amount'] as number,
  });
  await indexer.sync(1, 180, undefined, 180);

  const buckets = [BASE, BASE + 60, BASE + 120].map(String);
  const handle = await indexer.serve({ port: 47982 });
  try {
    // DEX query: candles in [BASE+60, BASE+120] ordered by time (SQL range on bucket).
    const r = await fetch(handle.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ candle1ms(where: { bucket_gte: ${BASE + 60} }, orderBy: bucket, orderDirection: asc) { nodes { id open high low close volume trades } } }` }),
    });
    const j = await r.json() as { data: { candle1ms: { nodes: Array<Record<string, unknown>> } } };
    const nodes = j.data.candle1ms.nodes;
    if (nodes.length !== 2) fail(`expected 2 candles in range, got ${nodes.length}`);
    for (const c of nodes) {
      if (!((c.low as number) <= (c.open as number) && (c.open as number) <= (c.high as number))) fail(`OHLC invariant broken: ${JSON.stringify(c)}`);
      if (!((c.low as number) <= (c.close as number) && (c.close as number) <= (c.high as number))) fail(`OHLC invariant broken: ${JSON.stringify(c)}`);
    }
    const total = await indexer.store.count('Candle1m');
    if (total !== 3) fail(`expected 3 candles total, got ${total}`);
    if (candleBucket(BASE + 61, 60) !== BASE + 60) fail('candleBucket math wrong');

    const c1 = nodes[0];
    console.log(`  180 swaps over 3 min → 3 one-minute candles (O/H/L/C/V maintained incrementally)`);
    console.log(`  range query [t+60, …] over SQL-indexed bucket → ${nodes.length} candles`);
    console.log(`  candle @${c1.id}: O=${c1.open} H=${c1.high} L=${c1.low} C=${c1.close} V=${c1.volume} (${c1.trades} trades)`);
    console.log(`[dogfood:candles] PASS — OHLCV maintained + served (the DEX #1 query).`);
    void buckets;
  } finally {
    await handle.stop();
  }
}

void main();
