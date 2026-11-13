/**
 * WsEventSource tests — real in-process WebSocketServer, no mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { OpnetChainMeta } from '../src/chains/opnet/types.js';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { WsEventSource } from '../src/chains/opnet/wsSource.js';
import { registerDecoder, DECODER_REGISTRY } from '../src/chains/opnet/decoders.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Spin up a WS server on a random port and return { server, port, broadcast }. */
async function startServer(): Promise<{
  server: WebSocketServer;
  port: number;
  broadcast: (payload: object) => void;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 });
    const clients = new Set<WebSocket>();

    server.on('connection', (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
    });

    server.once('listening', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;

      const broadcast = (payload: object): void => {
        const msg = JSON.stringify(payload);
        for (const ws of clients) ws.send(msg);
      };

      const close = (): Promise<void> =>
        new Promise((res) => server.close(() => res()));

      resolve({ server, port, broadcast, close });
    });
  });
}

/** Build a minimal valid OpStreamWebhookEvent payload. */
function makePayload(overrides: Partial<{
  blockNumber:     number;
  txHash:          string;
  contractAddress: string;
  eventName:       string;
  logIndex:        number;
  blockTimestamp:  number;
  txIndex:         number;
  fromAddress:     string | null;
  gasUsed:         string | null;
  burnedBitcoin:   string | null;
  failed:          boolean;
  revertReason:    string | null;
  eventRaw:        string;
  dataLength:      number;
}> = {}) {
  return {
    blockNumber:     100,
    txHash:          '0xabc',
    contractAddress: '0xcontract',
    eventName:       'TestEvent',
    logIndex:        0,
    blockTimestamp:  1_700_000_000,
    txIndex:         0,
    fromAddress:     '0xsender',
    gasUsed:         '21000',
    burnedBitcoin:   '500',
    failed:          false,
    revertReason:    null,
    // 96 zero bytes — valid length for many built-in decoders
    eventRaw:        '0x' + '00'.repeat(96),
    dataLength:      96,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WsEventSource', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let url: string;

  beforeEach(async () => {
    srv = await startServer();
    url = `ws://localhost:${srv.port}`;
  });

  afterEach(async () => {
    await srv.close();
  });

  // ── query() ──────────────────────────────────────────────────────────────

  it('queryStream() rejects with a helpful message', async () => {
    const source = new WsEventSource(url);
    await expect(async () => {
      for await (const _ of source.queryStream()) { /* empty */ }
    }).rejects.toThrowError(/WsEventSource is live-only/);
  });

  // ── subscribe() — basic delivery ─────────────────────────────────────────

  it('delivers a well-formed ChainEvent to onEvent', async () => {
    const source = new WsEventSource(url);
    const received: object[] = [];

    const stop = source.subscribe(1, async (e) => { received.push(e); });

    await new Promise((r) => setTimeout(r, 30)); // let connect settle
    srv.broadcast(makePayload({ blockNumber: 10 }));
    await new Promise((r) => setTimeout(r, 30));

    stop();

    expect(received).toHaveLength(1);
    const e = received[0] as Record<string, unknown>;
    expect(e['blockNumber']).toBe(10);
    expect(e['txHash']).toBe('0xabc');
    expect(e['contractAddress']).toBe('0xcontract');
    expect(e['eventName']).toBe('TestEvent');
    expect(e['eventRaw']).toBeInstanceOf(Uint8Array);
    expect(e['logIndex']).toBe(0);
    expect(e['blockTimestamp']).toBe(1_700_000_000);
  });

  // ── subscribe() — fromBlock filter ───────────────────────────────────────

  it('skips events with blockNumber < fromBlock', async () => {
    const source = new WsEventSource(url);
    const received: object[] = [];

    const stop = source.subscribe(50, async (e) => { received.push(e); });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({ blockNumber: 40 })); // should be skipped
    srv.broadcast(makePayload({ blockNumber: 50 })); // should pass
    srv.broadcast(makePayload({ blockNumber: 60 })); // should pass
    await new Promise((r) => setTimeout(r, 30));

    stop();

    expect(received).toHaveLength(2);
    const blocks = (received as Array<Record<string, unknown>>).map((e) => e['blockNumber']);
    expect(blocks).toEqual([50, 60]);
  });

  // ── subscribe() — hex eventRaw conversion ────────────────────────────────

  it('converts hex eventRaw to Uint8Array correctly', async () => {
    const source = new WsEventSource(url);
    let captured: Uint8Array | undefined;

    const stop = source.subscribe(1, async (e) => { captured = e.eventRaw; });

    await new Promise((r) => setTimeout(r, 30));
    // eventRaw = 0x0102ff — 3 bytes
    srv.broadcast(makePayload({ eventRaw: '0x0102ff', dataLength: 3 }));
    await new Promise((r) => setTimeout(r, 30));

    stop();

    expect(captured).toBeInstanceOf(Uint8Array);
    expect(Array.from(captured!)).toEqual([0x01, 0x02, 0xff]);
  });

  // ── subscribe() — counter-index decoder takes priority ───────────────────────────

  it('uses counter-index registered decoder when available', async () => {
    // Register a decoder for 'PriorityEvent' that returns a known result
    const originalSize = DECODER_REGISTRY.size;
    registerDecoder('PriorityEvent', () => ({ custom: 'decoded' }));

    const source = new WsEventSource(url);
    let captured: Record<string, unknown> | null | undefined;

    const stop = source.subscribe(1, async (e) => { captured = e.decoded; });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({ eventName: 'PriorityEvent' }));
    await new Promise((r) => setTimeout(r, 30));

    stop();
    DECODER_REGISTRY.delete('PriorityEvent');
    expect(DECODER_REGISTRY.size).toBe(originalSize);

    expect(captured).toEqual({ custom: 'decoded' });
  });

  // ── subscribe() — unknown event names produce null decoded ───────────────

  it('returns null decoded when no counter-index decoder is registered', async () => {
    const source = new WsEventSource(url);
    let captured: Record<string, unknown> | null | undefined;

    const stop = source.subscribe(1, async (e) => { captured = e.decoded; });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({ eventName: 'UnknownEventXYZ' }));
    await new Promise((r) => setTimeout(r, 30));

    stop();
    expect(captured).toBeNull();
  });

  // ── subscribe() — gasUsed / burnedBitcoin to BigInt ──────────────────────

  it('converts gasUsed and burnedBitcoin to BigInt', async () => {
    const source = new WsEventSource(url);
    let gas: unknown;
    let burned: unknown;

    const stop = source.subscribe(1, async (e) => {
      gas    = (e.chainMeta as OpnetChainMeta).gasUsed;
      burned = (e.chainMeta as OpnetChainMeta).burnedBitcoin;
    });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({ gasUsed: '99999', burnedBitcoin: '12345' }));
    await new Promise((r) => setTimeout(r, 30));

    stop();
    expect(gas).toBe(99999n);
    expect(burned).toBe(12345n);
  });

  // ── subscribe() — null fields map to undefined ───────────────────────────

  it('maps null fromAddress / gasUsed / burnedBitcoin / revertReason to undefined', async () => {
    const source = new WsEventSource(url);
    let captured: Record<string, unknown> | undefined;

    const stop = source.subscribe(1, async (e) => { captured = e as unknown as Record<string, unknown>; });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({
      fromAddress:   null,
      gasUsed:       null,
      burnedBitcoin: null,
      revertReason:  null,
    }));
    await new Promise((r) => setTimeout(r, 30));

    stop();
    expect(captured!['fromAddress']).toBeUndefined();
    expect(captured!['gasUsed']).toBeUndefined();
    expect(captured!['burnedBitcoin']).toBeUndefined();
    expect(captured!['revertReason']).toBeUndefined();
  });

  // ── unsubscribe ───────────────────────────────────────────────────────────

  it('stops delivering events after unsubscribe', async () => {
    const source = new WsEventSource(url);
    const received: object[] = [];

    const stop = source.subscribe(1, async (e) => { received.push(e); });

    await new Promise((r) => setTimeout(r, 30));
    srv.broadcast(makePayload({ blockNumber: 1 }));
    await new Promise((r) => setTimeout(r, 30));

    stop(); // unsubscribe

    srv.broadcast(makePayload({ blockNumber: 2 }));
    await new Promise((r) => setTimeout(r, 30));

    expect(received).toHaveLength(1);
  });

  // ── reconnection ─────────────────────────────────────────────────────────

  it('reconnects after server closes the connection', async () => {
    const source = new WsEventSource(url, { reconnectDelayMs: 50 });
    const received: object[] = [];

    const stop = source.subscribe(1, async (e) => { received.push(e); });

    await new Promise((r) => setTimeout(r, 40)); // initial connect

    // Force-close all clients to simulate a server-side disconnect
    for (const ws of srv.server.clients) ws.terminate();

    await new Promise((r) => setTimeout(r, 150)); // wait for reconnect

    srv.broadcast(makePayload({ blockNumber: 99 }));
    await new Promise((r) => setTimeout(r, 40));

    stop();
    expect(received.some((e) => (e as Record<string, unknown>)['blockNumber'] === 99)).toBe(true);
  });
});
