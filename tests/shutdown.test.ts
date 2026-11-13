/**
 * Graceful shutdown + health transitions (M18): shutdown() stops the live
 * subscription, drains the in-flight block, closes the server + DB and runs
 * hooks; health() tracks state and per-chain lag through a sync.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from '../src/source.js';

const schema = defineSchema({ Thing: { v: { type: 'int' } } });

function evt(block: number, id: string): ChainEvent {
  return {
    chainId: 0, network: 'test', blockNumber: block, blockHash: `0x${block}`,
    txHash: id, logIndex: 0, contractAddress: '0xc', eventName: 'E',
    eventRaw: new Uint8Array(0), decoded: {}, dataLength: 0,
  };
}

/** A source that yields a fixed set of events for backfill. */
function staticSource(events: ChainEvent[]): EventSource {
  return {
    async *queryStream(from: number, to: number, _f?: EventSourceFilters) {
      for (const e of events) if (e.blockNumber >= from && e.blockNumber <= to) yield e;
    },
    subscribe(): UnsubscribeFn { return () => {}; },
  } as unknown as EventSource;
}

describe('health() through a sync', () => {
  it('goes starting → backfilling → live as it catches the tip', async () => {
    const source = staticSource([evt(1, 'a'), evt(2, 'b'), evt(3, 'c')]);
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source });
    indexer.on('E', async (e, ctx) => { await ctx.store.set('Thing', e.txHash, { v: e.blockNumber }); });

    expect(indexer.health().state).toBe('starting');
    await indexer.sync(1, 3, undefined, 3);   // knownTip = 3 → caught up
    const h = indexer.health();
    expect(h.state).toBe('live');
    expect(h.chains[0]).toMatchObject({ chainId: 0, lastBlock: 3, blocksBehind: 0 });
  });

  it('counts a reorg via rollbackTo', async () => {
    const indexer = await createIndexer({
      schema, sink: new SqliteAdapter(new Database(':memory:')), reorg: { finalityDepth: 10 },
    });
    expect(indexer.stats.reorgs).toBe(0);
    await indexer.rollbackTo(0, 0);
    expect(indexer.stats.reorgs).toBe(1);
    expect(indexer.health().reorgs).toBe(1);
  });
});

describe('graceful shutdown', () => {
  it('stops the subscription, closes server + DB, runs hooks, reports stopped', async () => {
    const db = new Database(':memory:');
    const unsub = vi.fn();
    const source = {
      async *queryStream() { /* empty */ },
      subscribe: vi.fn((): UnsubscribeFn => unsub),
    } as unknown as EventSource;

    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(db), source });
    const hook = vi.fn();
    indexer.onShutdown(hook);

    indexer.subscribe(1);                       // registers liveUnsub
    const handle = await indexer.serve({ port: 47915 });
    expect((await fetch(`${handle.url.replace('/graphql', '')}/health`)).status).toBeLessThan(600);

    await indexer.shutdown();

    expect(unsub).toHaveBeenCalledTimes(1);     // subscription stopped
    expect(hook).toHaveBeenCalledTimes(1);      // cleanup hook ran
    expect(indexer.health().state).toBe('stopped');
    expect(db.open).toBe(false);                // sink DB closed

    // Server is closed — a request should now fail to connect.
    await expect(fetch('http://localhost:47915/health')).rejects.toBeDefined();
  });

  it('is idempotent — a second shutdown is a no-op', async () => {
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
    const hook = vi.fn();
    indexer.onShutdown(hook);
    await indexer.shutdown();
    await indexer.shutdown();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(indexer.health().state).toBe('stopped');
  });
});
