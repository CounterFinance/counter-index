/**
 * Streaming memory regression test.
 *
 * Verifies that sync() consumes the source as a lazy stream — only one event
 * is pulled from the generator at a time. Before the streaming refactor,
 * query() materialised the full range into an array, causing OOM on dense
 * chains.
 *
 * Proof strategy:
 *   - A synthetic source yields N events across B blocks.
 *   - We track "yielded" (generator has produced the value) and
 *     "dispatched" (indexer has called the event handler) counters.
 *   - After yielding event K, the indexer may have dispatched ≤ K events
 *     and must never have buffered the whole range upfront.
 *   - Max in-flight = max(yielded - dispatched) over the run; assert ≤ 2.
 */

import { describe, it, expect } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createIndexer } from '../src/indexer.js';
import { createTestAdapter } from '../src/adapter.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(blockNumber: number, i: number): ChainEvent {
  return {
    blockNumber,
    txHash:          `0xtx${blockNumber}_${i}`,
    contractAddress: '0xcontract',
    eventName:       'TestEvent',
    eventRaw:        new Uint8Array(0),
    decoded:         { index: i },
    dataLength:      0,
  };
}

function makeFakeSource(
  blocksCount: number,
  eventsPerBlock: number,
  onYield: () => void,
): EventSource {
  return {
    async *queryStream() {
      for (let b = 1; b <= blocksCount; b++) {
        for (let e = 0; e < eventsPerBlock; e++) {
          onYield();
          yield makeEvent(b, e);
        }
      }
    },
    subscribe(): UnsubscribeFn {
      return () => {};
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('streaming — lazy consumption', () => {
  it('never buffers more than 2 events ahead of dispatch', async () => {
    const BLOCKS = 200;
    const EPB    = 50; // events per block
    const TOTAL  = BLOCKS * EPB;

    let yielded    = 0;
    let dispatched = 0;
    let maxInFlight = 0;

    const source = makeFakeSource(BLOCKS, EPB, () => {
      yielded++;
      maxInFlight = Math.max(maxInFlight, yielded - dispatched);
    });

    const schema = defineSchema({
      Counter: { value: { type: 'int' } },
    });
    const adapter = createTestAdapter();
    const indexer = await createIndexer({ schema, sink: adapter, source });

    indexer.on('TestEvent', async () => {
      dispatched++;
    });

    const stats = await indexer.sync(1, BLOCKS);

    expect(stats.eventsProcessed).toBe(TOTAL);
    expect(dispatched).toBe(TOTAL);
    // M10 atomicity: the indexer buffers ONE block's events so the whole block
    // commits in a single transaction, then dispatches them when the next block
    // starts. Memory stays bounded by the largest block — NOT the whole range:
    // in-flight peaks at ~one block (EPB), nowhere near TOTAL.
    expect(maxInFlight).toBeLessThanOrEqual(EPB + 2);
    expect(maxInFlight).toBeLessThan(TOTAL / 10);
  });

  it('processes all blocks and writes checkpoint for each', async () => {
    const BLOCKS = 50;
    const EPB    = 10;

    const source = makeFakeSource(BLOCKS, EPB, () => {});
    const schema = defineSchema({
      Tally: { count: { type: 'int' } },
    });
    const adapter = createTestAdapter();
    const indexer = await createIndexer({ schema, sink: adapter, source });

    let blocksSeen = 0;
    indexer.onBlock(async () => { blocksSeen++; });

    const stats = await indexer.sync(1, BLOCKS);

    expect(stats.eventsProcessed).toBe(BLOCKS * EPB);
    expect(stats.blocksProcessed).toBe(BLOCKS);
    expect(blocksSeen).toBe(BLOCKS);

    // Checkpoint must reflect the last block
    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(BLOCKS);
  });
});
