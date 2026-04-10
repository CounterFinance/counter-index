# OpKit

Indexer framework for [OPNET](https://opnet.org) (Bitcoin L2). Define a schema, write async event
handlers, persist derived state to SQLite or Postgres, query indexed data over a built-in GraphQL
API with cursor pagination and optional live subscriptions.

OpKit is to OPNET what [Ponder](https://ponder.sh) is to EVM — TypeScript-native, DB-backed,
with auto-generated GraphQL requiring zero codegen.

```
OpStream DB ──→ DbEventSource (source) ──→ OpKit handlers ──→ opkit_* tables (sink)
(blocks/txs/events)                                                  ↓
                                                           indexer.serve()
                                                                  ↓
                                          GraphQL API (http + optional ws) ──→ Frontend
```

OpKit reads raw chain events from an **OpStream-ready database** (source) and writes derived,
indexed state into its own tables (sink). Source and sink can be the same database instance or
separate — your choice at runtime.

**OpKit is a library, not a runnable app.** It has no entry point — you import it, write your
schema and handlers, and run *your* app. OpKit is the engine; your indexer is the shell around it:

```
your-indexer/
  src/
    main.ts          ← ~30 lines: import OpKit, wire schema + handlers, call sync()
    handlers/
      swaps.ts       ← your business logic
  Dockerfile         ← runs main.ts (see OpKit/Dockerfile template)
```

**OpKit is Node.js server-side only.** It cannot run in a browser (`node:sqlite`, no FS).
Frontends query the indexed data through `indexer.serve()` — a GraphQL HTTP server OpKit starts
for you, auto-generated from your schema with no configuration required.

## Requirements

- Node.js >= 22 (uses `node:sqlite` built-in)
- An [OpStream](https://github.com/opnet-devs/opstream)-ready database as the event source

## Install

```bash
npm install @opnet-devs/opkit
```

## Quickstart

```ts
import {
  defineSchema, createIndexer,
  DbEventSource, openSqlite,
} from '@opnet-devs/opkit';

// 1. Define your indexed entities
const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
  Transfer: {
    txHash: { type: 'string' },
    from:   { type: 'string' },
    to:     { type: 'string' },
    value:  { type: 'bigint' },
    block:  { type: 'int' },
  },
});

// 2. Open connections
//    source — read-only, points at OpStream's database
//    sink   — OpKit's own database (separate file or same instance)
const source = new DbEventSource(openSqlite('/path/to/opstream.db'));
const sink   = openSqlite('/path/to/opkit.db');

// 3. Create the indexer (async — creates opkit_* tables in sink DB)
const indexer = await createIndexer({ schema, sink, source });

// 4. Register handlers (async handlers supported)
indexer.on('Transferred', async (event, ctx) => {
  const from  = event.decoded!['from'] as string;
  const to    = event.decoded!['to'] as string;
  const value = BigInt(event.decoded!['value'] as string);

  await ctx.store.set('Transfer', event.txHash, {
    txHash: event.txHash, from, to, value, block: event.blockNumber,
  });

  // ctx.blockTimestamp — unix timestamp of the block (from OpStream's blocks table)
  // event.fromAddress  — who submitted the transaction
  // event.gasUsed      — gas consumed (bigint)
  // event.failed       — true if the transaction reverted

  const sender = await ctx.store.get('Account', from);
  if (sender) {
    await ctx.store.update('Account', from, {
      balance: (sender['balance'] as bigint) - value,
      txCount: (sender['txCount'] as number) + 1,
      lastSeen: event.blockNumber,
    });
  }
});

// 5. Backfill historical blocks
await indexer.sync(941400, latestBlock);

// 6. Go live — polls OpStream DB for new blocks every 10s
const stop = indexer.subscribe(latestBlock + 1);

// 7. Query derived state
const accounts = await indexer.store.list('Account');
const whales   = await indexer.store.find('Account', (a) => (a['balance'] as bigint) > 1_000_000n);
const tx       = await indexer.store.get('Transfer', txHash);

console.log(indexer.stats);
// { eventsProcessed: 1842, eventsDecoded: 1654, eventsSkipped: 188, lastBlock: 9400 }

// 8. Serve a GraphQL API over the indexed data
//    GET  /graphql → GraphiQL playground (open in browser)
//    POST /graphql → execute queries
//    WS   /graphql → live subscriptions (opt-in, same port)
const handle = await indexer.serve({
  port: 4000,
  subscriptions: true,  // optional — requires: npm install graphql-ws ws
});
// → http://localhost:4000/graphql
// → ws://localhost:4000/graphql  (when subscriptions: true)

await handle.stop(); // graceful shutdown
```

## Core Concepts

### Schema (`defineSchema`)

Declare your indexed entities as typed fields. OpKit creates one SQL table per entity in the sink
database, prefixed `opkit_` to avoid collisions with OpStream's raw tables.

```ts
const schema = defineSchema({
  Pool: {
    address:   { type: 'string' },
    token0:    { type: 'string' },
    token1:    { type: 'string' },
    reserve0:  { type: 'bigint' },
    reserve1:  { type: 'bigint' },
    updatedAt: { type: 'int' },
    notes:     { type: 'string', optional: true },
  },
});
```

Field types: `string`, `int`, `float`, `bigint`, `boolean`, `bytes`.

`bigint` values are stored as decimal strings in SQL and deserialised back to `BigInt` on read.

### Handlers (`indexer.on`)

Handlers are async functions that fire when a specific event is seen. They receive the decoded event
and a context with the entity store.

```ts
indexer.on('Synced', async (event, ctx) => {
  const reserve0 = BigInt(event.decoded!['reserve0'] as string);
  const reserve1 = BigInt(event.decoded!['reserve1'] as string);
  await ctx.store.update('Pool', event.contractAddress, { reserve0, reserve1 });
});

indexer.on('*', async (event, ctx) => {
  // wildcard — fires for every event
});
```

### Store (`ctx.store`)

Async CRUD interface backed by the sink database:

```ts
await ctx.store.set('Pool', id, data);         // insert or overwrite
await ctx.store.get('Pool', id);               // lookup by id
await ctx.store.update('Pool', id, partial);   // merge fields (throws if missing)
await ctx.store.delete('Pool', id);            // remove
await ctx.store.list('Pool');                  // all entities
await ctx.store.count('Pool');                 // count
await ctx.store.find('Pool', predicate);       // JS-side filter
```

### Event Context (`DecodedEvent`)

Every handler receives a fully-enriched event:

```ts
event.blockNumber     // block height
event.txHash          // transaction hash
event.contractAddress // emitting contract
event.eventName       // e.g. 'Transferred'
event.decoded         // parsed fields (null if no decoder registered)
event.logIndex        // position within the transaction
event.blockTimestamp  // unix timestamp (from blocks table JOIN)
event.fromAddress     // who submitted the tx (from transactions table JOIN)
event.gasUsed         // bigint — gas consumed
event.burnedBitcoin   // bigint — bitcoin burned as fee
event.failed          // true if the transaction reverted
event.revertReason    // revert message string, if failed
```

### Source and Sink Connections

**Source** — where OpKit reads raw chain events from. Two implementations available:

| | `DbEventSource` | `RpcEventSource` |
|---|---|---|
| Requires | OpStream-ready DB | Any OPNET RPC node |
| Backfill speed | Sub-millisecond (SQL) | O(N) getBlock calls |
| Context richness | Full (tx + block JOINs) | Full (RPC tx fields) |
| Recommended for | Production | Lightweight / no OpStream |

**Sink** — where OpKit writes derived tables. OpKit owns this connection.

```ts
// ── Option 1: OpStream DB (fast — recommended) ────────────────────────────
const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/opkit.db');

// ── Option 2: Direct RPC (no OpStream needed) ─────────────────────────────
import { JSONRpcProvider } from 'opnet';
const source = new RpcEventSource(
  new JSONRpcProvider('https://mainnet.opnet.org'),
  { rpsLimit: 5 },   // ~5 req/s — conservative default
);
const sink = openSqlite('/data/opkit.db');

// ── Option 3: Smart factory — probes DB first, falls back to RPC ──────────
// Give it what you have; it picks the fastest available engine automatically.
import { JSONRpcProvider } from 'opnet';
const source = await createEventSource({
  db:  '/data/opstream.db',                              // Tier 1: try OpStream DB
  rpc: new JSONRpcProvider('https://mainnet.opnet.org'), // Tier 3: RPC fallback
});
// → DbEventSource if opstream.db is ready, RpcEventSource otherwise

// ── Postgres ──────────────────────────────────────────────────────────────
// OpKit's MinimalDbAdapter interface is structurally identical to
// @opnet-devs/opstream's DbAdapter — pass OpStream's adapter directly.
//   const source = new DbEventSource(await openPostgresDb(OPSTREAM_DB_URL));
//   const sink   = await openPostgresDb(OPKIT_DB_URL);
//   const indexer = await createIndexer({ schema, sink, source });
//
// Source and sink can be the same Postgres instance (opkit_* prefix avoids
// table collisions) or separate databases.
```

> **RpcEventSource speed:** backfilling 10,000 blocks takes ~2,000 RPC calls at 5 req/s
> (~7 minutes). `DbEventSource` does the same in milliseconds via a single SQL query.
> Use `RpcEventSource` for lightweight indexers watching recent blocks; use `DbEventSource`
> backed by OpStream for full-history backfills.

### Backfill and Live Indexing

**How it works today:** `sync()` runs a bulk query against the event source (SQL for
`DbEventSource`, getBlock loop for `RpcEventSource`). `subscribe()` polls on an interval —
there is no WebSocket push yet. On OPNET's current ~20 blocks/minute pace a 10-second poll
interval means at most ~3 blocks of lag, acceptable for any non-latency-critical use case.
A Tier-2 WebSocket source (OpStream broadcast server) is on the roadmap for sub-second latency.

```ts
// Backfill a block range (bulk SQL query, single round-trip)
const stats = await indexer.sync(fromBlock, toBlock);

// Backfill with filters (only specific contract or event names)
await indexer.sync(fromBlock, toBlock, {
  contract: '0xmotoswap_pair',
  eventNames: ['Synced', 'Swapped'],
});

// Go live — polls source DB every 10 seconds for new blocks
const stop = indexer.subscribe(latestBlock + 1);

// Custom poll interval (milliseconds)
const stop = indexer.subscribe(latestBlock + 1, { pollIntervalMs: 5000 });

// Stop live indexing
stop();
```

### Feed Events Directly

For WebSocket or other push sources, bypass the EventSource entirely:

```ts
// From a WebSocket push
ws.on('event', async (raw) => {
  await indexer.processRawEvent(raw.eventName, raw.data, {
    blockNumber:    raw.block,
    txHash:         raw.txHash,
    contractAddress:raw.contract,
    blockTimestamp: raw.timestamp,
    fromAddress:    raw.sender,
  });
});

// Pre-decoded event
await indexer.processEvent(event);
await indexer.processEvents(events);
```

### GraphQL API (`indexer.serve`)

OpKit generates a GraphQL schema directly from your `defineSchema()` entities — no SDL file,
no codegen. Call `indexer.serve()` after creating the indexer:

```ts
const handle = await indexer.serve({ port: 4000 });
// → http://localhost:4000/graphql
```

**GET /graphql** serves a GraphiQL playground (CDN-hosted, zero extra files).
**POST /graphql** executes queries.

One query pair is generated per entity. For a `Pool` entity:

```graphql
# Singular — by ID
pool(id: "pool-1") { id address reserve0 reserve1 fee }

# Plural — cursor-paginated Connection
pools(
  where:          { token0: "WBTC", fee_lte: 30, reserve0_gt: "500000" }
  orderBy:        reserve0
  orderDirection: desc
  first:          10
  after:          "Y3Vyc29y..."   # opaque cursor from a previous pageInfo.endCursor
) {
  items { id address reserve0 reserve1 }
  pageInfo { hasNextPage endCursor }
  totalCount
}
```

**Pagination** follows the cursor Connection pattern:

```graphql
# Page 1
pools(first: 10, orderBy: id, orderDirection: asc) {
  items { id }
  pageInfo { hasNextPage endCursor }
  totalCount
}

# Page 2 — pass endCursor from page 1 as `after`
pools(first: 10, orderBy: id, orderDirection: asc, after: "<endCursor>") {
  items { id }
  pageInfo { hasNextPage endCursor }
  totalCount
}
```

`totalCount` always reflects the full filtered set (not just the current page).
`hasNextPage: false` means you've reached the end.
Sorting is stable — ties are broken by id, so cursors are always deterministic.

**Filter operators** per field type:

| Type | Operators |
|---|---|
| `string`, `bytes` | (exact), `_not`, `_contains`, `_starts_with`, `_ends_with` |
| `int`, `float`, `bigint` | (exact), `_not`, `_gt`, `_lt`, `_gte`, `_lte` |
| `boolean` | (exact), `_not` |

`bigint` values are serialised as decimal strings over the wire (`"1000000"`).

**Subscriptions** (optional — requires peer deps):

```bash
npm install graphql-ws ws
```

```ts
const handle = await indexer.serve({ port: 4000, subscriptions: true });
// → ws://localhost:4000/graphql
```

```graphql
# Fires whenever a Pool is written (set or update)
subscription {
  poolUpdated { id address reserve0 reserve1 }
}
```

One subscription per entity (`poolUpdated`, `tokenUpdated`, etc.).
Fires on `store.set()` and `store.update()`. Deletes are not propagated.
The WebSocket server shares the same port as the HTTP server.

```ts
// Graceful shutdown
await handle.stop();
```

## Built-in Event Decoders

OpKit ships decoders for OPNET's big-endian binary event format:

| Event | Protocol | Fields |
|---|---|---|
| `Transferred` | OP-20 | `from`, `to`, `value` |
| `Approval` | OP-20 | `owner`, `spender`, `value` |
| `ApprovalForAll` | OP-721 | `owner`, `operator`, `approved` |
| `Synced` | Motoswap | `reserve0`, `reserve1` |
| `Swapped` | Motoswap | `sender`, `amount0In`, `amount1In`, `amount0Out`, `amount1Out`, `to` |
| `LiquidityAdded` | Motoswap | `sender`, `amount0`, `amount1` |
| `PoolCreated` | Motoswap Factory | `token0`, `token1` |
| `LiquidityListed` | NativeSwap | `totalLiquidity`, `provider` |
| `SwapExecuted` | NativeSwap | `buyer`, `amountIn`, `amountOut` |

Register your own:

```ts
import { registerDecoder } from '@opnet-devs/opkit';

registerDecoder('MyEvent', (rawBytes) => {
  // parse raw bytes → return object or null
  return { field1: readU256(rawBytes, 0) };
});
```

## Contract Standard Detection

```ts
import { isOP20Contract, isOP721Contract, classifyContract } from '@opnet-devs/opkit';

// Classify by observed events — no is_op20 column needed
const type = classifyContract(contractAddress, events);
// → 'op20' | 'op721' | 'unknown'

isOP20Contract(addr, events);   // has Transferred or Approval
isOP721Contract(addr, events);  // has ApprovalForAll (unambiguous OP-721 signal)
```

## Native Token Constants

```ts
import { OPNET_NATIVE_TOKENS, isNativeToken, getNativeToken } from '@opnet-devs/opkit';

// Seed the tokens table on startup (OpKit owns this, OpStream does not)
for (const token of OPNET_NATIVE_TOKENS) {
  db.run(
    'INSERT OR IGNORE INTO tokens (address, symbol, name, decimals) VALUES (?, ?, ?, ?)',
    [token.address, token.symbol, token.name, token.decimals],
  );
}

isNativeToken('0x000...01');         // true (BTC)
getNativeToken('0x000...02');        // { symbol: 'MOTO', decimals: 8, ... }
```

## Project Structure

```
src/
  adapter.ts         # MinimalDbAdapter interface + SqliteAdapter (node:sqlite built-in)
  source.ts          # EventSource interface + DbEventSource (reads OpStream DB)
  rpcSource.ts       # RpcEventSource — indexes directly from OPNET RPC (no OpStream)
  eventSourceFactory.ts # createEventSource() — capability-probing DB→RPC factory
  schema.ts          # defineSchema() — entity definition DSL
  store.ts           # createStore() — async DB-backed entity store (opkit_* tables)
  handler.ts         # HandlerRegistry — async event handler + block handler dispatch
  indexer.ts         # createIndexer() — main orchestrator (+ serve())
  graphql.ts         # GraphQL schema generation + HTTP server (indexer.serve())
  types.ts           # DecodedEvent type (with tx-level context fields)
  standards.ts       # isOP20Contract(), isOP721Contract(), classifyContract()
  tokens.ts          # OPNET_NATIVE_TOKENS, getNativeToken(), isNativeToken()
  decoders/
    eventDecoders.ts # Built-in OPNET binary event decoders
tests/
  schema.test.ts
  store.test.ts
  indexer.test.ts
  source.test.ts     # DbEventSource with seeded in-memory OpStream schema
  rpcSource.test.ts  # RpcEventSource with mock BlockProvider
  eventSourceFactory.test.ts
  graphql.test.ts    # GraphQL schema, resolvers, filters, ordering, pagination, serve()
  standards.test.ts
  tokens.test.ts
  decoders.test.ts
```

## Deployment

OpKit ships a `Dockerfile` template and `docker-compose.yml` for running the full stack.

**`Dockerfile`** — a starting point for your indexer app. Copy it to your project, update the
`COPY` paths and `CMD` to point at your `src/main.ts`, and build:

```bash
# From the Opnet-devs/ parent (required for the file:../OpKit dep)
docker build -f MyIndexer/Dockerfile -t my-indexer ..
```

**`docker-compose.yml`** — wires OpStream (chain scanner) + your indexer together:

```
opstream       → scans blocks → writes opstream.db
opkit-indexer  → reads opstream.db (source) → writes opkit.db (sink)
```

SQLite: two separate DB files on a shared Docker volume.
Postgres: same instance, `opkit_*` prefix prevents table collisions.

```bash
# SQLite (default)
just docker-up

# Postgres (bundled)
just docker-up -- --profile postgres
```

See `docker-compose.yml` for the full service definitions and `justfile` for all commands.

## Development

```bash
npm install
npm test             # vitest (155 tests)
npm run test:watch   # watch mode
```

One runtime dependency: `graphql` (schema + query engine). SQLite uses `node:sqlite` (Node 22+
built-in). `graphql-ws` and `ws` are optional peer deps — only needed for subscriptions.

## Roadmap

- [ ] Reorg handling — rollback derived `opkit_*` state on chain reorgs
- [x] Block handlers — `indexer.onBlock(handler)` fires after every block's events are processed
- [x] `RpcEventSource` — index directly from OPNET RPC, no OpStream required
- [x] `createEventSource` — capability-probing factory (DB → RPC fallback)
- [x] GraphQL API — `indexer.serve()` auto-generates schema + resolvers from `defineSchema()`, cursor pagination, GraphiQL playground
- [x] GraphQL subscriptions — `serve({ subscriptions: true })` via `graphql-ws` (optional peer dep)
- [ ] Tier 2 EventSource — OpStream WebSocket endpoint (sub-second latency, blocked on OpStream enriching its WebhookEvent payload)
- [ ] CLI scaffolding (`opkit init`)

## License

MIT
