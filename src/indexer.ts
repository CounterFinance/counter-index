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
import type { TypedStore } from './store.js';
import { createStore, scopeStoreToChain } from './store.js';
import type { MinimalDbAdapter } from './adapter.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import { isDynamicSource } from './source.js';
import { HandlerRegistry, type EventHandler, type BlockHandler, type HandlerContext, type BlockContext } from './handler.js';
import type { ChainEvent } from './types.js';
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
  /**
   * Enable reorg handling (prior-row journal + fork detection). Off by default.
   * `finalityDepth` is how many recent blocks stay rollback-able per chain.
   * See docs/reorg-design.md.
   */
  reorg?: { finalityDepth: number };
}

export interface IndexerStats {
  eventsProcessed: number;
  eventsDecoded: number;
  eventsSkipped: number;
  blocksProcessed: number;
  lastBlock: number;
  /** Entity upserts (set) — a create or an overwrite. */
  entitiesWritten: number;
  /** Explicit partial updates. */
  entitiesUpdated: number;
  /** Entity deletes. */
  entitiesDeleted: number;
  /** Write count per entity table (set/update/delete). */
  writesByTable: Record<string, number>;
}

export interface Indexer<S extends SchemaDefinition = SchemaDefinition> {
  /** Register a handler for an event name. Use '*' for all events. */
  on(eventName: string, handler: EventHandler<S>): void;

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
  onBlock(handler: BlockHandler<S>): void;

  /**
   * Register a factory: when `eventName` fires, `extract` returns the address of a
   * newly-deployed child contract to start watching (or null/undefined to ignore).
   * The child is tracked, persisted (survives restart), and — when the source
   * supports it — added to the source's watch set so its logs are fetched. Register
   * handlers for the child's own events with `on()` as usual.
   */
  onFactory(eventName: string, extract: (event: ChainEvent) => string | null | undefined): void;

  /** Process a single decoded event through all matching handlers. */
  processEvent(event: ChainEvent): Promise<void>;

  /** Process a batch of events in order. */
  processEvents(events: ChainEvent[]): Promise<void>;


  /**
   * Backfill: query [fromBlock, toBlock] from the source and run all events
   * through handlers. Requires source to be set.
   */
  sync(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
    /** Known chain tip — written to opindex_meta so _meta.synced reflects real catch-up state. */
    knownTip?: number,
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
  readonly store: TypedStore<S>;

  /** Processing statistics. */
  readonly stats: IndexerStats;

  /** Reset stats counters (does NOT drop DB tables). */
  resetStats(): void;

  /**
   * Roll entity state for a chain back to the end of `blockNumber` and rewind the
   * checkpoint, using the reorg journal. Requires `reorg` to have been enabled.
   * Re-run sync()/subscribe() from `blockNumber + 1` to rebuild the canonical chain.
   */
  rollbackTo(blockNumber: number, chainId?: number): Promise<void>;

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
): Promise<Indexer<S>> {
  const log = config.logger ?? noopLogger;
  const store = await createStore(config.schema, config.sink, log);
  const registry = new HandlerRegistry();
  let stats: IndexerStats = {
    eventsProcessed: 0, eventsDecoded: 0, eventsSkipped: 0, blocksProcessed: 0, lastBlock: 0,
    entitiesWritten: 0, entitiesUpdated: 0, entitiesDeleted: 0, writesByTable: {},
  };

  // Count entity writes for stats / metrics via the store's change feed.
  store.onChange((e) => {
    stats.writesByTable[e.entity] = (stats.writesByTable[e.entity] ?? 0) + 1;
    if (e.operation === 'set') stats.entitiesWritten++;
    else if (e.operation === 'update') stats.entitiesUpdated++;
    else if (e.operation === 'delete') stats.entitiesDeleted++;
  });

  // The runtime store is the untyped EntityStore; the public API (handler
  // contexts, indexer.store) presents it as the schema-typed TypedStore<S>.
  const typedStore = store as unknown as TypedStore<S>;
  const multichain = config.schema.multichain;
  // Chain of the block currently being processed — stamped by dispatch(), read
  // by dispatchBlock() for per-chain block context + checkpoint (multichain).
  let currentChainId = 0;
  let currentBlockHash = '';
  const reorgEnabled = !!config.reorg;
  const finalityDepth = config.reorg?.finalityDepth ?? 0;
  if (reorgEnabled) store.enableReorg(finalityDepth);

  // --- Factory / dynamic source tracking ---
  const factoryIntType = config.sink.dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
  const trackedSources = new Set<string>();
  let hasFactory = false;
  let sourcesTableReady = false;
  let sourcesLoaded = false;

  async function ensureSourcesTable(): Promise<void> {
    if (sourcesTableReady) return;
    await config.sink.exec(
      `CREATE TABLE IF NOT EXISTS opindex_sources (chain_id ${factoryIntType} NOT NULL, address TEXT NOT NULL, from_block ${factoryIntType}, PRIMARY KEY (chain_id, address))`,
    );
    sourcesTableReady = true;
  }

  async function addDiscovered(chainId: number, address: string, fromBlock: number): Promise<void> {
    const addr = address.toLowerCase();
    const key = `${chainId}:${addr}`;
    if (trackedSources.has(key)) return;
    trackedSources.add(key);
    await ensureSourcesTable();
    if (config.sink.dialect === 'sqlite') {
      await config.sink.run(`INSERT OR IGNORE INTO opindex_sources (chain_id, address, from_block) VALUES (?, ?, ?)`, [chainId, addr, fromBlock]);
    } else {
      await config.sink.run(`INSERT INTO opindex_sources (chain_id, address, from_block) VALUES ($1, $2, $3) ON CONFLICT (chain_id, address) DO NOTHING`, [chainId, addr, fromBlock]);
    }
    if (config.source && isDynamicSource(config.source)) config.source.addAddress(addr);
    log.info('indexer', 'factory child discovered', { chain: chainId, address: addr, from_block: fromBlock });
  }

  async function loadSourcesOnce(): Promise<void> {
    if (!hasFactory || sourcesLoaded) return;
    await ensureSourcesTable();
    const rows = await config.sink.all<{ chain_id: number; address: string }>(`SELECT chain_id, address FROM opindex_sources`);
    for (const r of rows) {
      trackedSources.add(`${r.chain_id}:${r.address}`);
      if (config.source && isDynamicSource(config.source)) config.source.addAddress(r.address);
    }
    sourcesLoaded = true;
  }

  const scopedStore = (chainId: number): TypedStore<S> =>
    multichain ? (scopeStoreToChain(store, chainId) as unknown as TypedStore<S>) : typedStore;

  function makeContext(event: ChainEvent): HandlerContext<S> {
    return {
      store: scopedStore(event.chainId),
      block: event.blockNumber,
      blockTimestamp: event.blockTimestamp,
    };
  }

  function makeBlockContext(blockNumber: number, blockTimestamp: number | undefined): BlockContext<S> {
    return { blockNumber, blockTimestamp, store: scopedStore(currentChainId) };
  }

  async function dispatch(event: ChainEvent): Promise<void> {
    currentChainId = event.chainId;
    currentBlockHash = event.blockHash;
    if (reorgEnabled) store.setReorgContext(event.blockNumber, event.chainId);
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
    await registry.dispatch(event, makeContext(event) as HandlerContext);
    log.trace('handler', 'dispatched', {
      event:      event.eventName,
      block:      event.blockNumber,
      tx:         event.txHash,
      elapsed_ms: Date.now() - t0,
    });
  }

  /**
   * Commit a block ATOMICALLY (M10): every entity write for the block, the
   * onBlock handlers, the block-hash record and the checkpoint commit together
   * inside ONE transaction. A crash mid-block rolls the whole block back, so the
   * checkpoint never advances past partially-applied state — on restart the block
   * is simply re-fetched and re-applied (exactly-once). Returns elapsed_ms.
   */
  async function commitBlock(
    blockNumber: number,
    blockTimestamp: number | undefined,
    events: ChainEvent[],
    tipBlock?: number,
  ): Promise<number> {
    stats.blocksProcessed++;
    const t0 = Date.now();
    await config.sink.transaction(async () => {
      // Buffer every entity write for the block, then commit them as batched
      // multi-row upserts (M13) — all inside this one transaction, so atomicity
      // and exactly-once (M10) are unchanged. A thrown block rolls back here and
      // the next beginBatch() resets the buffer.
      store.beginBatch();
      for (const event of events) await dispatch(event);
      await registry.dispatchBlock(makeBlockContext(blockNumber, blockTimestamp) as BlockContext);
      await store.flushBatch();
      if (reorgEnabled && currentBlockHash) {
        await store.recordBlockHash(currentChainId, blockNumber, currentBlockHash);
      }
      await store.writeBlockCheckpoint(blockNumber, tipBlock, blockTimestamp, multichain ? currentChainId : undefined);
    });
    if (reorgEnabled && finalityDepth > 0 && blockNumber - finalityDepth > 0) {
      await store.pruneReorgData(currentChainId, blockNumber - finalityDepth);
    }
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
      registry.on(eventName, handler as EventHandler);
    },

    onBlock(handler) {
      registry.onBlock(handler as BlockHandler);
    },

    onFactory(eventName, extract) {
      hasFactory = true;
      void ensureSourcesTable();
      registry.on(eventName, (async (event: ChainEvent) => {
        const addr = extract(event);
        if (addr) await addDiscovered(event.chainId, addr, event.blockNumber);
      }) as EventHandler);
    },

    async processEvent(event) {
      await dispatch(event);
    },

    async processEvents(events) {
      let currentBlock = -1;
      let currentTimestamp: number | undefined;
      let buffer: ChainEvent[] = [];

      for (const event of events) {
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          const elapsedMs = await commitBlock(currentBlock, currentTimestamp, buffer);
          log.debug('indexer', 'block processed', {
            block: currentBlock, events_in_block: buffer.length, elapsed_ms: elapsedMs,
          });
          buffer = [];
        }
        currentBlock     = event.blockNumber;
        currentTimestamp = event.blockTimestamp;
        buffer.push(event);
      }

      if (currentBlock !== -1) {
        const elapsedMs = await commitBlock(currentBlock, currentTimestamp, buffer);
        log.debug('indexer', 'block processed', {
          block: currentBlock, events_in_block: buffer.length, elapsed_ms: elapsedMs,
        });
      }
    },

    async sync(fromBlock, toBlock, filters, knownTip) {
      const source = requireSource();
      await loadSourcesOnce();
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
      let buffer: ChainEvent[] = [];

      // Progress ticker — emit a log line every 5 seconds during long syncs.
      // This is the primary INFO heartbeat; skip the per-block / per-window lines
      // (they're DEBUG).
      let lastProgressAt = Date.now();
      let progressBlock  = fromBlock;
      let progressEvents = 0;

      for await (const event of source.queryStream(fromBlock, toBlock, filters)) {
        if (currentBlock !== -1 && event.blockNumber !== currentBlock) {
          const elapsedMs = await commitBlock(currentBlock, currentTimestamp, buffer, knownTip);
          log.debug('indexer', 'block processed', {
            block: currentBlock, events_in_block: buffer.length, elapsed_ms: elapsedMs,
          });
          buffer = [];

          const now = Date.now();
          if (now - lastProgressAt >= 5_000) {
            const elapsed   = (now - lastProgressAt) / 1_000;
            const blkDelta  = currentBlock - progressBlock;
            const behind    = knownTip != null ? knownTip - currentBlock : toBlock - currentBlock;
            const eta       = blkDelta > 0 ? Math.round(behind / (blkDelta / elapsed)) : null;
            log.info('indexer', 'progress', {
              block:          currentBlock,
              tip:            knownTip ?? toBlock,
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
        buffer.push(event);
        progressEvents++;
      }

      if (currentBlock !== -1) {
        const elapsedMs = await commitBlock(currentBlock, currentTimestamp, buffer, knownTip);
        log.debug('indexer', 'block processed', {
          block: currentBlock, events_in_block: buffer.length, elapsed_ms: elapsedMs,
        });
      }

      // Advance checkpoint to the scan boundary even when the last N blocks had
      // no matching events — ensures _meta.block.number means "scanned up to here".
      if (currentBlock !== toBlock) {
        await config.sink.transaction(async () => {
          await store.writeBlockCheckpoint(toBlock, knownTip, currentTimestamp, multichain ? currentChainId : undefined);
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
      void loadSourcesOnce();
      // Track block transitions so onBlock handlers fire after each block's events.
      // The last block in a poll batch fires when the next batch brings a new block number.
      let lastBlock     = -1;
      let lastTimestamp: number | undefined;
      let liveBuffer: ChainEvent[] = [];
      log.info('indexer', 'subscribe start', { from_block: fromBlock });

      return source.subscribe(
        fromBlock,
        async (event) => {
          if (lastBlock !== -1 && event.blockNumber !== lastBlock) {
            // In live mode, the block we just finished IS effectively our tip — no backlog.
            // Passing lastBlock as tipBlock keeps blocksBehind=0 and synced=true.
            // The just-finished block IS our frontier (one-behind the tip arriving
            // now); committing it atomically here means the tip block stays
            // uncommitted until the next block confirms — safer for reorgs.
            const elapsedMs = await commitBlock(lastBlock, lastTimestamp, liveBuffer, lastBlock);
            log.info('indexer', 'live block', {
              block: lastBlock, events_in_block: liveBuffer.length, elapsed_ms: elapsedMs,
            });
            liveBuffer = [];
          }

          // Fork detection: a new block whose parentHash disagrees with the hash
          // we stored for block-1 means our recent chain is orphaned. Roll back a
          // finality window and re-index the canonical blocks before this one.
          if (reorgEnabled && event.parentHash && event.blockNumber !== lastBlock) {
            const prevStored = await store.getBlockHash(event.chainId, event.blockNumber - 1);
            if (prevStored !== undefined && prevStored !== event.parentHash) {
              const safe = Math.max(fromBlock - 1, event.blockNumber - 1 - finalityDepth);
              log.info('indexer', 'reorg detected', {
                chain: event.chainId, block: event.blockNumber, rollback_to: safe,
                expected_parent: prevStored, got_parent: event.parentHash,
              });
              await store.rollbackToBlock(safe, event.chainId);
              await store.writeBlockCheckpoint(safe, undefined, undefined, multichain ? event.chainId : undefined);
              let cb = -1; let ct: number | undefined; let rbuf: ChainEvent[] = [];
              for await (const e of source.queryStream(safe + 1, event.blockNumber - 1, options?.filters)) {
                if (cb !== -1 && e.blockNumber !== cb) { await commitBlock(cb, ct, rbuf, cb); rbuf = []; }
                cb = e.blockNumber; ct = e.blockTimestamp; rbuf.push(e);
              }
              if (cb !== -1) await commitBlock(cb, ct, rbuf, cb);
            }
          }

          lastBlock     = event.blockNumber;
          lastTimestamp = event.blockTimestamp;
          liveBuffer.push(event);
        },
        { pollIntervalMs: options?.pollIntervalMs },
      );
    },

    async rollbackTo(blockNumber, chainId = 0) {
      await store.rollbackToBlock(blockNumber, chainId);
      await store.writeBlockCheckpoint(blockNumber, undefined, undefined, multichain ? chainId : undefined);
    },

    get store() {
      return typedStore;
    },

    get stats() {
      return { ...stats };
    },

    resetStats() {
      stats = {
        eventsProcessed: 0, eventsDecoded: 0, eventsSkipped: 0, blocksProcessed: 0, lastBlock: 0,
        entitiesWritten: 0, entitiesUpdated: 0, entitiesDeleted: 0, writesByTable: {},
      };
    },

    async serve(options) {
      const gqlSchema = buildGraphQLSchema(config.schema, store, {
        subscriptions: options?.subscriptions,
        maxPageSize: options?.maxPageSize,
      });
      // Default /health + /metrics expose the live indexer stats.
      const serveOptions = { ...options, status: options?.status ?? ((): Record<string, unknown> => ({ ...stats })) };
      const { server, url } = startGraphQLServer(gqlSchema, serveOptions);
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
