/**
 * @opnet-collective/op-index — Indexer framework for OPNET.
 *
 * Define a schema. Register event handlers. Feed chain data via sync() or subscribe().
 * Query your indexed entities from the DB op-index manages.
 */

// --- Core framework --------------------------------------------------------

export { defineSchema, type Schema, type SchemaDefinition, type EntityDef, type FieldDef, type FieldType } from './schema.js';
export { type EntityStore, type StoreChangeEvent } from './store.js';
export { HandlerRegistry, type HandlerContext, type EventHandler, type BlockContext, type BlockHandler } from './handler.js';
export { createIndexer, type Indexer, type IndexerConfig, type IndexerStats, type ServeOptions, type ServeHandle } from './indexer.js';
export { type IndexerLogger } from './logger.js';

// --- DB adapter ------------------------------------------------------------

export {
  type MinimalDbAdapter,
  SqliteAdapter,
  openSqlite,
  createTestAdapter,
  PostgresAdapter,
  openPostgres,
} from './adapter.js';

// --- Event source ----------------------------------------------------------

export {
  DbEventSource,
  type EventSource,
  type EventSourceFilters,
  type UnsubscribeFn,
} from './source.js';

export {
  RpcEventSource,
  type BlockProvider,
  type BlockLike,
  type TransactionLike,
  type RpcEventSourceOptions,
} from './rpcSource.js';

export {
  WsEventSource,
  type WsEventSourceOptions,
} from './wsSource.js';

export {
  OpStreamRpcEventSource,
  type OpStreamRpcEventSourceOptions,
} from './opStreamRpcSource.js';

export {
  createEventSource,
  probeOpStreamSchema,
  type EventSourceInput,
  type CreateEventSourceOptions,
} from './eventSourceFactory.js';

// --- Types -----------------------------------------------------------------

export type { DecodedEvent } from './types.js';

// --- Event decoders --------------------------------------------------------

export {
  decodeEvent, registerDecoder, DECODER_REGISTRY,
  type EventDecoder,
} from './decoders/eventDecoders.js';

// --- Contract standard detection -------------------------------------------

export {
  OP20_EVENT_NAMES, OP721_EVENT_NAMES,
  isOP20Contract, isOP721Contract, classifyContract,
  type OP20EventName, type OP721EventName,
} from './standards.js';

// --- Native token constants ------------------------------------------------

export {
  OPNET_NATIVE_TOKENS, getNativeToken, isNativeToken,
  type TokenMetadata,
} from './tokens.js';

// --- Address utilities -----------------------------------------------------

export {
  pubkeyHexToP2op, isP2opAddress, normaliseFromAddress,
} from './p2op.js';

