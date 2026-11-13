/**
 * Reorg hardening (M11): atomic rollback (+ checkpoint rewind in the same
 * transaction), crash-during-rollback consistency, and deep-reorg detection
 * (a fork below the retained finality window stops loudly, never diverges).
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter, type MinimalDbAdapter } from '../src/adapter.js';
import { createStore, DeepReorgError } from '../src/store.js';
import { defineSchema, type Schema, type SchemaDefinition } from '../src/schema.js';

const schema = defineSchema({ Bal: { n: { type: 'int' } } }) as Schema<SchemaDefinition>;

/** Seed a reorg-enabled store with 4 journalled blocks + block hashes. */
async function seeded(adapter: MinimalDbAdapter) {
  const store = await createStore(schema, adapter);
  store.enableReorg(1000);
  for (let b = 1; b <= 4; b++) {
    store.setReorgContext(b, 0);
    await store.set('Bal', 'x', { n: b * 10 });
    if (b >= 3) await store.set('Bal', 'y', { n: b });
    await store.recordBlockHash(0, b, `0x${b}`);
    await store.writeBlockCheckpoint(b, undefined, undefined, undefined);
  }
  return store;
}

describe('atomic rollback + checkpoint rewind', () => {
  it('rewinds data AND the checkpoint together', async () => {
    const store = await seeded(new SqliteAdapter(new Database(':memory:')));
    expect((await store.readCheckpoint())!.lastBlock).toBe(4);

    await store.rollbackToBlock(2, 0);

    expect((await store.get('Bal', 'x'))!['n']).toBe(20);     // block-2 state
    expect(await store.get('Bal', 'y')).toBeUndefined();      // y first appeared at block 3
    expect((await store.readCheckpoint())!.lastBlock).toBe(2); // checkpoint rewound in the same txn
  });
});

describe('crash during rollback → consistent (atomic)', () => {
  it('a failure mid-rollback leaves the pre-rollback state fully intact', async () => {
    const inner = new SqliteAdapter(new Database(':memory:'));
    let armed = false;
    const flaky: MinimalDbAdapter = {
      dialect: inner.dialect,
      run: (sql, p) => {
        if (armed && sql.includes('DELETE FROM counterindex_journal')) throw new Error('crash mid-rollback');
        return inner.run(sql, p);
      },
      get: (sql, p) => inner.get(sql, p),
      all: (sql, p) => inner.all(sql, p),
      exec: (sql) => inner.exec(sql),
      transaction: (fn) => inner.transaction(fn),
    };
    const store = await seeded(flaky);
    armed = true;

    await expect(store.rollbackToBlock(2, 0)).rejects.toThrow('crash mid-rollback');

    // The whole rollback transaction was rolled back — nothing half-applied.
    expect((await store.get('Bal', 'x'))!['n']).toBe(40);      // still block-4 state
    expect((await store.get('Bal', 'y'))!['n']).toBe(4);       // y still present
    expect((await store.readCheckpoint())!.lastBlock).toBe(4); // checkpoint not rewound
    // Journal intact → a retry can still roll back correctly.
    armed = false;
    await store.rollbackToBlock(2, 0);
    expect((await store.get('Bal', 'x'))!['n']).toBe(20);
    expect(await store.get('Bal', 'y')).toBeUndefined();
  });
});

describe('deep-reorg detection', () => {
  it('throws DeepReorgError when the fork is below the retained finality window', async () => {
    const store = await seeded(new SqliteAdapter(new Database(':memory:')));
    // Finality pruning drops journal + hashes at/below block 2 — blocks 3,4 retained.
    await store.pruneReorgData(0, 2);

    // Rolling back to block 1 needs the (now pruned) journal for block 2 → impossible.
    await expect(store.rollbackToBlock(1, 0)).rejects.toBeInstanceOf(DeepReorgError);

    // A rollback within the retained window still works.
    await store.rollbackToBlock(3, 0);
    expect((await store.get('Bal', 'x'))!['n']).toBe(30);
  });

  it('DeepReorgError carries the requested block + retained floor', async () => {
    const store = await seeded(new SqliteAdapter(new Database(':memory:')));
    await store.pruneReorgData(0, 2);
    await store.rollbackToBlock(0, 0).catch((e: unknown) => {
      expect(e).toBeInstanceOf(DeepReorgError);
      const d = e as DeepReorgError;
      expect(d.requestedBlock).toBe(0);
      expect(d.retainedFloor).toBe(3);
      expect(d.chainId).toBe(0);
    });
  });
});
