/**
 * Event handler registration and dispatch.
 *
 * Handlers are functions that receive a decoded on-chain event and a context
 * object with access to the entity store. This is where indexing logic lives:
 *
 *   indexer.on('Transferred', (event, ctx) => {
 *     ctx.store.set('Transfer', event.txHash, {
 *       from: event.decoded.from,
 *       to: event.decoded.to,
 *       value: BigInt(event.decoded.value),
 *     });
 *   });
 */

import type { EntityStore } from './store.js';
import type { ChainEvent } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context passed to every event handler. */
export interface HandlerContext {
  /** The entity store — read and write indexed data here. */
  store: EntityStore;
  /** Block number of the current event. */
  block: number;
  /** Unix timestamp of the block. Undefined when source doesn't provide it. */
  blockTimestamp: number | undefined;
}

/** An event handler function. May be async. */
export type EventHandler = (event: ChainEvent, context: HandlerContext) => Promise<void> | void;

/**
 * Context passed to every block handler.
 * Fires once per block, after all event handlers for that block have run.
 */
export interface BlockContext {
  /** The block number that just finished processing. */
  blockNumber: number;
  /** Unix timestamp of the block. Undefined when source doesn't provide it. */
  blockTimestamp: number | undefined;
  /** The entity store — read and write indexed data here. */
  store: EntityStore;
}

/**
 * A block handler function. Fires once per block after all events in that
 * block have been dispatched to event handlers.
 *
 * Useful for:
 *   - OHLCV candle closes: "commit the candle for block N"
 *   - Reserve snapshots: "snapshot pool state at end of block N"
 *   - Block-level aggregates: "update rolling stats every block"
 *
 * Note: only fires for blocks that contain at least one indexed event.
 * Blocks with zero events are not observed by the block handler.
 */
export type BlockHandler = (context: BlockContext) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export class HandlerRegistry {
  private handlers = new Map<string, EventHandler[]>();
  private wildcardHandlers: EventHandler[] = [];
  private blockHandlers: BlockHandler[] = [];

  /**
   * Register a handler for a specific event name.
   * Pass '*' to handle all events.
   */
  on(eventName: string, handler: EventHandler): void {
    if (eventName === '*') {
      this.wildcardHandlers.push(handler);
      return;
    }
    const list = this.handlers.get(eventName);
    if (list) {
      list.push(handler);
    } else {
      this.handlers.set(eventName, [handler]);
    }
  }

  /** Register a block handler. Fires once per block after all its events are dispatched. */
  onBlock(handler: BlockHandler): void {
    this.blockHandlers.push(handler);
  }

  /** Dispatch an event to all matching handlers. Awaits async handlers in sequence. */
  async dispatch(event: ChainEvent, context: HandlerContext): Promise<void> {
    const specific = this.handlers.get(event.eventName);
    if (specific) {
      for (const handler of specific) {
        await handler(event, context);
      }
    }
    for (const handler of this.wildcardHandlers) {
      await handler(event, context);
    }
  }

  /** Dispatch a block-end signal to all block handlers. */
  async dispatchBlock(context: BlockContext): Promise<void> {
    for (const handler of this.blockHandlers) {
      await handler(context);
    }
  }

  /** Whether any block handlers are registered. */
  get hasBlockHandlers(): boolean {
    return this.blockHandlers.length > 0;
  }

  /** List all registered event names (excluding wildcard). */
  registeredEvents(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Total number of registered handlers (including wildcards and block handlers). */
  get handlerCount(): number {
    let count = this.wildcardHandlers.length + this.blockHandlers.length;
    for (const list of this.handlers.values()) {
      count += list.length;
    }
    return count;
  }
}
