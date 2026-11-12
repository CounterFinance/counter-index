/**
 * Postgres contract test against a REAL database (not the recording mock in
 * postgres.test.ts). Skipped unless PG_URL is set; `npm run test:pg` spins a
 * dockerized Postgres, sets PG_URL, runs this, and tears the container down.
 *
 * Proves the Postgres adapter path end-to-end: DDL, CRUD, upsert, list/count,
 * the reorg journal + rollback, and checkpoints — on actual Postgres.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPostgres, type MinimalDbAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

const PG = process.env.PG_URL;
const suite = PG ? describe : describe.skip;

suite('Postgres integration (real connection)', () => {
  let adapter: MinimalDbAdapter;

  beforeAll(async () => {
    adapter = await openPostgres(PG as string);
    // Clean slate — drop any op-index tables from a previous run.
    const rows = await adapter.all<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE tablename LIKE 'opindex_%'",
    );
    for (const r of rows) await adapter.exec(`DROP TABLE IF EXISTS "${r.tablename}" CASCADE`);
  });
  afterAll(async () => {
    await (adapter as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('round-trips CRUD + upsert + typed fields', async () => {
    const schema = defineSchema({ Acct: { bal: { type: 'bigint' }, name: { type: 'string' }, flag: { type: 'boolean' } } }) as Schema<SchemaDefinition>;
    const store = await createStore(schema, adapter);

    await store.set('Acct', 'a', { bal: 100n, name: 'alice', flag: true });
    const got = await store.get('Acct', 'a');
    expect(got!['bal']).toBe(100n);            // bigint round-trips through pg TEXT
    expect(got!['name']).toBe('alice');
    expect(got!['flag']).toBe(true);           // native pg boolean

    await store.update('Acct', 'a', { bal: 150n });
    expect((await store.get('Acct', 'a'))!['bal']).toBe(150n);

    await store.set('Acct', 'a', { bal: 200n, name: 'alice', flag: false });   // upsert (ON CONFLICT)
    expect((await store.get('Acct', 'a'))!['bal']).toBe(200n);
    expect(await store.count('Acct')).toBe(1);

    await store.delete('Acct', 'a');
    expect(await store.get('Acct', 'a')).toBeUndefined();
  });

  it('reorg journal + rollback on real Postgres', async () => {
    const schema = defineSchema({ Bal: { n: { type: 'int' } } }) as Schema<SchemaDefinition>;
    const store = await createStore(schema, adapter);
    store.enableReorg(1000);

    store.setReorgContext(1, 1); await store.set('Bal', 'x', { n: 10 });
    store.setReorgContext(2, 1); await store.set('Bal', 'x', { n: 20 });
    store.setReorgContext(3, 1); await store.set('Bal', 'y', { n: 5 });
    store.setReorgContext(4, 1); await store.set('Bal', 'x', { n: 999 }); await store.delete('Bal', 'y');

    await store.rollbackToBlock(2, 1);           // undo blocks 3 & 4
    expect((await store.get('Bal', 'x'))!['n']).toBe(20);   // restored
    expect(await store.get('Bal', 'y')).toBeUndefined();    // y never existed at block 2
  });

  it('batched block writes (multi-row upsert) on real Postgres', async () => {
    const schema = defineSchema({ Tok: { bal: { type: 'bigint' }, sym: { type: 'string' } } }) as Schema<SchemaDefinition>;
    const store = await createStore(schema, adapter);

    // Simulate one block: buffer many writes, flush as chunked multi-row upserts.
    store.beginBatch();
    for (let i = 0; i < 500; i++) await store.set('Tok', `t${i}`, { bal: BigInt(i), sym: `S${i}` });
    await store.update('Tok', 't0', { bal: 1_000n });   // read-your-writes inside the batch
    expect((await store.get('Tok', 't0'))!['bal']).toBe(1_000n);
    await store.flushBatch();

    expect(await store.count('Tok')).toBe(500);
    expect((await store.get('Tok', 't0'))!['bal']).toBe(1_000n);   // merged value persisted
    expect((await store.get('Tok', 't499'))!['bal']).toBe(499n);

    // Re-flush the same keys (ON CONFLICT DO UPDATE path) + a batched delete.
    store.beginBatch();
    await store.set('Tok', 't1', { bal: 7n, sym: 'X' });
    await store.delete('Tok', 't2');
    await store.flushBatch();
    expect((await store.get('Tok', 't1'))!['bal']).toBe(7n);
    expect(await store.get('Tok', 't2')).toBeUndefined();
    expect(await store.count('Tok')).toBe(499);
  });

  it('query pushdown: filters, bigint NUMERIC order, keyset — on real Postgres', async () => {
    const schema = defineSchema({ Pos: { amount: { type: 'bigint', index: true }, owner: { type: 'string', index: true } } }) as Schema<SchemaDefinition>;
    const store = await createStore(schema, adapter);
    // Big values where lexical != numeric (and beyond 2^53, so REAL would be wrong).
    await store.set('Pos', 'a', { amount: 2n, owner: 'x' });
    await store.set('Pos', 'b', { amount: 100000000000000000009n, owner: 'y' });
    await store.set('Pos', 'c', { amount: 30n, owner: 'x' });
    await store.set('Pos', 'd', { amount: 100000000000000000008n, owner: 'x' });

    // Numeric order (Postgres NUMERIC is exact for uint256-scale values).
    expect((await store.query('Pos', { orderBy: 'amount', orderDirection: 'asc' })).map((r) => r.id)).toEqual(['a', 'c', 'd', 'b']);
    // Filter + range.
    expect((await store.query('Pos', { where: [{ field: 'owner', op: 'eq', value: 'x' }, { field: 'amount', op: 'gt', value: 2n }] })).map((r) => r.id).sort()).toEqual(['c', 'd']);
    expect(await store.countWhere('Pos', [{ field: 'owner', op: 'eq', value: 'x' }])).toBe(3);

    // Keyset page 2 (desc).
    const p1 = await store.query('Pos', { orderBy: 'amount', orderDirection: 'desc', limit: 2 });
    expect(p1.map((r) => r.id)).toEqual(['b', 'd']);
    const p2 = await store.query('Pos', { orderBy: 'amount', orderDirection: 'desc', limit: 2, cursor: { sortValue: p1[1].amount, id: p1[1].id as string } });
    expect(p2.map((r) => r.id)).toEqual(['c', 'a']);
  });

  it('checkpoints read/write', async () => {
    const schema = defineSchema({ Z: { v: { type: 'int' } } }) as Schema<SchemaDefinition>;
    const store = await createStore(schema, adapter);
    await store.writeBlockCheckpoint(42, 100, 1_700_000_000);
    const cp = await store.readCheckpoint();
    expect(cp?.lastBlock).toBe(42);
    expect(cp?.tipBlock).toBe(100);
  });
});
