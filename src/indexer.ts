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
import { HandlerRegistry, type EventHandler, type BlockHandler, type HandlerContext, type BlockContext } from './handler.js';
import { decodeEvent } from './decoders/eventDecoders.js';
import type { DecodedEvent } from './types.js';
import { buildGraphQLSchema, startGraphQLServer, startSubscriptionServer, type ServeOptions, type ServeHandle } from './graphql.js';

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
  blocksProcessed: number;
  lastBlock: number;
}

export interface Indexer {
  /** Register a handler for an event name. Use '*' for all events. */
  on(eventName: string, handler: EventHandler): void;

  /**
   * Register a block handler. Fires once per block after all event handlers
   * for that block have run. Only fires for blocks that contain at least one
   * indexed event — empty blocks are not observed.
   *
   * Use this for candle closes, reserve snapshots, or any block-level aggregate:
   *
   *   indexer.onBlock(async ({ blockNumber, blockTimestamp, store }) => {
   *     await store.set('Candle', String(blockNumber), { close: currentPrice, ... });
   *   });
   */
  onBlock(handler: BlockHandler): void;

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

  /**
   * Start a GraphQL HTTP server that exposes all indexed entities.
   *
   * - GET  /graphql → GraphiQL playground
   * - POST /graphql → execute queries
   * - WS   /graphql → subscriptions (when options.subscriptions: true)
   *
   * Subscriptions require peer deps: npm install graphql-ws ws
   *
   * Example:
   *   const handle = await indexer.serve({ port: 4000 });
   *   console.log(`GraphQL at ${handle.url}`);
   *   await handle.stop(); // graceful shutdown
   */
  serve(options?: ServeOptions): Promise<ServeHandle>;
}

export type { ServeOptions, ServeHandle };

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
    blocksProcessed: 0,
    lastBlock: 0,
  };

  function makeContext(event: DecodedEvent): HandlerContext {
    return {
      store,
      block: event.blockNumber,
      blockTimestamp: event.blockTimestamp,
    };
  }

  function makeBlockContext(blockNumber: number, blockTimestamp: number | undefined): BlockContext {
    return { blockNumber, blockTimestamp, store };
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

  async function dispatchBlock(blockNumber: number, blockTimestamp: number | undefined): Promise<void> {
    stats.blocksProcessed++;
    await registry.dispatchBlock(makeBlockContext(blockNumber, blockTimestamp));
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

    onBlock(handler) {
      registry.onBlock(handler);
    },

    async processEvent(event) {
      await dispatch(event);
    },

    async processEvents(events) {
      let currentBlock = -1;
      let currentTimestamp: number | undefined;

      for (const event of events) {
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          await dispatchBlock(currentBlock, currentTimestamp);
        }
        currentBlock     = event.blockNumber;
        currentTimestamp = event.blockTimestamp;
        await dispatch(event);
      }

      if (currentBlock !== -1) {
        await dispatchBlock(currentBlock, currentTimestamp);
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

      let currentBlock = -1;
      let currentTimestamp: number | undefined;

      for (const event of events) {
        // Block boundary — fire block handlers for the completed block
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          await dispatchBlock(currentBlock, currentTimestamp);
        }
        currentBlock    = event.blockNumber;
        currentTimestamp = event.blockTimestamp;
        await dispatch(event);
      }

      // Fire block handler for the final block
      if (currentBlock !== -1) {
        await dispatchBlock(currentBlock, currentTimestamp);
      }

      return { ...stats };
    },

    subscribe(fromBlock, options) {
      const source = requireSource();
      // Track block transitions so onBlock handlers fire after each block's events.
      // The last block in a poll batch fires when the next batch brings a new block number.
      let lastBlock     = -1;
      let lastTimestamp: number | undefined;

      return source.subscribe(
        fromBlock,
        async (event) => {
          if (lastBlock !== -1 && event.blockNumber !== lastBlock) {
            await dispatchBlock(lastBlock, lastTimestamp);
          }
          lastBlock     = event.blockNumber;
          lastTimestamp = event.blockTimestamp;
          await dispatch(event);
        },
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
        blocksProcessed: 0,
        lastBlock: 0,
      };
    },

    async serve(options) {
      const gqlSchema = buildGraphQLSchema(config.schema, store, {
        subscriptions: options?.subscriptions,
      });
      const { server, url } = startGraphQLServer(gqlSchema, options);
      if (options?.subscriptions) {
        await startSubscriptionServer(gqlSchema, server);
      }
      return {
        url,
        stop: () => new Promise((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
      };
    },
  };
}
