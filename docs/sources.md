# Sources

An EventSource is what counter-index reads raw chain events from. It is completely decoupled from the
sink (where counter-index writes your indexed tables) — they can be different databases, different
servers, or different technologies entirely.

counter-index ships two source implementations and a smart factory that picks the best one available.

## Comparison

| | `DbEventSource` | `WsEventSource` | `RpcEventSource` |
|---|---|---|---|
| Requires | OpStream-ready SQLite or Postgres | OpStream WebSocket broadcast | Any OPNET RPC endpoint |
| Backfill speed | Sub-millisecond (single SQL query) | ❌ Live-only | O(N) `getBlock` calls |
| Live latency | ~10 s poll interval | Sub-second push | ~10 s poll interval |
| Context richness | Full — tx fields + block JOINs | Full — 15-field enriched payload | Full — RPC tx fields |
| Best for | Production, full-history backfills | Low-latency live indexers | Lightweight indexers, no OpStream |

---

## DbEventSource

Reads from an [OpStream](https://github.com/opnet-collective/opstream)-ready database. OpStream
pre-indexes all OPNET blocks, transactions, and events into a structured schema — `DbEventSource`
queries that schema with a single SQL statement per `sync()` call, making historical backfills
essentially instantaneous.

```ts
import { DbEventSource, openSqlite } from '@counterfinance/counter-index';

const source = new DbEventSource(openSqlite('/data/opstream.db'));
```

### With Postgres

counter-index ships its own `PostgresAdapter` backed by the `postgres` npm package. Use `openPostgres()`
for both the source (reading from an OpStream Postgres DB) and the sink:

```ts
import { DbEventSource, openPostgres, createIndexer } from '@counterfinance/counter-index';

const source = new DbEventSource(await openPostgres(process.env.OPSTREAM_DB_URL!));
const sink   = await openPostgres(process.env.OPINDEX_DB_URL!);

const indexer = await createIndexer({ schema, sink, source });

// On graceful shutdown — drain the connection pool
process.on('SIGTERM', async () => {
  await source.adapter.end?.();
  await sink.end();
});
```

Source and sink can be the same Postgres instance — counter-index's `opindex_` table prefix prevents
collisions with OpStream's raw tables.

---

## WsEventSource

Connects to OpStream's WebSocket broadcast server. Events arrive fully enriched — all 15 fields
populated — with sub-second latency. No DB reads, no RPC calls.

```ts
import { WsEventSource } from '@counterfinance/counter-index';

const source = new WsEventSource('ws://localhost:8080');
```

Requires the `ws` peer dependency:

```bash
npm install ws
```

### Live-only

`WsEventSource` cannot backfill historical blocks — it only sees events as they are broadcast.
For full-history indexers, pair it with `DbEventSource` for backfill and switch to `WsEventSource`
for live subscriptions (wire them separately in your `main.ts`):

```ts
import { DbEventSource, WsEventSource, openSqlite } from '@counterfinance/counter-index';

// Backfill via SQL — instant
const dbSource = new DbEventSource(openSqlite('/data/opstream.db'));
await indexer.sync(fromBlock, latestBlock, { source: dbSource });

// Live via WebSocket — sub-second latency
const wsSource = new WsEventSource('ws://localhost:8080');
indexer.subscribe(latestBlock + 1, { source: wsSource });
```

### Options

```ts
interface WsEventSourceOptions {
  reconnectDelayMs?:    number; // Base delay on disconnect. Default: 1000
  maxReconnectDelayMs?: number; // Backoff ceiling. Default: 30 000
}
```

Reconnection uses exponential backoff: delay doubles on each failure up to `maxReconnectDelayMs`,
then resets to `reconnectDelayMs` on a successful open.

### Decoding

OpStream stores and broadcasts raw event bytes only — there is no `decoded_json` column or
field. Decoding lives entirely in counter-index's `DECODER_REGISTRY` and is applied at read time on
the raw `eventRaw` bytes. Register a decoder with `registerDecoder()` and it instantly
applies to every subsequent event (and, for `DbEventSource`, every historical event in
the archive — no rewrite needed).

### No server-side filtering

OpStream broadcasts every event to all connected clients. Filtering by contract address or event
name must be done inside your handlers. Use `fromBlock` on `subscribe()` to skip events from
blocks before your start point.

### `createEventSource` integration

Pass `ws` as the Tier 2 option. It is chosen after the DB probe fails and before RPC:

```ts
const source = await createEventSource({
  db:  '/data/opstream.db',           // Tier 1 — try OpStream DB first
  ws:  'ws://localhost:8080',         // Tier 2 — WS if DB not ready
  rpc: new JSONRpcProvider('...'),    // Tier 3 — RPC as last resort
});
```

---

## RpcEventSource

Talks directly to any OPNET RPC node. No OpStream installation required — point it at a public
endpoint and you're indexing immediately.

```ts
import { RpcEventSource } from '@counterfinance/counter-index';
import { JSONRpcProvider } from 'opnet';

const source = new RpcEventSource(
  new JSONRpcProvider('https://mainnet.opnet.org'),
  { rpsLimit: 5 },
);
```

counter-index does not import from the `opnet` SDK directly. Instead it defines a minimal `BlockProvider`
interface that `JSONRpcProvider` satisfies via TypeScript structural typing — no version coupling,
no forced dependency.

### Options

```ts
interface RpcEventSourceOptions {
  rpsLimit?:    number; // Max RPC calls per second. Default: 5
  retryDelayMs?: number; // Delay between retries on failed block. Default: 1000
  maxRetries?:  number; // Max attempts before skipping a block. Default: 3
}
```

### Speed expectations

At `rpsLimit: 5`, backfilling 10,000 blocks takes ~2,000 `getBlock` calls — the wall-clock time
depends on RPC latency, but expect several minutes for large ranges. `DbEventSource` performs the
same backfill in milliseconds via a single SQL query.

Use `RpcEventSource` for:
- Lightweight indexers watching recent blocks only
- Environments where OpStream is not yet deployed
- Quick prototypes before committing to the full OpStream stack

### BlockProvider interface

If you want to mock the provider in tests or wrap a custom RPC client, implement:

```ts
interface BlockProvider {
  getBlock(height: bigint, prefetchTxs: boolean): Promise<BlockLike | null>;
  getBlockNumber(): Promise<bigint>;
}
```

Any object that satisfies this shape works — no class inheritance required.

---

## createEventSource — capability-probing factory

Give `createEventSource` whatever you have. It probes for the fastest available engine and falls
back automatically.

```ts
import { createEventSource } from '@counterfinance/counter-index';
import { JSONRpcProvider } from 'opnet';

const source = await createEventSource({
  db:  '/data/opstream.db',                              // Tier 1 — try OpStream DB first
  rpc: new JSONRpcProvider('https://mainnet.opnet.org'), // Tier 3 — RPC fallback
});
// → DbEventSource if opstream.db has the events/transactions/blocks tables
// → RpcEventSource otherwise (with a console warning)
```

You can also pass a pre-opened adapter instead of a file path:

```ts
const source = await createEventSource({
  db:  await openPostgres(process.env.OPSTREAM_DB_URL!),
  rpc: new JSONRpcProvider('https://mainnet.opnet.org'),
});
```

### Probe logic

`createEventSource` calls `probeOpStreamSchema()` internally, which checks for the three tables
`DbEventSource` needs (`events`, `transactions`, `blocks`). If all three exist the DB source is
used. If any are missing it logs a warning and falls back to the RPC source. If neither resolves
it throws.

You can call `probeOpStreamSchema` directly if you need to check readiness yourself:

```ts
import { probeOpStreamSchema, openSqlite } from '@counterfinance/counter-index';

const ready = await probeOpStreamSchema(openSqlite('/data/opstream.db'));
// → true if OpStream-ready, false otherwise
```

---

## Filtering queries

Both `DbEventSource` and `RpcEventSource` accept optional filters on `sync()` and `subscribe()`
to skip irrelevant events before they reach your handlers:

```ts
await indexer.sync(fromBlock, toBlock, {
  contract:   '0xmotoswap_pair',           // only this contract
  eventNames: ['Synced', 'Swapped'],       // only these event names
});

indexer.subscribe(latestBlock + 1, {
  filters: { contract: '0xmotoswap_pair' },
});
```

Filtering at the source level is significantly cheaper than filtering inside handlers — especially
with `DbEventSource`, where the filter is pushed into the SQL `WHERE` clause.

---

## Sink connections

The sink is where counter-index writes your `opindex_*` tables. Open it independently of the source:

```ts
import { openSqlite } from '@counterfinance/counter-index';

// SQLite
const sink = openSqlite('/data/opindex.db');

// Postgres
const sink = await openPostgres(process.env.OPINDEX_DB_URL!);
```

Pass the sink to `createIndexer`:

```ts
const indexer = await createIndexer({ schema, sink, source });
```

counter-index creates its tables on first run and does nothing on subsequent runs — `createIndexer` is
safe to call repeatedly against the same sink database.
