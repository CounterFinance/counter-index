/**
 * Multichain: two chains indexed into one shared store, isolated by chainId,
 * with per-chain checkpoints. Uses tiny in-memory fake sources.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import { createMultiIndexer } from '../src/multiIndexer.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

function transfer(chainId: number, block: number, logIndex: number, from: string, to: string, value: bigint): ChainEvent {
  return {
    chainId, network: `chain-${chainId}`, blockNumber: block, blockHash: `0xb${block}`,
    txHash: `0xtx-${chainId}-${block}-${logIndex}`, logIndex, contractAddress: '0xtoken',
    eventName: 'Transfer', eventRaw: new Uint8Array(0),
    decoded: { from, to, value: value.toString() }, dataLength: 0,
  };
}

function fakeSource(events: ChainEvent[]): EventSource {
  return {
    async *queryStream(fromBlock: number, toBlock: number): AsyncIterable<ChainEvent> {
      for (const e of events) if (e.blockNumber >= fromBlock && e.blockNumber <= toBlock) yield e;
    },
    subscribe(): UnsubscribeFn { return () => {}; },
  };
}

const schema = defineSchema({
  TokenHolder: { holder: { type: 'string' }, balance: { type: 'bigint' } },
}, { multichain: true });

let sink: SqliteAdapter;

beforeEach(() => { sink = new SqliteAdapter(new Database(':memory:')); });

describe('createMultiIndexer', () => {
  it('indexes two chains into one store, isolated by chainId', async () => {
    const mi = await createMultiIndexer({
      schema, sink,
      sources: [
        { source: fakeSource([transfer(1, 1, 0, 'A', 'B', 100n)]), chainId: 1, fromBlock: 1, toBlock: 1 },
        { source: fakeSource([transfer(2, 1, 0, 'A', 'B', 100n)]), chainId: 2, fromBlock: 1, toBlock: 1 },
      ],
    });

    mi.on('Transfer', async (event, ctx) => {
      const d = event.decoded!;
      const from = d['from'] as string, to = d['to'] as string, value = BigInt(d['value'] as string);
      for (const [h, delta] of [[to, value], [from, -value]] as const) {
        const cur = await ctx.store.get('TokenHolder', h);
        await ctx.store.set('TokenHolder', h, { holder: h, balance: (cur ? BigInt(cur.balance as bigint) : 0n) + delta });
      }
    });

    await mi.syncAll();

    const rows = await mi.store.list('TokenHolder');
    expect(rows).toHaveLength(4);   // A,B on chain 1 + A,B on chain 2 — distinct rows
    // Composite (chainId, id) PK: ids are clean, NOT "1:A" prefixed.
    expect(rows.map((r) => r['id']).sort()).toEqual(['A', 'A', 'B', 'B']);

    const bal = (chainId: number, holder: string): bigint => {
      const r = rows.find((x) => x['chainId'] === chainId && x['holder'] === holder);
      return r ? BigInt(r['balance'] as bigint) : 0n;
    };
    expect(bal(1, 'B')).toBe(100n);
    expect(bal(2, 'B')).toBe(100n);     // same holder, different chain — isolated
    expect(bal(1, 'A')).toBe(-100n);
    expect(bal(2, 'A')).toBe(-100n);
  });

  it('writes a separate checkpoint row per chain', async () => {
    const mi = await createMultiIndexer({
      schema, sink,
      sources: [
        { source: fakeSource([transfer(1, 5, 0, 'A', 'B', 1n)]), chainId: 1, fromBlock: 1, toBlock: 5 },
        { source: fakeSource([transfer(2, 9, 0, 'A', 'B', 1n)]), chainId: 2, fromBlock: 1, toBlock: 9 },
      ],
    });
    mi.on('Transfer', async (event, ctx) => {
      const d = event.decoded!;
      await ctx.store.set('TokenHolder', d['to'] as string, { holder: d['to'] as string, balance: 1n });
    });
    await mi.syncAll();

    const meta = await sink.all<{ id: string; last_block: number }>('SELECT id, last_block FROM counterindex_meta ORDER BY id');
    const ids = meta.map((m) => m.id);
    expect(ids).toContain('chain:1');
    expect(ids).toContain('chain:2');
    expect(meta.find((m) => m.id === 'chain:1')!.last_block).toBe(5);
    expect(meta.find((m) => m.id === 'chain:2')!.last_block).toBe(9);
  });

  it('backfills chains in PARALLEL when each has its own connection', async () => {
    // A source whose first yield is delayed, so a sequential syncAll takes ~2×D
    // and a parallel one ~1×D. Each chain gets its OWN sink (separate connection).
    const DELAY = 60;
    const delayedSource = (chainId: number): EventSource => ({
      async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
        await new Promise((r) => setTimeout(r, DELAY));
        if (from <= 1 && to >= 1) yield transfer(chainId, 1, 0, 'A', 'B', 1n);
      },
      subscribe(): UnsubscribeFn { return () => {}; },
    });

    const makeMi = (useOwnSinks: boolean) => createMultiIndexer({
      schema, sink,
      sources: [
        { source: delayedSource(1), chainId: 1, fromBlock: 1, toBlock: 1, sink: useOwnSinks ? new SqliteAdapter(new Database(':memory:')) : undefined },
        { source: delayedSource(2), chainId: 2, fromBlock: 1, toBlock: 1, sink: useOwnSinks ? new SqliteAdapter(new Database(':memory:')) : undefined },
      ],
    });

    const run = async (useOwnSinks: boolean): Promise<number> => {
      const mi = await makeMi(useOwnSinks);
      mi.on('Transfer', async (e, ctx) => { await ctx.store.set('TokenHolder', e.decoded!['to'] as string, { holder: 'B', balance: 1n }); });
      const t0 = Date.now();
      await mi.syncAll();
      return Date.now() - t0;
    };

    const seqMs = await run(false);   // shared connection → sequential
    const parMs = await run(true);    // per-chain connections → parallel
    expect(seqMs).toBeGreaterThanOrEqual(2 * DELAY - 15);
    expect(parMs).toBeLessThan(seqMs - DELAY / 2);   // meaningfully overlapped
  });

  it('rejects a non-multichain schema', async () => {
    const single = defineSchema({ X: { v: { type: 'int' } } });
    await expect(createMultiIndexer({ schema: single, sink, sources: [] }))
      .rejects.toThrow(/multichain/);
  });

  it('exposes chainId as a GraphQL filter', async () => {
    const mi = await createMultiIndexer({
      schema, sink,
      sources: [
        { source: fakeSource([transfer(1, 1, 0, 'A', 'B', 100n)]), chainId: 1, fromBlock: 1, toBlock: 1 },
        { source: fakeSource([transfer(2, 1, 0, 'A', 'B', 100n)]), chainId: 2, fromBlock: 1, toBlock: 1 },
      ],
    });
    mi.on('Transfer', async (event, ctx) => {
      const d = event.decoded!;
      const from = d['from'] as string, to = d['to'] as string, value = BigInt(d['value'] as string);
      for (const [h, delta] of [[to, value], [from, -value]] as const) {
        const cur = await ctx.store.get('TokenHolder', h);
        await ctx.store.set('TokenHolder', h, { holder: h, balance: (cur ? BigInt(cur.balance as bigint) : 0n) + delta });
      }
    });
    await mi.syncAll();

    const handle = await mi.serve({ port: 47833 });
    try {
      const res = await fetch(handle.url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ tokenHolders(where: { chainId: 1 }) { totalCount nodes { chainId holder balance } } }' }),
      });
      const json = await res.json() as { data: { tokenHolders: { totalCount: number; nodes: Array<{ chainId: number; holder: string; balance: string }> } } };
      const conn = json.data.tokenHolders;
      expect(conn.totalCount).toBe(2);                    // only chain 1's A and B
      expect(conn.nodes.every((n) => n.chainId === 1)).toBe(true);
    } finally {
      await handle.stop();
    }
  });
});
