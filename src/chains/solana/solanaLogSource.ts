/**
 * SolanaLogSource — an EventSource over Solana program logs. Solana has no
 * `eth_getLogs`; events arrive as `emit!` "Program data: <base64>" lines in a
 * transaction's log messages. This source turns those into chain-neutral
 * ChainEvents via a SolanaDecoder, so the core indexer handles Solana with zero
 * changes. Transaction fetching is injected (`fetchSlots`) so it's testable
 * offline and can wire to any RPC / Geyser / Yellowstone feed.
 */

import type { EventSource, EventSourceFilters, UnsubscribeFn } from '../../source.js';
import type { ChainEvent } from '../../types.js';
import type { SolanaDecoder } from './solanaDecoder.js';
import type { SolanaChainMeta } from './types.js';

/** One transaction's decoded-relevant data, as a fetcher yields it. */
export interface SolanaTx {
  slot: number;
  signature: string;
  /** Raw `log messages` for the transaction (as `getTransaction` returns them). */
  logs: string[];
  blockTime?: number;
}

export interface SolanaLogSourceOptions {
  chainId: number;
  network: string;
  /** The program whose events we index (base58). */
  programId: string;
  decoder: SolanaDecoder;
  /** Pull transactions for a slot range (inclusive). Injected: RPC, Geyser, fixture. */
  fetchSlots: (fromSlot: number, toSlot: number) => AsyncIterable<SolanaTx>;
  /** Live tip poller (optional). */
  pollIntervalMs?: number;
}

const PROGRAM_DATA = 'Program data: ';

/** Extract + base64-decode the `Program data:` payloads from a tx's logs. */
export function programDataPayloads(logs: string[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const line of logs) {
    if (line.startsWith(PROGRAM_DATA)) {
      try { out.push(new Uint8Array(Buffer.from(line.slice(PROGRAM_DATA.length).trim(), 'base64'))); }
      catch { /* skip malformed line */ }
    }
  }
  return out;
}

export class SolanaLogSource implements EventSource {
  constructor(private readonly opts: SolanaLogSourceOptions) {}

  private *toEvents(tx: SolanaTx): Iterable<ChainEvent> {
    let logIndex = 0;
    for (const raw of programDataPayloads(tx.logs)) {
      const decoded = this.opts.decoder.decode({ raw });
      if (!decoded) continue;                                   // not one of our events
      const meta: SolanaChainMeta = {
        kind: 'solana',
        programId: this.opts.programId,
        slot: tx.slot,
        discriminator: Buffer.from(raw.subarray(0, 8)).toString('hex'),
      };
      yield {
        chainId: this.opts.chainId,
        network: this.opts.network,
        blockNumber: tx.slot,                 // slot is Solana's block height
        blockHash: tx.signature,
        blockTimestamp: tx.blockTime,
        txHash: tx.signature,
        logIndex: logIndex++,
        contractAddress: this.opts.programId,
        eventName: decoded.eventName,
        eventRaw: raw,
        decoded: decoded.decoded,
        dataLength: raw.length,
        chainMeta: meta,
      };
    }
  }

  async *queryStream(fromBlock: number, toBlock: number, filters?: EventSourceFilters): AsyncIterable<ChainEvent> {
    for await (const tx of this.opts.fetchSlots(fromBlock, toBlock)) {
      for (const event of this.toEvents(tx)) {
        if (filters?.eventNames && !filters.eventNames.includes(event.eventName)) continue;
        yield event;
      }
    }
  }

  subscribe(fromBlock: number, onEvent: (e: ChainEvent) => Promise<void>, options: { pollIntervalMs?: number } = {}): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? this.opts.pollIntervalMs ?? 2_000;
    let lastSlot = fromBlock - 1;
    let stopped = false;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        let maxSlot = lastSlot;
        for await (const tx of this.opts.fetchSlots(lastSlot + 1, Number.MAX_SAFE_INTEGER)) {
          if (stopped) return;
          maxSlot = Math.max(maxSlot, tx.slot);
          for (const event of this.toEvents(tx)) { if (stopped) return; await onEvent(event); }
        }
        lastSlot = maxSlot;
      } catch { /* transient — retry next tick */ }
      if (!stopped) timer = setTimeout(() => void poll(), intervalMs);
    };
    let timer = setTimeout(() => void poll(), 0);
    return () => { stopped = true; clearTimeout(timer); };
  }
}
