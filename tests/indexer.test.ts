/**
 * Integration test: full pipeline schema → handlers → events → query (DB-backed).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createIndexer } from '../src/indexer.js';
import { createTestAdapter } from '../src/adapter.js';
import type { MinimalDbAdapter } from '../src/adapter.js';
import type { DecodedEvent } from '../src/types.js';

// --- Schema ----------------------------------------------------------------

const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
  Transfer: {
    txHash: { type: 'string' },
    from:   { type: 'string' },
    to:     { type: 'string' },
    value:  { type: 'bigint' },
    block:  { type: 'int' },
  },
});

// --- Helpers ---------------------------------------------------------------

function makeEvent(
  eventName: string,
  decoded: Record<string, unknown>,
  overrides: Partial<DecodedEvent> = {},
): DecodedEvent {
  return {
    blockNumber: 100,
    txHash: '0xdeadbeef',
    contractAddress: '0xcontract1',
    eventName,
    eventRaw: new Uint8Array(0),
    decoded,
    dataLength: 0,
    ...overrides,
  };
}

let adapter: MinimalDbAdapter;

beforeEach(() => {
  adapter = createTestAdapter();
});

// --- Tests -----------------------------------------------------------------

describe('createIndexer', () => {
  it('creates successfully with a sink adapter', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    expect(indexer).toBeDefined();
    expect(indexer.store).toBeDefined();
  });

  it('processes events through handlers and updates store', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });

    indexer.on('Transferred', async (event, ctx) => {
      const from = event.decoded!['from'] as string;
      const to = event.decoded!['to'] as string;
      const value = BigInt(event.decoded!['value'] as string);

      await ctx.store.set('Transfer', event.txHash, {
        txHash: event.txHash, from, to, value, block: event.blockNumber,
      });

      if (!await ctx.store.get('Account', from)) {
        await ctx.store.set('Account', from, { address: from, balance: 0n, txCount: 0, lastSeen: 0 });
      }
      const sender = await ctx.store.get('Account', from);
      await ctx.store.update('Account', from, {
        balance: (sender!['balance'] as bigint) - value,
        txCount: (sender!['txCount'] as number) + 1,
        lastSeen: event.blockNumber,
      });
    });

    await indexer.processEvent(
      makeEvent('Transferred', { from: '0xalice', to: '0xbob', value: '5000' }),
    );

    const transfer = await indexer.store.get('Transfer', '0xdeadbeef');
    expect(transfer).toBeDefined();
    expect(transfer!['from']).toBe('0xalice');
    expect(transfer!['value']).toBe(5000n);

    const alice = await indexer.store.get('Account', '0xalice');
    expect(alice!['balance']).toBe(-5000n);
    expect(alice!['txCount']).toBe(1);
    expect(alice!['lastSeen']).toBe(100);
  });

  it('tracks stats', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    indexer.on('Transferred', async () => {});

    await indexer.processEvent(makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }));
    await indexer.processEvent(makeEvent('Unknown', null as unknown as Record<string, unknown>));

    expect(indexer.stats.eventsProcessed).toBe(2);
    expect(indexer.stats.eventsDecoded).toBe(1);
    expect(indexer.stats.eventsSkipped).toBe(1);
  });

  it('processEvents handles batch in order', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    const order: number[] = [];

    indexer.on('*', async (event) => {
      order.push(event.blockNumber);
    });

    await indexer.processEvents([
      makeEvent('A', {}, { blockNumber: 1 }),
      makeEvent('B', {}, { blockNumber: 2 }),
      makeEvent('C', {}, { blockNumber: 3 }),
    ]);

    expect(order).toEqual([1, 2, 3]);
    expect(indexer.stats.lastBlock).toBe(3);
  });

  it('wildcard handlers receive all events', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let count = 0;
    indexer.on('*', async () => { count++; });

    await indexer.processEvent(makeEvent('Transferred', {}));
    await indexer.processEvent(makeEvent('Approved', {}));
    await indexer.processEvent(makeEvent('Minted', {}));

    expect(count).toBe(3);
  });

  it('resetStats clears counters but preserves DB state', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    indexer.on('Transferred', async (event, ctx) => {
      await ctx.store.set('Account', 'a1', { address: '0xa', balance: 0n, txCount: 0, lastSeen: 0 });
    });
    await indexer.processEvent(makeEvent('Transferred', {}));
    expect(await indexer.store.count('Account')).toBe(1);
    expect(indexer.stats.eventsProcessed).toBe(1);

    indexer.resetStats();
    expect(indexer.stats.eventsProcessed).toBe(0);
    // DB state is preserved after resetStats
    expect(await indexer.store.count('Account')).toBe(1);
  });

  it('processRawEvent decodes and dispatches', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let received: DecodedEvent | null = null;

    indexer.on('Transferred', async (event) => { received = event; });

    // Build raw Transferred event: from (32 bytes) + to (32 bytes) + value (32 bytes U256)
    const raw = new Uint8Array(96);
    raw[31] = 0x01;
    raw[63] = 0x02;
    raw[95] = 100;

    await indexer.processRawEvent('Transferred', raw, {
      blockNumber: 50,
      txHash: '0xtx',
      contractAddress: '0xtoken',
    });

    expect(received).not.toBeNull();
    expect(received!.decoded!['value']).toBe('100');
    expect(received!.blockNumber).toBe(50);
  });

  it('blockTimestamp passes through to HandlerContext', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let receivedTs: number | undefined;

    indexer.on('Transferred', async (_event, ctx) => {
      receivedTs = ctx.blockTimestamp;
    });

    await indexer.processEvent(
      makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }, {
        blockTimestamp: 1712345678,
      }),
    );

    expect(receivedTs).toBe(1712345678);
  });

  it('tx-level fields are accessible in handler', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let seen: Partial<DecodedEvent> = {};

    indexer.on('Transferred', async (event) => {
      seen = { fromAddress: event.fromAddress, logIndex: event.logIndex, gasUsed: event.gasUsed };
    });

    await indexer.processEvent(
      makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }, {
        fromAddress: '0xsender',
        logIndex: 3,
        gasUsed: 21000n,
      }),
    );

    expect(seen.fromAddress).toBe('0xsender');
    expect(seen.logIndex).toBe(3);
    expect(seen.gasUsed).toBe(21000n);
  });

  it('multiple handlers for same event all fire', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let a = 0, b = 0;
    indexer.on('Transferred', async () => { a++; });
    indexer.on('Transferred', async () => { b++; });

    await indexer.processEvent(makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }));

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('full pipeline: multiple events → query entities', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });

    indexer.on('Transferred', async (event, ctx) => {
      const from = event.decoded!['from'] as string;
      const to = event.decoded!['to'] as string;
      const value = BigInt(event.decoded!['value'] as string);

      await ctx.store.set('Transfer', event.txHash, {
        txHash: event.txHash, from, to, value, block: event.blockNumber,
      });

      for (const addr of [from, to]) {
        if (!await ctx.store.get('Account', addr)) {
          await ctx.store.set('Account', addr, { address: addr, balance: 0n, txCount: 0, lastSeen: 0 });
        }
      }

      const sender = await ctx.store.get('Account', from);
      await ctx.store.update('Account', from, {
        balance: (sender!['balance'] as bigint) - value,
        txCount: (sender!['txCount'] as number) + 1,
        lastSeen: event.blockNumber,
      });

      const receiver = await ctx.store.get('Account', to);
      await ctx.store.update('Account', to, {
        balance: (receiver!['balance'] as bigint) + value,
        txCount: (receiver!['txCount'] as number) + 1,
        lastSeen: event.blockNumber,
      });
    });

    await indexer.processEvents([
      makeEvent('Transferred', { from: '0xalice', to: '0xbob', value: '1000' },
        { blockNumber: 10, txHash: '0xtx1' }),
      makeEvent('Transferred', { from: '0xbob', to: '0xcharlie', value: '300' },
        { blockNumber: 11, txHash: '0xtx2' }),
      makeEvent('Transferred', { from: '0xalice', to: '0xcharlie', value: '200' },
        { blockNumber: 12, txHash: '0xtx3' }),
    ]);

    expect(await indexer.store.count('Account')).toBe(3);
    expect(await indexer.store.count('Transfer')).toBe(3);

    const alice = await indexer.store.get('Account', '0xalice');
    expect(alice!['balance']).toBe(-1200n);
    expect(alice!['txCount']).toBe(2);

    const bob = await indexer.store.get('Account', '0xbob');
    expect(bob!['balance']).toBe(700n);

    const charlie = await indexer.store.get('Account', '0xcharlie');
    expect(charlie!['balance']).toBe(500n);

    expect(indexer.stats.eventsProcessed).toBe(3);
    expect(indexer.stats.lastBlock).toBe(12);
  });

  it('sync() requires source to be configured', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    await expect(indexer.sync(1, 100)).rejects.toThrow('No EventSource');
  });
});

// ---------------------------------------------------------------------------
// Block handlers
// ---------------------------------------------------------------------------

describe('onBlock', () => {
  it('fires once per block after all events in that block are dispatched', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    const log: string[] = [];

    indexer.on('Transferred', async (event) => {
      log.push(`event:${event.blockNumber}:${event.txHash}`);
    });
    indexer.onBlock(async ({ blockNumber }) => {
      log.push(`block:${blockNumber}`);
    });

    await indexer.processEvents([
      makeEvent('Transferred', {}, { blockNumber: 10, txHash: 'tx1' }),
      makeEvent('Transferred', {}, { blockNumber: 10, txHash: 'tx2' }),
      makeEvent('Transferred', {}, { blockNumber: 11, txHash: 'tx3' }),
    ]);

    // Events fire before their block handler
    expect(log).toEqual([
      'event:10:tx1',
      'event:10:tx2',
      'block:10',       // fires after both block-10 events
      'event:11:tx3',
      'block:11',       // fires after block-11 event
    ]);
  });

  it('fires exactly once per distinct block', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    const blocksSeen: number[] = [];

    indexer.onBlock(async ({ blockNumber }) => { blocksSeen.push(blockNumber); });

    await indexer.processEvents([
      makeEvent('X', {}, { blockNumber: 5, txHash: 'a' }),
      makeEvent('X', {}, { blockNumber: 5, txHash: 'b' }),
      makeEvent('X', {}, { blockNumber: 5, txHash: 'c' }),
      makeEvent('X', {}, { blockNumber: 6, txHash: 'd' }),
      makeEvent('X', {}, { blockNumber: 7, txHash: 'e' }),
    ]);

    expect(blocksSeen).toEqual([5, 6, 7]);
  });

  it('receives blockTimestamp in context', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let seenTs: number | undefined;

    indexer.onBlock(async ({ blockTimestamp }) => { seenTs = blockTimestamp; });

    await indexer.processEvents([
      makeEvent('X', {}, { blockNumber: 10, blockTimestamp: 1712345678 }),
    ]);

    expect(seenTs).toBe(1712345678);
  });

  it('can write to the store', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });

    indexer.onBlock(async ({ blockNumber, store }) => {
      await store.set('Transfer', `candle:${blockNumber}`, {
        txHash: `candle:${blockNumber}`,
        from: 'system', to: 'system', value: 0n, block: blockNumber,
      });
    });

    await indexer.processEvents([
      makeEvent('X', {}, { blockNumber: 42, txHash: 'tx1' }),
    ]);

    const candle = await indexer.store.get('Transfer', 'candle:42');
    expect(candle).toBeDefined();
    expect(candle!['block']).toBe(42);
  });

  it('multiple block handlers all fire', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let a = 0, b = 0;

    indexer.onBlock(async () => { a++; });
    indexer.onBlock(async () => { b++; });

    await indexer.processEvents([
      makeEvent('X', {}, { blockNumber: 1, txHash: 'tx1' }),
      makeEvent('X', {}, { blockNumber: 2, txHash: 'tx2' }),
    ]);

    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('increments blocksProcessed in stats', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    indexer.onBlock(async () => {});

    await indexer.processEvents([
      makeEvent('X', {}, { blockNumber: 10, txHash: 'a' }),
      makeEvent('X', {}, { blockNumber: 10, txHash: 'b' }),
      makeEvent('X', {}, { blockNumber: 11, txHash: 'c' }),
    ]);

    expect(indexer.stats.blocksProcessed).toBe(2);
  });

  it('does not fire when no events are processed', async () => {
    const indexer = await createIndexer({ schema, sink: adapter });
    let fired = false;
    indexer.onBlock(async () => { fired = true; });
    await indexer.processEvents([]);
    expect(fired).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Range-end checkpoint (sync advances _meta even when last N blocks are empty)
// ---------------------------------------------------------------------------

describe('sync() range-end checkpoint', () => {
  function makeSource(events: DecodedEvent[]) {
    return {
      async *queryStream() { yield* events; },
      subscribe() { return () => {}; },
    };
  }

  it('checkpoints toBlock when range has no events at all', async () => {
    const indexer = await createIndexer({
      schema, sink: adapter,
      source: makeSource([]),
    });
    await indexer.sync(1, 50);
    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(50);
  });

  it('checkpoints toBlock when last blocks in range have no events', async () => {
    const indexer = await createIndexer({
      schema, sink: adapter,
      source: makeSource([
        makeEvent('X', {}, { blockNumber: 10, txHash: 'a' }),
        makeEvent('X', {}, { blockNumber: 20, txHash: 'b' }),
        // blocks 21-50 have no events
      ]),
    });
    await indexer.sync(1, 50);
    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(50);
  });

  it('does not fire onBlock for the synthetic range-end write', async () => {
    const indexer = await createIndexer({
      schema, sink: adapter,
      source: makeSource([
        makeEvent('X', {}, { blockNumber: 5, txHash: 'a' }),
        // blocks 6-20 have no events
      ]),
    });
    const blocksSeen: number[] = [];
    indexer.onBlock(async ({ blockNumber }) => { blocksSeen.push(blockNumber); });
    await indexer.sync(1, 20);
    // onBlock should only fire for block 5 (has events), NOT for block 20 (range-end)
    expect(blocksSeen).toEqual([5]);
    const cp = await indexer.store.readCheckpoint();
    expect(cp?.lastBlock).toBe(20);
  });
});
