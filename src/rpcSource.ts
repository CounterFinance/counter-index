/**
 * RpcEventSource — EventSource implementation that reads directly from the OPNET RPC.
 *
 * No OpStream required. Works against any public OPNET node.
 * Trade-off: one getBlock() call per block → O(N) for backfill, vs sub-millisecond SQL
 * with DbEventSource. Use for lightweight indexers or when OpStream is not available.
 *
 * OpKit has zero runtime dependencies. This file defines a minimal BlockProvider interface
 * that the opnet SDK's JSONRpcProvider satisfies via TypeScript structural typing — no import
 * from 'opnet' needed. The caller wires the provider at startup.
 *
 * Usage:
 *   import { JSONRpcProvider } from 'opnet';
 *   const source = new RpcEventSource(
 *     new JSONRpcProvider('https://mainnet.opnet.org'),
 *     { rpsLimit: 5 },
 *   );
 */

import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import type { DecodedEvent } from './types.js';
import { decodeEvent } from './decoders/eventDecoders.js';

// ---------------------------------------------------------------------------
// OPNET block/transaction shape — duck-typed, no SDK import
// ---------------------------------------------------------------------------

/** Minimal block shape — opnet SDK's Block satisfies this structurally. */
export interface BlockLike {
  height: bigint | number;
  timestamp?: number;
  transactions: TransactionLike[];
}

/**
 * Minimal transaction shape — opnet SDK's InteractionTransaction satisfies this.
 *
 * `events` is a Record keyed by contract address. Each value is an array of
 * { type: eventName, data: raw bytes }. Only present on Interaction transactions.
 */
export interface TransactionLike {
  id: string;
  OPNetType: number;    // 1 = Interaction — the only type that emits events
  events?: Record<string, Array<{ type: string; data: Buffer | Uint8Array }>>;
  contractAddress?: string;
  from?: string;
  txIndex?: number;
  gasUsed?: bigint | string;
  burnedBitcoin?: bigint | string;
  failed?: boolean;
  revertReason?: string | null;
}

/** Minimal provider interface — opnet SDK's JSONRpcProvider satisfies this. */
export interface BlockProvider {
  getBlock(height: bigint, prefetchTxs: boolean): Promise<BlockLike | null>;
  getBlockNumber(): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RpcEventSourceOptions {
  /** Max getBlock() calls per second. Default: 5. */
  rpsLimit?: number;
  /** Delay (ms) between retries on a failed block fetch. Default: 1000. */
  retryDelayMs?: number;
  /** Max retries before skipping a block. Default: 3. */
  maxRetries?: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** OPNetTransactionTypes.Interaction — defined locally to avoid SDK import. */
const INTERACTION_TYPE = 1;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Event extraction
// ---------------------------------------------------------------------------

function extractEvents(
  block: BlockLike,
  blockNumber: number,
  filters?: EventSourceFilters,
): DecodedEvent[] {
  const events: DecodedEvent[] = [];
  const blockTimestamp = block.timestamp;

  for (const [txIndex, tx] of block.transactions.entries()) {
    if (tx.OPNetType !== INTERACTION_TYPE || !tx.events) continue;

    // log_index is per-tx, 0-based, increments across all events in the tx
    // regardless of which contract emits them — matches OpStream's convention.
    let logIndex = 0;

    for (const [contractAddr, evts] of Object.entries(tx.events)) {
      // Contract filter — keep counter consistent even when skipping
      if (filters?.contract && contractAddr.toLowerCase() !== filters.contract.toLowerCase()) {
        logIndex += evts.length;
        continue;
      }

      for (const evt of evts) {
        // Event name filter
        if (filters?.eventNames && !filters.eventNames.includes(evt.type)) {
          logIndex++;
          continue;
        }

        const rawData = evt.data instanceof Uint8Array
          ? evt.data
          : new Uint8Array(evt.data);

        events.push({
          blockNumber,
          txHash:          tx.id,
          contractAddress: contractAddr,
          eventName:       evt.type,
          eventRaw:        rawData,
          decoded:         decodeEvent(evt.type, rawData),
          dataLength:      rawData.length,
          logIndex:        logIndex++,
          txIndex,
          blockTimestamp,
          fromAddress:     tx.from ?? undefined,
          gasUsed:         tx.gasUsed != null ? BigInt(tx.gasUsed) : undefined,
          burnedBitcoin:   tx.burnedBitcoin != null ? BigInt(tx.burnedBitcoin) : undefined,
          failed:          tx.failed,
          revertReason:    tx.revertReason ?? undefined,
        });
      }
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// RpcEventSource
// ---------------------------------------------------------------------------

export class RpcEventSource implements EventSource {
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly provider: BlockProvider,
    options: RpcEventSourceOptions = {},
  ) {
    this.minIntervalMs = Math.ceil(1000 / (options.rpsLimit ?? 5));
    this.maxRetries    = options.maxRetries  ?? 3;
    this.retryDelayMs  = options.retryDelayMs ?? 1000;
  }

  async query(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): Promise<DecodedEvent[]> {
    const results: DecodedEvent[] = [];
    let lastCallAt = 0;

    for (let n = fromBlock; n <= toBlock; n++) {
      // Rate limiting — enforce minIntervalMs between getBlock calls
      const elapsed = Date.now() - lastCallAt;
      if (elapsed < this.minIntervalMs) {
        await sleep(this.minIntervalMs - elapsed);
      }

      const block = await this.fetchBlockWithRetry(BigInt(n));
      lastCallAt = Date.now();

      if (!block) continue; // null after maxRetries — skip block

      results.push(...extractEvents(block, n, filters));
    }

    return results;
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: DecodedEvent) => Promise<void>,
    options: { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? 10_000;
    let lastBlock = fromBlock - 1;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const tip = await this.provider.getBlockNumber();
        const maxBlock = Number(tip);
        if (maxBlock > lastBlock) {
          const events = await this.query(lastBlock + 1, maxBlock);
          for (const e of events) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = maxBlock;
        }
      } catch {
        // poll errors are non-fatal — next tick will retry
      }
      if (!stopped) {
        setTimeout(() => { void poll(); }, intervalMs);
      }
    };

    setTimeout(() => { void poll(); }, 0);

    return () => { stopped = true; };
  }

  private async fetchBlockWithRetry(n: bigint): Promise<BlockLike | null> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.provider.getBlock(n, true);
      } catch {
        if (attempt < this.maxRetries - 1) {
          await sleep(this.retryDelayMs);
        }
      }
    }
    return null; // exhausted retries — caller skips this block
  }
}
