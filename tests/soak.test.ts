/**
 * Soak correctness (M15): a long run must stay CORRECT, not just not-crash. We
 * index many events over a bounded account set and assert the accumulated
 * balances match an independent tally, the entity set is bounded, health is
 * live, and no errors were recorded. (Heap/leak behaviour is proven separately
 * by `npm run soak`, which needs --expose-gc for stable numbers.)
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const ACCOUNTS = 200;
const PER_BLOCK = 25;
const EVENTS = 40_000;
const acct = (i: number): string => `0x${(i % ACCOUNTS).toString(16).padStart(6, '0')}`;

const schema = defineSchema({ Balance: { amount: { type: 'bigint' } } });

function streamSource(tally: Map<string, bigint>): EventSource {
  return {
    async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
      let i = 0;
      for (let block = from; block <= to; block++) {
        for (let k = 0; k < PER_BLOCK; k++, i++) {
          const to2 = acct(i * 7);        // spread across accounts
          tally.set(to2, (tally.get(to2) ?? 0n) + 1n);
          yield {
            chainId: 1, network: 'soak', blockNumber: block, blockHash: `0x${block}`,
            txHash: `0x${block}_${k}`, logIndex: k, contractAddress: '0xc', eventName: 'T',
            eventRaw: new Uint8Array(0), decoded: { to: to2 }, dataLength: 0,
          } as ChainEvent;
        }
      }
    },
    subscribe(): UnsubscribeFn { return () => {}; },
  } as unknown as EventSource;
}

describe('soak correctness at scale', () => {
  it(`stays correct over ${EVENTS.toLocaleString()} events`, async () => {
    const tally = new Map<string, bigint>();
    const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source: streamSource(tally) });
    indexer.on('T', async (e, ctx) => {
      const to = e.decoded!['to'] as string;
      const cur = await ctx.store.get('Balance', to);
      await ctx.store.set('Balance', to, { amount: (cur ? (cur.amount as bigint) : 0n) + 1n });
    });

    const blocks = EVENTS / PER_BLOCK;
    await indexer.sync(1, blocks, undefined, blocks);

    // Every account's indexed balance equals the independent tally.
    for (const [holder, expected] of tally) {
      const row = await indexer.store.get('Balance', holder);
      expect(row!.amount).toBe(expected);
    }
    expect(await indexer.store.count('Balance')).toBe(tally.size);
    expect(tally.size).toBeLessThanOrEqual(ACCOUNTS);     // bounded entity set
    expect(indexer.stats.eventsProcessed).toBe(EVENTS);
    expect(indexer.stats.errors).toBe(0);
    expect(indexer.health().state).toBe('live');
  });
});
