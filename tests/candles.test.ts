/**
 * OHLCV candles (defineCandles): incremental open/high/low/close/volume/trades
 * per time bucket, maintained as events flow — the DEX "give me 1m candles" path.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import { defineCandles, candleEntity, candleBucket } from '../src/candles.js';
import type { ChainEvent } from '../src/types.js';

const schema = defineSchema({
  Swap: { price: { type: 'float' }, amount: { type: 'float' } },
  Candle1m: candleEntity(),
}) as Schema<SchemaDefinition>;

function swap(block: number, tsSec: number, price: number, amount: number): ChainEvent {
  return {
    chainId: 0, network: 't', blockNumber: block, blockHash: `0x${block}`, blockTimestamp: tsSec,
    txHash: `0x${block}_${price}`, logIndex: 0, contractAddress: '0xp', eventName: 'Swap',
    eventRaw: new Uint8Array(0), decoded: { price, amount }, dataLength: 0,
  };
}

describe('defineCandles', () => {
  it('candleBucket floors to the interval start', () => {
    expect(candleBucket(1_700_000_061, 60)).toBe(1_700_000_040);
    expect(candleBucket(1_700_000_039, 60)).toBe(1_700_000_040 - 60);
  });

  it('builds correct OHLCV per 1m bucket from a trade stream', async () => {
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
    defineCandles(indexer, {
      entity: 'Candle1m', on: 'Swap', intervalSec: 60,
      price: (e) => e.decoded!['price'] as number,
      volume: (e) => e.decoded!['amount'] as number,
    });

    const base = 1_700_000_040;                 // a real bucket start (divisible by 60)
    await indexer.processEvents([
      // bucket A [base, base+60): prices 100,105,95,102 vol 1,2,3,4
      swap(1, base + 1,  100, 1),
      swap(1, base + 10, 105, 2),
      swap(1, base + 20, 95,  3),
      swap(1, base + 59, 102, 4),
      // bucket B [base+60, …): prices 110,108 vol 5,6
      swap(2, base + 61, 110, 5),
      swap(2, base + 90, 108, 6),
    ]);

    const a = await indexer.store.get('Candle1m', String(base));
    expect(a).toMatchObject({ open: 100, high: 105, low: 95, close: 102, volume: 10, trades: 4, bucket: base });

    const b = await indexer.store.get('Candle1m', String(base + 60));
    expect(b).toMatchObject({ open: 110, high: 110, low: 108, close: 108, volume: 11, trades: 2, bucket: base + 60 });

    expect(await indexer.store.count('Candle1m')).toBe(2);
  });

  it('skips events without a block timestamp', async () => {
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
    defineCandles(indexer, { entity: 'Candle1m', on: 'Swap', intervalSec: 60, price: () => 1 });
    const e = swap(1, 0, 1, 1); delete (e as { blockTimestamp?: number }).blockTimestamp;
    await indexer.processEvents([e]);
    expect(await indexer.store.count('Candle1m')).toBe(0);
  });
});
