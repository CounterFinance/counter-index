/**
 * Property test (fast-check): rolling back to a fork undoes EVERYTHING after it —
 * apply∘undo = identity. For any random sequence of set/delete ops across blocks
 * and any fork point, a store that applies ALL ops then rolls back to the fork
 * must equal a fresh store that only applied ops up to the fork.
 */

import { describe, it } from 'vitest';
import fc from 'fast-check';
import Database from 'better-sqlite3';
import { createStore, type EntityStore } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';

const schema = defineSchema({ E: { n: { type: 'int' } } }) as Schema<SchemaDefinition>;

interface Op { block: number; key: string; del: boolean; n: number }
const opArb = fc.record({
  block: fc.integer({ min: 1, max: 8 }),
  key: fc.constantFrom('a', 'b', 'c', 'd'),
  del: fc.boolean(),
  n: fc.integer({ min: 0, max: 100 }),
});

async function freshStore(reorg: boolean): Promise<EntityStore> {
  const store = await createStore(schema, new SqliteAdapter(new Database(':memory:')));
  if (reorg) store.enableReorg(1000);
  return store;
}

async function apply(store: EntityStore, ops: Op[], maxBlock: number): Promise<void> {
  for (const o of ops) {
    if (o.block > maxBlock) continue;
    store.setReorgContext(o.block, 1);
    if (o.del) await store.delete('E', o.key);
    else await store.set('E', o.key, { n: o.n });
  }
}

async function dump(store: EntityStore): Promise<string> {
  const rows = (await store.list('E')).map((r) => ({ id: r['id'], n: r['n'] }));
  rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify(rows);
}

describe('reorg journal property', () => {
  it('rollback to a fork undoes everything after it (apply∘undo = identity)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), fc.integer({ min: 0, max: 9 }), async (ops, fork) => {
        const sorted = [...ops].sort((a, b) => a.block - b.block);

        const ref = await freshStore(false);
        await apply(ref, sorted, fork);                 // only blocks <= fork
        const expected = await dump(ref);

        const main = await freshStore(true);
        await apply(main, sorted, 99);                  // all blocks
        await main.rollbackToBlock(fork, 1);            // then undo everything after the fork
        const actual = await dump(main);

        return actual === expected;
      }),
      { numRuns: 150 },
    );
  });
});
