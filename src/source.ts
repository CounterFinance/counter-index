/**
 * EventSource — the chain-neutral interface the indexer reads raw chain events
 * from. Core defines only the contract; each chain ships its own implementation
 * under `src/chains/<chain>/` (e.g. OPNET's DbEventSource, RpcEventSource;
 * EVM's EvmLogSource). The source is READ-ONLY — op-index never writes back
 * through it.
 */

import type { ChainEvent } from './types.js';

export type UnsubscribeFn = () => void;

export interface EventSourceFilters {
  /** Only return events from this contract address. */
  contract?: string;
  /** Only return events with these names. */
  eventNames?: string[];
}

export interface EventSource {
  /**
   * Backfill: stream all events in [fromBlock, toBlock] inclusive, ordered by
   * block number ASC, then intra-block order. Memory is bounded — events are
   * yielded as they are fetched, never materialised into one array. Filters
   * are ANDed.
   */
  queryStream(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): AsyncIterable<ChainEvent>;

  /**
   * Live: poll/stream for new events after fromBlock and call onEvent for each.
   * Returns an unsubscribe function that stops delivery when called.
   */
  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
    options?: { pollIntervalMs?: number },
  ): UnsubscribeFn;
}
