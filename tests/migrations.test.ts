/**
 * Incremental schema migrations (M19): adding a field to the schema adds the
 * column in place (ALTER TABLE ADD COLUMN) instead of needing a reset — existing
 * rows keep their data and get the new field's default.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

describe('incremental migration', () => {
  it('adds a new field as a column, preserving existing rows', async () => {
    const db = new Database(':memory:');
    const adapter = new SqliteAdapter(db);

    // v1: one field.
    const v1 = defineSchema({ Acct: { balance: { type: 'bigint' } } }) as Schema<SchemaDefinition>;
    const s1 = await createStore(v1, adapter);
    await s1.set('Acct', 'a', { balance: 100n });

    // v2 on the SAME database: a new required field + a new optional field.
    const v2 = defineSchema({
      Acct: { balance: { type: 'bigint' }, label: { type: 'string' }, note: { type: 'string', optional: true } },
    }) as Schema<SchemaDefinition>;
    const s2 = await createStore(v2, adapter);   // migrates in place

    // Existing row survived; new columns took their defaults.
    const a = await s2.get('Acct', 'a');
    expect(a!.balance).toBe(100n);
    expect(a!.label).toBe('');          // NOT NULL default for the added string field
    expect(a!.note).toBeUndefined();    // optional → NULL

    // New writes use the full shape.
    await s2.set('Acct', 'b', { balance: 5n, label: 'bob', note: 'hi' });
    const b = await s2.get('Acct', 'b');
    expect(b).toMatchObject({ balance: 5n, label: 'bob', note: 'hi' });
  });

  it('is idempotent — re-opening the same schema does nothing', async () => {
    const db = new Database(':memory:');
    const adapter = new SqliteAdapter(db);
    const schema = defineSchema({ X: { v: { type: 'int' } } }) as Schema<SchemaDefinition>;
    await createStore(schema, adapter);
    await createStore(schema, adapter);   // must not throw
    const cols = (db.prepare('PRAGMA table_info("counterindex_x")').all() as Array<{ name: string }>).map((r) => r.name);
    expect(cols).toEqual(['id', 'v']);
  });
});
