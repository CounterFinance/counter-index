/**
 * Entity store — DB-backed indexed data store.
 *
 * Each entity defined in the schema gets its own `opindex_<entity>` table
 * (lowercase). Tables are created automatically when the store is initialised.
 * All operations are async — the underlying adapter may be synchronous SQLite
 * or async Postgres; callers don't need to know which.
 *
 * BigInt fields are serialised as decimal strings (TEXT) since SQL has no
 * native bigint type. They are deserialised back to BigInt on read.
 *
 * Table prefix `opindex_` prevents collisions with OpStream's raw tables when
 * both use the same database.
 */

import type { Schema, SchemaDefinition, EntityDef, FieldType } from './schema.js';
import type { MinimalDbAdapter } from './adapter.js';

// ---------------------------------------------------------------------------
// Public interface (fully async)
// ---------------------------------------------------------------------------

/** Emitted after every store mutation. */
export interface StoreChangeEvent {
  entity: string;
  id: string;
  /** The entity record after the write, or null when the entity was deleted. */
  record: Record<string, unknown> | null;
  operation: 'set' | 'update' | 'delete';
}

export interface EntityStore {
  /** Get a single entity by id. Returns undefined if not found. */
  get(entity: string, id: string): Promise<Record<string, unknown> | undefined>;

  /** Insert or overwrite an entity by id. */
  set(entity: string, id: string, data: Record<string, unknown>): Promise<void>;

  /** Merge partial fields into an existing entity. Throws if not found. */
  update(entity: string, id: string, partial: Record<string, unknown>): Promise<void>;

  /** Delete an entity by id. No-op if not found. */
  delete(entity: string, id: string): Promise<void>;

  /** List all entities of a given type. */
  list(entity: string): Promise<Record<string, unknown>[]>;

  /** Count entities of a given type. */
  count(entity: string): Promise<number>;

  /** Find entities matching a predicate (JS-side filtering after SELECT *). */
  find(
    entity: string,
    predicate: (record: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>[]>;

  /**
   * Subscribe to all store mutations (set / update / delete).
   * The handler fires synchronously after each write, with the resulting record
   * (or null for deletes). Returns an unsubscribe function.
   */
  onChange(handler: (event: StoreChangeEvent) => void): () => void;
}

// ---------------------------------------------------------------------------
// SQL type mapping
// ---------------------------------------------------------------------------

const TABLE_PREFIX = 'opindex_';

function fieldTypeSql(type: FieldType, dialect: 'sqlite' | 'postgres'): string {
  switch (type) {
    case 'string':  return 'TEXT';
    case 'int':     return dialect === 'postgres' ? 'BIGINT' : 'INTEGER';
    case 'float':   return dialect === 'postgres' ? 'DOUBLE PRECISION' : 'REAL';
    case 'bigint':  return 'TEXT';     // stored as decimal string
    case 'boolean': return dialect === 'postgres' ? 'BOOLEAN' : 'INTEGER';
    case 'bytes':   return dialect === 'postgres' ? 'BYTEA' : 'BLOB';
  }
}

function tableName(entity: string): string {
  return `${TABLE_PREFIX}${entity.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Serialisation helpers
// ---------------------------------------------------------------------------

function serialise(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'bigint':  return typeof value === 'bigint' ? value.toString() : String(value);
    case 'boolean': return value ? 1 : 0;
    default:        return value;
  }
}

function deserialise(value: unknown, type: FieldType): unknown {
  if (value === null || value === undefined) return undefined;
  switch (type) {
    case 'bigint':  return BigInt(value as string);
    case 'boolean': return value !== 0 && value !== false;
    default:        return value;
  }
}

function deserialiseRow(
  row: Record<string, unknown>,
  def: EntityDef,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: row['id'] };
  for (const [field, fieldDef] of Object.entries(def)) {
    if (field in row) {
      out[field] = deserialise(row[field], fieldDef.type);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/** Quote a column name to handle SQL reserved words (from, to, select, etc.). */
function col(name: string): string {
  return `"${name}"`;
}

function buildCreateTable(entity: string, def: EntityDef, dialect: 'sqlite' | 'postgres'): string {
  const table = tableName(entity);
  const cols = ['"id" TEXT NOT NULL PRIMARY KEY'];
  for (const [field, fieldDef] of Object.entries(def)) {
    const sqlType = fieldTypeSql(fieldDef.type, dialect);
    const nullable = fieldDef.optional ? '' : ` NOT NULL DEFAULT ''`;
    cols.push(`${col(field)} ${sqlType}${nullable}`);
  }
  return `CREATE TABLE IF NOT EXISTS ${table} (${cols.join(', ')})`;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function createStore(
  schema: Schema<SchemaDefinition>,
  adapter: MinimalDbAdapter,
): Promise<EntityStore> {
  // Create all entity tables
  for (const name of schema.entityNames()) {
    const def = schema.getEntity(name);
    const ddl = buildCreateTable(name, def, adapter.dialect);
    await adapter.exec(ddl);
  }

  function assertKnown(entity: string): EntityDef {
    return schema.getEntity(entity); // throws if unknown
  }

  // Change notification — simple pub/sub, no external dependency
  const changeHandlers = new Set<(event: StoreChangeEvent) => void>();

  function notify(event: StoreChangeEvent): void {
    for (const handler of changeHandlers) handler(event);
  }

  return {
    async get(entity, id) {
      const def = assertKnown(entity);
      const table = tableName(entity);
      const row = await adapter.get<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE "id" = ?`,
        [id],
      );
      if (!row) return undefined;
      return deserialiseRow(row, def);
    },

    async set(entity, id, data) {
      const def = assertKnown(entity);
      const table = tableName(entity);
      const fields = Object.keys(def);
      const cols = ['"id"', ...fields.map(col)].join(', ');
      const placeholders = ['?', ...fields.map(() => '?')].join(', ');
      const values = [id, ...fields.map((f) => serialise(data[f], def[f]!.type))];
      await adapter.run(
        `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${placeholders})`,
        values,
      );
      // Notify with the JS-typed record (not the serialised SQL form)
      const record: Record<string, unknown> = { id };
      for (const [f, fieldDef] of Object.entries(def)) {
        record[f] = data[f] !== undefined ? data[f] : null;
        // Normalise so consumers always get typed values (bigint, boolean, etc.)
        if (record[f] !== null && record[f] !== undefined) {
          record[f] = deserialise(serialise(record[f], fieldDef.type), fieldDef.type);
        }
      }
      notify({ entity, id, record, operation: 'set' });
    },

    async update(entity, id, partial) {
      const def = assertKnown(entity);
      const table = tableName(entity);
      const existing = await adapter.get<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE "id" = ?`,
        [id],
      );
      if (!existing) throw new Error(`${entity} with id "${id}" not found`);

      const setClauses: string[] = [];
      const values: unknown[] = [];
      for (const [field, value] of Object.entries(partial)) {
        if (field in def) {
          setClauses.push(`${col(field)} = ?`);
          values.push(serialise(value, def[field]!.type));
        }
      }
      if (setClauses.length === 0) return;
      values.push(id);
      await adapter.run(
        `UPDATE ${table} SET ${setClauses.join(', ')} WHERE "id" = ?`,
        values,
      );
      // Re-read the full row so the notification has the complete merged record
      const updated = await adapter.get<Record<string, unknown>>(
        `SELECT * FROM ${table} WHERE "id" = ?`,
        [id],
      );
      notify({ entity, id, record: updated ? deserialiseRow(updated, def) : null, operation: 'update' });
    },

    async delete(entity, id) {
      assertKnown(entity);
      const table = tableName(entity);
      await adapter.run(`DELETE FROM ${table} WHERE "id" = ?`, [id]);
      notify({ entity, id, record: null, operation: 'delete' });
    },

    async list(entity) {
      const def = assertKnown(entity);
      const table = tableName(entity);
      const rows = await adapter.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      return rows.map((r) => deserialiseRow(r, def));
    },

    async count(entity) {
      assertKnown(entity);
      const table = tableName(entity);
      const row = await adapter.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      return row?.n ?? 0;
    },

    async find(entity, predicate) {
      const def = assertKnown(entity);
      const table = tableName(entity);
      const rows = await adapter.all<Record<string, unknown>>(`SELECT * FROM ${table}`);
      return rows
        .map((r) => deserialiseRow(r, def))
        .filter(predicate);
    },

    onChange(handler) {
      changeHandlers.add(handler);
      return () => { changeHandlers.delete(handler); };
    },
  };
}
