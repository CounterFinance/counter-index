/**
 * Dogfood: rich schema (M16). A DEX-shaped graph — Pool ← Swap(ref: Pool) —
 * indexed from synthetic events, then queried over a REAL served GraphQL endpoint
 * with NESTED resolution (`swap.pool { token0 }`). Also proves a unique constraint.
 *
 *   npx tsx dogfood/relationships.ts
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ChainEvent } from '../src/types.js';

const schema = defineSchema({
  Pool: { token0: { type: 'string' }, token1: { type: 'string' }, addr: { type: 'string', unique: true } },
  Swap: { amount: { type: 'bigint' }, pool: { type: 'string', ref: 'Pool' } },
});

const fail = (m: string): never => { console.error(`[dogfood:relationships] FAIL — ${m}`); process.exit(1); };

async function main(): Promise<void> {
  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });

  // Seed a pool and three swaps referencing it (one dangling).
  await indexer.store.set('Pool', 'pool-wbtc-usdc', { token0: 'WBTC', token1: 'USDC', addr: '0xpool1' });
  await indexer.store.set('Swap', 'swap-1', { amount: 100n, pool: 'pool-wbtc-usdc' });
  await indexer.store.set('Swap', 'swap-2', { amount: 250n, pool: 'pool-wbtc-usdc' });
  await indexer.store.set('Swap', 'swap-3', { amount: 999n, pool: 'does-not-exist' });

  // Unique constraint: a second pool with the SAME addr must be rejected.
  let uniqueRejected = false;
  try { await indexer.store.set('Pool', 'pool-dup', { token0: 'X', token1: 'Y', addr: '0xpool1' }); }
  catch { uniqueRejected = true; }
  if (!uniqueRejected) fail('unique constraint on Pool.addr did not reject a duplicate');

  const handle = await indexer.serve({ port: 47980 });
  try {
    const q = async (query: string): Promise<Record<string, unknown>> => {
      const r = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
      const j = await r.json() as { data?: Record<string, unknown>; errors?: unknown };
      if (j.errors) fail(`GraphQL errors: ${JSON.stringify(j.errors)}`);
      return j.data!;
    };

    // Nested resolution over HTTP.
    const d1 = await q(`{ swap(id: "swap-1") { amount pool { id token0 token1 } } }`);
    const swap = d1['swap'] as { amount: string; pool: { id: string; token0: string } | null };
    if (swap.pool?.token0 !== 'WBTC' || swap.amount !== '100') fail(`nested pool not resolved: ${JSON.stringify(swap)}`);

    // Dangling ref → null.
    const d2 = await q(`{ swap(id: "swap-3") { pool { id } } }`);
    if ((d2['swap'] as { pool: unknown }).pool !== null) fail('dangling ref should resolve to null');

    // Filter by ref id, nested select.
    const d3 = await q(`{ swaps(where: { pool: "pool-wbtc-usdc" }, orderBy: amount) { totalCount nodes { id pool { token1 } } } }`);
    const conn = d3['swaps'] as { totalCount: number; nodes: Array<{ id: string; pool: { token1: string } }> };
    if (conn.totalCount !== 2 || conn.nodes[0].pool.token1 !== 'USDC') fail(`filter-by-ref failed: ${JSON.stringify(conn)}`);

    console.log(`  swap-1.pool → { WBTC / USDC }   (nested resolution over HTTP)`);
    console.log(`  swap-3.pool → null              (dangling ref)`);
    console.log(`  swaps(pool: pool-wbtc-usdc) → 2 (filter by ref id + nested select)`);
    console.log(`  Pool.addr unique → duplicate rejected`);
    console.log(`[dogfood:relationships] PASS — entity relationships + unique constraint verified end-to-end.`);
  } finally {
    await handle.stop();
  }
}

void main();
