/**
 * EvmLogSource — an EventSource over `eth_getLogs`, implementing the same core
 * interface as the OPNET sources. Backfill chunks the block range and fetches
 * logs per chunk (server-side address filtering); live mode polls the head.
 * Logs are decoded through an EvmAbiDecoder, so nothing above the source changes.
 *
 * Requires the optional peer dependency `viem`. Pass a configured viem
 * PublicClient (recommended — you control chain/transport/retries) or an rpcUrl.
 */

import { createPublicClient, http } from 'viem';
import type { PublicClient, Abi, Log } from 'viem';
import type { EventSource, EventSourceFilters, UnsubscribeFn, DynamicSource } from '../../source.js';
import type { ChainEvent } from '../../types.js';
import type { EvmChainMeta } from './types.js';
import { EvmAbiDecoder } from './evmDecoder.js';
import { withRetry, type RetryOptions } from '../../lifecycle.js';

export interface EvmLogSourceOptions {
  /** EIP-155 chain id stamped on every event. */
  chainId: number;
  /** Human-readable network label, e.g. "eth-mainnet", "base-mainnet". */
  network: string;
  /** ABI(s) used to decode logs (and, with `addresses`, to filter). */
  abi: Abi | Abi[];
  /** A configured viem PublicClient. Preferred. */
  client?: PublicClient;
  /** Or an RPC URL — a default http() client is built from it. */
  rpcUrl?: string;
  /** Restrict logs to these contract addresses (server-side filter). */
  addresses?: string[];
  /** Max blocks per eth_getLogs call. Default 2000. */
  maxBlockRange?: number;
  /** Poll interval for live mode (ms). Default 12000. */
  pollIntervalMs?: number;
  /**
   * Fetch each block's timestamp (one getBlock per block that has logs, cached)
   * so ChainEvent.blockTimestamp is populated for time-series handlers. Default
   * true. Set false to skip the extra round-trips when you don't need block time.
   */
  fetchBlockTimestamps?: boolean;
  /**
   * Retry/backoff for transient RPC failures (`eth_getLogs`, `eth_getBlock*`),
   * exponential with full jitter. Off by default (one attempt). A public RPC
   * under load benefits from e.g. `{ attempts: 4 }`.
   */
  retry?: RetryOptions;
  /**
   * Fetch this many `eth_getLogs` chunks in parallel during backfill, yielding
   * them strictly in block order (ordered-parallel). Default 1 (sequential).
   * 4–8 cuts backfill wall time dramatically when the RPC round-trip dominates.
   */
  concurrency?: number;
}

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex'));

export class EvmLogSource implements EventSource, DynamicSource {
  private readonly client: PublicClient;
  private readonly decoder: EvmAbiDecoder;
  private readonly chainId: number;
  private readonly network: string;
  /** Watched contract addresses (lowercased). Grows via addAddress (factories). */
  private readonly addressSet: Set<string>;
  private readonly maxBlockRange: number;
  private readonly defaultPollMs: number;
  private readonly fetchTs: boolean;
  private readonly retry: RetryOptions;
  private readonly concurrency: number;
  /** blockNumber -> unix timestamp, cached across chunks. */
  private readonly tsCache = new Map<number, number>();
  /** Observability counters (read by callers / metrics). */
  requests = 0;
  retries = 0;

  constructor(options: EvmLogSourceOptions) {
    if (!options.client && !options.rpcUrl) {
      throw new Error('[counter-index] EvmLogSource requires either `client` or `rpcUrl`.');
    }
    this.client = options.client ?? createPublicClient({ transport: http(options.rpcUrl) });
    this.decoder = new EvmAbiDecoder(options.abi);
    this.chainId = options.chainId;
    this.network = options.network;
    this.addressSet = new Set((options.addresses ?? []).map((a) => a.toLowerCase()));
    this.maxBlockRange = options.maxBlockRange ?? 2000;
    this.defaultPollMs = options.pollIntervalMs ?? 12_000;
    this.fetchTs = options.fetchBlockTimestamps ?? true;
    this.retry = options.retry ?? { attempts: 1 };
    this.concurrency = Math.max(1, options.concurrency ?? 1);
  }

  /** Issue one RPC call, counting requests + retries and applying backoff. */
  private rpc<T>(fn: () => Promise<T>): Promise<T> {
    this.requests++;
    return withRetry(fn, { ...this.retry, onRetry: (a, e, d) => { this.retries++; this.retry.onRetry?.(a, e, d); } });
  }

  /** Fetch + cache timestamps for the blocks that have logs in this batch. */
  private async loadTimestamps(logs: Log[]): Promise<void> {
    const want = new Set<number>();
    for (const l of logs) {
      const bn = Number(l.blockNumber ?? 0n);
      if (!this.tsCache.has(bn)) want.add(bn);
    }
    for (const bn of want) {
      try {
        const block = await this.rpc(() => this.client.getBlock({ blockNumber: BigInt(bn), includeTransactions: false }));
        this.tsCache.set(bn, Number(block.timestamp));
      } catch { /* leave undefined — timestamp is best-effort */ }
    }
  }

  async *queryStream(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): AsyncIterable<ChainEvent> {
    const addressFilter = this.resolveAddressFilter(filters);

    // Split the range into fixed chunks, then fetch up to `concurrency` chunks
    // in flight while yielding them strictly in order — so the indexer still sees
    // blocks ascending, but we're not idle waiting on one RPC round-trip at a time.
    const ranges: Array<[number, number]> = [];
    for (let f = fromBlock; f <= toBlock; f += this.maxBlockRange) {
      ranges.push([f, Math.min(f + this.maxBlockRange - 1, toBlock)]);
    }

    const fetchChunk = async ([f, end]: [number, number]): Promise<Log[]> => {
      const logs = await this.rpc(() => this.client.getLogs({ address: addressFilter, fromBlock: BigInt(f), toBlock: BigInt(end) }));
      const ordered = [...logs].sort(compareLogs);
      if (this.fetchTs) await this.loadTimestamps(ordered);
      return ordered;
    };

    const inflight: Array<Promise<Log[]>> = [];
    let next = 0;
    while (next < ranges.length && inflight.length < this.concurrency) inflight.push(fetchChunk(ranges[next++]));
    while (inflight.length > 0) {
      const ordered = await inflight.shift()!;                              // head chunk, in order
      if (next < ranges.length) inflight.push(fetchChunk(ranges[next++]));  // keep the pipe full
      const txEventsByTx = buildTxEventsMap(ordered, this.decoder);
      for (const log of ordered) {
        const event = this.toChainEvent(log, txEventsByTx);
        if (filters?.eventNames && !filters.eventNames.includes(event.eventName)) continue;
        yield event;
      }
    }
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
    options: { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? this.defaultPollMs;
    let lastBlock = fromBlock - 1;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const tip = Number(await this.rpc(() => this.client.getBlockNumber()));
        if (tip > lastBlock) {
          for await (const e of this.queryStream(lastBlock + 1, tip)) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = tip;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[counter-index] EvmLogSource poll error (retry in ${intervalMs / 1000}s): ${msg}`);
      }
      if (!stopped) setTimeout(() => { void poll(); }, intervalMs);
    };

    setTimeout(() => { void poll(); }, 0);
    return () => { stopped = true; };
  }

  /** Start watching an additional contract (e.g. a factory-discovered child). */
  addAddress(address: string): void {
    this.addressSet.add(address.toLowerCase());
  }

  private resolveAddressFilter(filters?: EventSourceFilters): `0x${string}`[] | undefined {
    if (filters?.contract) return [filters.contract as `0x${string}`];
    return this.addressSet.size > 0 ? ([...this.addressSet] as `0x${string}`[]) : undefined;
  }

  private toChainEvent(
    log: Log,
    txEventsByTx: Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>,
  ): ChainEvent {
    const raw = hexToBytes(log.data);
    const decodedLog = this.decoder.decode({ raw, topics: log.topics });
    const eventName = decodedLog?.eventName ?? (log.topics[0] ?? 'unknown');

    const chainMeta: EvmChainMeta = {
      kind: 'evm',
      topics: [...log.topics],
      removed: log.removed,
    };

    return {
      chainId:         this.chainId,
      network:         this.network,
      blockNumber:     Number(log.blockNumber ?? 0n),
      blockHash:       log.blockHash ?? '',
      blockTimestamp:  this.tsCache.get(Number(log.blockNumber ?? 0n)),
      txHash:          log.transactionHash ?? '',
      txIndex:         log.transactionIndex ?? undefined,
      logIndex:        log.logIndex ?? undefined,
      contractAddress: log.address,
      eventName,
      eventRaw:        raw,
      decoded:         decodedLog?.decoded ?? null,
      dataLength:      raw.length,
      txEvents:        log.transactionHash ? txEventsByTx.get(log.transactionHash) : undefined,
      chainMeta,
    };
  }
}

function compareLogs(a: Log, b: Log): number {
  const bn = Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n);
  if (bn !== 0) return bn;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/**
 * Group every log in the chunk by tx hash, then by contract address — the
 * router-pattern sibling map (matches the OPNET sources' `txEvents` shape:
 * Map<contractAddress, {type,raw}[]>, shared by reference across a tx's events).
 */
function buildTxEventsMap(
  logs: Log[],
  decoder: EvmAbiDecoder,
): Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>> {
  const byTx = new Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>();
  for (const log of logs) {
    if (!log.transactionHash) continue;
    const raw = hexToBytes(log.data);
    const type = decoder.decode({ raw, topics: log.topics })?.eventName ?? (log.topics[0] ?? 'unknown');
    let perTx = byTx.get(log.transactionHash);
    if (!perTx) { perTx = new Map(); byTx.set(log.transactionHash, perTx); }
    const bucket = perTx.get(log.address);
    if (bucket) bucket.push({ type, raw });
    else perTx.set(log.address, [{ type, raw }]);
  }
  return byTx;
}
