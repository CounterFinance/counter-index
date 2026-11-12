/**
 * Indexer-level AUTOMATIC reorg recovery: a source whose live feed delivers an
 * orphaned tip block, then the canonical chain. The indexer must detect the
 * parentHash break, roll back, re-index the canonical blocks, and converge to the
 * same state as a fresh index. Deterministic, no network.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

const schema = defineSchema({ Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } } }) as Schema<SchemaDefinition>;

function ev(block: number, hash: string, parent: string, amount: bigint): ChainEvent {
  return {
    chainId: 1, network: 'test', blockNumber: block, blockHash: hash, parentHash: parent,
    txHash: `0xtx${block}-${hash}`, logIndex: 0, contractAddress: '0xc',
    eventName: 'Set', eventRaw: new Uint8Array(0), decoded: { holder: 'alice', amount: amount.toString() }, dataLength: 0,
  };
}

/** Canonical: 1→2→3. Live feed: 1, then an ORPHANED 2' (amount 999), then canonical 3. */
function reorgSource(): { source: EventSource; done: Promise<void> } {
  // Block 4 is a canonical trailing block: under M10 atomicity the tip block
  // buffers until the next block confirms it, so block 3 commits when 4 arrives.
  const canonical = [ev(1, 'H1', 'H0', 100n), ev(2, 'H2', 'H1', 150n), ev(3, 'H3', 'H2', 200n), ev(4, 'H4', 'H3', 200n)];
  const live = [ev(1, 'H1', 'H0', 100n), ev(2, 'H2o', 'H1', 999n), ev(3, 'H3', 'H2', 200n), ev(4, 'H4', 'H3', 200n)];
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  return {
    done,
    source: {
      async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
        for (const e of canonical) if (e.blockNumber >= from && e.blockNumber <= to) yield e;
      },
      subscribe(_from: number, onEvent: (e: ChainEvent) => Promise<void>): UnsubscribeFn {
        void (async () => { for (const e of live) await onEvent(e); resolve(); })();
        return () => {};
      },
    },
  };
}

describe('indexer automatic reorg recovery', () => {
  it('rolls back an orphaned tip and converges to the canonical state', async () => {
    const { source, done } = reorgSource();
    const indexer = await createIndexer({
      schema, sink: new SqliteAdapter(new Database(':memory:')), source, reorg: { finalityDepth: 5 },
    });
    indexer.on('Set', async (event, ctx) => {
      const d = event.decoded!;
      await ctx.store.set('Balance', d['holder'] as string, { holder: d['holder'] as string, amount: BigInt(d['amount'] as string) });
    });

    indexer.subscribe(1);
    await done;
    await new Promise((r) => setTimeout(r, 20));

    // After recovery, alice must reflect the CANONICAL chain (block 3 → 200), not
    // the orphaned 999.
    const row = await indexer.store.get('Balance', 'alice');
    expect(row!.amount).toBe(200n);
  });
});
