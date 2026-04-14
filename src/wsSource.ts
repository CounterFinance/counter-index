/**
 * WsEventSource — Tier 2 EventSource backed by OpStream's WebSocket broadcast.
 *
 * OpStream streams fully-enriched events over a plain RFC 6455 WebSocket. This
 * source connects to that feed and delivers `DecodedEvent` objects with
 * sub-second latency — no DB or RPC calls required.
 *
 * Limitations:
 *   - Live-only: `query()` throws. Use DbEventSource for historical backfill.
 *   - No server-side filtering: all events are broadcast. Filter inside handlers
 *     or use the `fromBlock` parameter to skip early blocks.
 *
 * Requires the `ws` peer dependency:
 *   npm install ws
 */

import WebSocket from 'ws';
import type { EventSource, UnsubscribeFn } from './source.js';
import type { DecodedEvent } from './types.js';
import { decodeEvent } from './decoders/eventDecoders.js';

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

function toDecodedEvent(raw: OpStreamWebhookEvent): DecodedEvent {
  const eventRaw = hexToUint8Array(raw.eventRaw);

  // OpStream broadcasts raw event bytes only — decoding lives entirely in op-index's
  // DECODER_REGISTRY and is applied at read time. Adding a new decoder instantly
  // applies to subsequent broadcasts with no OpStream change.
  const decoded = decodeEvent(raw.eventName, eventRaw);

  return {
    blockNumber:     raw.blockNumber,
    txHash:          raw.txHash,
    contractAddress: raw.contractAddress,
    eventName:       raw.eventName,
    eventRaw,
    decoded,
    dataLength:      raw.dataLength ?? eventRaw.length,
    logIndex:        raw.logIndex,
    blockTimestamp:  raw.blockTimestamp,
    txIndex:         raw.txIndex,
    fromAddress:     raw.fromAddress ?? undefined,
    gasUsed:         raw.gasUsed != null ? BigInt(raw.gasUsed) : undefined,
    burnedBitcoin:   raw.burnedBitcoin != null ? BigInt(raw.burnedBitcoin) : undefined,
    failed:          raw.failed,
    revertReason:    raw.revertReason ?? undefined,
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

  query(): Promise<DecodedEvent[]> {
    throw new Error(
      '[op-index] WsEventSource is live-only — use DbEventSource for historical backfill.',
    );
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: DecodedEvent) => Promise<void>,
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
      });

      ws.on('message', (data: Buffer) => {
        if (stopped) return;
        let raw: OpStreamWebhookEvent;
        try {
          raw = JSON.parse(data.toString()) as OpStreamWebhookEvent;
        } catch {
          return; // ignore malformed frames
        }
        if (raw.blockNumber < fromBlock) return;
        void onEvent(toDecodedEvent(raw));
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
