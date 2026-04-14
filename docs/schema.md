# Schema

The schema is the contract between your business logic and op-index's storage layer. Define it once
— op-index uses it to create SQL tables, validate store writes, and auto-generate your entire GraphQL
API. No SDL, no migration files, no codegen step.

## defineSchema

```ts
import { defineSchema } from '@opnet-collective/op-index';

const schema = defineSchema({
  Pool: {
    address:   { type: 'string' },
    token0:    { type: 'string' },
    token1:    { type: 'string' },
    reserve0:  { type: 'bigint' },
    reserve1:  { type: 'bigint' },
    feeBps:    { type: 'int' },
    active:    { type: 'boolean' },
    notes:     { type: 'string', optional: true },
  },
});
```

Each top-level key is an **entity name**. Each value is a map of **field names** to field
definitions. Every entity gets an implicit `id: string` primary key — you supply the id value
when calling `store.set()`.

## Field types

| Type | TypeScript | SQL storage | GraphQL type |
|---|---|---|---|
| `string` | `string` | `TEXT` | `String` |
| `int` | `number` | `INTEGER` / `BIGINT` | `Int` |
| `float` | `number` | `REAL` / `DOUBLE PRECISION` | `Float` |
| `bigint` | `bigint` | `TEXT` (decimal string) | `BigInt` (custom scalar) |
| `boolean` | `boolean` | `INTEGER` (0/1) / `BOOLEAN` | `Boolean` |
| `bytes` | `Buffer` / `Uint8Array` | `BLOB` / `BYTEA` | `String` (hex) |

### bigint

OPNET deals heavily in 256-bit integers. op-index stores `bigint` values as decimal strings in SQL
(there is no native 256-bit integer type in SQLite or Postgres) and deserialises them back to
`BigInt` on every read. Over GraphQL they are serialised as decimal strings again — pass them as
quoted string literals in queries:

```graphql
pools(where: { reserve0_gt: "1000000000000000000" }) { items { id reserve0 } }
```

### bytes

Store raw binary data (event payloads, hashes). op-index does not automatically hex-encode bytes
fields — that is left to your handler. When exposed over GraphQL, `bytes` fields are typed as
`String` and whatever value you stored is returned verbatim.

## Optional fields

By default every field is `NOT NULL`. Mark a field `optional: true` when it may be absent:

```ts
const schema = defineSchema({
  Pool: {
    notes: { type: 'string', optional: true }, // nullable in SQL + GraphQL
  },
});
```

In the store, writing `undefined` or omitting an optional field stores `NULL`. Reading it back
returns `undefined`. Over GraphQL it serialises as `null`.

## SQL table names

op-index prefixes every table with `opindex_` (lowercased entity name) to avoid collisions with
OpStream's raw tables when both live in the same database:

| Entity | Table |
|---|---|
| `Pool` | `opindex_pool` |
| `Transfer` | `opindex_transfer` |
| `LiquidityPosition` | `opindex_liquidityposition` |

Tables are created with `CREATE TABLE IF NOT EXISTS` — running `createIndexer()` multiple times
on the same database is safe and idempotent.

## Multiple entities

A schema can define as many entities as you need. They are independent — no foreign key
relationships are enforced at the SQL level (you manage references yourself in handlers):

```ts
const schema = defineSchema({
  Pool:     { address: { type: 'string' }, reserve0: { type: 'bigint' }, reserve1: { type: 'bigint' } },
  Swap:     { poolId: { type: 'string' }, amountIn: { type: 'bigint' }, amountOut: { type: 'bigint' }, trader: { type: 'string' } },
  Candle:   { poolId: { type: 'string' }, open: { type: 'bigint' }, close: { type: 'bigint' }, block: { type: 'int' } },
});
```

## TypeScript inference

`defineSchema` is fully generic. The entity names and field types flow through to `store.set()`
and `store.get()` — you get autocomplete on entity names and compile-time errors if you pass an
unknown entity:

```ts
// ✓ TypeScript knows 'Pool' is valid
await ctx.store.set('Pool', id, { address: '0x...', reserve0: 1000n });

// ✗ TypeScript error — 'Swap' not in schema (if not defined)
await ctx.store.set('Swap', id, { ... });
```

> **Note:** Field-level type checking inside the data object is not enforced at compile time —
> TypeScript sees `Record<string, unknown>` for the data argument. Mismatches will surface as
> runtime errors from the SQL layer. This is a known limitation; typed store writes are on the
> roadmap.
