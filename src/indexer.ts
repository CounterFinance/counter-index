/**
 * Indexer — the main orchestrator.
 *
 * Wire up a schema, register event handlers, then feed events in.
 * The indexer decodes raw events, dispatches to handlers, and maintains
 * the entity store.
 *
 * Usage:
 *   const indexer = createIndexer({ schema });
 *   indexer.on('Transferred', (event, ctx) => { ... });
 *
 *   // Feed events (from OpStream, RPC, or any source)
 *   indexer.processEvent(event);
 *   indexer.processEvents(events);
 *
 *   // Query indexed data
 *   const accounts = indexer.store.list('Account');
 */

import type { Schema, SchemaDefinition } from './schema.js';
import type { EntityStore } from './store.js';
import { createStore } from './store.js';
import { HandlerRegistry, type EventHandler, type HandlerContext } from './handler.js';
import { decodeEvent } from './decoders/eventDecoders.js';
import type { DecodedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface IndexerConfig<S extends SchemaDefinition = SchemaDefinition> {
  schema: Schema<S>;
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
  processEvent(event: DecodedEvent): void;

  /** Process a batch of events in order. */
  processEvents(events: DecodedEvent[]): void;

  /**
   * Process a raw event: decode it first, then dispatch.
   * Useful when you have raw event bytes and a name but haven't decoded yet.
   */
  processRawEvent(
    eventName: string,
    rawData: Buffer | Uint8Array,
    meta: { blockNumber: number; txHash: string; contractAddress: string },
  ): void;

  /** The entity store. Query indexed data here. */
  readonly store: EntityStore;

  /** Processing statistics. */
  readonly stats: IndexerStats;

  /** Reset the store and stats. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createIndexer<S extends SchemaDefinition>(
  config: IndexerConfig<S>,
): Indexer {
  let store = createStore(config.schema);
  const registry = new HandlerRegistry();
  let stats: IndexerStats = {
    eventsProcessed: 0,
    eventsDecoded: 0,
    eventsSkipped: 0,
    lastBlock: 0,
  };

  function makeContext(block: number): HandlerContext {
    return { store, block };
  }

  function dispatch(event: DecodedEvent): void {
    stats.eventsProcessed++;
    if (event.blockNumber > stats.lastBlock) {
      stats.lastBlock = event.blockNumber;
    }

    if (event.decoded) {
      stats.eventsDecoded++;
    } else {
      stats.eventsSkipped++;
    }

    registry.dispatch(event, makeContext(event.blockNumber));
  }

  return {
    on(eventName, handler) {
      registry.on(eventName, handler);
    },

    processEvent(event) {
      dispatch(event);
    },

    processEvents(events) {
      for (const event of events) {
        dispatch(event);
      }
    },

    processRawEvent(eventName, rawData, meta) {
      const decoded = decodeEvent(eventName, rawData);
      const event: DecodedEvent = {
        blockNumber: meta.blockNumber,
        txHash: meta.txHash,
        contractAddress: meta.contractAddress,
        eventName,
        eventRaw: rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData),
        decoded,
        dataLength: rawData.length,
      };
      dispatch(event);
    },

    get store() {
      return store;
    },

    get stats() {
      return { ...stats };
    },

    reset() {
      store = createStore(config.schema);
      stats = {
        eventsProcessed: 0,
        eventsDecoded: 0,
        eventsSkipped: 0,
        lastBlock: 0,
      };
    },
  };
}
