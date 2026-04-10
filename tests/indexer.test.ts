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
