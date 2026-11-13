/**
 * Secondary indexes (M13): `index: true` fields and the multichain `chainId`
 * column get a real SQL index, so where/orderBy on them don't scan.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

async function indexesFor(table: string, schema: Schema<SchemaDefinition>): Promise<string[]> {
  const db = new Database(':memory:');
  await createStore(schema, new SqliteAdapter(db));
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=? AND name LIKE '%_idx'").all(table) as Array<{ name: string }>).map((r) => r.name);
}

describe('secondary indexes', () => {
  it('creates an index for each index:true field', async () => {
    const schema = defineSchema({
      Holder: { token: { type: 'string', index: true }, holder: { type: 'string', index: true }, bal: { type: 'bigint' } },
    }) as Schema<SchemaDefinition>;
    const idx = await indexesFor('counterindex_holder', schema);
    expect(idx).toContain('counterindex_holder_token_idx');
    expect(idx).toContain('counterindex_holder_holder_idx');
    expect(idx).not.toContain('counterindex_holder_bal_idx');   // not marked → no index
  });

  it('auto-indexes chainId in a multichain schema', async () => {
    const schema = defineSchema({ Thing: { v: { type: 'int' } } }, { multichain: true }) as Schema<SchemaDefinition>;
    const idx = await indexesFor('counterindex_thing', schema);
    expect(idx).toContain('counterindex_thing_chainid_idx');
  });

  it('single-chain schema has no chainId index', async () => {
    const schema = defineSchema({ Thing: { v: { type: 'int' } } }) as Schema<SchemaDefinition>;
    const idx = await indexesFor('counterindex_thing', schema);
    expect(idx).toHaveLength(0);
  });
});
