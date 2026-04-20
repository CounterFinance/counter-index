/**
 * OpStreamRpcEventSource — EventSource backed by OpStream's HTTP JSON-RPC API.
 *
 * Uses `opstream_getBlockRange` (up to 1000 blocks per call, full enrichment) for
 * both backfill and polling. This is the remote equivalent of DbEventSource — one
 * HTTP call per chunk instead of one SQL query — without requiring direct DB access.
 *
 * Works against any OpStream HTTP endpoint, including Railway-deployed instances:
 *   https://opstream-testnet-production.up.railway.app
 *   https://opstream-mainnet-production.up.railway.app
 *
 * Live subscriptions:
 *   If a WebSocket URL is provided, subscribe() connects to OpStream's WS broadcast
 *   for sub-second latency and falls back to polling automatically if the connection
 *   fails or is unavailable. Polling can be forced via `forcePolling: true`.
 */

import WebSocket from 'ws';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import type { DecodedEvent } from './types.js';
import type { WsEventSourceOptions } from './wsSource.js';
import { decodeEvent } from './decoders/eventDecoders.js';
import { normaliseFromAddress } from './p2op.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpStreamRpcEventSourceOptions {
  /**
   * WebSocket URL for live subscriptions (e.g. 'ws://localhost:8081').
   * If provided, subscribe() tries WS first; falls back to polling if it
   * cannot connect. If absent, subscribe() always polls.
   */
  wsUrl?: string;
  /**
   * Force polling even when wsUrl is set. Default: false.
   */
  forcePolling?: boolean;
  /**
   * Maximum blocks per opstream_getBlockRange call. Default: 1000 (server max).
   * Reduce if you hit the 10 000-transaction or 50 000-event limits frequently.
   */
  chunkSize?: number;
  /** Milliseconds between polls in polling mode. Default: 10 000. */
  pollIntervalMs?: number;
  /**
   * Number of chunk requests to fire in parallel during query(). Default: 1 (sequential).
   * Raise to 4–8 for faster backfill over a low-latency connection. Results are always
   * returned in block-number order regardless of which request finishes first.
   */
  concurrency?: number;
  /** Reconnect options forwarded to the internal WS connection. */
  wsOptions?: WsEventSourceOptions;
  /**
   * Optional progress logger called after each chunk is fetched.
   * Receives a human-readable line — caller decides how to print it.
   * Default: no logging.
   */
  onChunkFetched?: (info: { fromBlock: number; toBlock: number; events: number; elapsedMs: number }) => void;
  /**
   * Called when a single block is skipped because the server-limit retry budget
   * is exhausted. The block's events are lost for this run — caller can record
   * the block number for later re-indexing.
   * Default: no callback (a console.warn is always emitted).
   */
  onBlockSkipped?: (blockNumber: number) => void;
}

// ---------------------------------------------------------------------------
// Wire types from opstream_getBlockRange
// ---------------------------------------------------------------------------

interface RpcEventEntry {
  contractAddress: string;
  type:            string;   // event name
  data:            string;   // base64-encoded event_raw bytes
}

interface RpcTxFull {
  hash:            string;
  blockNumber:     string;   // hex "0x…"
  index:           number;
  OPNetType:       string;
  from:            string | null;
  contractAddress: string | null;
  gasUsed:         string;   // hex "0x…"
  burnedBitcoin:   string;   // hex "0x…"
  revert?:         string | null;  // present only when tx failed
  events:          RpcEventEntry[];
}

interface RpcBlockRange {
  hash:         string;
  height:       string;      // decimal string
  time:         number | null;
  transactions: RpcTxFull[] | string[];  // string[] when includeTx=false
}

// OpStream WebhookEvent wire format (for WS fallback — same as WsEventSource)
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
  eventRaw:        string;   // hex "0x…"
  dataLength?:     number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBigInt(hex: string): bigint {
  return BigInt(hex.startsWith('0x') ? hex : '0x' + hex);
}

function base64ToUint8Array(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function hexToUint8Array(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const padded = clean.length % 2 === 0 ? clean : '0' + clean;
  return new Uint8Array(Buffer.from(padded, 'hex'));
}

/** Map a fully-enriched RPC block array to DecodedEvent[]. */
function mapBlocksToEvents(
  blocks:  RpcBlockRange[],
  filters?: EventSourceFilters,
): DecodedEvent[] {
  const out: DecodedEvent[] = [];

  for (const block of blocks) {
    const blockTimestamp = block.time ?? undefined;
    const blockNumber    = Number(block.height);

    for (const tx of block.transactions as RpcTxFull[]) {
      if (!tx.events?.length) continue;
      if (filters?.contract && tx.contractAddress !== filters.contract) continue;

      const failed = tx.revert !== undefined;

      // Build the txEvents Map once per tx — covers ALL contract addresses and
      // ALL event names regardless of filters. `tx.events` is a flat array from
      // opstream_getBlockRange, so we group by contractAddress here.
      const txEvents = new Map<string, Array<{ type: string; raw: Uint8Array }>>();
      for (const entry of tx.events) {
        const raw = base64ToUint8Array(entry.data);
        const bucket = txEvents.get(entry.contractAddress);
        if (bucket) {
          bucket.push({ type: entry.type, raw });
        } else {
          txEvents.set(entry.contractAddress, [{ type: entry.type, raw }]);
        }
      }

      // logIndex is per-tx, 0-based — increments across every event in the tx
      // regardless of filters, so post-filter events have a stable position
      // within the tx. Mirrors RpcEventSource / DbEventSource behaviour.
      let logIndex = 0;

      for (const ev of tx.events) {
        if (filters?.eventNames && !filters.eventNames.includes(ev.type)) {
          logIndex++;
          continue;
        }

        const eventRaw = base64ToUint8Array(ev.data);

        const { address: fromAddress, pubkeyHex: fromAddressPubkey } =
          normaliseFromAddress(tx.from);

        out.push({
          blockNumber,
          txHash:          tx.hash,
          contractAddress: ev.contractAddress,
          eventName:       ev.type,
          eventRaw,
          decoded:         decodeEvent(ev.type, eventRaw),
          dataLength:      eventRaw.length,
          logIndex:        logIndex++,
          blockTimestamp,
          txIndex:         tx.index,
          fromAddress,
          fromAddressPubkey,
          gasUsed:         tx.gasUsed      ? hexToBigInt(tx.gasUsed)      : undefined,
          burnedBitcoin:   tx.burnedBitcoin ? hexToBigInt(tx.burnedBitcoin) : undefined,
          failed,
          revertReason:    tx.revert ?? undefined,
          txEvents,
        });
      }
    }
  }

  return out;
}

/** Map a WS WebhookEvent to a DecodedEvent (mirrors WsEventSource.toDecodedEvent). */
function wsEventToDecoded(raw: OpStreamWebhookEvent): DecodedEvent {
  const eventRaw = hexToUint8Array(raw.eventRaw);
  const { address: fromAddress, pubkeyHex: fromAddressPubkey } =
    normaliseFromAddress(raw.fromAddress);
  return {
    blockNumber:     raw.blockNumber,
    txHash:          raw.txHash,
    contractAddress: raw.contractAddress,
    eventName:       raw.eventName,
    eventRaw,
    decoded:         decodeEvent(raw.eventName, eventRaw),
    dataLength:      raw.dataLength ?? eventRaw.length,
    logIndex:        raw.logIndex,
    blockTimestamp:  raw.blockTimestamp,
    txIndex:         raw.txIndex,
    fromAddress,
    fromAddressPubkey,
    gasUsed:         raw.gasUsed      != null ? BigInt(raw.gasUsed)      : undefined,
    burnedBitcoin:   raw.burnedBitcoin != null ? BigInt(raw.burnedBitcoin) : undefined,
    failed:          raw.failed,
    revertReason:    raw.revertReason ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// OpStreamRpcEventSource
// ---------------------------------------------------------------------------

export class OpStreamRpcEventSource implements EventSource {
  private readonly chunkSize:       number;
  private readonly concurrency:     number;
  private readonly pollIntervalMs:  number;
  private readonly wsUrl:           string | undefined;
  private readonly forcePolling:    boolean;
  private readonly wsOptions:       WsEventSourceOptions;
  private readonly onChunkFetched?: (info: { fromBlock: number; toBlock: number; events: number; elapsedMs: number }) => void;
  private readonly onBlockSkipped?: (blockNumber: number) => void;

  constructor(
    /** HTTP URL of the OpStream JSON-RPC endpoint. */
    private readonly httpUrl: string,
    options: OpStreamRpcEventSourceOptions = {},
  ) {
    this.chunkSize       = options.chunkSize      ?? 1_000;
    this.concurrency     = options.concurrency    ?? 1;
    this.pollIntervalMs  = options.pollIntervalMs ?? 10_000;
    this.wsUrl           = options.wsUrl;
    this.forcePolling    = options.forcePolling   ?? false;
    this.wsOptions       = options.wsOptions      ?? {};
    this.onChunkFetched  = options.onChunkFetched;
    this.onBlockSkipped  = options.onBlockSkipped;
  }

  // ── HTTP JSON-RPC call ──────────────────────────────────────────────────────

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const resp = await fetch(this.httpUrl, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
    });
    const json = await resp.json() as { result?: T; error?: { code: number; message: string } };
    if (json.error) {
      const err = Object.assign(
        new Error(`[OpStreamRpc] ${method}: ${json.error.message}`),
        { code: json.error.code },
      );
      throw err;
    }
    return json.result as T;
  }

  // ── Latest block number (via btc_blockNumber) ───────────────────────────────

  private async getLatestBlock(): Promise<number> {
    const n = await this.rpc<string | number>('btc_blockNumber', []);
    return Number(BigInt(n));
  }

  // ── Fetch one chunk — auto-retry with aggressive halving ──────────────────

  private async fetchChunk(
    fromBlock: number,
    toBlock:   number,
    filters?:  EventSourceFilters,
  ): Promise<DecodedEvent[]> {
    let chunkEnd = toBlock;

    // Up to 20 attempts: aggressive halving handles blocks with thousands of
    // events per block (e.g. testnet dense periods). Single-block is the floor.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const t0     = Date.now();
        const blocks = await this.rpc<RpcBlockRange[]>(
          'opstream_getBlockRange',
          [fromBlock, chunkEnd, { includeTx: true, includeEvents: true }],
        );
        const events    = mapBlocksToEvents(blocks, filters);
        const elapsedMs = Date.now() - t0;
        this.onChunkFetched?.({ fromBlock, toBlock: chunkEnd, events: events.length, elapsedMs });
        if (chunkEnd < toBlock) {
          const remaining = await this.fetchChunk(chunkEnd + 1, toBlock, filters);
          return [...events, ...remaining];
        }
        return events;

      } catch (err: unknown) {
        // Server returns -32602 when the range exceeds tx/event limits.
        const code = (err as { code?: number }).code;
        if (code !== -32602) throw err;

        // Parse suggested toBlock from message: "… e.g. [N, M]."
        const msg   = (err as Error).message ?? '';
        const match = msg.match(/\[(\d+),\s*(\d+)\]/);
        if (match) {
          const suggested = Number(match[2]);
          if (suggested < chunkEnd && suggested >= fromBlock) {
            chunkEnd = suggested;
            continue;
          }
        }

        // If already at a single block and the server still rejects it,
        // there is nothing we can do — skip it with a warning.
        if (chunkEnd <= fromBlock) {
          // eslint-disable-next-line no-console
          console.warn(`[op-index] OpStreamRpcEventSource: skipping single dense block ${fromBlock} (server limit exceeded)`);
          this.onBlockSkipped?.(fromBlock);
          return [];
        }

        // Halve the range and retry
        chunkEnd = fromBlock + Math.max(0, Math.floor((chunkEnd - fromBlock) / 2));
      }
    }
    throw new Error(`[OpStreamRpc] could not satisfy server limits for range [${fromBlock}, ${toBlock}] after 20 attempts`);
  }

  // ── queryStream() — sequential chunked streaming ─────────────────────────
  //
  // Fetches one chunk at a time and yields events immediately. Peak memory is
  // bounded by one chunk (≤ chunkSize blocks) rather than the entire range.
  // Concurrency > 1 is intentionally not supported here — ordered streaming
  // without full materialisation requires sequential fetching.

  async *queryStream(
    fromBlock: number,
    toBlock:   number,
    filters?:  EventSourceFilters,
  ): AsyncIterable<DecodedEvent> {
    for (let f = fromBlock; f <= toBlock; ) {
      const end    = Math.min(f + this.chunkSize - 1, toBlock);
      const events = await this.fetchChunk(f, end, filters);
      for (const event of events) yield event;
      f = end + 1;
    }
  }

  // ── subscribe() — WS-first, polling fallback ─────────────────────────────────

  subscribe(
    fromBlock: number,
    onEvent:   (e: DecodedEvent) => Promise<void>,
    options:   { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? this.pollIntervalMs;

    // ── Try WebSocket first ─────────────────────────────────────────────────
    if (this.wsUrl && !this.forcePolling) {
      return this._subscribeWsWithFallback(fromBlock, onEvent, intervalMs);
    }

    // ── Polling only ────────────────────────────────────────────────────────
    return this._subscribePoll(fromBlock, onEvent, intervalMs);
  }

  private _subscribeWsWithFallback(
    fromBlock:  number,
    onEvent:    (e: DecodedEvent) => Promise<void>,
    intervalMs: number,
  ): UnsubscribeFn {
    let stopped     = false;
    let ws:          WebSocket | null = null;
    let wsConnected = false;
    let stopPoll:    (() => void) | null = null;

    const baseDelay = this.wsOptions.reconnectDelayMs    ?? 1_000;
    const maxDelay  = this.wsOptions.maxReconnectDelayMs ?? 30_000;
    let delay       = baseDelay;

    const startPollFallback = (): void => {
      if (stopped || stopPoll) return;
      // eslint-disable-next-line no-console
      console.warn('[op-index] OpStreamRpcEventSource: WS unavailable — falling back to polling');
      stopPoll = this._subscribePoll(fromBlock, onEvent, intervalMs);
    };

    const connect = (): void => {
      if (stopped) return;
      ws = new WebSocket(this.wsUrl!);

      ws.on('open', () => {
        wsConnected = true;
        delay = baseDelay;
        // Cancel polling fallback if it started before WS connected
        if (stopPoll) {
          stopPoll();
          stopPoll = null;
        }
        // Opt in to filtered push mode (opstream_subscribe).
        // Old broadcast-only servers ignore this and keep broadcasting.
        ws!.send(JSON.stringify({
          jsonrpc: '2.0',
          id:      1,
          method:  'opstream_subscribe',
          params:  ['logs', this.wsOptions.subscribeFilter ?? {}],
        }));
      });

      ws.on('message', (data: Buffer) => {
        if (stopped) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }

        const msg = parsed as Record<string, unknown>;

        // Path 1: opstream_subscription notification (subscribed mode)
        if (msg['method'] === 'opstream_subscription') {
          const params = msg['params'] as Record<string, unknown> | undefined;
          const raw = params?.['result'] as OpStreamWebhookEvent | undefined;
          if (raw && typeof raw.blockNumber === 'number' && raw.blockNumber >= fromBlock && raw.eventRaw) {
            void onEvent(wsEventToDecoded(raw));
          }
          return;
        }

        // Path 2: JSON-RPC ack (subscribe/unsubscribe response) — ignore
        if ('id' in msg && 'jsonrpc' in msg) return;

        // Path 3: legacy plain WebhookEvent (old OpStream without subscription support)
        const raw = parsed as OpStreamWebhookEvent;
        if (typeof raw.blockNumber === 'number' && raw.blockNumber >= fromBlock && raw.eventRaw) {
          void onEvent(wsEventToDecoded(raw));
        }
      });

      ws.on('close', () => {
        if (stopped) return;
        if (!wsConnected) {
          // Never connected — start polling now
          startPollFallback();
        }
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, maxDelay);
      });

      ws.on('error', () => {
        // 'close' always fires after 'error'
      });
    };

    connect();
    // If WS doesn't open within 5 s, start polling as a safety net
    setTimeout(() => {
      if (!wsConnected && !stopped) startPollFallback();
    }, 5_000);

    return (): void => {
      stopped = true;
      ws?.close();
      stopPoll?.();
    };
  }

  private _subscribePoll(
    fromBlock:  number,
    onEvent:    (e: DecodedEvent) => Promise<void>,
    intervalMs: number,
  ): UnsubscribeFn {
    let lastBlock = fromBlock - 1;
    let stopped   = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const maxBlock = await this.getLatestBlock();
        if (maxBlock > lastBlock) {
          for await (const e of this.queryStream(lastBlock + 1, maxBlock)) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = maxBlock;
        }
      } catch {
        // Non-fatal — next tick will retry
      }
      if (!stopped) setTimeout(() => { void poll(); }, intervalMs);
    };

    setTimeout(() => { void poll(); }, 0);
    return (): void => { stopped = true; };
  }
}
