/**
 * Entity store — in-memory indexed data store.
 *
 * Each entity type gets its own key-value map (id → record).
 * The store validates entity names against the schema but keeps
 * records as plain objects for simplicity.
 *
 * Future: SQLite-backed store for persistence across restarts.
 */

import type { Schema, SchemaDefinition } from './schema.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface EntityStore {
  /** Get a single entity by id. Returns undefined if not found. */
  get(entity: string, id: string): Record<string, unknown> | undefined;

  /** Insert or overwrite an entity by id. */
  set(entity: string, id: string, data: Record<string, unknown>): void;

  /** Merge partial fields into an existing entity. Throws if not found. */
  update(entity: string, id: string, partial: Record<string, unknown>): void;

  /** Delete an entity by id. No-op if not found. */
  delete(entity: string, id: string): void;

  /** List all entities of a given type. */
  list(entity: string): Record<string, unknown>[];

  /** Count entities of a given type. */
  count(entity: string): number;

  /** Find entities matching a predicate. */
  find(
    entity: string,
    predicate: (record: Record<string, unknown>) => boolean,
  ): Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export function createStore(schema: Schema<SchemaDefinition>): EntityStore {
  // One Map per entity type
  const tables = new Map<string, Map<string, Record<string, unknown>>>();

  for (const name of schema.entityNames()) {
    tables.set(name, new Map());
  }

  function getTable(entity: string): Map<string, Record<string, unknown>> {
    const table = tables.get(entity);
    if (!table) throw new Error(`Unknown entity: "${entity}"`);
    return table;
  }

  return {
    get(entity, id) {
      return getTable(entity).get(id);
    },

    set(entity, id, data) {
      getTable(entity).set(id, { ...data, id });
    },

    update(entity, id, partial) {
      const table = getTable(entity);
      const existing = table.get(id);
      if (!existing) {
        throw new Error(`${entity} with id "${id}" not found`);
      }
      table.set(id, { ...existing, ...partial });
    },

    delete(entity, id) {
      getTable(entity).delete(id);
    },

    list(entity) {
      return Array.from(getTable(entity).values());
    },

    count(entity) {
      return getTable(entity).size;
    },

    find(entity, predicate) {
      const results: Record<string, unknown>[] = [];
      for (const record of getTable(entity).values()) {
        if (predicate(record)) results.push(record);
      }
      return results;
    },
  };
}
