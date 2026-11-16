/**
 * Filter-operator parity: the FilterOp semantics are implemented twice by
 * necessity — compiled into SQL by store.query (used by GraphQL/REST/SQL-over-
 * HTTP) and evaluated in JS by serving.matchesFilters (used by SSE live queries).
 * If the two ever disagree, a live subscriber sees different rows than a REST
 * reader. This test runs the same filter through both paths over the same data
 * and asserts identical matches for every operator, so drift fails CI.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createStore, type EntityStore, type StoreFilter } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { createTestAdapter } from '../src/adapter.js';
import { matchesFilters } from '../src/serving.js';

const schema = defineSchema({
  Row: { holder: { type: 'string' }, amount: { type: 'bigint' }, rank: { type: 'int' } },
}) as Schema<SchemaDefinition>;

const SEED = [
  { id: 'a', holder: '0xalice',  amount: 100n, rank: 1 },
  { id: 'b', holder: '0xbob',    amount: 200n, rank: 2 },
  { id: 'c', holder: '0xcarol',  amount: 300n, rank: 3 },
  { id: 'd', holder: '0xalicia', amount: 200n, rank: 2 },
  { id: 'e', holder: '0xeve',    amount: 500n, rank: 9 },
];

const F = (field: string, op: StoreFilter['op'], value: unknown): StoreFilter => ({ field, op, value });

// Every operator, across a string and the two numeric field types.
const CASES: StoreFilter[] = [
  F('holder', 'eq', '0xbob'),
  F('holder', 'not', '0xbob'),
  F('holder', 'contains', 'alic'),
  F('holder', 'starts_with', '0xal'),
  F('holder', 'ends_with', 'ice'),
  F('holder', 'in', ['0xalice', '0xeve']),
  F('amount', 'eq', 200n),
  F('amount', 'not', 200n),
  F('amount', 'gt', 200n),
  F('amount', 'gte', 200n),
  F('amount', 'lt', 300n),
  F('amount', 'lte', 200n),
  F('amount', 'in', [100n, 500n]),
  F('rank', 'eq', 2),
  F('rank', 'gt', 2),
  F('rank', 'gte', 2),
  F('rank', 'lt', 3),
  F('rank', 'lte', 2),
  F('rank', 'in', [1, 9]),
];

describe('SQL (store.query) vs JS (matchesFilters) parity', () => {
  let store: EntityStore;
  let rows: Record<string, unknown>[];

  beforeEach(async () => {
    store = await createStore(schema, createTestAdapter());
    for (const r of SEED) await store.set('Row', r.id, r);
    rows = await store.list('Row');
  });

  const label = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? String(x) : x));
  for (const f of CASES) {
    it(`agrees on ${f.field} ${f.op} ${label(f.value)}`, async () => {
      const sqlIds = (await store.query('Row', { where: [f] })).map((r) => r.id as string).sort();
      const jsIds = rows.filter((r) => matchesFilters(r, [f])).map((r) => r.id as string).sort();
      expect(jsIds).toEqual(sqlIds);
    });
  }

  it('agrees on a compound AND of filters', async () => {
    const where = [F('amount', 'gte', 200n), F('rank', 'lt', 9), F('holder', 'contains', 'al')];
    const sqlIds = (await store.query('Row', { where })).map((r) => r.id as string).sort();
    const jsIds = rows.filter((r) => matchesFilters(r, where)).map((r) => r.id as string).sort();
    expect(jsIds).toEqual(sqlIds);
    expect(sqlIds.length).toBeGreaterThan(0);   // guard: the case actually matches something
  });
});
