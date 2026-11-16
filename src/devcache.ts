/**
 * Dev-loop event cache.
 *
 * An indexer's inner loop is slow for one reason: every restart re-fetches the
 * same blocks from the chain. The fix is to separate FETCHING (slow, networked)
 * from PROCESSING (fast, your handlers): cache fetched events once, and on every
 * later run replay them from the cache with zero calls to the source. Edit a
 * handler, restart under `tsx watch`, and a re-sync over an already-cached range
 * hits the disk, not the RPC, so iteration feels instant.
 *
 *   import { createCachedSource, createIndexer, openSqlite } from '@counterfinance/counter-index';
 *
 *   const cached = await createCachedSource(myEvmSource);  // persists to .counterindex-cache/
 *   const indexer = await createIndexer({ schema, source: cached, sink: openSqlite(':memory:') });
 *   await indexer.sync(from, to);   // 1st run fetches + caches; every later run replays from cache
 *
 * The cache is keyed by block range and is filter-independent: it stores the raw
 * event stream and applies `queryStream` filters on read, so changing a filter
 * between runs still replays from cache. Live `subscribe()` is passed straight
 * through (live data is never cached). This is a development aid; point it at a
 * throwaway cache file, not production state.
 */

import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import type { ChainEvent } from './types.js';
import type { MinimalDbAdapter } from './adapter.js';
import { openSqlite } from './adapter.js';

// ---------------------------------------------------------------------------
// Structured codec: JSON that round-trips bigint, Uint8Array, and Map
// (ChainEvent.decoded carries bigints, eventRaw is bytes, txEvents is a Map).
// ---------------------------------------------------------------------------

function encode(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v === 'bigint') return { $bigint: v.toString() };
    if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString('base64') };
    if (v instanceof Map) return { $map: Array.from((v as Map<unknown, unknown>).entries()) };
    return v;
  });
}

function decode(json: string): unknown {
  return JSON.parse(json, (_k, v: unknown) => {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['$bigint'] === 'string') return BigInt(o['$bigint']);
      if (typeof o['$bytes'] === 'string') return new Uint8Array(Buffer.from(o['$bytes'], 'base64'));
      if (Array.isArray(o['$map'])) return new Map(o['$map'] as [unknown, unknown][]);
    }
    return v;
  });
}

const encodeEvent = (e: ChainEvent): string => encode(e);
const decodeEvent = (s: string): ChainEvent => decode(s) as ChainEvent;

// ---------------------------------------------------------------------------
// Covered-range maths
// ---------------------------------------------------------------------------

type Range = { lo: number; hi: number };

/** Merge overlapping/adjacent ranges into a minimal sorted set. */
function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.lo - b.lo);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.lo <= last.hi + 1) last.hi = Math.max(last.hi, r.hi);
    else out.push({ ...r });
  }
  return out;
}

/** The sub-intervals of [from, to] not covered by `covered` (sorted, merged). */
function gapsIn(from: number, to: number, covered: Range[]): Range[] {
  const gaps: Range[] = [];
  let cursor = from;
  for (const r of covered) {
    if (r.hi < cursor) continue;
    if (r.lo > to) break;
    if (r.lo > cursor) gaps.push({ lo: cursor, hi: Math.min(r.lo - 1, to) });
    cursor = Math.max(cursor, r.hi + 1);
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ lo: cursor, hi: to });
  return gaps;
}

// ---------------------------------------------------------------------------
// Options + stats
// ---------------------------------------------------------------------------

export interface CachedSourceOptions {
  /** SQLite cache file. Default: `.counterindex-cache/events.db`. Ignored if `adapter` is given. */
  path?: string;
  /** A pre-opened cache adapter (tests pass an in-memory one). Overrides `path`. */
  adapter?: MinimalDbAdapter;
  /** Called once per `queryStream`, after gap-fill, with how the range was served. */
  onReplay?: (info: { from: number; to: number; gapsFetched: number; fromCache: boolean }) => void;
}

export interface CacheStats {
  /** Events held in the cache. */
  events: number;
  /** Merged covered block ranges. */
  ranges: Range[];
  /** Events pulled from the underlying source over this instance's lifetime. */
  fetchedFromSource: number;
}

function matches(e: ChainEvent, f?: EventSourceFilters): boolean {
  if (!f) return true;
  if (f.contract && e.contractAddress.toLowerCase() !== f.contract.toLowerCase()) return false;
  if (f.eventNames && f.eventNames.length > 0 && !f.eventNames.includes(e.eventName)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// CachedEventSource
// ---------------------------------------------------------------------------

export class CachedEventSource implements EventSource {
  private fetched = 0;

  private constructor(
    private readonly inner: EventSource,
    private readonly db: MinimalDbAdapter,
    private readonly onReplay?: CachedSourceOptions['onReplay'],
  ) {}

  /** Create the cache (and its tables) around an inner source. */
  static async create(inner: EventSource, opts: CachedSourceOptions = {}): Promise<CachedEventSource> {
    const db = opts.adapter ?? openSqlite(opts.path ?? '.counterindex-cache/events.db');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS cache_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        block INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cache_events_block ON cache_events(block);
      CREATE TABLE IF NOT EXISTS cache_ranges (lo INTEGER NOT NULL, hi INTEGER NOT NULL);
    `);
    return new CachedEventSource(inner, db, opts.onReplay);
  }

  private async coveredRanges(): Promise<Range[]> {
    const rows = await this.db.all<Range>('SELECT lo, hi FROM cache_ranges ORDER BY lo');
    return mergeRanges(rows.map((r) => ({ lo: Number(r.lo), hi: Number(r.hi) })));
  }

  /** Fetch any sub-ranges of [from,to] not yet cached, and persist their events. */
  private async ensureCovered(from: number, to: number): Promise<number> {
    const gaps = gapsIn(from, to, await this.coveredRanges());
    for (const gap of gaps) {
      // Cache the RAW stream (no filters) so the cache is reusable across filters.
      const events: ChainEvent[] = [];
      for await (const e of this.inner.queryStream(gap.lo, gap.hi)) {
        events.push(e);
        this.fetched++;
      }
      await this.db.transaction(async () => {
        for (const e of events) {
          await this.db.run('INSERT INTO cache_events (block, json) VALUES (?, ?)', [e.blockNumber, encodeEvent(e)]);
        }
        await this.db.run('INSERT INTO cache_ranges (lo, hi) VALUES (?, ?)', [gap.lo, gap.hi]);
      });
    }
    // Re-merge the range set so coverage stays minimal.
    if (gaps.length > 0) {
      const merged = mergeRanges((await this.db.all<Range>('SELECT lo, hi FROM cache_ranges')).map((r) => ({ lo: Number(r.lo), hi: Number(r.hi) })));
      await this.db.transaction(async () => {
        await this.db.run('DELETE FROM cache_ranges');
        for (const r of merged) await this.db.run('INSERT INTO cache_ranges (lo, hi) VALUES (?, ?)', [r.lo, r.hi]);
      });
    }
    return gaps.length;
  }

  async *queryStream(fromBlock: number, toBlock: number, filters?: EventSourceFilters): AsyncIterable<ChainEvent> {
    const gapsFetched = await this.ensureCovered(fromBlock, toBlock);
    this.onReplay?.({ from: fromBlock, to: toBlock, gapsFetched, fromCache: gapsFetched === 0 });
    const rows = await this.db.all<{ json: string }>(
      'SELECT json FROM cache_events WHERE block BETWEEN ? AND ? ORDER BY block, seq',
      [fromBlock, toBlock],
    );
    for (const row of rows) {
      const e = decodeEvent(row.json);
      if (matches(e, filters)) yield e;
    }
  }

  /** Live data is never cached: pass straight through to the inner source. */
  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
    options?: { pollIntervalMs?: number },
  ): UnsubscribeFn {
    return this.inner.subscribe(fromBlock, onEvent, options);
  }

  /** Drop all cached events + coverage (force a cold re-fetch next run). */
  async clear(): Promise<void> {
    await this.db.exec('DELETE FROM cache_events; DELETE FROM cache_ranges;');
  }

  async stats(): Promise<CacheStats> {
    const c = await this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM cache_events');
    return { events: Number(c?.n ?? 0), ranges: await this.coveredRanges(), fetchedFromSource: this.fetched };
  }
}

/** Wrap an EventSource in a persistent dev cache. See {@link CachedEventSource}. */
export function createCachedSource(inner: EventSource, opts?: CachedSourceOptions): Promise<CachedEventSource> {
  return CachedEventSource.create(inner, opts);
}
