/**
 * createMultiIndexer — index several chains into ONE shared store + schema.
 *
 * Each source gets its own indexer bound to the shared sink (shared tables), so
 * writes from every chain land in the same entities but are isolated by the
 * `chainId` dimension (see `scopeStoreToChain`) and resumed from per-chain
 * checkpoints. This matches the Envio/Ponder "each chain independent" model
 * rather than one merged cross-chain stream — no chain waits on another.
 *
 *   const schema = defineSchema({ TokenHolder: {...} }, { multichain: true });
 *   const mi = await createMultiIndexer({ schema, sink, sources: [
 *     { source: ethSource,  chainId: 1,    fromBlock: 0, toBlock: ethTip },
 *     { source: baseSource, chainId: 8453, fromBlock: 0, toBlock: baseTip },
 *   ]});
 *   mi.on('Transfer', handler);
 *   await mi.syncAll();
 *   await mi.serve({ port: 4000 });   // one GraphQL API, filter by chainId
 */

import type { Schema, SchemaDefinition } from './schema.js';
import type { MinimalDbAdapter } from './adapter.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from './source.js';
import type { EventHandler, BlockHandler } from './handler.js';
import type { TypedStore } from './store.js';
import type { IndexerLogger } from './logger.js';
import { createIndexer, type Indexer, type IndexerStats, type ServeOptions, type ServeHandle } from './indexer.js';

export interface MultiSource {
  /** The chain's event source (already configured with its chainId). */
  source: EventSource;
  /** EIP-155 chain id — used for per-chain checkpoints and logging. */
  chainId: number;
  /** Backfill start block for this chain. */
  fromBlock: number;
  /** Backfill end block for this chain (required for syncAll). */
  toBlock?: number;
  /** Optional per-source event filter. */
  filters?: EventSourceFilters;
  /**
   * Optional dedicated DB connection for this chain. Provide one per source
   * (e.g. separate connections from a Postgres pool to the SAME database) to let
   * `syncAll()` backfill chains **in parallel** — a single shared connection
   * can't run concurrent transactions, so without this they run sequentially.
   */
  sink?: MinimalDbAdapter;
}

export interface MultiIndexerConfig<S extends SchemaDefinition = SchemaDefinition> {
  /** Must be a multichain schema: defineSchema(def, { multichain: true }). */
  schema: Schema<S>;
  sink: MinimalDbAdapter;
  sources: MultiSource[];
  logger?: IndexerLogger;
}

export interface MultiIndexer<S extends SchemaDefinition = SchemaDefinition> {
  /** Register an event handler on every chain's indexer. */
  on(eventName: string, handler: EventHandler<S>): void;
  /** Register a block handler on every chain's indexer. */
  onBlock(handler: BlockHandler<S>): void;
  /** The shared, chain-aware store (query across chains; filter by chainId). */
  readonly store: TypedStore<S>;
  /** Backfill every source over its [fromBlock, toBlock], in parallel. */
  syncAll(): Promise<IndexerStats[]>;
  /** Go live on every source. Returns one unsubscribe that stops them all. */
  subscribeAll(options?: { pollIntervalMs?: number }): UnsubscribeFn;
  /** Serve one GraphQL API over the shared store. */
  serve(options?: ServeOptions): Promise<ServeHandle>;
  /** The underlying per-chain indexers, if you need direct access. */
  readonly indexers: ReadonlyArray<{ chainId: number; indexer: Indexer<S> }>;
}

export async function createMultiIndexer<S extends SchemaDefinition>(
  config: MultiIndexerConfig<S>,
): Promise<MultiIndexer<S>> {
  if (!config.schema.multichain) {
    throw new Error(
      '[counter-index] createMultiIndexer requires a multichain schema — pass { multichain: true } to defineSchema().',
    );
  }

  const entries: Array<{ chainId: number; indexer: Indexer<S>; spec: MultiSource }> = [];
  for (const spec of config.sources) {
    const indexer = await createIndexer({
      schema: config.schema, sink: spec.sink ?? config.sink, source: spec.source, logger: config.logger,
    });
    entries.push({ chainId: spec.chainId, indexer, spec });
  }
  // Parallel backfill is safe only when every chain has its OWN connection —
  // otherwise concurrent transactions would collide on the shared connection.
  const canParallelize = config.sources.length > 1 && config.sources.every((s) => s.sink !== undefined);

  const first = entries[0];
  if (!first) throw new Error('[counter-index] createMultiIndexer needs at least one source.');

  return {
    on(eventName, handler) {
      for (const e of entries) e.indexer.on(eventName, handler);
    },
    onBlock(handler) {
      for (const e of entries) e.indexer.onBlock(handler);
    },
    get store() {
      return first.indexer.store;    // shared physical tables
    },
    get indexers() {
      return entries.map((e) => ({ chainId: e.chainId, indexer: e.indexer }));
    },
    async syncAll() {
      const one = ({ indexer, spec }: typeof entries[number]): Promise<IndexerStats> => {
        const to = spec.toBlock ?? spec.fromBlock;
        return indexer.sync(spec.fromBlock, to, spec.filters, to);
      };
      if (canParallelize) {
        // Each chain has its own connection → backfill all chains concurrently.
        return Promise.all(entries.map(one));
      }
      // Shared connection: a SQLite connection can't run two transactions at
      // once, so run sequentially. Give each source its own `sink` to parallelize.
      const results: IndexerStats[] = [];
      for (const e of entries) results.push(await one(e));
      return results;
    },
    subscribeAll(options) {
      const unsubs = entries.map(({ indexer, spec }) =>
        indexer.subscribe(spec.fromBlock, { pollIntervalMs: options?.pollIntervalMs, filters: spec.filters }));
      return () => { for (const u of unsubs) u(); };
    },
    serve(options) {
      return first.indexer.serve(options);
    },
  };
}
