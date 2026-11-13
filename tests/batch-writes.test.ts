/**
 * Per-block write batching (M13): beginBatch/flushBatch buffer writes and commit
 * them as multi-row upserts, with read-your-writes inside the batch and reorg
 * journalling preserved (the pre-block prior is captured once, at first touch).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/adapter.js';
import { createStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

function store() {
  const schema = defineSchema({ Counter: { n: { type: 'int' } } }) as Schema<SchemaDefinition>;
  return createStore(schema, new SqliteAdapter(new Database(':memory:')));
}

describe('batched writes — read-your-writes', () => {
  it('sees its own set/update/delete before the flush', async () => {
    const s = await store();
    s.beginBatch();

    await s.set('Counter', 'a', { n: 1 });
    expect(await s.get('Counter', 'a')).toEqual({ id: 'a', n: 1 });   // buffer read, no DB row yet

    await s.update('Counter', 'a', { n: 7 });
    expect(await s.get('Counter', 'a')).toEqual({ id: 'a', n: 7 });   // merge served from buffer

    await s.delete('Counter', 'a');
    expect(await s.get('Counter', 'a')).toBeUndefined();              // tombstone served from buffer

    await s.flushBatch();
    expect(await s.get('Counter', 'a')).toBeUndefined();              // delete won → nothing in DB
  });

  it('commits many buffered rows as one batch', async () => {
    const s = await store();
    s.beginBatch();
    for (let i = 0; i < 250; i++) await s.set('Counter', `k${i}`, { n: i });
    await s.flushBatch();

    expect(await s.count('Counter')).toBe(250);
    expect(await s.get('Counter', 'k0')).toEqual({ id: 'k0', n: 0 });
    expect(await s.get('Counter', 'k249')).toEqual({ id: 'k249', n: 249 });
  });

  it('chunks a block larger than the bind-parameter ceiling', async () => {
    const s = await store();
    s.beginBatch();
    const N = 10_001;                      // perRow=2 → chunkRows=10000 → spills to a 2nd chunk
    for (let i = 0; i < N; i++) await s.set('Counter', `k${i}`, { n: i });
    await s.flushBatch();
    expect(await s.count('Counter')).toBe(N);
    expect(await s.get('Counter', 'k10000')).toEqual({ id: 'k10000', n: 10000 });
  });

  it('last write wins when a key is set repeatedly in one batch', async () => {
    const s = await store();
    s.beginBatch();
    await s.set('Counter', 'a', { n: 1 });
    await s.set('Counter', 'a', { n: 2 });
    await s.set('Counter', 'a', { n: 3 });
    await s.flushBatch();
    expect(await s.get('Counter', 'a')).toEqual({ id: 'a', n: 3 });
    expect(await s.count('Counter')).toBe(1);
  });

  it('an aggregate read inside a batch flushes pending writes first', async () => {
    const s = await store();
    s.beginBatch();
    await s.set('Counter', 'a', { n: 1 });
    await s.set('Counter', 'b', { n: 2 });
    const all = await s.list('Counter');                 // triggers a mid-batch flush
    expect(all.map((r) => r.id).sort()).toEqual(['a', 'b']);
    await s.set('Counter', 'c', { n: 3 });               // buffering resumes after the flush
    await s.flushBatch();
    expect(await s.count('Counter')).toBe(3);
  });
});

describe('batched writes — reorg journalling preserved', () => {
  it('rolls a buffered block back to the pre-block state', async () => {
    const s = await store();
    s.enableReorg(10);

    // Block 1 (buffered): seed `a`.
    s.setReorgContext(1, 0);
    s.beginBatch();
    await s.set('Counter', 'a', { n: 1 });
    await s.flushBatch();

    // Block 2 (buffered): mutate `a`, add `b`. Priors must be journalled at
    // first touch from the DB (a=1, b absent), not from the buffered new values.
    s.setReorgContext(2, 0);
    s.beginBatch();
    await s.update('Counter', 'a', { n: 99 });
    await s.set('Counter', 'b', { n: 5 });
    await s.flushBatch();

    expect(await s.get('Counter', 'a')).toEqual({ id: 'a', n: 99 });
    expect(await s.get('Counter', 'b')).toEqual({ id: 'b', n: 5 });

    // Roll back block 2 → the end-of-block-1 state.
    await s.rollbackToBlock(1, 0);
    expect(await s.get('Counter', 'a')).toEqual({ id: 'a', n: 1 });   // restored prior
    expect(await s.get('Counter', 'b')).toBeUndefined();             // insert undone
  });
});
