/**
 * opindex_meta atomicity tests.
 *
 * The checkpoint (opindex_meta.last_block) MUST only advance when all writes
 * for that block have committed. Specifically:
 *
 *   1. Successful blocks advance the checkpoint.
 *   2. A failed onBlock handler rolls back both the onBlock writes AND the
 *      checkpoint — the checkpoint does not advance for that block.
 *   3. After a failed block, readCheckpoint() returns the last *successful*
 *      block number, so a restart replays from there.
 *
 * Note: event handler writes (via indexer.on()) happen before the per-block
 * transaction and are committed individually (idempotent UPSERTs). Only onBlock
 * handler writes and the checkpoint write are wrapped in a single transaction.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createIndexer } from '../src/indexer.js';
import { createTestAdapter } from '../src/adapter.js';
import type { DecodedEvent } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(blockNumber: number, txSuffix = ''): DecodedEvent {
  return {
    blockNumber,
    txHash:          `0xtx${blockNumber}${txSuffix}`,
    contractAddress: '0xcontract',
    eventName:       'Ping',
    eventRaw:        new Uint8Array(0),
    decoded:         {},
    dataLength:      0,
  };
}

const schema = defineSchema({
  Tally: {
    block:  { type: 'int' },
    pings:  { type: 'int' },
  },
  BlockRecord: {
    blockNum: { type: 'int' },
  },
});

// ---------------------------------------------------------------------------

describe('meta atomicity', () => {
  it('checkpoint advances after each successfully processed block', async () => {
    const adapter = createTestAdapter();
    const indexer = await createIndexer({ schema, sink: adapter });

    await indexer.processEvents([
      makeEvent(10),
      makeEvent(10, 'b'),
      makeEvent(11),
    ]);

    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(11);
  });

  it('checkpoint is undefined before any blocks are processed', async () => {
    const adapter = createTestAdapter();
    const indexer = await createIndexer({ schema, sink: adapter });

    const cp = await indexer.store.readCheckpoint();
    expect(cp).toBeUndefined();
  });

  it('failed onBlock handler rolls back checkpoint — does not advance last_block', async () => {
    const adapter = createTestAdapter();
    const indexer = await createIndexer({ schema, sink: adapter });

    // Process block 10 successfully
    await indexer.processEvents([makeEvent(10)]);
    const cpAfter10 = await indexer.store.readCheckpoint();
    expect(cpAfter10?.lastBlock).toBe(10);

    // Block 11 has an event handler that writes, then an onBlock handler that throws.
    // The checkpoint must NOT advance to 11.
    indexer.onBlock(async ({ blockNumber }) => {
      if (blockNumber === 11) {
        throw new Error('simulated onBlock failure on block 11');
      }
    });

    await expect(
      indexer.processEvents([makeEvent(11)]),
    ).rejects.toThrow('simulated onBlock failure on block 11');

    // Checkpoint must still be 10 — block 11's onBlock tx rolled back
    const cpAfterFailure = await indexer.store.readCheckpoint();
    expect(cpAfterFailure?.lastBlock).toBe(10);
  });

  it('checkpoint resumes from last successful block on restart', async () => {
    const adapter = createTestAdapter();

    // First indexer: processes blocks 1–3
    {
      const indexer = await createIndexer({ schema, sink: adapter });
      indexer.on('Ping', async ({ blockNumber }, ctx) => {
        await ctx.store.set('Tally', String(blockNumber), { block: blockNumber, pings: 1 });
      });
      await indexer.processEvents([makeEvent(1), makeEvent(2), makeEvent(3)]);
    }

    // Second indexer (simulates restart): checkpoint should be 3
    {
      const indexer2 = await createIndexer({ schema, sink: adapter });
      const cp = await indexer2.store.readCheckpoint();
      expect(cp?.lastBlock).toBe(3);

      // Data from first run must still be visible
      const t1 = await indexer2.store.get('Tally', '1');
      const t3 = await indexer2.store.get('Tally', '3');
      expect(t1?.block).toBe(1);
      expect(t3?.block).toBe(3);
    }
  });

  it('tipBlock is stored in checkpoint when provided', async () => {
    const adapter = createTestAdapter();
    // writeBlockCheckpoint is called by processEvents internally;
    // tip is passed by sync() — test directly via store
    const indexer = await createIndexer({ schema, sink: adapter });

    await indexer.store.writeBlockCheckpoint(42, 1000);

    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(42);
    expect(cp?.tipBlock).toBe(1000);
  });
});
