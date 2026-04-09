/**
 * @opnet-devs/opkit — Indexer framework for OPNET.
 *
 * Define a schema. Register event handlers. Feed chain data.
 * Query your indexed entities.
 */

// --- Core framework --------------------------------------------------------

export { defineSchema, type Schema, type SchemaDefinition, type EntityDef, type FieldDef, type FieldType } from './schema.js';
export { createStore, type EntityStore } from './store.js';
export { HandlerRegistry, type HandlerContext, type EventHandler } from './handler.js';
export { createIndexer, type Indexer, type IndexerConfig, type IndexerStats } from './indexer.js';

// --- Types -----------------------------------------------------------------

export type { DecodedEvent } from './types.js';

// --- Event decoders --------------------------------------------------------

export {
  decodeEvent, registerDecoder, DECODER_REGISTRY,
  type EventDecoder,
} from './decoders/eventDecoders.js';
