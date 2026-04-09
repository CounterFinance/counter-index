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
import type { DecodedEvent } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context passed to every event handler. */
export interface HandlerContext {
  /** The entity store — read and write indexed data here. */
  store: EntityStore;
  /** Block number of the current event. */
  block: number;
}

/** An event handler function. */
export type EventHandler = (event: DecodedEvent, context: HandlerContext) => void;

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

export class HandlerRegistry {
  private handlers = new Map<string, EventHandler[]>();
  private wildcardHandlers: EventHandler[] = [];

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

  /** Dispatch an event to all matching handlers. */
  dispatch(event: DecodedEvent, context: HandlerContext): void {
    const specific = this.handlers.get(event.eventName);
    if (specific) {
      for (const handler of specific) {
        handler(event, context);
      }
    }
    for (const handler of this.wildcardHandlers) {
      handler(event, context);
    }
  }

  /** List all registered event names (excluding wildcard). */
  registeredEvents(): string[] {
    return Array.from(this.handlers.keys());
  }

  /** Total number of registered handlers (including wildcards). */
  get handlerCount(): number {
    let count = this.wildcardHandlers.length;
    for (const list of this.handlers.values()) {
      count += list.length;
    }
    return count;
  }
}
