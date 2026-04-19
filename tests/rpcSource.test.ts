/**
 * RpcEventSource tests — mock BlockProvider, no real RPC calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RpcEventSource, type BlockLike, type BlockProvider } from '../src/rpcSource.js';
import { registerDecoder } from '../src/decoders/eventDecoders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INTERACTION = 1;
const GENERIC     = 0;

function makeBlock(
  height: number,
  txs: BlockLike['transactions'] = [],
  timestamp?: number,
): BlockLike {
  return { height: BigInt(height), timestamp, transactions: txs };
}

function makeTx(
  id: string,
  events: Record<string, Array<{ type: string; data: Uint8Array }>> = {},
  opts: { OPNetType?: number; from?: string; gasUsed?: bigint; failed?: boolean } = {},
) {
  return {
    id,
    OPNetType: opts.OPNetType ?? INTERACTION,
    events,
    from:      opts.from,
    gasUsed:   opts.gasUsed,
    failed:    opts.failed,
  };
}

function makeProvider(blocks: Map<number, BlockLike>): BlockProvider {
  return {
    getBlock:       async (h, _p) => blocks.get(Number(h)) ?? null,
    getBlockNumber: async ()      => BigInt(Math.max(...blocks.keys())),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RpcEventSource.query', () => {
  it('returns all events across a block range', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] })])],
      [101, makeBlock(101, [makeTx('tx2', { '0xB': [{ type: 'Evt', data: new Uint8Array(0) }] })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 101);
    expect(events).toHaveLength(2);
    expect(events[0]!.blockNumber).toBe(100);
    expect(events[1]!.blockNumber).toBe(101);
  });

  it('returns empty array when range has no events', async () => {
    const blocks = new Map([[100, makeBlock(100, [])]]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events).toHaveLength(0);
  });

  it('skips non-Interaction transactions', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [
        makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] }, { OPNetType: GENERIC }),
        makeTx('tx2', { '0xB': [{ type: 'Evt', data: new Uint8Array(0) }] }),
      ])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events).toHaveLength(1);
    expect(events[0]!.txHash).toBe('tx2');
  });

  it('skips blocks where provider returns null', async () => {
    const blocks = new Map([
      [101, makeBlock(101, [makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] })])],
    ]);
    // block 100 not in map → provider returns null
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 101);
    expect(events).toHaveLength(1);
    expect(events[0]!.blockNumber).toBe(101);
  });

  it('filters by contract address (case-insensitive)', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        '0xAAA': [{ type: 'Evt', data: new Uint8Array(0) }],
        '0xBBB': [{ type: 'Evt', data: new Uint8Array(0) }],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100, { contract: '0xaaa' });
    expect(events).toHaveLength(1);
    expect(events[0]!.contractAddress).toBe('0xAAA');
  });

  it('filters by event name', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        '0xA': [
          { type: 'Transferred', data: new Uint8Array(0) },
          { type: 'Approval',    data: new Uint8Array(0) },
        ],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100, { eventNames: ['Approval'] });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('Approval');
  });

  it('assigns log_index correctly within a tx', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        '0xA': [
          { type: 'EvtA', data: new Uint8Array(0) },
          { type: 'EvtB', data: new Uint8Array(0) },
        ],
        '0xB': [
          { type: 'EvtC', data: new Uint8Array(0) },
        ],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events[0]!.logIndex).toBe(0);
    expect(events[1]!.logIndex).toBe(1);
    expect(events[2]!.logIndex).toBe(2);
  });

  it('keeps log_index consistent across filtered-out contracts', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        '0xSkip': [
          { type: 'Evt', data: new Uint8Array(0) },
          { type: 'Evt', data: new Uint8Array(0) },
        ],
        '0xKeep': [
          { type: 'Evt', data: new Uint8Array(0) },
        ],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100, { contract: '0xKeep' });
    expect(events).toHaveLength(1);
    expect(events[0]!.logIndex).toBe(2); // 0xSkip used indices 0 and 1
  });

  it('decodes events using registered decoder', async () => {
    registerDecoder('TestEvt', (_raw) => ({ field: 'decoded-value' }));
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        '0xA': [{ type: 'TestEvt', data: new Uint8Array(4) }],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events[0]!.decoded).toEqual({ field: 'decoded-value' });
  });

  it('populates tx-level fields from the transaction', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [
        makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] }, {
          from: '0xsender', gasUsed: 21000n, failed: false,
        }),
      ], 1712340000)],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    // '0xsender' is not a 32-byte hex pubkey — passes through unchanged
    expect(events[0]!.fromAddress).toBe('0xsender');
    expect(events[0]!.fromAddressPubkey).toBeUndefined();
    expect(events[0]!.gasUsed).toBe(21000n);
    expect(events[0]!.failed).toBe(false);
    expect(events[0]!.blockTimestamp).toBe(1712340000);
  });

  it('normalises a 32-byte hex pubkey in tx.from to bech32m fromAddress', async () => {
    const HEX_PUBKEY = '0'.repeat(64);
    const blocks = new Map([
      [100, makeBlock(100, [
        makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] }, {
          from: HEX_PUBKEY,
        }),
      ])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events[0]!.fromAddress).toMatch(/^op1/);
    expect(events[0]!.fromAddressPubkey).toBe(HEX_PUBKEY);
  });

  it('populates txEvents with all sibling events in the same tx', async () => {
    const ROUTER = '0xrouter';
    const TOKEN  = '0xtoken';
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        [ROUTER]: [
          { type: 'SwapExecuted', data: new Uint8Array([1]) },
        ],
        [TOKEN]: [
          { type: 'Transferred', data: new Uint8Array([2]) },
        ],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.txEvents).toBeDefined();
      expect(e.txEvents!.get(ROUTER)?.[0]?.type).toBe('SwapExecuted');
      expect(e.txEvents!.get(TOKEN)?.[0]?.type).toBe('Transferred');
    }
    // Shared reference across sibling events from the same tx
    expect(events[0]!.txEvents).toBe(events[1]!.txEvents);
  });

  it('txEvents covers all events even when filtered event names exclude siblings', async () => {
    const ROUTER = '0xrouter';
    const TOKEN  = '0xtoken';
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', {
        [ROUTER]: [{ type: 'SwapExecuted', data: new Uint8Array(0) }],
        [TOKEN]:  [{ type: 'Transferred',  data: new Uint8Array(0) }],
      })])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100, { eventNames: ['SwapExecuted'] });
    expect(events).toHaveLength(1);
    // Even though we filtered to SwapExecuted only, txEvents still contains Transferred
    expect(events[0]!.txEvents!.get(TOKEN)?.[0]?.type).toBe('Transferred');
  });

  it('txEvents is scoped per-tx (different txs get different maps)', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [
        makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] }),
        makeTx('tx2', { '0xB': [{ type: 'Evt', data: new Uint8Array(0) }] }),
      ])],
    ]);
    const source = new RpcEventSource(makeProvider(blocks), { rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events).toHaveLength(2);
    expect(events[0]!.txEvents).not.toBe(events[1]!.txEvents);
    expect(events[0]!.txEvents!.has('0xA')).toBe(true);
    expect(events[0]!.txEvents!.has('0xB')).toBe(false);
    expect(events[1]!.txEvents!.has('0xB')).toBe(true);
    expect(events[1]!.txEvents!.has('0xA')).toBe(false);
  });

  it('retries on block fetch failure and returns null after maxRetries', async () => {
    let calls = 0;
    const failProvider: BlockProvider = {
      getBlock: async () => { calls++; throw new Error('timeout'); },
      getBlockNumber: async () => 100n,
    };
    const source = new RpcEventSource(failProvider, { maxRetries: 2, retryDelayMs: 0, rpsLimit: 1000 });
    const events = await source.query(100, 100);
    expect(events).toHaveLength(0);    // block skipped
    expect(calls).toBe(2);            // retried exactly maxRetries times
  });
});

describe('RpcEventSource.subscribe', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('calls onEvent for new blocks as they appear', async () => {
    const blocks = new Map([
      [100, makeBlock(100, [makeTx('tx1', { '0xA': [{ type: 'Evt', data: new Uint8Array(0) }] })])],
    ]);
    const provider = makeProvider(blocks);
    const source   = new RpcEventSource(provider, { rpsLimit: 1000 });
    const received: string[] = [];

    const stop = source.subscribe(100, async (e) => { received.push(e.txHash); }, { pollIntervalMs: 10_000 });

    // Advance past the immediate setTimeout(0) that triggers the first poll
    await vi.advanceTimersByTimeAsync(1);
    stop();
    expect(received).toContain('tx1');
  });

  it('returns unsubscribe fn that stops polling', async () => {
    let calls = 0;
    const provider: BlockProvider = {
      getBlock:       async () => null,
      getBlockNumber: async () => { calls++; return 100n; },
    };
    const source = new RpcEventSource(provider, { rpsLimit: 1000 });
    const stop = source.subscribe(101, async () => {}, { pollIntervalMs: 500 });

    await vi.advanceTimersByTimeAsync(600);
    stop();
    const callsAfterStop = calls;
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(callsAfterStop); // no more calls after stop()
  });
});
