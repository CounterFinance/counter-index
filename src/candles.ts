/**
 * First-class OHLCV time-series (candles). A DEX/portfolio indexer's #1 served
 * query is candles; `defineCandles` maintains them incrementally as events flow,
 * using the same store (and the M13 read-your-writes buffer within a block), so
 * no extra pass and no separate aggregation job.
 *
 *   const schema = defineSchema({ Swap: {...}, Candle1m: candleEntity() });
 *   const indexer = await createIndexer({ schema, sink, source });
 *   defineCandles(indexer, { entity: 'Candle1m', on: 'Swap', intervalSec: 60,
 *     price: (e) => Number(e.decoded!.price), volume: (e) => Number(e.decoded!.amount) });
 *
 * Each candle's id is its bucket-start unix second (string), so they sort and
 * keyset-paginate by id, and `where: { bucket_gte: … }` ranges over SQL (M17).
 */

import type { ChainEvent } from './types.js';
import type { EntityDef } from './schema.js';

/** The entity shape a candle stream writes. Spread into `defineSchema`. */
export function candleEntity(): EntityDef {
  return {
    open:   { type: 'float' },
    high:   { type: 'float' },
    low:    { type: 'float' },
    close:  { type: 'float' },
    volume: { type: 'float' },
    trades: { type: 'int' },
    bucket: { type: 'int', index: true },   // indexed for time-range queries
  };
}

/** Minimal store surface defineCandles needs (satisfied by ctx.store / indexer.store). */
interface CandleStore {
  get(entity: string, id: string): Promise<Record<string, unknown> | undefined>;
  set(entity: string, id: string, data: Record<string, unknown>): Promise<void>;
}
interface CandleIndexer {
  on(eventName: string, handler: (event: ChainEvent, ctx: { store: CandleStore }) => Promise<void>): void;
}

export interface DefineCandlesOptions {
  /** Candle entity name in the schema (use `candleEntity()` for its shape). */
  entity: string;
  /** Source event name to aggregate (e.g. 'Swap'). */
  on: string;
  /** Bucket size in seconds (60 = 1m, 300 = 5m, 3600 = 1h, 86400 = 1d). */
  intervalSec: number;
  /** Extract the trade price from an event. */
  price: (event: ChainEvent) => number;
  /** Extract the trade volume (default 0). */
  volume?: (event: ChainEvent) => number;
}

/** Floor a unix-seconds timestamp to its bucket start. */
export function candleBucket(tsSec: number, intervalSec: number): number {
  return Math.floor(tsSec / intervalSec) * intervalSec;
}

/**
 * Register an OHLCV aggregator: for every `on` event with a block timestamp,
 * update the candle bucket it falls in (open=first, high/low=extremes, close=
 * last, volume=sum, trades=count). Candles are per-chain (ctx.store is scoped).
 */
export function defineCandles(indexer: CandleIndexer, opts: DefineCandlesOptions): void {
  if (opts.intervalSec <= 0) throw new Error('[op-index] defineCandles: intervalSec must be > 0');
  indexer.on(opts.on, async (event, ctx) => {
    const ts = event.blockTimestamp;
    if (ts === undefined) return;                       // no time → can't bucket
    const bucket = candleBucket(ts, opts.intervalSec);
    const id = String(bucket);
    const p = opts.price(event);
    const v = opts.volume ? opts.volume(event) : 0;

    const cur = await ctx.store.get(opts.entity, id);
    if (!cur) {
      await ctx.store.set(opts.entity, id, { open: p, high: p, low: p, close: p, volume: v, trades: 1, bucket });
    } else {
      await ctx.store.set(opts.entity, id, {
        open:   cur['open'],                            // first price in the bucket, unchanged
        high:   Math.max(cur['high'] as number, p),
        low:    Math.min(cur['low'] as number, p),
        close:  p,                                      // last price wins
        volume: (cur['volume'] as number) + v,
        trades: (cur['trades'] as number) + 1,
        bucket,
      });
    }
  });
}
