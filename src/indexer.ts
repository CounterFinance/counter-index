/**
 * Indexer — the main orchestrator.
 *
 * Wire up a schema, a sink DB (where op-index writes derived tables), and optionally
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
import { noopLogger, type IndexerLogger } from './logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndexerConfig<S extends SchemaDefinition = SchemaDefinition> {
  schema: Schema<S>;
  /** Sink DB — op-index owns its own opindex_* tables here. */
  sink: MinimalDbAdapter;
  /** Source — where raw chain events are read from. Required for sync() and subscribe(). */
  source?: EventSource;
  /** Optional logger. Defaults to a no-op logger. */
  logger?: IndexerLogger;
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

  /** The entity store — query op-index's derived tables here. */
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
  const log = config.logger ?? noopLogger;
  const store = await createStore(config.schema, config.sink, log);
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
    // DEBUG: compact per-event line — the event name is the handler identifier.
    log.debug('handler', 'dispatch', {
      event:    event.eventName,
      contract: event.contractAddress,
      block:    event.blockNumber,
      tx:       event.txHash,
    });
    // TRACE: per-handler timing — only computed when log is trace-enabled.
    const t0 = Date.now();
    await registry.dispatch(event, makeContext(event));
    log.trace('handler', 'dispatched', {
      event:      event.eventName,
      block:      event.blockNumber,
      tx:         event.txHash,
      elapsed_ms: Date.now() - t0,
    });
  }

  /**
   * Flush a block: run onBlock handlers + write the checkpoint atomically.
   * Returns elapsed_ms so callers can emit a log line at the level they want
   * (DEBUG during sync, INFO during subscribe).
   */
  async function dispatchBlock(
    blockNumber: number,
    blockTimestamp: number | undefined,
    tipBlock?: number,
  ): Promise<number> {
    stats.blocksProcessed++;
    const t0 = Date.now();
    await config.sink.transaction(async () => {
      await registry.dispatchBlock(makeBlockContext(blockNumber, blockTimestamp));
      await store.writeBlockCheckpoint(blockNumber, tipBlock, blockTimestamp);
    });
    return Date.now() - t0;
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
      let eventsInBlock = 0;

      for (const event of events) {
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          const elapsedMs = await dispatchBlock(currentBlock, currentTimestamp);
          log.debug('indexer', 'block processed', {
            block: currentBlock, events_in_block: eventsInBlock, elapsed_ms: elapsedMs,
          });
          eventsInBlock = 0;
        }
        currentBlock     = event.blockNumber;
        currentTimestamp = event.blockTimestamp;
        eventsInBlock++;
        await dispatch(event);
      }

      if (currentBlock !== -1) {
        const elapsedMs = await dispatchBlock(currentBlock, currentTimestamp);
        log.debug('indexer', 'block processed', {
          block: currentBlock, events_in_block: eventsInBlock, elapsed_ms: elapsedMs,
        });
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
      const syncStart  = Date.now();

      // DEBUG: per-window framing. Consumers typically log an INFO
      // "backfilling X → Y" line that aggregates many windows, so this
      // would be redundant at INFO.
      const filterNames = filters?.eventNames ?? null;
      log.debug('indexer', 'sync start', {
        from:        fromBlock,
        to:          toBlock,
        blocks:      toBlock - fromBlock + 1,
        event_count: filterNames ? filterNames.length : 0,
        events:      filterNames ? filterNames.join(',') : '*',
      });

      let currentBlock = -1;
      let currentTimestamp: number | undefined;
      let eventsInBlock = 0;

      // Progress ticker — emit a log line every 5 seconds during long syncs.
      // This is the primary INFO heartbeat; skip the per-block / per-window lines
      // (they're DEBUG).
      let lastProgressAt = Date.now();
      let progressBlock  = fromBlock;
      let progressEvents = 0;

      for await (const event of source.queryStream(fromBlock, toBlock, filters)) {
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          const elapsedMs = await dispatchBlock(currentBlock, currentTimestamp);
          log.debug('indexer', 'block processed', {
            block: currentBlock, events_in_block: eventsInBlock, elapsed_ms: elapsedMs,
          });
          eventsInBlock = 0;

          const now = Date.now();
          if (now - lastProgressAt >= 5_000) {
            const elapsed   = (now - lastProgressAt) / 1_000;
            const blkDelta  = currentBlock - progressBlock;
            const behind    = toBlock - currentBlock;
            const eta       = blkDelta > 0 ? Math.round(behind / (blkDelta / elapsed)) : null;
            log.info('indexer', 'progress', {
              block:          currentBlock,
              tip:            toBlock,
              behind,
              blocks_per_sec: Number((blkDelta / elapsed).toFixed(1)),
              events_per_sec: Number((progressEvents / elapsed).toFixed(1)),
              eta_sec:        eta,
            });
            lastProgressAt = now;
            progressBlock  = currentBlock;
            progressEvents = 0;
          }
        }
        currentBlock     = event.blockNumber;
        currentTimestamp = event.blockTimestamp;
        eventsInBlock++;
        progressEvents++;
        await dispatch(event);
      }

      if (currentBlock !== -1) {
        const elapsedMs = await dispatchBlock(currentBlock, currentTimestamp);
        log.debug('indexer', 'block processed', {
          block: currentBlock, events_in_block: eventsInBlock, elapsed_ms: elapsedMs,
        });
      }

      // Advance checkpoint to the scan boundary even when the last N blocks had
      // no matching events — ensures _meta.block.number means "scanned up to here".
      if (currentBlock !== toBlock) {
        await config.sink.transaction(async () => {
          await store.writeBlockCheckpoint(toBlock, undefined, currentTimestamp);
        });
      }

      const elapsedMs = Date.now() - syncStart;
      log.debug('indexer', 'sync complete', {
        from:           fromBlock,
        to:             toBlock,
        blocks:         toBlock - fromBlock + 1,
        events:         stats.eventsProcessed,
        elapsed_ms:     elapsedMs,
        blocks_per_sec: Number(((toBlock - fromBlock + 1) / (elapsedMs / 1_000)).toFixed(1)),
      });

      return { ...stats };
    },

    subscribe(fromBlock, options) {
      const source = requireSource();
      // Track block transitions so onBlock handlers fire after each block's events.
      // The last block in a poll batch fires when the next batch brings a new block number.
      let lastBlock     = -1;
      let lastTimestamp: number | undefined;

      let eventsInBlock = 0;
      log.info('indexer', 'subscribe start', { from_block: fromBlock });

      return source.subscribe(
        fromBlock,
        async (event) => {
          if (lastBlock !== -1 && event.blockNumber !== lastBlock) {
            const elapsedMs = await dispatchBlock(lastBlock, lastTimestamp);
            // INFO: live-mode heartbeat. At ~1 block / 10s this is ~6 lines/min,
            // giving a clear "still alive" signal without flooding logs.
            log.info('indexer', 'live block', {
              block: lastBlock, events_in_block: eventsInBlock, elapsed_ms: elapsedMs,
            });
            eventsInBlock = 0;
          }
          lastBlock     = event.blockNumber;
          lastTimestamp = event.blockTimestamp;
          eventsInBlock++;
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
