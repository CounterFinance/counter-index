/**
 * Indexer — the main orchestrator.
 *
 * Wire up a schema, a sink DB (where OpKit writes derived tables), and optionally
 * a source (where raw chain events are read from). Register event handlers, then
 * run backfill via sync() or go live via subscribe().
 *
 * Usage:
 *   const indexer = await createIndexer({ schema, sink: adapter, source: dbSource });
 *   indexer.on('Transferred', async (event, ctx) => {
 *     await ctx.store.set('Transfer', event.txHash, { ... });
 *   });
 *
 *   await indexer.sync(941400, latestBlock);   // backfill
 *   indexer.subscribe();                        // go live
 *
 *   // Or feed events directly (e.g. from a WebSocket)
 *   await indexer.processEvent(event);
 */

import type { Schema, SchemaDefinition } from './schema.js';
import type { EntityStore } from './store.js';
import { createStore } from './store.js';
import type { MinimalDbAdapter } from './adapter.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import { HandlerRegistry, type EventHandler, type HandlerContext } from './handler.js';
import { decodeEvent } from './decoders/eventDecoders.js';
import type { DecodedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndexerConfig<S extends SchemaDefinition = SchemaDefinition> {
  schema: Schema<S>;
  /** Sink DB — OpKit owns its own opkit_* tables here. */
  sink: MinimalDbAdapter;
  /** Source — where raw chain events are read from. Required for sync() and subscribe(). */
  source?: EventSource;
}

export interface IndexerStats {
  eventsProcessed: number;
  eventsDecoded: number;
  eventsSkipped: number;
  lastBlock: number;
}

export interface Indexer {
  /** Register a handler for an event name. Use '*' for all events. */
  on(eventName: string, handler: EventHandler): void;

  /** Process a single decoded event through all matching handlers. */
  processEvent(event: DecodedEvent): Promise<void>;

  /** Process a batch of events in order. */
  processEvents(events: DecodedEvent[]): Promise<void>;

  /**
   * Process a raw event: decode it first, then dispatch.
   * Useful when receiving raw bytes directly (e.g. WebSocket push).
   */
  processRawEvent(
    eventName: string,
    rawData: Buffer | Uint8Array,
    meta: {
      blockNumber: number;
      txHash: string;
      contractAddress: string;
      blockTimestamp?: number;
      logIndex?: number;
      fromAddress?: string;
    },
  ): Promise<void>;

  /**
   * Backfill: query [fromBlock, toBlock] from the source and run all events
   * through handlers. Requires source to be set.
   */
  sync(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): Promise<IndexerStats>;

  /**
   * Live: subscribe to new events from the source starting at fromBlock.
   * Returns an unsubscribe function. Requires source to be set.
   */
  subscribe(
    fromBlock: number,
    options?: { pollIntervalMs?: number; filters?: EventSourceFilters },
  ): UnsubscribeFn;

  /** The entity store — query OpKit's derived tables here. */
  readonly store: EntityStore;

  /** Processing statistics. */
  readonly stats: IndexerStats;

  /** Reset stats counters (does NOT drop DB tables). */
  resetStats(): void;
}

// ---------------------------------------------------------------------------
// Factory — async because createStore() is async (runs CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------

export async function createIndexer<S extends SchemaDefinition>(
  config: IndexerConfig<S>,
): Promise<Indexer> {
  const store = await createStore(config.schema, config.sink);
  const registry = new HandlerRegistry();
  let stats: IndexerStats = {
    eventsProcessed: 0,
    eventsDecoded: 0,
    eventsSkipped: 0,
    lastBlock: 0,
  };

  function makeContext(event: DecodedEvent): HandlerContext {
    return {
      store,
      block: event.blockNumber,
      blockTimestamp: event.blockTimestamp,
    };
  }

  async function dispatch(event: DecodedEvent): Promise<void> {
    stats.eventsProcessed++;
    if (event.blockNumber > stats.lastBlock) {
      stats.lastBlock = event.blockNumber;
    }
    if (event.decoded) {
      stats.eventsDecoded++;
    } else {
      stats.eventsSkipped++;
    }
    await registry.dispatch(event, makeContext(event));
  }

  function requireSource(): EventSource {
    if (!config.source) {
      throw new Error(
        'No EventSource configured. Pass source: to createIndexer() or use processEvent() directly.',
      );
    }
    return config.source;
  }

  return {
    on(eventName, handler) {
      registry.on(eventName, handler);
    },

    async processEvent(event) {
      await dispatch(event);
    },

    async processEvents(events) {
      for (const event of events) {
        await dispatch(event);
      }
    },

    async processRawEvent(eventName, rawData, meta) {
      const raw = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
      const decoded = decodeEvent(eventName, raw);
      await dispatch({
        blockNumber:     meta.blockNumber,
        txHash:          meta.txHash,
        contractAddress: meta.contractAddress,
        eventName,
        eventRaw:        raw,
        decoded,
        dataLength:      raw.length,
        blockTimestamp:  meta.blockTimestamp,
        logIndex:        meta.logIndex,
        fromAddress:     meta.fromAddress,
      });
    },

    async sync(fromBlock, toBlock, filters) {
      const source = requireSource();
      const events = await source.query(fromBlock, toBlock, filters);
      for (const event of events) {
        await dispatch(event);
      }
      return { ...stats };
    },

    subscribe(fromBlock, options) {
      const source = requireSource();
      return source.subscribe(
        fromBlock,
        async (event) => { await dispatch(event); },
        { pollIntervalMs: options?.pollIntervalMs },
      );
    },

    get store() {
      return store;
    },

    get stats() {
      return { ...stats };
    },

    resetStats() {
      stats = {
        eventsProcessed: 0,
        eventsDecoded: 0,
        eventsSkipped: 0,
        lastBlock: 0,
      };
    },
  };
}
