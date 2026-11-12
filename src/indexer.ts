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
import { createStore, scopeStoreToChain, DeepReorgError } from './store.js';
import type { MinimalDbAdapter } from './adapter.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import { isDynamicSource } from './source.js';
import { HandlerRegistry, type EventHandler, type BlockHandler, type HandlerContext, type BlockContext } from './handler.js';
import type { ChainEvent } from './types.js';
import { buildGraphQLSchema, startGraphQLServer, startSubscriptionServer, type ServeOptions, type ServeHandle } from './graphql.js';
import { buildReadPath } from './serving.js';
import { noopLogger, type IndexerLogger } from './logger.js';
import {
  Lifecycle, Histogram, noopTracer,
  type LifecycleOptions, type HealthReport, type Tracer,
} from './lifecycle.js';

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
  /** Health-state machine tuning (stall/live thresholds, injectable clock). */
  lifecycle?: LifecycleOptions;
  /** OpenTelemetry-shaped tracer hook (default: no-op). Emits a span per block. */
  tracer?: Tracer;
  /**
   * Log a WARN when a single handler invocation exceeds this many ms — precise
   * slow-handler attribution by event name (#34). Off by default.
   */
  slowHandlerMs?: number;
  /**
   * Observe handler errors (log/alert) WITHOUT changing control flow — the error
   * still propagates and rolls the block back. Fires once per failed dispatch.
   */
  onError?: (err: unknown, event: ChainEvent) => void;
  /**
   * Called when a reorg is detected that is deeper than `finalityDepth` (the
   * journal for those blocks was already pruned, so a correct rollback is
   * impossible). The indexer halts the live subscription and marks itself
   * errored; this hook lets you page an operator. Default: just log + halt.
   */
  onDeepReorg?: (err: DeepReorgError) => void;
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
  /** Reorgs detected + rolled back. */
  reorgs: number;
  /** Handler errors observed (each rolls its block back). */
  errors: number;
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
   * Register a BEFORE-block middleware: fires once per block, before any of its
   * event handlers, inside the block transaction (e.g. to seed per-block state or
   * open a span). Symmetric with onBlock (which fires after).
   */
  beforeBlock(handler: BlockHandler<S>): void;

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
   * Per-event-name handler latency — precise perf attribution (#34). Returns
   * `{ [eventName]: { calls, avgMs, sumMs } }` so you can see which handler is
   * your bottleneck. Also surfaced on `/metrics`.
   */
  handlerStats(): Record<string, { calls: number; avgMs: number; sumMs: number }>;

  /**
   * Current operational health: state (`starting | backfilling | live |
   * degraded | stalled | draining | stopped`), uptime, per-chain lag, and the
   * reorg/error/retry counters. This is what `/health` and `/metrics` report.
   */
  health(): HealthReport;

  /**
   * Graceful shutdown: stop the live subscription, let the in-flight block
   * finish committing (block commits are atomic — M10), close the HTTP server
   * and the sink DB, then run any `onShutdown` hooks. Idempotent.
   */
  shutdown(): Promise<void>;

  /** Register a cleanup hook run during shutdown (after the DB is closed). */
  onShutdown(hook: () => void | Promise<void>): void;

  /**
   * Install SIGTERM/SIGINT handlers that call shutdown() once. Returns a
   * function that removes them. Call from your entrypoint, not from a library.
   */
  installSignalHandlers(signals?: NodeJS.Signals[]): () => void;

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
  const freshStats = (): IndexerStats => ({
    eventsProcessed: 0, eventsDecoded: 0, eventsSkipped: 0, blocksProcessed: 0, lastBlock: 0,
    entitiesWritten: 0, entitiesUpdated: 0, entitiesDeleted: 0, writesByTable: {},
    reorgs: 0, errors: 0,
  });
  let stats: IndexerStats = freshStats();

  // Operability (M18): health-state machine, handler-latency histogram, tracer.
  const lifecycle = new Lifecycle(config.lifecycle);
  const handlerLatency = new Histogram();
  // Per-event-name latency (named-handler perf attribution, #34).
  const handlerLatencyByName = new Map<string, Histogram>();
  const perHandler = (name: string): Histogram => {
    let h = handlerLatencyByName.get(name);
    if (!h) { h = new Histogram(); handlerLatencyByName.set(name, h); }
    return h;
  };
  const slowHandlerMs = config.slowHandlerMs ?? 0;
  const computeHandlerStats = (): Record<string, { calls: number; avgMs: number; sumMs: number }> => {
    const out: Record<string, { calls: number; avgMs: number; sumMs: number }> = {};
    for (const [name, h] of handlerLatencyByName) {
      const s = h.snapshot();
      out[name] = { calls: s.count, sumMs: s.sum, avgMs: s.count > 0 ? s.sum / s.count : 0 };
    }
    return out;
  };
  const tracer = config.tracer ?? noopTracer;
  const shutdownHooks: Array<() => void | Promise<void>> = [];
  let liveUnsub: UnsubscribeFn | undefined;   // set while subscribed
  let serveHandle: ServeHandle | undefined;   // set while serving
  let inFlightBlock: Promise<unknown> = Promise.resolve();   // the current commitBlock
  let shuttingDown = false;
  let halted = false;   // set on an unrecoverable deep reorg — stops processing

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
    // Per-handler timing feeds the latency histogram (and TRACE logs).
    const t0 = Date.now();
    try {
      await registry.dispatch(event, makeContext(event) as HandlerContext);
    } catch (err) {
      stats.errors++;
      lifecycle.recordError();
      config.onError?.(err, event);   // observe (log/alert) — does not swallow
      throw err;                      // propagate — the block transaction must roll back (M10)
    }
    const dt = Date.now() - t0;
    handlerLatency.observe(dt);
    perHandler(event.eventName).observe(dt);
    if (slowHandlerMs > 0 && dt > slowHandlerMs) {
      log.warn('handler', 'slow handler', { event: event.eventName, block: event.blockNumber, tx: event.txHash, elapsed_ms: dt });
    }
    log.trace('handler', 'dispatched', {
      event:      event.eventName,
      block:      event.blockNumber,
      tx:         event.txHash,
      elapsed_ms: dt,
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
    const span = tracer.startSpan('op-index.block', { block: blockNumber, events: events.length });
    // Expose the in-flight commit so shutdown() can await a clean block boundary.
    const commit = config.sink.transaction(async () => {
      // Buffer every entity write for the block, then commit them as batched
      // multi-row upserts (M13) — all inside this one transaction, so atomicity
      // and exactly-once (M10) are unchanged. A thrown block rolls back here and
      // the next beginBatch() resets the buffer.
      store.beginBatch();
      await registry.dispatchBlockStart(makeBlockContext(blockNumber, blockTimestamp) as BlockContext);
      for (const event of events) await dispatch(event);
      await registry.dispatchBlock(makeBlockContext(blockNumber, blockTimestamp) as BlockContext);
      await store.flushBatch();
      if (reorgEnabled && currentBlockHash) {
        await store.recordBlockHash(currentChainId, blockNumber, currentBlockHash);
      }
      await store.writeBlockCheckpoint(blockNumber, tipBlock, blockTimestamp, multichain ? currentChainId : undefined);
    });
    inFlightBlock = commit;
    try {
      await commit;
    } finally {
      span.end();
    }
    lifecycle.recordBlock(currentChainId, blockNumber, tipBlock);
    // Retain one block MORE than finalityDepth: a reorg rolls back to
    // `tip - finalityDepth`, and the boundary-continuity guard (M11) needs that
    // block's hash still present to tell a deep reorg from a shallow one.
    if (reorgEnabled && finalityDepth > 0 && blockNumber - finalityDepth - 1 > 0) {
      await store.pruneReorgData(currentChainId, blockNumber - finalityDepth - 1);
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

  async function doShutdown(): Promise<void> {
    if (shuttingDown) { await inFlightBlock.catch(() => {}); return; }
    shuttingDown = true;
    lifecycle.draining();
    log.info('indexer', 'shutdown: draining', {});
    // 1. Stop pulling new blocks.
    try { liveUnsub?.(); } catch { /* unsub best-effort */ }
    liveUnsub = undefined;
    // 2. Let the in-flight block finish committing (commits are atomic — M10).
    await inFlightBlock.catch(() => { /* a failed block already rolled back */ });
    // 3. Close the HTTP server, then the sink DB.
    try { await serveHandle?.stop(); } catch (err) { log.warn('indexer', 'shutdown: server close failed', { err: String(err) }); }
    serveHandle = undefined;
    const closable = config.sink as unknown as { end?: () => Promise<void>; close?: () => void | Promise<void> };
    try { await closable.end?.(); await closable.close?.(); } catch (err) { log.warn('indexer', 'shutdown: db close failed', { err: String(err) }); }
    // 4. User cleanup hooks.
    for (const hook of shutdownHooks) {
      try { await hook(); } catch (err) { log.warn('indexer', 'shutdown: hook failed', { err: String(err) }); }
    }
    lifecycle.stopped();
    log.info('indexer', 'shutdown: stopped', {});
  }

  return {
    on(eventName, handler) {
      registry.on(eventName, handler as EventHandler);
    },

    onBlock(handler) {
      registry.onBlock(handler as BlockHandler);
    },

    beforeBlock(handler) {
      registry.beforeBlock(handler as BlockHandler);
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
      lifecycle.start();
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
      lifecycle.start();
      // Track block transitions so onBlock handlers fire after each block's events.
      // The last block in a poll batch fires when the next batch brings a new block number.
      let lastBlock     = -1;
      let lastTimestamp: number | undefined;
      let liveBuffer: ChainEvent[] = [];
      log.info('indexer', 'subscribe start', { from_block: fromBlock });

      liveUnsub = source.subscribe(
        fromBlock,
        async (event) => {
          if (halted) return;   // an unrecoverable deep reorg stopped processing
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
              stats.reorgs++;
              lifecycle.recordReorg();
              try {
                await store.rollbackToBlock(safe, event.chainId);   // rewinds the checkpoint atomically (M11)
              } catch (err) {
                if (err instanceof DeepReorgError) {
                  // Deeper than finalityDepth — we can't roll back correctly. Halt
                  // loudly instead of silently diverging; the operator must act.
                  log.error('indexer', 'deep reorg beyond finalityDepth — halting', {
                    chain: event.chainId, block: event.blockNumber, retained_floor: err.retainedFloor,
                  });
                  stats.errors++;
                  lifecycle.recordError();
                  halted = true;
                  liveUnsub?.();
                  config.onDeepReorg?.(err);
                  return;
                }
                throw err;
              }
              // Boundary-continuity guard (M11): we rolled back only to `safe`
              // (clamped to finalityDepth). If the canonical chain's first block
              // after `safe` does NOT build on our retained `safe` hash, the true
              // fork is OLDER than finalityDepth — re-indexing from here would
              // silently diverge. Detect it and halt loudly.
              const safeHash = await store.getBlockHash(event.chainId, safe);
              let boundaryChecked = false;
              let cb = -1; let ct: number | undefined; let rbuf: ChainEvent[] = [];
              for await (const e of source.queryStream(safe + 1, event.blockNumber - 1, options?.filters)) {
                if (!boundaryChecked && e.blockNumber === safe + 1 && e.parentHash && safeHash && e.parentHash !== safeHash) {
                  log.error('indexer', 'deep reorg beyond finalityDepth — halting', {
                    chain: event.chainId, block: event.blockNumber, fork_before: safe,
                  });
                  stats.errors++; lifecycle.recordError();
                  halted = true; liveUnsub?.();
                  config.onDeepReorg?.(new DeepReorgError(safe, safe + 1, event.chainId));
                  return;
                }
                boundaryChecked = true;
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
      return liveUnsub;
    },

    async rollbackTo(blockNumber, chainId = 0) {
      stats.reorgs++;
      lifecycle.recordReorg();
      await store.rollbackToBlock(blockNumber, chainId);   // atomic: rewinds checkpoint too (M11)
    },

    get store() {
      return typedStore;
    },

    get stats() {
      return { ...stats };
    },

    resetStats() {
      stats = freshStats();
      handlerLatency.reset();
      handlerLatencyByName.clear();
    },

    handlerStats() {
      return computeHandlerStats();
    },

    health() {
      return lifecycle.health();
    },

    onShutdown(hook) {
      shutdownHooks.push(hook);
    },

    shutdown() {
      return doShutdown();
    },

    installSignalHandlers(signals = ['SIGTERM', 'SIGINT']) {
      const handlers = signals.map((sig) => {
        const h = (): void => {
          log.info('indexer', 'signal received', { signal: sig });
          void doShutdown().then(() => process.exit(0));
        };
        process.on(sig, h);
        return [sig, h] as const;
      });
      return () => { for (const [sig, h] of handlers) process.off(sig, h); };
    },

    async serve(options) {
      const gqlSchema = buildGraphQLSchema(config.schema, store, {
        subscriptions: options?.subscriptions,
        maxPageSize: options?.maxPageSize,
      });
      // Default /health + /metrics expose live stats + the health-state machine
      // + the handler-latency histogram. A caller can override `status` entirely.
      const defaultStatus = (): Record<string, unknown> => ({
        ...stats,
        health: lifecycle.health(),
        handlerLatencyMs: handlerLatency.snapshot(),
        handlersByEvent: computeHandlerStats(),
      });
      const serveOptions = { ...options, status: options?.status ?? defaultStatus };
      // Serving-scale read path (opidx-#57): REST / SQL-over-HTTP / SSE, built on
      // the same store.query pushdown. Inherits the GraphQL endpoint's auth token
      // and page cap unless the readPath config overrides them.
      const readRouter = options?.readPath
        ? buildReadPath(config.schema, store, {
            maxPageSize: options.maxPageSize,
            auth: options.auth,
            ...options.readPath,
          })
        : undefined;
      const { server, url } = startGraphQLServer(gqlSchema, serveOptions, readRouter);
      if (options?.subscriptions) {
        await startSubscriptionServer(gqlSchema, server);
      }
      const handle: ServeHandle = {
        url,
        stop: () => new Promise((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
      };
      serveHandle = handle;
      return handle;
    },
  };
}
