/**
 * DX features (M21): named-handler perf attribution (per-event latency +
 * slow-handler WARN), the onError observer, and beforeBlock middleware ordering.
 */

import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import { noopLogger, type IndexerLogger } from '../src/logger.js';
import type { ChainEvent } from '../src/types.js';

const schema = defineSchema({ Thing: { v: { type: 'int' } } });

function evt(name: string, block: number, id: string): ChainEvent {
  return {
    chainId: 0, network: 'test', blockNumber: block, blockHash: `0xb${block}`,
    txHash: id, logIndex: 0, contractAddress: '0xc', eventName: name,
    eventRaw: new Uint8Array(0), decoded: {}, dataLength: 0,
  };
}

const sink = () => new SqliteAdapter(new Database(':memory:'));

describe('named-handler perf attribution', () => {
  it('tracks per-event-name latency in handlerStats()', async () => {
    const ix = await createIndexer({ schema, sink: sink() });
    ix.on('A', async (_e, ctx) => { await ctx.store.set('Thing', 'x', { v: 1 }); });
    ix.on('B', async (_e, ctx) => { await ctx.store.set('Thing', 'y', { v: 2 }); });

    await ix.processEvents([evt('A', 1, 't1'), evt('A', 1, 't2'), evt('B', 1, 't3')]);

    const s = ix.handlerStats();
    expect(s['A'].calls).toBe(2);
    expect(s['B'].calls).toBe(1);
    expect(s['A'].avgMs).toBeGreaterThanOrEqual(0);
    expect(s['A'].sumMs).toBeGreaterThanOrEqual(0);
  });

  it('logs a WARN when a handler exceeds slowHandlerMs, naming the event', async () => {
    const warns: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
    const logger: IndexerLogger = { ...noopLogger, warn: (_c, msg, extra) => warns.push({ msg, extra }) };
    const ix = await createIndexer({ schema, sink: sink(), logger, slowHandlerMs: 15 });
    ix.on('Slow', async () => { await new Promise((r) => setTimeout(r, 30)); });

    await ix.processEvents([evt('Slow', 1, 't1')]);

    const slow = warns.find((w) => w.msg === 'slow handler');
    expect(slow).toBeDefined();
    expect(slow!.extra!['event']).toBe('Slow');
    expect(slow!.extra!['elapsed_ms'] as number).toBeGreaterThanOrEqual(15);
  });
});

describe('onError observer', () => {
  it('fires on a handler error with the event, and the error still propagates', async () => {
    const onError = vi.fn();
    const ix = await createIndexer({ schema, sink: sink(), onError });
    ix.on('Boom', async () => { throw new Error('kaboom'); });

    await expect(ix.processEvents([evt('Boom', 1, 't1')])).rejects.toThrow('kaboom');
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, event] = onError.mock.calls[0];
    expect((err as Error).message).toBe('kaboom');
    expect((event as ChainEvent).eventName).toBe('Boom');
    expect(ix.stats.errors).toBe(1);
  });
});

describe('beforeBlock middleware', () => {
  it('runs before event handlers and before onBlock, once per block', async () => {
    const order: string[] = [];
    const ix = await createIndexer({ schema, sink: sink() });
    ix.beforeBlock(async () => { order.push('before'); });
    ix.on('E', async () => { order.push('event'); });
    ix.onBlock(async () => { order.push('after'); });

    await ix.processEvents([evt('E', 1, 't1'), evt('E', 1, 't2')]);

    expect(order).toEqual(['before', 'event', 'event', 'after']);   // one before/after per block
  });
});
