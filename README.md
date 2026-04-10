# OpKit

Indexer framework for [OPNET](https://opnet.org) (Bitcoin L2). Define a schema, write async event
handlers, persist derived state to SQLite or Postgres, query indexed data.

OpKit is to OPNET what [Ponder](https://ponder.sh) is to EVM — TypeScript-native, DB-backed,
no GraphQL required.

```
OpStream DB ──→ DbEventSource (source) ──→ OpKit handlers ──→ opkit_* tables (sink)
(blocks/txs/events)                                                  ↓
                                                           Your app / dashboard
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

**OpKit is Node.js server-side only.** It cannot run in a browser (`node:sqlite`, no FS). Your
frontend or any HTTP client reads from the `opkit_*` tables OpKit maintains — through a database
connection or an HTTP API layer you build on top.

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

**Source** — where OpKit reads raw chain events from. Points at an OpStream-ready database.
Read-only from OpKit's perspective.

**Sink** — where OpKit writes derived tables. OpKit owns this connection.

```ts
// SQLite — two separate files (recommended for local setups)
const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/opkit.db');

// Postgres — pass any MinimalDbAdapter-compatible adapter as source or sink.
// OpKit's MinimalDbAdapter interface is structurally identical to
// @opnet-devs/opstream's DbAdapter, so the OpStream adapter passes through
// directly with no import needed.
//
// Example using OpStream's PostgresAdapter:
//   const source = new DbEventSource(await openPostgresDb(OPSTREAM_DB_URL));
//   const sink   = await openPostgresDb(OPKIT_DB_URL);
//   const indexer = await createIndexer({ schema, sink, source });
//
// Source and sink can be the same Postgres database (opkit_* prefix avoids
// table collisions) or separate databases in the same instance.
```

### Backfill and Live Indexing

**How it works today:** `sync()` runs a single bulk SQL query against OpStream's `events` table
(with JOINs for tx and block context). `subscribe()` polls that same table on an interval —
there is no WebSocket push yet. On OPNET's current ~20 blocks/minute pace a 10-second poll
interval means at most ~3 blocks of lag, which is well within acceptable range for any
non-latency-critical use case. A `RpcEventSource` backed by OpStream's WebSocket broadcast
server is on the roadmap for when sub-second latency or remote deployment matters.

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
  schema.ts          # defineSchema() — entity definition DSL
  store.ts           # createStore() — async DB-backed entity store (opkit_* tables)
  handler.ts         # HandlerRegistry — async event handler dispatch
  indexer.ts         # createIndexer() — main orchestrator
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
npm test             # vitest (76 tests)
npm run test:watch   # watch mode
```

Zero npm runtime dependencies — uses `node:sqlite` (Node 22+ built-in).

## Roadmap

- [ ] Reorg handling — rollback derived state on chain reorgs
- [ ] Block handlers — run logic every block, not just on events
- [ ] `RpcEventSource` — subscribe to OpStream's WebSocket instead of polling DB
- [ ] CLI scaffolding (`opkit init`)

## License

MIT
