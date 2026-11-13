/**
 * Compile-time tests for the schema-inferred typed store (M3).
 *
 * Checked by `npm run typecheck` (tsconfig.typecheck.json), NOT shipped in the
 * build. Each `@ts-expect-error` is itself a test: if the line below it stops
 * being an error, tsc fails with "Unused '@ts-expect-error' directive". So this
 * file passing proves the typed store both ACCEPTS correct usage and REJECTS
 * the listed mistakes.
 */

import { createIndexer, defineSchema, openSqlite } from '../src/index.js';

const schema = defineSchema({
  TokenHolder: {
    token:   { type: 'string' },
    holder:  { type: 'string' },
    balance: { type: 'bigint' },
    note:    { type: 'string', optional: true },
  },
});

// Never executed — this file exists only to be type-checked.
export async function _storeTypeTests(): Promise<void> {
  const indexer = await createIndexer({ schema, sink: openSqlite(':memory:') });

  indexer.on('Transferred', async (_event, ctx) => {
    // ✓ correct shape (optional field omitted)
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h', balance: 1n });
    // ✓ optional field supplied
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h', balance: 1n, note: 'x' });
    // ✓ partial update
    await ctx.store.update('TokenHolder', 'id', { balance: 2n });

    // ✗ balance must be bigint, not string
    // @ts-expect-error
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h', balance: 'nope' });

    // ✗ unknown entity name
    // @ts-expect-error
    await ctx.store.set('Nope', 'id', { anything: 1 });

    // ✗ missing required field 'balance'
    // @ts-expect-error
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h' });

    // ✗ unknown field
    // @ts-expect-error
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h', balance: 1n, bogus: 1 });

    const row = await ctx.store.get('TokenHolder', 'id');
    if (row) {
      const b: bigint = row.balance;   // ✓ inferred as bigint
      const id: string = row.id;       // ✓ read rows carry the stamped id
      void b; void id;
      // ✗ balance is bigint, not string
      // @ts-expect-error
      const s: string = row.balance;
      void s;
    }
  });

  // ✓ block handler store is typed too
  indexer.onBlock(async (ctx) => {
    await ctx.store.set('TokenHolder', 'id', { token: 't', holder: 'h', balance: 0n });
  });
}
