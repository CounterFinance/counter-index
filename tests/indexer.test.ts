/**
 * Integration test: full pipeline from schema → handlers → events → query.
 */

import { describe, it, expect } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createIndexer } from '../src/indexer.js';
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

// --- Tests -----------------------------------------------------------------

describe('createIndexer', () => {
  it('processes events through handlers and updates store', () => {
    const indexer = createIndexer({ schema });

    indexer.on('Transferred', (event, ctx) => {
      const from = event.decoded!.from as string;
      const to = event.decoded!.to as string;
      const value = BigInt(event.decoded!.value as string);

      ctx.store.set('Transfer', event.txHash, {
        txHash: event.txHash,
        from, to, value,
        block: event.blockNumber,
      });

      // Ensure sender account exists then update
      if (!ctx.store.get('Account', from)) {
        ctx.store.set('Account', from, { address: from, balance: 0n, txCount: 0, lastSeen: 0 });
      }
      const sender = ctx.store.get('Account', from)!;
      ctx.store.update('Account', from, {
        balance: (sender.balance as bigint) - value,
        txCount: (sender.txCount as number) + 1,
        lastSeen: event.blockNumber,
      });
    });

    indexer.processEvent(
      makeEvent('Transferred', { from: '0xalice', to: '0xbob', value: '5000' }),
    );

    const transfer = indexer.store.get('Transfer', '0xdeadbeef');
    expect(transfer).toBeDefined();
    expect(transfer!.from).toBe('0xalice');
    expect(transfer!.value).toBe(5000n);

    const alice = indexer.store.get('Account', '0xalice');
    expect(alice).toBeDefined();
    expect(alice!.balance).toBe(-5000n);
    expect(alice!.txCount).toBe(1);
    expect(alice!.lastSeen).toBe(100);
  });

  it('tracks stats', () => {
    const indexer = createIndexer({ schema });
    indexer.on('Transferred', () => {});

    indexer.processEvent(makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }));
    indexer.processEvent(makeEvent('Unknown', null as unknown as Record<string, unknown>));

    expect(indexer.stats.eventsProcessed).toBe(2);
    expect(indexer.stats.eventsDecoded).toBe(1);
    expect(indexer.stats.eventsSkipped).toBe(1);
  });

  it('processEvents handles batch in order', () => {
    const indexer = createIndexer({ schema });
    const order: number[] = [];

    indexer.on('*', (event) => {
      order.push(event.blockNumber);
    });

    indexer.processEvents([
      makeEvent('A', {}, { blockNumber: 1 }),
      makeEvent('B', {}, { blockNumber: 2 }),
      makeEvent('C', {}, { blockNumber: 3 }),
    ]);

    expect(order).toEqual([1, 2, 3]);
    expect(indexer.stats.lastBlock).toBe(3);
  });

  it('wildcard handlers receive all events', () => {
    const indexer = createIndexer({ schema });
    let count = 0;
    indexer.on('*', () => { count++; });

    indexer.processEvent(makeEvent('Transferred', {}));
    indexer.processEvent(makeEvent('Approved', {}));
    indexer.processEvent(makeEvent('Minted', {}));

    expect(count).toBe(3);
  });

  it('reset clears store and stats', () => {
    const indexer = createIndexer({ schema });
    indexer.on('Transferred', (event, ctx) => {
      ctx.store.set('Account', 'a1', { address: '0xa' });
    });
    indexer.processEvent(makeEvent('Transferred', {}));
    expect(indexer.store.count('Account')).toBe(1);
    expect(indexer.stats.eventsProcessed).toBe(1);

    indexer.reset();
    expect(indexer.store.count('Account')).toBe(0);
    expect(indexer.stats.eventsProcessed).toBe(0);
  });

  it('processRawEvent decodes and dispatches', () => {
    const indexer = createIndexer({ schema });
    let received: DecodedEvent | null = null;

    indexer.on('Transferred', (event) => { received = event; });

    // Build raw Transferred event: from (32 bytes) + to (32 bytes) + value (32 bytes U256)
    const raw = new Uint8Array(96);
    raw[31] = 0x01; // from = 0x000...01
    raw[63] = 0x02; // to = 0x000...02
    raw[95] = 100;  // value = 100

    indexer.processRawEvent('Transferred', raw, {
      blockNumber: 50,
      txHash: '0xtx',
      contractAddress: '0xtoken',
    });

    expect(received).not.toBeNull();
    expect(received!.decoded).not.toBeNull();
    expect(received!.decoded!.value).toBe('100');
    expect(received!.blockNumber).toBe(50);
  });

  it('multiple handlers for same event all fire', () => {
    const indexer = createIndexer({ schema });
    let a = 0, b = 0;
    indexer.on('Transferred', () => { a++; });
    indexer.on('Transferred', () => { b++; });

    indexer.processEvent(makeEvent('Transferred', { from: '0xa', to: '0xb', value: '1' }));

    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  it('full pipeline: multiple events → query entities', () => {
    const indexer = createIndexer({ schema });

    indexer.on('Transferred', (event, ctx) => {
      const from = event.decoded!.from as string;
      const to = event.decoded!.to as string;
      const value = BigInt(event.decoded!.value as string);

      ctx.store.set('Transfer', event.txHash, {
        txHash: event.txHash, from, to, value,
        block: event.blockNumber,
      });

      // Upsert accounts
      for (const addr of [from, to]) {
        if (!ctx.store.get('Account', addr)) {
          ctx.store.set('Account', addr, { address: addr, balance: 0n, txCount: 0, lastSeen: 0 });
        }
      }

      const sender = ctx.store.get('Account', from)!;
      ctx.store.update('Account', from, {
        balance: (sender.balance as bigint) - value,
        txCount: (sender.txCount as number) + 1,
        lastSeen: event.blockNumber,
      });

      const receiver = ctx.store.get('Account', to)!;
      ctx.store.update('Account', to, {
        balance: (receiver.balance as bigint) + value,
        txCount: (receiver.txCount as number) + 1,
        lastSeen: event.blockNumber,
      });
    });

    // Three transfers
    indexer.processEvents([
      makeEvent('Transferred', { from: '0xalice', to: '0xbob', value: '1000' },
        { blockNumber: 10, txHash: '0xtx1' }),
      makeEvent('Transferred', { from: '0xbob', to: '0xcharlie', value: '300' },
        { blockNumber: 11, txHash: '0xtx2' }),
      makeEvent('Transferred', { from: '0xalice', to: '0xcharlie', value: '200' },
        { blockNumber: 12, txHash: '0xtx3' }),
    ]);

    // Verify accounts
    expect(indexer.store.count('Account')).toBe(3);
    expect(indexer.store.count('Transfer')).toBe(3);

    const alice = indexer.store.get('Account', '0xalice')!;
    expect(alice.balance).toBe(-1200n);
    expect(alice.txCount).toBe(2);

    const bob = indexer.store.get('Account', '0xbob')!;
    expect(bob.balance).toBe(700n); // +1000 -300
    expect(bob.txCount).toBe(2);

    const charlie = indexer.store.get('Account', '0xcharlie')!;
    expect(charlie.balance).toBe(500n); // +300 +200

    expect(indexer.stats.eventsProcessed).toBe(3);
    expect(indexer.stats.lastBlock).toBe(12);
  });
});
