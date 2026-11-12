/**
 * Reorg journal + rollback (store level), deterministic — no network.
 * Proves: index blocks, rollback to a fork, re-index the canonical branch →
 * final state EQUALS a from-scratch index of the canonical history.
 * See docs/reorg-design.md.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createStore, type EntityStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';

const schema = defineSchema({
  Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } },
}) as Schema<SchemaDefinition>;

const CHAIN = 1;

async function newStore(): Promise<EntityStore> {
  const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
  store.enableReorg(50);
  return store;
}

/** Apply a write at a given block (sets the journal context first). */
async function at(store: EntityStore, block: number, fn: (s: EntityStore) => Promise<void>): Promise<void> {
  store.setReorgContext(block, CHAIN);
  await fn(store);
}

async function dump(store: EntityStore): Promise<Record<string, bigint>> {
  const rows = await store.list('Balance');
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r['holder'] as string] = r['amount'] as bigint;
  return out;
}

let store: EntityStore;
beforeEach(async () => { store = await newStore(); });

describe('reorg journal + rollbackToBlock', () => {
  it('rollback + re-index equals a fresh index of the canonical chain', async () => {
    // Shared prefix (blocks 1-3)
    await at(store, 1, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 100n }); });
    await at(store, 2, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 150n }); });
    await at(store, 3, async (s) => { await s.set('Balance', 'bob', { holder: 'bob', amount: 50n }); });

    // Orphaned branch (blocks 4-5): update alice, create carol, delete bob
    await at(store, 4, async (s) => {
      await s.set('Balance', 'alice', { holder: 'alice', amount: 999n });
      await s.set('Balance', 'carol', { holder: 'carol', amount: 7n });
    });
    await at(store, 5, async (s) => { await s.delete('Balance', 'bob'); });

    expect(await dump(store)).toEqual({ alice: 999n, carol: 7n });   // bob deleted

    // Reorg: roll back to block 3, then index the canonical block 4'
    await store.rollbackToBlock(3, CHAIN);
    expect(await dump(store)).toEqual({ alice: 150n, bob: 50n });    // carol gone, bob+alice restored

    await at(store, 4, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 200n }); });

    // Fresh store indexing ONLY the canonical history 1,2,3,4'
    const fresh = await newStore();
    await at(fresh, 1, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 100n }); });
    await at(fresh, 2, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 150n }); });
    await at(fresh, 3, async (s) => { await s.set('Balance', 'bob', { holder: 'bob', amount: 50n }); });
    await at(fresh, 4, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 200n }); });

    expect(await dump(store)).toEqual(await dump(fresh));
    expect(await dump(store)).toEqual({ alice: 200n, bob: 50n });
  });

  it('records and reads block hashes; prunes below finality', async () => {
    await store.recordBlockHash(CHAIN, 10, '0xaaa');
    await store.recordBlockHash(CHAIN, 11, '0xbbb');
    expect(await store.getBlockHash(CHAIN, 10)).toBe('0xaaa');
    expect(await store.getBlockHash(CHAIN, 99)).toBeUndefined();
    await store.pruneReorgData(CHAIN, 10);
    expect(await store.getBlockHash(CHAIN, 10)).toBeUndefined();   // pruned
    expect(await store.getBlockHash(CHAIN, 11)).toBe('0xbbb');     // kept
  });

  it('rolling back with no journal entries is a no-op', async () => {
    await at(store, 1, async (s) => { await s.set('Balance', 'alice', { holder: 'alice', amount: 1n }); });
    await store.rollbackToBlock(5, CHAIN);   // nothing after block 5
    expect(await dump(store)).toEqual({ alice: 1n });
  });
});
