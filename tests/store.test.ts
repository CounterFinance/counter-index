/**
 * EntityStore — DB-backed store tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { defineSchema } from '../src/schema.js';
import { createStore } from '../src/store.js';
import { createTestAdapter, type SqliteAdapter } from '../src/adapter.js';
import type { MinimalDbAdapter } from '../src/adapter.js';

const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    active:   { type: 'boolean' },
    lastSeen: { type: 'int', optional: true },
  },
  Transfer: {
    txHash: { type: 'string' },
    from:   { type: 'string' },
    to:     { type: 'string' },
    value:  { type: 'bigint' },
    block:  { type: 'int' },
  },
});

let adapter: MinimalDbAdapter;

beforeEach(() => {
  adapter = createTestAdapter();
});

describe('createStore', () => {
  it('creates tables without error', async () => {
    await expect(createStore(schema, adapter)).resolves.toBeDefined();
  });

  it('creates opindex_* prefixed tables', async () => {
    await createStore(schema, adapter);
    const raw = (adapter as SqliteAdapter).rawDb;
    const tables = raw.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'opindex_%'`,
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('opindex_account');
    expect(names).toContain('opindex_transfer');
  });

  it('is idempotent — creating twice does not throw', async () => {
    await createStore(schema, adapter);
    await expect(createStore(schema, adapter)).resolves.toBeDefined();
  });
});

describe('set / get', () => {
  it('stores and retrieves a record', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'alice', {
      address: '0xalice', balance: 1000n, txCount: 3, active: true,
    });
    const record = await store.get('Account', 'alice');
    expect(record).toBeDefined();
    expect(record!['address']).toBe('0xalice');
    expect(record!['balance']).toBe(1000n);
    expect(record!['txCount']).toBe(3);
    expect(record!['active']).toBe(true);
  });

  it('overwrites an existing record on set', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'alice', { address: '0xa', balance: 100n, txCount: 1, active: true });
    await store.set('Account', 'alice', { address: '0xa', balance: 999n, txCount: 5, active: false });
    const record = await store.get('Account', 'alice');
    expect(record!['balance']).toBe(999n);
    expect(record!['active']).toBe(false);
  });

  it('returns undefined for missing id', async () => {
    const store = await createStore(schema, adapter);
    expect(await store.get('Account', 'nobody')).toBeUndefined();
  });

  it('throws on unknown entity', async () => {
    const store = await createStore(schema, adapter);
    await expect(store.get('Unknown', 'id')).rejects.toThrow();
  });

  it('serialises bigint as string and deserialises back', async () => {
    const store = await createStore(schema, adapter);
    const big = 123456789012345678901234567890n;
    await store.set('Account', 'whale', { address: '0xw', balance: big, txCount: 0, active: true });
    const record = await store.get('Account', 'whale');
    expect(record!['balance']).toBe(big);
  });
});

describe('update', () => {
  it('merges partial fields', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'bob', { address: '0xbob', balance: 500n, txCount: 2, active: true });
    await store.update('Account', 'bob', { txCount: 10, balance: 200n });
    const record = await store.get('Account', 'bob');
    expect(record!['txCount']).toBe(10);
    expect(record!['balance']).toBe(200n);
    expect(record!['address']).toBe('0xbob');
  });

  it('throws if entity not found', async () => {
    const store = await createStore(schema, adapter);
    await expect(store.update('Account', 'ghost', { txCount: 1 })).rejects.toThrow();
  });
});

describe('delete', () => {
  it('removes an entity', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'alice', { address: '0xa', balance: 0n, txCount: 0, active: false });
    await store.delete('Account', 'alice');
    expect(await store.get('Account', 'alice')).toBeUndefined();
  });

  it('no-op on missing entity', async () => {
    const store = await createStore(schema, adapter);
    await expect(store.delete('Account', 'nobody')).resolves.toBeUndefined();
  });
});

describe('list / count', () => {
  it('lists all entities', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'a1', { address: '0x1', balance: 0n, txCount: 0, active: true });
    await store.set('Account', 'a2', { address: '0x2', balance: 0n, txCount: 0, active: true });
    expect(await store.list('Account')).toHaveLength(2);
  });

  it('counts correctly', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'a1', { address: '0x1', balance: 0n, txCount: 0, active: true });
    await store.set('Account', 'a2', { address: '0x2', balance: 0n, txCount: 0, active: true });
    expect(await store.count('Account')).toBe(2);
    await store.delete('Account', 'a1');
    expect(await store.count('Account')).toBe(1);
  });
});

describe('find', () => {
  it('filters by predicate', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'rich',  { address: '0xr', balance: 1_000_000n, txCount: 10, active: true });
    await store.set('Account', 'poor',  { address: '0xp', balance: 100n, txCount: 1, active: true });
    await store.set('Account', 'broke', { address: '0xb', balance: 0n, txCount: 0, active: false });
    const whales = await store.find('Account', (r) => (r['balance'] as bigint) > 500n);
    expect(whales).toHaveLength(1);
    expect(whales[0]!['address']).toBe('0xr');
  });
});

describe('entity isolation', () => {
  it('different entities do not interfere', async () => {
    const store = await createStore(schema, adapter);
    await store.set('Account', 'id1', { address: '0xa', balance: 0n, txCount: 0, active: true });
    await store.set('Transfer', 'id1', { txHash: '0xtx', from: '0xa', to: '0xb', value: 100n, block: 1 });
    expect(await store.count('Account')).toBe(1);
    expect(await store.count('Transfer')).toBe(1);
  });
});
