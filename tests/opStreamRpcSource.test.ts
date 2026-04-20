/**
 * OpStreamRpcEventSource tests — mock fetch, no real HTTP calls.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpStreamRpcEventSource } from '../src/opStreamRpcSource.js';

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function b64(str: string): string {
  return Buffer.from(str).toString('base64');
}

/** Build a minimal RpcBlockRange JSON result for opstream_getBlockRange. */
function makeBlockRangeResult(blocks: Array<{
  height: number;
  time?: number;
  txs: Array<{
    hash: string;
    index: number;
    from?: string | null;
    events: Array<{ contractAddress: string; type: string; data?: string }>;
  }>;
}>) {
  return blocks.map(b => ({
    hash:   `0x${b.height.toString(16).padStart(64, '0')}`,
    height: String(b.height),
    time:   b.time ?? null,
    transactions: b.txs.map(tx => ({
      hash:            tx.hash,
      blockNumber:     `0x${b.height.toString(16)}`,
      index:           tx.index,
      OPNetType:       '1',
      from:            tx.from ?? null,
      contractAddress: tx.events[0]?.contractAddress ?? null,
      gasUsed:         '0x0',
      burnedBitcoin:   '0x0',
      events:          tx.events.map(ev => ({
        contractAddress: ev.contractAddress,
        type:            ev.type,
        data:            ev.data ?? b64(''),
      })),
    })),
  }));
}

function mockFetch(result: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// logIndex tests
// ---------------------------------------------------------------------------

describe('OpStreamRpcEventSource — logIndex continuity', () => {
  it('assigns 0-based logIndex within a single tx', async () => {
    const result = makeBlockRangeResult([{
      height: 100,
      txs: [{
        hash:  '0xabc',
        index: 0,
        from:  null,
        events: [
          { contractAddress: 'op1aaa', type: 'EventA' },
          { contractAddress: 'op1aaa', type: 'EventB' },
          { contractAddress: 'op1bbb', type: 'EventC' },
        ],
      }],
    }]);
    mockFetch(result);

    const src = new OpStreamRpcEventSource('http://localhost');
    const events = await collect(src.queryStream(100, 100));

    expect(events).toHaveLength(3);
    expect(events[0]!.logIndex).toBe(0);
    expect(events[1]!.logIndex).toBe(1);
    expect(events[2]!.logIndex).toBe(2);
  });

  it('resets logIndex counter between transactions', async () => {
    const result = makeBlockRangeResult([{
      height: 200,
      txs: [
        {
          hash:  '0xtx1',
          index: 0,
          from:  null,
          events: [
            { contractAddress: 'op1aaa', type: 'EventA' },
            { contractAddress: 'op1bbb', type: 'EventB' },
          ],
        },
        {
          hash:  '0xtx2',
          index: 1,
          from:  null,
          events: [
            { contractAddress: 'op1ccc', type: 'EventC' },
            { contractAddress: 'op1ddd', type: 'EventD' },
          ],
        },
      ],
    }]);
    mockFetch(result);

    const src = new OpStreamRpcEventSource('http://localhost');
    const events = await collect(src.queryStream(200, 200));

    expect(events).toHaveLength(4);
    // tx1 events: logIndex 0, 1
    expect(events[0]!.txHash).toBe('0xtx1');
    expect(events[0]!.logIndex).toBe(0);
    expect(events[1]!.txHash).toBe('0xtx1');
    expect(events[1]!.logIndex).toBe(1);
    // tx2 events: logIndex resets to 0, 1
    expect(events[2]!.txHash).toBe('0xtx2');
    expect(events[2]!.logIndex).toBe(0);
    expect(events[3]!.txHash).toBe('0xtx2');
    expect(events[3]!.logIndex).toBe(1);
  });

  it('normalises a 32-byte hex pubkey tx.from to bech32m fromAddress', async () => {
    const HEX_PUBKEY = 'ab'.repeat(32); // 64 hex chars
    const result = makeBlockRangeResult([{
      height: 400,
      txs: [{
        hash:  '0xtx_from',
        index: 0,
        from:  HEX_PUBKEY,
        events: [{ contractAddress: 'op1aaa', type: 'Evt' }],
      }],
    }]);
    mockFetch(result);

    const src = new OpStreamRpcEventSource('http://localhost');
    const events = await collect(src.queryStream(400, 400));

    expect(events[0]!.fromAddress).toMatch(/^op1/);
    expect(events[0]!.fromAddressPubkey).toBe(HEX_PUBKEY);
  });

  it('consumes logIndex slots for filtered-out events', async () => {
    // Event at index 1 is filtered out by eventNames, but logIndex should
    // still jump from 0 to 2 for the next included event.
    const result = makeBlockRangeResult([{
      height: 300,
      txs: [{
        hash:  '0xtx3',
        index: 0,
        from:  null,
        events: [
          { contractAddress: 'op1aaa', type: 'Included' },
          { contractAddress: 'op1aaa', type: 'Filtered' },
          { contractAddress: 'op1bbb', type: 'Included' },
        ],
      }],
    }]);
    mockFetch(result);

    const src = new OpStreamRpcEventSource('http://localhost');
    const events = await collect(src.queryStream(300, 300, { eventNames: ['Included'] }));

    expect(events).toHaveLength(2);
    expect(events[0]!.logIndex).toBe(0);
    expect(events[1]!.logIndex).toBe(2);  // slot 1 consumed by Filtered
  });
});
