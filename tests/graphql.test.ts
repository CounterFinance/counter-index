/**
 * GraphQL layer tests — schema generation, resolvers, Connection pagination,
 * cursor correctness, filtering, ordering, BigInt serialisation, subscriptions,
 * and the serve() method on the Indexer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { graphql, subscribe, parse } from 'graphql';
import { defineSchema } from '../src/schema.js';
import { createIndexer } from '../src/indexer.js';
import { buildGraphQLSchema } from '../src/graphql.js';
import { createTestAdapter } from '../src/adapter.js';
import type { MinimalDbAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';

// ---------------------------------------------------------------------------
// Shared schema
// ---------------------------------------------------------------------------

const schema = defineSchema({
  Pool: {
    address:  { type: 'string' },
    token0:   { type: 'string' },
    token1:   { type: 'string' },
    reserve0: { type: 'bigint' },
    reserve1: { type: 'bigint' },
    fee:      { type: 'int' },
    active:   { type: 'boolean' },
    notes:    { type: 'string', optional: true },
  },
  Token: {
    symbol:   { type: 'string' },
    decimals: { type: 'int' },
    volume:   { type: 'bigint' },
  },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(adapter: MinimalDbAdapter) {
  return createStore(schema, adapter);
}

async function seedPools(store: Awaited<ReturnType<typeof makeStore>>) {
  await store.set('Pool', 'pool-1', {
    address: '0xaaa', token0: 'WBTC', token1: 'MOTO',
    reserve0: 1_000_000n, reserve1: 500_000n, fee: 30, active: true,
  });
  await store.set('Pool', 'pool-2', {
    address: '0xbbb', token0: 'WBTC', token1: 'USDT',
    reserve0: 2_000_000n, reserve1: 1_000_000n, fee: 5, active: true,
  });
  await store.set('Pool', 'pool-3', {
    address: '0xccc', token0: 'MOTO', token1: 'USDT',
    reserve0: 300_000n, reserve1: 150_000n, fee: 30, active: false,
    notes: 'deprecated',
  });
}

// Inline base64 cursor helpers (mirror what graphql.ts does)
const encodeCursor = (id: string) => Buffer.from(id, 'utf8').toString('base64');

// ---------------------------------------------------------------------------
// Schema shape
// ---------------------------------------------------------------------------

describe('buildGraphQLSchema — shape', () => {
  let adapter: MinimalDbAdapter;
  beforeEach(() => { adapter = createTestAdapter(); });

  it('produces singular query per entity', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store);
    const fields = gql.getQueryType()!.getFields();
    expect(fields['pool']).toBeDefined();
    expect(fields['token']).toBeDefined();
  });

  it('produces plural query per entity', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store);
    const fields = gql.getQueryType()!.getFields();
    expect(fields['pools']).toBeDefined();
    expect(fields['tokens']).toBeDefined();
  });

  it('plural queries have where / orderBy / orderDirection / first / after args', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store);
    const argNames = gql.getQueryType()!.getFields()['pools']!.args.map((a) => a.name);
    expect(argNames).toContain('where');
    expect(argNames).toContain('orderBy');
    expect(argNames).toContain('orderDirection');
    expect(argNames).toContain('first');
    expect(argNames).toContain('after');
  });

  it('plural query return type is a Connection with nodes / pageInfo / totalCount', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store);
    // PoolConnection fields
    const connType = gql.getType('PoolConnection');
    expect(connType).toBeDefined();
    const connFields = (connType as import('graphql').GraphQLObjectType).getFields();
    expect(connFields['nodes']).toBeDefined();
    expect(connFields['pageInfo']).toBeDefined();
    expect(connFields['totalCount']).toBeDefined();
  });

  it('no subscription type when subscriptions not enabled', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store);
    expect(gql.getSubscriptionType()).toBeUndefined();
  });

  it('subscription type present when subscriptions: true', async () => {
    const store = await makeStore(adapter);
    const gql = buildGraphQLSchema(schema, store, { subscriptions: true });
    const sub = gql.getSubscriptionType();
    expect(sub).toBeDefined();
    expect(sub!.getFields()['poolUpdated']).toBeDefined();
    expect(sub!.getFields()['tokenUpdated']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Singular resolver — pool(id)
// ---------------------------------------------------------------------------

describe('pool(id) resolver', () => {
  let adapter: MinimalDbAdapter;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await seedPools(store);
    gqlSchema = buildGraphQLSchema(schema, store);
  });

  it('returns entity by id', async () => {
    const result = await graphql({ schema: gqlSchema, source: `{ pool(id: "pool-1") { id address token0 fee } }` });
    expect(result.errors).toBeUndefined();
    expect(result.data!['pool']).toMatchObject({ id: 'pool-1', address: '0xaaa', token0: 'WBTC', fee: 30 });
  });

  it('returns null for unknown id', async () => {
    const result = await graphql({ schema: gqlSchema, source: `{ pool(id: "nope") { id } }` });
    expect(result.errors).toBeUndefined();
    expect(result.data!['pool']).toBeNull();
  });

  it('serialises BigInt as string', async () => {
    const result = await graphql({ schema: gqlSchema, source: `{ pool(id: "pool-1") { reserve0 reserve1 } }` });
    expect(result.errors).toBeUndefined();
    expect(result.data!['pool']).toMatchObject({ reserve0: '1000000', reserve1: '500000' });
  });

  it('returns null for unset optional field', async () => {
    const result = await graphql({ schema: gqlSchema, source: `{ pool(id: "pool-1") { notes } }` });
    expect(result.errors).toBeUndefined();
    expect((result.data!['pool'] as Record<string, unknown>)['notes']).toBeNull();
  });

  it('returns value for set optional field', async () => {
    const result = await graphql({ schema: gqlSchema, source: `{ pool(id: "pool-3") { notes } }` });
    expect(result.errors).toBeUndefined();
    expect((result.data!['pool'] as Record<string, unknown>)['notes']).toBe('deprecated');
  });
});

// ---------------------------------------------------------------------------
// Plural resolver — Connection shape
// ---------------------------------------------------------------------------

describe('pools() — Connection shape', () => {
  let adapter: MinimalDbAdapter;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await seedPools(store);
    gqlSchema = buildGraphQLSchema(schema, store);
  });

  it('returns nodes, pageInfo, totalCount', async () => {
    const result = await graphql({
      schema: gqlSchema,
      source: `{ pools { nodes { id } pageInfo { hasNextPage endCursor } totalCount } }`,
    });
    expect(result.errors).toBeUndefined();
    const conn = result.data!['pools'] as { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null }; totalCount: number };
    expect(conn.nodes.length).toBe(3);
    expect(conn.totalCount).toBe(3);
    expect(conn.pageInfo.hasNextPage).toBe(false);
  });

  it('returns empty nodes array and totalCount 0 when no entities', async () => {
    const empty = createTestAdapter();
    const emptyStore = await makeStore(empty);
    const emptySchema = buildGraphQLSchema(schema, emptyStore);
    const result = await graphql({ schema: emptySchema, source: `{ pools { nodes { id } totalCount pageInfo { hasNextPage endCursor } } }` });
    expect(result.errors).toBeUndefined();
    const conn = result.data!['pools'] as { nodes: unknown[]; totalCount: number; pageInfo: { endCursor: string | null } };
    expect(conn.nodes).toEqual([]);
    expect(conn.totalCount).toBe(0);
    expect(conn.pageInfo.endCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('pools() — where filters', () => {
  let adapter: MinimalDbAdapter;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await seedPools(store);
    gqlSchema = buildGraphQLSchema(schema, store);
  });

  function poolIds(result: Awaited<ReturnType<typeof graphql>>) {
    return ((result.data!['pools'] as { nodes: { id: string }[] }).nodes).map((p) => p.id);
  }

  it('exact match on string field', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { token0: "WBTC" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    const ids = poolIds(r);
    expect(ids).toContain('pool-1');
    expect(ids).toContain('pool-2');
    expect(ids).not.toContain('pool-3');
  });

  it('_not filter', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { token0_not: "WBTC" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-3']);
  });

  it('_contains filter', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { token1_contains: "OT" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toContain('pool-1'); // MOTO
  });

  it('_starts_with filter', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { address_starts_with: "0xa" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-1']);
  });

  it('_ends_with filter', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { address_ends_with: "bb" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-2']);
  });

  it('exact match on int field', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { fee: 5 }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-2']);
  });

  it('_gt filter on int field', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { fee_gt: 5 }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    const ids = poolIds(r);
    expect(ids).toContain('pool-1');
    expect(ids).toContain('pool-3');
    expect(ids).not.toContain('pool-2');
  });

  it('_lte filter on int field', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { fee_lte: 5 }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-2']);
  });

  it('exact match on boolean', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { active: false }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-3']);
  });

  it('filter by id', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { id: "pool-2" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    expect(poolIds(r)).toEqual(['pool-2']);
  });

  it('BigInt field filter with string literal', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { reserve0_gt: "500000" }) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    const ids = poolIds(r);
    expect(ids).toContain('pool-1');
    expect(ids).toContain('pool-2');
    expect(ids).not.toContain('pool-3');
  });

  it('totalCount reflects filtered count, not total', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(where: { token0: "WBTC" }) { nodes { id } totalCount } }` });
    expect(r.errors).toBeUndefined();
    expect((result: unknown) => result).toBeDefined();
    const conn = r.data!['pools'] as { totalCount: number };
    expect(conn.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('pools() — ordering', () => {
  let adapter: MinimalDbAdapter;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await seedPools(store);
    gqlSchema = buildGraphQLSchema(schema, store);
  });

  it('orderBy fee asc', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: fee, orderDirection: asc) { nodes { fee } } }` });
    expect(r.errors).toBeUndefined();
    const fees = (r.data!['pools'] as { nodes: { fee: number }[] }).nodes.map((p) => p.fee);
    expect(fees).toEqual([5, 30, 30]);
  });

  it('orderBy fee desc', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: fee, orderDirection: desc) { nodes { fee } } }` });
    expect(r.errors).toBeUndefined();
    const fees = (r.data!['pools'] as { nodes: { fee: number }[] }).nodes.map((p) => p.fee);
    expect(fees).toEqual([30, 30, 5]);
  });

  it('orderBy id asc', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: id, orderDirection: asc) { nodes { id } } }` });
    expect(r.errors).toBeUndefined();
    const ids = (r.data!['pools'] as { nodes: { id: string }[] }).nodes.map((p) => p.id);
    expect(ids).toEqual(['pool-1', 'pool-2', 'pool-3']);
  });

  it('orderBy BigInt field desc', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: reserve0, orderDirection: desc) { nodes { reserve0 } } }` });
    expect(r.errors).toBeUndefined();
    const reserves = (r.data!['pools'] as { nodes: { reserve0: string }[] }).nodes.map((p) => p.reserve0);
    expect(reserves).toEqual(['2000000', '1000000', '300000']);
  });

  it('ties broken by id (stable sort)', async () => {
    // pool-1 and pool-3 both have fee: 30 — id tiebreaker should give pool-1 first
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: fee, orderDirection: asc) { nodes { id fee } } }` });
    expect(r.errors).toBeUndefined();
    const nodes = (r.data!['pools'] as { nodes: { id: string; fee: number }[] }).nodes;
    // fee-5 first, then fee-30 x2 sorted by id
    expect(nodes[1]!.id).toBe('pool-1');
    expect(nodes[2]!.id).toBe('pool-3');
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

describe('pools() — cursor pagination', () => {
  let adapter: MinimalDbAdapter;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await seedPools(store);
    gqlSchema = buildGraphQLSchema(schema, store);
  });

  it('first limits items', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: id, orderDirection: asc, first: 2) { nodes { id } pageInfo { hasNextPage } } }` });
    expect(r.errors).toBeUndefined();
    const conn = r.data!['pools'] as { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
    expect(conn.nodes.length).toBe(2);
    expect(conn.pageInfo.hasNextPage).toBe(true);
  });

  it('hasNextPage false on last page', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: id, orderDirection: asc, first: 10) { nodes { id } pageInfo { hasNextPage } } }` });
    expect(r.errors).toBeUndefined();
    expect((r.data!['pools'] as { pageInfo: { hasNextPage: boolean } }).pageInfo.hasNextPage).toBe(false);
  });

  it('endCursor is base64 of last item id', async () => {
    const r = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: id, orderDirection: asc, first: 2) { pageInfo { endCursor } } }` });
    expect(r.errors).toBeUndefined();
    const cursor = (r.data!['pools'] as { pageInfo: { endCursor: string } }).pageInfo.endCursor;
    expect(cursor).toBe(encodeCursor('pool-2'));
  });

  it('after cursor fetches next page', async () => {
    // Page 1
    const page1 = await graphql({ schema: gqlSchema, source: `{ pools(orderBy: id, orderDirection: asc, first: 2) { nodes { id } pageInfo { endCursor hasNextPage } } }` });
    const { endCursor, hasNextPage } = (page1.data!['pools'] as { pageInfo: { endCursor: string; hasNextPage: boolean } }).pageInfo;
    expect(hasNextPage).toBe(true);

    // Page 2 using cursor
    const page2 = await graphql({
      schema: gqlSchema,
      source: `{ pools(orderBy: id, orderDirection: asc, first: 2, after: "${endCursor}") { nodes { id } pageInfo { hasNextPage } } }`,
    });
    expect(page2.errors).toBeUndefined();
    const conn2 = page2.data!['pools'] as { nodes: { id: string }[]; pageInfo: { hasNextPage: boolean } };
    expect(conn2.nodes.map((i) => i.id)).toEqual(['pool-3']);
    expect(conn2.pageInfo.hasNextPage).toBe(false);
  });

  it('totalCount stays constant across pages', async () => {
    const cursor = encodeCursor('pool-1');
    const r = await graphql({
      schema: gqlSchema,
      source: `{ pools(orderBy: id, orderDirection: asc, first: 1, after: "${cursor}") { nodes { id } totalCount } }`,
    });
    expect(r.errors).toBeUndefined();
    // totalCount = full filtered count, not just this page
    expect((r.data!['pools'] as { totalCount: number }).totalCount).toBe(3);
  });

  it('unknown cursor returns items from beginning', async () => {
    const badCursor = encodeCursor('nonexistent-id');
    const r = await graphql({
      schema: gqlSchema,
      source: `{ pools(orderBy: id, orderDirection: asc, first: 10, after: "${badCursor}") { nodes { id } } }`,
    });
    expect(r.errors).toBeUndefined();
    // cursor not found → no slice, returns all
    expect((r.data!['pools'] as { nodes: { id: string }[] }).nodes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Multiple entity types
// ---------------------------------------------------------------------------

describe('multiple entity types', () => {
  it('Pool and Token queries work independently', async () => {
    const adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await store.set('Token', 'tok-1', { symbol: 'WBTC', decimals: 8, volume: 9_999n });
    await store.set('Token', 'tok-2', { symbol: 'MOTO', decimals: 8, volume: 1n });
    await seedPools(store);
    const gqlSchema = buildGraphQLSchema(schema, store);

    const result = await graphql({
      schema: gqlSchema,
      source: `{
        pools { nodes { id } totalCount }
        tokens { nodes { id symbol } totalCount }
        token(id: "tok-1") { symbol volume }
      }`,
    });
    expect(result.errors).toBeUndefined();
    expect((result.data!['pools'] as { totalCount: number }).totalCount).toBe(3);
    expect((result.data!['tokens'] as { totalCount: number }).totalCount).toBe(2);
    expect((result.data!['token'] as { symbol: string; volume: string })).toMatchObject({
      symbol: 'WBTC',
      volume: '9999',
    });
  });
});

// ---------------------------------------------------------------------------
// GraphQL Subscriptions
// ---------------------------------------------------------------------------

describe('subscriptions', () => {
  let adapter: MinimalDbAdapter;
  let store: Awaited<ReturnType<typeof makeStore>>;
  let gqlSchema: ReturnType<typeof buildGraphQLSchema>;

  beforeEach(async () => {
    adapter = createTestAdapter();
    store = await makeStore(adapter);
    gqlSchema = buildGraphQLSchema(schema, store, { subscriptions: true });
  });

  it('poolUpdated fires when store.set() is called', async () => {
    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id address } }`),
    });
    if (!Symbol.asyncIterator in (result as object)) throw new Error('not an async iterator');
    const iter = (result as AsyncIterableIterator<{ data?: { poolUpdated: { id: string; address: string } } }>)[Symbol.asyncIterator]();

    await store.set('Pool', 'p1', {
      address: '0xfff', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const { value } = await iter.next();
    expect(value.data?.poolUpdated.id).toBe('p1');
    expect(value.data?.poolUpdated.address).toBe('0xfff');

    await iter.return?.();
  });

  it('poolUpdated fires when store.update() is called', async () => {
    await store.set('Pool', 'p1', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 100n, reserve1: 100n, fee: 10, active: true,
    });

    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id fee } }`),
    });
    const iter = (result as AsyncIterableIterator<{ data?: { poolUpdated: { id: string; fee: number } } }>)[Symbol.asyncIterator]();

    await store.update('Pool', 'p1', { fee: 99 });

    const { value } = await iter.next();
    expect(value.data?.poolUpdated.id).toBe('p1');
    expect(value.data?.poolUpdated.fee).toBe(99);

    await iter.return?.();
  });

  it('poolUpdated does not fire for other entities', async () => {
    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id } }`),
    });
    const iter = (result as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]();

    // Write a Token — should NOT trigger poolUpdated
    await store.set('Token', 'tok-1', { symbol: 'WBTC', decimals: 8, volume: 1n });

    // Write a Pool — SHOULD trigger
    await store.set('Pool', 'p1', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const { value } = await (iter as AsyncIterator<{ data?: { poolUpdated: { id: string } } }>).next();
    expect(value.data?.poolUpdated.id).toBe('p1');

    await iter.return?.();
  });

  it('poolUpdated does not fire on store.delete()', async () => {
    await store.set('Pool', 'p1', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id } }`),
    });
    const iter = (result as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]();

    // Delete should NOT trigger subscription (record === null — filtered out)
    await store.delete('Pool', 'p1');

    // Write a new pool so we have something to await
    await store.set('Pool', 'p2', {
      address: '0xbbb', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const { value } = await (iter as AsyncIterator<{ data?: { poolUpdated: { id: string } } }>).next();
    // First event received must be p2, not p1's delete
    expect(value.data?.poolUpdated.id).toBe('p2');

    await iter.return?.();
  });

  it('multiple concurrent subscribers all receive the event', async () => {
    const make = () => subscribe({ schema: gqlSchema, document: parse(`subscription { poolUpdated { id } }`) });
    const [r1, r2] = await Promise.all([make(), make()]);

    const iter1 = (r1 as AsyncIterableIterator<{ data?: { poolUpdated: { id: string } } }>)[Symbol.asyncIterator]();
    const iter2 = (r2 as AsyncIterableIterator<{ data?: { poolUpdated: { id: string } } }>)[Symbol.asyncIterator]();

    await store.set('Pool', 'shared', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const [v1, v2] = await Promise.all([iter1.next(), iter2.next()]);
    expect(v1.value.data?.poolUpdated.id).toBe('shared');
    expect(v2.value.data?.poolUpdated.id).toBe('shared');

    await Promise.all([iter1.return?.(), iter2.return?.()]);
  });

  it('unsubscribing (return) stops further events', async () => {
    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id } }`),
    });
    const iter = (result as AsyncIterableIterator<unknown>)[Symbol.asyncIterator]();

    // Unsubscribe before any events
    await iter.return?.();

    // This write should NOT reach the (now-closed) iterator
    await store.set('Pool', 'after-unsub', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 1n, reserve1: 1n, fee: 1, active: true,
    });

    const { done } = await iter.next();
    expect(done).toBe(true);
  });

  it('BigInt fields serialised as strings in subscription payload', async () => {
    const result = await subscribe({
      schema: gqlSchema,
      document: parse(`subscription { poolUpdated { id reserve0 } }`),
    });
    const iter = (result as AsyncIterableIterator<{ data?: { poolUpdated: { id: string; reserve0: string } } }>)[Symbol.asyncIterator]();

    await store.set('Pool', 'p1', {
      address: '0xaaa', token0: 'A', token1: 'B',
      reserve0: 999_999n, reserve1: 1n, fee: 1, active: true,
    });

    const { value } = await iter.next();
    expect(value.data?.poolUpdated.reserve0).toBe('999999');

    await iter.return?.();
  });
});

// ---------------------------------------------------------------------------
// indexer.serve() integration smoke tests
// ---------------------------------------------------------------------------

describe('indexer.serve()', () => {
  const serveSchema = defineSchema({ Item: { name: { type: 'string' } } });
  const BASE_PORT = 19870;
  let portOffset = 0;
  const handles: Array<{ stop(): Promise<void> }> = [];

  afterEach(async () => {
    for (const h of handles) { try { await h.stop(); } catch { /* already stopped */ } }
    handles.length = 0;
  });

  it('returns a handle with url and stop()', async () => {
    const port = BASE_PORT + portOffset++;
    const indexer = await createIndexer({ schema: serveSchema, sink: createTestAdapter() });
    const handle = await indexer.serve({ port });
    handles.push(handle);
    expect(handle.url).toBe(`http://localhost:${port}/graphql`);
    expect(typeof handle.stop).toBe('function');
  });

  it('stop() resolves cleanly', async () => {
    const port = BASE_PORT + portOffset++;
    const indexer = await createIndexer({ schema: serveSchema, sink: createTestAdapter() });
    const handle = await indexer.serve({ port });
    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('uses custom port in url', async () => {
    const port = BASE_PORT + portOffset++;
    const indexer = await createIndexer({ schema: serveSchema, sink: createTestAdapter() });
    const handle = await indexer.serve({ port });
    handles.push(handle);
    expect(handle.url).toBe(`http://localhost:${port}/graphql`);
  });

  it('uses custom path in url', async () => {
    const port = BASE_PORT + portOffset++;
    const indexer = await createIndexer({ schema: serveSchema, sink: createTestAdapter() });
    const handle = await indexer.serve({ port, path: '/api/graphql' });
    handles.push(handle);
    expect(handle.url).toBe(`http://localhost:${port}/api/graphql`);
  });
});

// ---------------------------------------------------------------------------
// _meta field
// ---------------------------------------------------------------------------

describe('_meta field', () => {
  it('is exposed in the schema', async () => {
    const store = await makeStore(createTestAdapter());
    const gql = buildGraphQLSchema(schema, store);
    expect(gql.getQueryType()!.getFields()['_meta']).toBeDefined();
  });

  it('returns null when no checkpoint has been written', async () => {
    const store = await makeStore(createTestAdapter());
    const gql = buildGraphQLSchema(schema, store);
    const result = await graphql({
      schema: gql,
      source: '{ _meta { block { number } } }',
    });
    expect(result.errors).toBeUndefined();
    expect(result.data!['_meta']).toBeNull();
  });

  it('returns block.number and timestamp after writeBlockCheckpoint', async () => {
    const adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await adapter.transaction(async () => {
      await store.writeBlockCheckpoint(42, undefined, 1700000000);
    });
    const gql = buildGraphQLSchema(schema, store);
    const result = await graphql({
      schema: gql,
      source: '{ _meta { block { number timestamp } tipBlock blocksBehind hasIndexingErrors synced } }',
    });
    expect(result.errors).toBeUndefined();
    const meta = result.data!['_meta'] as Record<string, unknown>;
    expect(meta['block']).toMatchObject({ number: 42, timestamp: 1700000000 });
    expect(meta['tipBlock']).toBeNull();
    expect(meta['blocksBehind']).toBeNull();
    expect(meta['hasIndexingErrors']).toBe(false);
    expect(meta['synced']).toBe(true); // null tipBlock → synced
  });

  it('computes blocksBehind and synced when tipBlock is set', async () => {
    const adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await adapter.transaction(async () => {
      await store.writeBlockCheckpoint(100, 200, 1700000100);
    });
    const gql = buildGraphQLSchema(schema, store);
    const result = await graphql({
      schema: gql,
      source: '{ _meta { block { number timestamp } tipBlock blocksBehind synced } }',
    });
    expect(result.errors).toBeUndefined();
    const meta = result.data!['_meta'] as Record<string, unknown>;
    expect(meta['block']).toMatchObject({ number: 100, timestamp: 1700000100 });
    expect(meta['tipBlock']).toBe(200);
    expect(meta['blocksBehind']).toBe(100);
    expect(meta['synced']).toBe(false);
  });

  it('synced is true when blocksBehind is 0', async () => {
    const adapter = createTestAdapter();
    const store = await makeStore(adapter);
    await adapter.transaction(async () => {
      await store.writeBlockCheckpoint(200, 200);
    });
    const gql = buildGraphQLSchema(schema, store);
    const result = await graphql({ schema: gql, source: '{ _meta { synced blocksBehind } }' });
    expect(result.errors).toBeUndefined();
    const meta = result.data!['_meta'] as Record<string, unknown>;
    expect(meta['blocksBehind']).toBe(0);
    expect(meta['synced']).toBe(true);
  });
});
