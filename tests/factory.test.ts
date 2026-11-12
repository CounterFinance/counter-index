/**
 * Factory / dynamic sources: a factory event reveals a child contract; the
 * indexer starts watching it (via the source's addAddress), indexes its events,
 * and persists the discovery so a restart re-watches it.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { EventSource, DynamicSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

const FACTORY = '0xfactory';
const POOL = '0xpool0000000000000000000000000000000000';

function ev(block: number, contract: string, name: string, decoded: Record<string, unknown>): ChainEvent {
  return {
    chainId: 1, network: 'test', blockNumber: block, blockHash: `0xb${block}`,
    txHash: `0xtx${block}`, logIndex: 0, contractAddress: contract,
    eventName: name, eventRaw: new Uint8Array(0), decoded, dataLength: 0,
  };
}

/** A source that only yields events from contracts in its (growing) watch set. */
class FakeDynSource implements EventSource, DynamicSource {
  private readonly watched = new Set<string>();
  constructor(seed: string[], private readonly events: ChainEvent[]) {
    for (const a of seed) this.watched.add(a.toLowerCase());
  }
  addAddress(a: string): void { this.watched.add(a.toLowerCase()); }
  async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
    for (const e of this.events) {
      if (e.blockNumber >= from && e.blockNumber <= to && this.watched.has(e.contractAddress.toLowerCase())) yield e;
    }
  }
  subscribe(): UnsubscribeFn { return () => {}; }
}

const schema = defineSchema({ Pool: { amount: { type: 'bigint' } } }) as Schema<SchemaDefinition>;
const EVENTS = [
  ev(1, FACTORY, 'PoolCreated', { pair: POOL }),
  ev(2, POOL, 'Swap', { amount: '5' }),
];

let sink: SqliteAdapter;
beforeEach(() => { sink = new SqliteAdapter(new Database(':memory:')); });

describe('onFactory', () => {
  it('discovers a child, watches it, and indexes its events', async () => {
    const source = new FakeDynSource([FACTORY], EVENTS);
    const indexer = await createIndexer({ schema, sink, source });
    indexer.onFactory('PoolCreated', (e) => e.decoded!['pair'] as string);
    indexer.on('Swap', async (e, ctx) => { await ctx.store.set('Pool', 'p', { amount: BigInt(e.decoded!['amount'] as string) }); });

    // Pass 1: only the factory is watched → PoolCreated is seen, child discovered.
    await indexer.sync(1, 1);
    const persisted = await sink.all<{ address: string }>('SELECT address FROM opindex_sources');
    expect(persisted.map((r) => r.address)).toContain(POOL.toLowerCase());

    // Pass 2: the child is now watched → its Swap is indexed.
    await indexer.sync(2, 2);
    expect((await indexer.store.get('Pool', 'p'))!.amount).toBe(5n);
  });

  it('re-watches persisted children after a restart', async () => {
    // First run discovers the child.
    const first = await createIndexer({ schema, sink, source: new FakeDynSource([FACTORY], EVENTS) });
    first.onFactory('PoolCreated', (e) => e.decoded!['pair'] as string);
    await first.sync(1, 1);

    // "Restart": a brand-new indexer + fresh source seeded ONLY with the factory,
    // over the SAME sink. loadSourcesOnce must re-add the persisted child.
    const source = new FakeDynSource([FACTORY], EVENTS);
    const restarted = await createIndexer({ schema, sink, source });
    restarted.onFactory('PoolCreated', (e) => e.decoded!['pair'] as string);
    restarted.on('Swap', async (e, ctx) => { await ctx.store.set('Pool', 'p', { amount: BigInt(e.decoded!['amount'] as string) }); });

    await restarted.sync(2, 2);   // child was re-watched on load → Swap indexed
    expect((await restarted.store.get('Pool', 'p'))!.amount).toBe(5n);
  });
});
