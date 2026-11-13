/**
 * Bench: per-block write batching (M13).
 *
 * Simulates one block of ERC-20-style Transfer events — each event writes a
 * Transfer row and upserts the sender's + receiver's Balance. We count the
 * number of WRITE round-trips (adapter.run calls) the block costs, unbatched
 * vs. batched, and the wall time. Round-trips are the honest metric: on a
 * networked Postgres each one pays a full RTT, so cutting 3N → a handful is the
 * win. Reads are a separate axis (SQL pushdown, M17).
 *
 *   npx tsx dogfood/bench-batch.ts
 */

import Database from 'better-sqlite3';
import { SqliteAdapter, type MinimalDbAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

/** Wrap an adapter and count write round-trips (run) and read round-trips (get/all). */
class Counting implements MinimalDbAdapter {
  writes = 0;
  reads = 0;
  constructor(private readonly inner: MinimalDbAdapter) {}
  get dialect(): 'sqlite' | 'postgres' { return this.inner.dialect; }
  run(sql: string, params?: unknown[]): Promise<void> { this.writes++; return this.inner.run(sql, params); }
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined> { this.reads++; return this.inner.get<T>(sql, params); }
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> { this.reads++; return this.inner.all<T>(sql, params); }
  exec(sql: string): Promise<void> { return this.inner.exec(sql); }
  transaction<T>(fn: () => Promise<T>): Promise<T> { return this.inner.transaction(fn); }
}

const schema = defineSchema({
  Transfer: { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'bigint' } },
  Balance:  { amount: { type: 'bigint' } },
}) as Schema<SchemaDefinition>;

const N = 2000;                       // transfers in the block
const ACCOUNTS = 200;                 // balances churned (hot set, lots of re-touch)
const acct = (i: number) => `0x${(i % ACCOUNTS).toString(16).padStart(40, '0')}`;

/** Apply one block's worth of transfers through the handler pattern (get→set balances). */
async function applyBlock(store: Awaited<ReturnType<typeof createStore>>): Promise<void> {
  for (let i = 0; i < N; i++) {
    const from = acct(i), to = acct(i + 1), amount = BigInt(1000 + i);
    await store.set('Transfer', `tx${i}`, { from, to, amount });
    const fb = (await store.get('Balance', from))?.['amount'] as bigint | undefined;
    await store.set('Balance', from, { amount: (fb ?? 1_000_000n) - amount });
    const tb = (await store.get('Balance', to))?.['amount'] as bigint | undefined;
    await store.set('Balance', to, { amount: (tb ?? 0n) + amount });
  }
}

async function bench(batched: boolean): Promise<{ writes: number; reads: number; ms: number }> {
  const adapter = new Counting(new SqliteAdapter(new Database(":memory:")));
  const store = await createStore(schema, adapter);
  const baseW = adapter.writes, baseR = adapter.reads;   // skip DDL round-trips
  const t0 = performance.now();
  if (batched) store.beginBatch();
  await applyBlock(store);
  if (batched) await store.flushBatch();
  const ms = performance.now() - t0;
  return { writes: adapter.writes - baseW, reads: adapter.reads - baseR, ms };
}

const un = await bench(false);
const ba = await bench(true);

const factor = (a: number, b: number) => (b === 0 ? 'inf' : `${(a / b).toFixed(0)}x fewer`);
console.log(`\n  block: ${N} transfers over ${ACCOUNTS} accounts → ${N} Transfer rows + balance churn\n`);
console.log(`  mode        write round-trips   read round-trips   wall`);
console.log(`  unbatched   ${String(un.writes).padStart(15)}   ${String(un.reads).padStart(16)}   ${un.ms.toFixed(1)}ms`);
console.log(`  batched     ${String(ba.writes).padStart(15)}   ${String(ba.reads).padStart(16)}   ${ba.ms.toFixed(1)}ms`);
console.log(`  reduction   ${factor(un.writes, ba.writes).padStart(15)}   ${factor(un.reads, ba.reads).padStart(16)}\n`);

// Correctness guard: both paths must land identical final balances.
async function finalBalances(batched: boolean): Promise<string> {
  const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
  if (batched) store.beginBatch();
  await applyBlock(store);
  if (batched) await store.flushBatch();
  const rows = await store.list('Balance');
  return rows.sort((a, b) => (a.id as string).localeCompare(b.id as string)).map((r) => `${r.id}=${r.amount as bigint}`).join(',');
}
const ok = (await finalBalances(false)) === (await finalBalances(true));
console.log(`  correctness: batched final state == unbatched → ${ok ? 'PASS' : 'FAIL'}\n`);
if (!ok) process.exit(1);
