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

    const meta = await sink.all<{ id: string; last_block: number }>('SELECT id, last_block FROM opindex_meta ORDER BY id');
    const ids = meta.map((m) => m.id);
    expect(ids).toContain('chain:1');
    expect(ids).toContain('chain:2');
    expect(meta.find((m) => m.id === 'chain:1')!.last_block).toBe(5);
    expect(meta.find((m) => m.id === 'chain:2')!.last_block).toBe(9);
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
