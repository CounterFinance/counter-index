/**
 * Rich schema (M16): entity relationships with nested GraphQL resolution
 * (`swap.pool { token0 }`), dangling refs → null, filtering by the ref id, and
 * `unique` field constraints enforced as UNIQUE indexes.
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { graphql } from 'graphql';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { buildGraphQLSchema } from '../src/graphql.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

const schema = defineSchema({
  Pool: { token0: { type: 'string' }, token1: { type: 'string' } },
  Swap: { amount: { type: 'bigint' }, pool: { type: 'string', ref: 'Pool' } },
}) as Schema<SchemaDefinition>;

async function seeded() {
  const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
  await store.set('Pool', 'pool-1', { token0: 'WBTC', token1: 'USDC' });
  await store.set('Swap', 'swap-1', { amount: 100n, pool: 'pool-1' });
  await store.set('Swap', 'swap-2', { amount: 200n, pool: 'pool-1' });
  await store.set('Swap', 'swap-3', { amount: 300n, pool: 'ghost' });   // dangling ref
  const gql = buildGraphQLSchema(schema, store);
  return { store, gql };
}

describe('entity relationships', () => {
  it('resolves a ref field as the nested entity', async () => {
    const { gql } = await seeded();
    const r = await graphql({ schema: gql, source: `{ swap(id: "swap-1") { amount pool { id token0 token1 } } }` });
    expect(r.errors).toBeUndefined();
    const swap = (r.data!['swap'] as { amount: string; pool: { id: string; token0: string; token1: string } });
    expect(swap.amount).toBe('100');
    expect(swap.pool).toEqual({ id: 'pool-1', token0: 'WBTC', token1: 'USDC' });
  });

  it('a dangling ref resolves to null (not an error)', async () => {
    const { gql } = await seeded();
    const r = await graphql({ schema: gql, source: `{ swap(id: "swap-3") { pool { id } } }` });
    expect(r.errors).toBeUndefined();
    expect((r.data!['swap'] as { pool: unknown }).pool).toBeNull();
  });

  it('filters by the ref id (the stored string)', async () => {
    const { gql } = await seeded();
    const r = await graphql({ schema: gql, source: `{ swaps(where: { pool: "pool-1" }, orderBy: amount) { nodes { id pool { token0 } } totalCount } }` });
    expect(r.errors).toBeUndefined();
    const conn = r.data!['swaps'] as { nodes: Array<{ id: string; pool: { token0: string } }>; totalCount: number };
    expect(conn.totalCount).toBe(2);
    expect(conn.nodes.map((n) => n.id)).toEqual(['swap-1', 'swap-2']);
    expect(conn.nodes[0].pool.token0).toBe('WBTC');
  });
});

describe('unique constraint', () => {
  it('rejects a duplicate value on a unique field', async () => {
    const uq = defineSchema({ Acct: { addr: { type: 'string', unique: true }, n: { type: 'int' } } }) as Schema<SchemaDefinition>;
    const store = await createStore(uq, new SqliteAdapter(new Database(':memory:')));
    await store.set('Acct', 'a', { addr: '0xAA', n: 1 });
    // A different id with the SAME unique addr must fail.
    await expect(store.set('Acct', 'b', { addr: '0xAA', n: 2 })).rejects.toThrow(/UNIQUE|unique/i);
    // A distinct addr is fine.
    await store.set('Acct', 'c', { addr: '0xBB', n: 3 });
    expect(await store.count('Acct')).toBe(2);
  });
});
