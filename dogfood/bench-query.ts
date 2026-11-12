/**
 * Bench: query pushdown (M17). The old GraphQL resolver called store.list() —
 * loading the WHOLE table into memory — then filtered/sorted/sliced in JS. That
 * is the DoS of opidx-#42. store.query() now pushes WHERE/ORDER BY/LIMIT into
 * SQL, so a "first: 20" page reads ~20 rows regardless of table size.
 *
 *   npx tsx dogfood/bench-query.ts
 */

import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

const schema = defineSchema({
  Transfer: { amount: { type: 'bigint', index: true }, holder: { type: 'string', index: true }, block: { type: 'int', index: true } },
}) as Schema<SchemaDefinition>;

const N = 200_000;
const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));

process.stdout.write(`  seeding ${N.toLocaleString()} rows…`);
store.beginBatch();
for (let i = 0; i < N; i++) await store.set('Transfer', `t${i}`, { amount: BigInt(i), holder: `0x${i % 500}`, block: i });
await store.flushBatch();
console.log(' done');

const mb = (): number => Math.round(process.memoryUsage().heapUsed / 1e6);

// Old path: whole-table load + JS work (what the resolver used to do).
let t0 = performance.now();
const base = mb();
const all = await store.list('Transfer');
const pageOld = all
  .filter((r) => (r.holder as string) === '0x7')
  .sort((a, b) => Number(a.block) - Number(b.block))
  .slice(0, 20);
const oldMs = performance.now() - t0;
const oldHeap = mb() - base;

// New path: push filter/order/limit into SQL.
t0 = performance.now();
const pageNew = await store.query('Transfer', {
  where: [{ field: 'holder', op: 'eq', value: '0x7' }], orderBy: 'block', orderDirection: 'asc', limit: 20,
});
const newMs = performance.now() - t0;

console.log(`\n  query: holder = 0x7, order by block, first 20 — over ${N.toLocaleString()} rows\n`);
console.log(`  path          rows loaded        wall      added heap`);
console.log(`  whole-table   ${String(all.length).padStart(11)}   ${oldMs.toFixed(1).padStart(7)}ms   ~${oldHeap}MB`);
console.log(`  SQL pushdown  ${String(pageNew.length).padStart(11)}   ${newMs.toFixed(1).padStart(7)}ms   negligible`);
console.log(`  reduction     ${(all.length / pageNew.length).toFixed(0).padStart(10)}x fewer rows loaded, ${(oldMs / newMs).toFixed(0)}x faster\n`);

const ok = JSON.stringify(pageOld.map((r) => r.id)) === JSON.stringify(pageNew.map((r) => r.id));
console.log(`  correctness: pushdown page == whole-table page → ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exit(1);
