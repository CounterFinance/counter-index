/**
 * Server-side query pushdown (M17): store.query / store.countWhere translate
 * filters, ordering and keyset cursors into parameterised SQL — no whole-table
 * load (closes the DoS of opidx-#42). Covers each operator, numeric bigint
 * ordering, LIKE escaping, and stable keyset pagination.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import type { MinimalDbAdapter } from '../src/adapter.js';

const schema = defineSchema({
  Tok: { amount: { type: 'bigint', index: true }, holder: { type: 'string', index: true }, block: { type: 'int', index: true } },
}) as Schema<SchemaDefinition>;

async function seeded() {
  const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
  // amounts chosen so lexical != numeric order (10 < 2 lexically).
  await store.set('Tok', 'a', { amount: 2n, holder: '0xAA', block: 100 });
  await store.set('Tok', 'b', { amount: 10n, holder: '0xBB', block: 101 });
  await store.set('Tok', 'c', { amount: 3n, holder: '0xAA', block: 102 });
  await store.set('Tok', 'd', { amount: 100n, holder: '0xCC', block: 103 });
  return store;
}

describe('store.query filters (pushed to SQL)', () => {
  it('eq / not', async () => {
    const s = await seeded();
    expect((await s.query('Tok', { where: [{ field: 'holder', op: 'eq', value: '0xAA' }] })).map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect((await s.query('Tok', { where: [{ field: 'holder', op: 'not', value: '0xAA' }] })).map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('int range gt/lt/gte/lte', async () => {
    const s = await seeded();
    expect((await s.query('Tok', { where: [{ field: 'block', op: 'gt', value: 101 }] })).map((r) => r.id).sort()).toEqual(['c', 'd']);
    expect((await s.query('Tok', { where: [{ field: 'block', op: 'lte', value: 101 }] })).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('bigint range + order is NUMERIC, not lexical', async () => {
    const s = await seeded();
    // amount > 3 must include 10 and 100 (numeric), not exclude them lexically.
    expect((await s.query('Tok', { where: [{ field: 'amount', op: 'gt', value: 3n }] })).map((r) => r.id).sort()).toEqual(['b', 'd']);
    // order by amount asc → 2, 3, 10, 100 (numeric)
    expect((await s.query('Tok', { orderBy: 'amount', orderDirection: 'asc' })).map((r) => r.amount)).toEqual([2n, 3n, 10n, 100n]);
  });

  it('contains / starts_with / ends_with with LIKE escaping', async () => {
    const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
    await store.set('Tok', 'p', { amount: 1n, holder: 'a%b_c', block: 1 });
    await store.set('Tok', 'q', { amount: 1n, holder: 'axbyc', block: 1 });
    // `%` and `_` are literal, not wildcards → only 'a%b_c' matches.
    expect((await store.query('Tok', { where: [{ field: 'holder', op: 'contains', value: '%b_' }] })).map((r) => r.id)).toEqual(['p']);
    expect((await store.query('Tok', { where: [{ field: 'holder', op: 'starts_with', value: 'a%' }] })).map((r) => r.id)).toEqual(['p']);
    expect((await store.query('Tok', { where: [{ field: 'holder', op: 'ends_with', value: '_c' }] })).map((r) => r.id)).toEqual(['p']);
  });

  it('in: membership over a set (and empty set matches nothing)', async () => {
    const s = await seeded();
    expect((await s.query('Tok', { where: [{ field: 'id', op: 'in', value: ['a', 'd'] }] })).map((r) => r.id).sort()).toEqual(['a', 'd']);
    expect((await s.query('Tok', { where: [{ field: 'holder', op: 'in', value: ['0xAA', '0xCC'] }] })).map((r) => r.id).sort()).toEqual(['a', 'c', 'd']);
    expect((await s.query('Tok', { where: [{ field: 'id', op: 'in', value: [] }] })).length).toBe(0);
  });

  it('rejects an unknown field (allow-list — no injection surface)', async () => {
    const s = await seeded();
    await expect(s.query('Tok', { where: [{ field: 'evil; DROP TABLE counterindex_tok', op: 'eq', value: 'x' }] })).rejects.toThrow(/Unknown field/);
    await expect(s.query('Tok', { orderBy: 'nope' })).rejects.toThrow(/Unknown field/);
  });

  it('countWhere counts matches in SQL', async () => {
    const s = await seeded();
    expect(await s.countWhere('Tok', [{ field: 'holder', op: 'eq', value: '0xAA' }])).toBe(2);
    expect(await s.countWhere('Tok')).toBe(4);
  });
});

describe('store.query keyset pagination', () => {
  it('walks every row once, no gaps or dups', async () => {
    const s = await seeded();
    const pageSize = 2;
    const seen: string[] = [];
    let cursor: { sortValue: unknown; id: string } | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const rows = await s.query('Tok', { orderBy: 'amount', orderDirection: 'asc', cursor, limit: pageSize + 1 });
      const page = rows.slice(0, pageSize);
      if (page.length === 0) break;
      for (const r of page) seen.push(r.id as string);
      if (rows.length <= pageSize) break;
      const last = page[page.length - 1];
      cursor = { sortValue: last.amount, id: last.id as string };
    }
    expect(seen).toEqual(['a', 'c', 'b', 'd']);   // numeric amount order: 2,3,10,100
  });

  it('desc keyset is stable too', async () => {
    const s = await seeded();
    const first = await s.query('Tok', { orderBy: 'amount', orderDirection: 'desc', limit: 2 });
    expect(first.map((r) => r.id)).toEqual(['d', 'b']);
    const next = await s.query('Tok', { orderBy: 'amount', orderDirection: 'desc', limit: 2, cursor: { sortValue: first[1].amount, id: first[1].id as string } });
    expect(next.map((r) => r.id)).toEqual(['c', 'a']);
  });
});

describe('query is pushed to SQL (no whole-table load)', () => {
  it('emits a WHERE + LIMIT, not a bare SELECT *', async () => {
    const seenSql: string[] = [];
    const inner = new SqliteAdapter(new Database(':memory:'));
    const spy: MinimalDbAdapter = {
      dialect: inner.dialect,
      run: (sql, p) => inner.run(sql, p),
      get: (sql, p) => inner.get(sql, p),
      all: (sql, p) => { seenSql.push(sql); return inner.all(sql, p); },
      exec: (sql) => inner.exec(sql),
      transaction: (fn) => inner.transaction(fn),
    };
    const store = await createStore(schema, spy);
    await store.set('Tok', 'a', { amount: 5n, holder: '0xAA', block: 1 });
    seenSql.length = 0;

    await store.query('Tok', { where: [{ field: 'holder', op: 'eq', value: '0xAA' }], orderBy: 'block', limit: 10 });
    const sql = seenSql.find((s) => s.includes('SELECT * FROM counterindex_tok'))!;
    expect(sql).toMatch(/WHERE/);
    expect(sql).toMatch(/ORDER BY/);
    expect(sql).toMatch(/LIMIT/);
  });
});
