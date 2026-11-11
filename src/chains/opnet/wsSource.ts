/**
 * WsEventSource — Tier 2 EventSource backed by OpStream's WebSocket broadcast.
 *
 * OpStream streams fully-enriched events over a plain RFC 6455 WebSocket. This
 * source connects to that feed and delivers `ChainEvent` objects with
 * sub-second latency — no DB or RPC calls required.
 *
 * Limitations:
 *   - Live-only: `query()` throws. Use DbEventSource for historical backfill.
 *
 * Server-side filtering (new OpStream servers):
 *   On connect, sends opstream_subscribe("logs", subscribeFilter) so only matching
 *   events are pushed — saves bandwidth for single-contract bots.
 *   Three-path message parser handles all server types:
 *     1. opstream_subscription notification → extract params.result
 *     2. JSON-RPC ack (subscribe response)  → ignored
 *     3. Legacy plain WebhookEvent          → old broadcast-only servers
 *
 * Requires the `ws` peer dependency:
 *   npm install ws
 */

import WebSocket from 'ws';
import type { EventSource, UnsubscribeFn } from '../../source.js';
import type { ChainEvent } from '../../types.js';
import { decodeEvent } from './decoders.js';
import { OPNET_CHAIN_ID, OPNET_NETWORK } from './constants.js';
import type { OpnetChainMeta } from './types.js';

// ---------------------------------------------------------------------------
// OpStream WebhookEvent wire format (15 enriched fields)
// ---------------------------------------------------------------------------

interface OpStreamWebhookEvent {
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
  eventRaw:        string; // hex-encoded: "0x1a2b..."
  dataLength?:     number; // may be absent in older payloads
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WsEventSourceOptions {
  /** Base reconnect delay on disconnect. Default: 1000 ms. */
  reconnectDelayMs?:    number;
  /** Maximum reconnect delay after exponential backoff. Default: 30 000 ms. */
  maxReconnectDelayMs?: number;
  /**
   * Server-side filter sent with opstream_subscribe("logs").
   * Omit or pass {} to receive all logs from all contracts.
   * New OpStream servers (with subscription support) apply this filter
   * server-side; old broadcast-only servers ignore it and send everything.
   */
  subscribeFilter?: { address?: string; eventNames?: string[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  // Pad to even length
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  return new Uint8Array(Buffer.from(padded, 'hex'));
}

function toChainEvent(raw: OpStreamWebhookEvent): ChainEvent {
  const eventRaw = hexToUint8Array(raw.eventRaw);

  // OpStream broadcasts raw event bytes only — decoding lives entirely in op-index's
  // DECODER_REGISTRY and is applied at read time. Adding a new decoder instantly
  // applies to subsequent broadcasts with no OpStream change.
  const decoded = decodeEvent(raw.eventName, eventRaw);

  return {
    chainId:         OPNET_CHAIN_ID,
    network:         OPNET_NETWORK,
    blockNumber:     raw.blockNumber,
    blockHash:       '',
    blockTimestamp:  raw.blockTimestamp,
    txHash:          raw.txHash,
    txIndex:         raw.txIndex,
    logIndex:        raw.logIndex,
    contractAddress: raw.contractAddress,
    eventName:       raw.eventName,
    eventRaw,
    decoded,
    dataLength:      raw.dataLength ?? eventRaw.length,
    chainMeta: {
      kind:          'opnet',
      fromAddress:   raw.fromAddress ?? undefined,
      gasUsed:       raw.gasUsed != null ? BigInt(raw.gasUsed) : undefined,
      burnedBitcoin: raw.burnedBitcoin != null ? BigInt(raw.burnedBitcoin) : undefined,
      failed:        raw.failed,
      revertReason:  raw.revertReason ?? undefined,
    } as OpnetChainMeta,
  };
}

// ---------------------------------------------------------------------------
// WsEventSource
// ---------------------------------------------------------------------------

export class WsEventSource implements EventSource {
  constructor(
    /** WebSocket URL for OpStream's broadcast server, e.g. 'ws://localhost:8080'. */
    private readonly url: string,
    private readonly options: WsEventSourceOptions = {},
  ) {}

  // eslint-disable-next-line require-yield
  async *queryStream(): AsyncIterable<ChainEvent> {
    throw new Error(
      '[op-index] WsEventSource is live-only — use DbEventSource for historical backfill.',
    );
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
  ): UnsubscribeFn {
    let stopped = false;
    let ws: WebSocket | null = null;
    let delay = this.options.reconnectDelayMs ?? 1_000;
    const maxDelay = this.options.maxReconnectDelayMs ?? 30_000;
    const baseDelay = this.options.reconnectDelayMs ?? 1_000;

    const connect = (): void => {
      if (stopped) return;

      ws = new WebSocket(this.url);

      ws.on('open', () => {
        // Reset backoff on successful connection
        delay = baseDelay;
        // Opt in to server-side filtered push (opstream_subscribe).
        // Old broadcast-only servers ignore this message and keep broadcasting.
        ws!.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'opstream_subscribe',
          params:  ['logs', this.options.subscribeFilter ?? {}],
        }));
      });

      ws.on('message', (data: Buffer) => {
        if (stopped) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return; // ignore malformed frames
        }

        const msg = parsed as Record<string, unknown>;

        // Path 1: opstream_subscription notification (subscribed mode)
        if (msg['method'] === 'opstream_subscription') {
          const params = msg['params'] as Record<string, unknown> | undefined;
          const raw = params?.['result'] as OpStreamWebhookEvent | undefined;
          if (raw && typeof raw.blockNumber === 'number' && raw.blockNumber >= fromBlock && raw.eventRaw) {
            void onEvent(toChainEvent(raw));
          }
          return;
        }

        // Path 2: JSON-RPC ack (subscribe/unsubscribe response) — ignore
        if ('id' in msg && 'jsonrpc' in msg) return;

        // Path 3: legacy plain WebhookEvent (old OpStream without subscription support)
        const raw = parsed as OpStreamWebhookEvent;
        if (typeof raw.blockNumber === 'number' && raw.blockNumber >= fromBlock && raw.eventRaw) {
          void onEvent(toChainEvent(raw));
        }
      });

      ws.on('close', () => {
        if (stopped) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, maxDelay);
      });

      ws.on('error', () => {
        // 'close' always fires after 'error' — reconnect logic lives there
      });
    };

    connect();

    return (): void => {
      stopped = true;
      ws?.close();
    };
  }
}
