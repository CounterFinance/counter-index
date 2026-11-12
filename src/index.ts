/**
 * @opnet-collective/op-index — chain-neutral indexer framework.
 *
 * Define a schema. Register event handlers. Feed chain data from a source
 * adapter via sync() or subscribe(). Query your indexed entities over an
 * auto-generated GraphQL API. The core is chain-neutral; each chain ships as an
 * adapter under `./chains/<chain>`. OPNET is the first adapter.
 */

// --- Core framework (chain-neutral) ----------------------------------------

export { defineSchema, type Schema, type SchemaDefinition, type EntityDef, type FieldDef, type FieldType, type DefineSchemaOptions } from './schema.js';
export { type EntityStore, type StoreChangeEvent, type TypedStore, type RowOf, type StoredRow } from './store.js';
export { HandlerRegistry, type HandlerContext, type EventHandler, type BlockContext, type BlockHandler } from './handler.js';
export { createIndexer, type Indexer, type IndexerConfig, type IndexerStats, type ServeOptions, type ServeHandle } from './indexer.js';
export { createMultiIndexer, type MultiIndexer, type MultiIndexerConfig, type MultiSource } from './multiIndexer.js';
export { type IndexerLogger, createLogger, noopLogger, type LoggerOptions, type LogLevel } from './logger.js';

// --- Operability (health, metrics, tracing, retry) — M18 -------------------

export {
  Lifecycle, Histogram, noopTracer, jsonTracer, withRetry,
  type HealthState, type HealthReport, type ChainHealth, type LifecycleOptions,
  type Tracer, type Span, type RetryOptions,
} from './lifecycle.js';

// --- DB adapter ------------------------------------------------------------

export {
  type MinimalDbAdapter,
  SqliteAdapter,
  openSqlite,
  createTestAdapter,
  PostgresAdapter,
  openPostgres,
} from './adapter.js';

// --- Event source interface (implementations live in chain adapters) -------

export {
  type EventSource,
  type EventSourceFilters,
  type UnsubscribeFn,
  type DynamicSource,
  isDynamicSource,
} from './source.js';

// --- Core types ------------------------------------------------------------

export type {
  ChainEvent,
  ChainMeta,
} from './types.js';

export type { Decoder, DecodeInput, DecodeResult } from './decoder.js';

// --- EVM adapter (optional; requires peer dep `viem`) ----------------------
export {
  EvmAbiDecoder,
  EvmLogSource,
  type EvmLogSourceOptions,
  type EvmChainMeta,
} from './chains/evm/index.js';

// --- OPNET adapter ---------------------------------------------------------
// Re-exported at the top level for convenience; the canonical path is
// '@opnet-collective/op-index/chains/opnet'.

export {
  DbEventSource,
  RpcEventSource,
  type BlockProvider,
  type BlockLike,
  type TransactionLike,
  type RpcEventSourceOptions,
  WsEventSource,
  type WsEventSourceOptions,
  OpStreamRpcEventSource,
  type OpStreamRpcEventSourceOptions,
  createEventSource,
  probeOpStreamSchema,
  type EventSourceInput,
  type CreateEventSourceOptions,
  decodeEvent, registerDecoder, DECODER_REGISTRY,
  type EventDecoder,
  OpnetDecoder, opnetDecoder,
  OP20_EVENT_NAMES, OP721_EVENT_NAMES,
  isOP20Contract, isOP721Contract, classifyContract,
  type OP20EventName, type OP721EventName,
  OPNET_NATIVE_TOKENS, getNativeToken, isNativeToken,
  type TokenMetadata,
  pubkeyHexToP2op, isP2opAddress, normaliseFromAddress,
  OPNET_CHAIN_ID, OPNET_NETWORK,
  type OpnetChainMeta,
} from './chains/opnet/index.js';
