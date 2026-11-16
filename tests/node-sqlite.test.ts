/**
 * NodeSqliteAdapter: SQLite on Node's built-in `node:sqlite` with no native
 * dependency. Validated by running the store surface on it and asserting the
 * results match the better-sqlite3 adapter exactly — if they agree, node:sqlite
 * is a true drop-in and the native dependency is optional.
 */

import { describe, it, expect } from 'vitest';
import { openNodeSqlite, createTestAdapter, type MinimalDbAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

const schema = defineSchema({
  Balance: { holder: { type: 'string' }, amount: { type: 'bigint' }, rank: { type: 'int' } },
}) as Schema<SchemaDefinition>;

async function runStoreSurface(adapter: MinimalDbAdapter) {
  const store = await createStore(schema, adapter);
  await store.set('Balance', 'a', { holder: '0xA', amount: 100n, rank: 1 });
  await store.set('Balance', 'b', { holder: '0xB', amount: 300n, rank: 3 });
  await store.set('Balance', 'c', { holder: '0xC', amount: 200n, rank: 2 });
  await store.update('Balance', 'a', { amount: 150n });
  await store.delete('Balance', 'c');
  return {
    get: await store.get('Balance', 'a'),
    count: await store.count('Balance'),
    queryAsc: (await store.query('Balance', { where: [{ field: 'amount', op: 'gte', value: 150n }], orderBy: 'amount', orderDirection: 'asc' })).map((r) => r.id),
    contains: (await store.query('Balance', { where: [{ field: 'holder', op: 'contains', value: '0x' }] })).map((r) => r.id).sort(),
    countWhere: await store.countWhere('Balance', [{ field: 'rank', op: 'gte', value: 1 }]),
    list: (await store.list('Balance')).map((r) => r.id).sort(),
  };
}

describe('NodeSqliteAdapter (node:sqlite, no native dependency)', () => {
  it('matches better-sqlite3 across the store surface', async () => {
    const onNode = await runStoreSurface(await openNodeSqlite(':memory:'));
    const onBetter = await runStoreSurface(createTestAdapter());
    expect(onNode).toEqual(onBetter);               // drop-in parity

    // absolute sanity (not just "both wrong the same way")
    expect(onNode.count).toBe(2);
    expect(onNode.get).toMatchObject({ id: 'a', holder: '0xA', amount: 150n, rank: 1 });
    expect(typeof (onNode.get as Record<string, unknown>)['amount']).toBe('bigint');
    expect(onNode.queryAsc).toEqual(['a', 'b']);     // amount >= 150, asc: a(150), b(300)
    expect(onNode.countWhere).toBe(2);
  });

  it('commits and rolls back transactions like SqliteAdapter', async () => {
    const a = await openNodeSqlite(':memory:');
    await a.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    // commit
    await a.transaction(async () => { await a.run('INSERT INTO t VALUES (?)', ['ok']); });
    expect((await a.all<{ id: string }>('SELECT id FROM t')).map((r) => r.id)).toEqual(['ok']);
    // rollback on throw
    await expect(a.transaction(async () => {
      await a.run('INSERT INTO t VALUES (?)', ['doomed']);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect((await a.all<{ id: string }>('SELECT id FROM t')).map((r) => r.id)).toEqual(['ok']);  // doomed row gone
    a.close();
    expect(a.rawDb.isOpen).toBe(false);
  });
});
