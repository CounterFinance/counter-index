/**
 * Observability: entity delta counters in IndexerStats, exposed via /health
 * (JSON) and /metrics (Prometheus) on serve().
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';

const schema = defineSchema({ Thing: { v: { type: 'int' } } });

function evt(id: string): ChainEvent {
  return {
    chainId: 0, network: 'test', blockNumber: 1, blockHash: '0xb1',
    txHash: id, logIndex: 0, contractAddress: '0xc', eventName: 'E',
    eventRaw: new Uint8Array(0), decoded: {}, dataLength: 0,
  };
}

describe('observability', () => {
  it('counts entity writes and serves /health + /metrics', async () => {
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
    indexer.on('E', async (e, ctx) => { await ctx.store.set('Thing', e.txHash, { v: 1 }); });

    await indexer.processEvents([evt('0xa'), evt('0xb'), evt('0xc')]);   // 3 upserts

    expect(indexer.stats.entitiesWritten).toBe(3);
    expect(indexer.stats.writesByTable['Thing']).toBe(3);

    const handle = await indexer.serve({ port: 47900 });
    try {
      const health = await (await fetch('http://localhost:47900/health')).json() as Record<string, unknown>;
      expect(health['status']).toBe('ok');
      expect(health['entitiesWritten']).toBe(3);
      expect(health['eventsProcessed']).toBe(3);

      const metrics = await (await fetch('http://localhost:47900/metrics')).text();
      expect(metrics).toContain('opindex_entitiesWritten 3');
      expect(metrics).toContain('opindex_blocksProcessed 1');
      expect(metrics).toContain('opindex_writesByTable{key="Thing"} 3');
    } finally {
      await handle.stop();
    }
  });
});
