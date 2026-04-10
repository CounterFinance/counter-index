# Sources

An EventSource is what OpKit reads raw chain events from. It is completely decoupled from the
sink (where OpKit writes your indexed tables) — they can be different databases, different
servers, or different technologies entirely.

OpKit ships two source implementations and a smart factory that picks the best one available.

## Comparison

| | `DbEventSource` | `RpcEventSource` |
|---|---|---|
| Requires | OpStream-ready SQLite or Postgres | Any OPNET RPC endpoint |
| Backfill speed | Sub-millisecond (single SQL query) | O(N) `getBlock` calls |
| Context richness | Full — tx fields + block JOINs | Full — RPC tx fields |
| Best for | Production, full-history backfills | Lightweight indexers, no OpStream |

---

## DbEventSource

Reads from an [OpStream](https://github.com/opnet-devs/opstream)-ready database. OpStream
pre-indexes all OPNET blocks, transactions, and events into a structured schema — `DbEventSource`
queries that schema with a single SQL statement per `sync()` call, making historical backfills
essentially instantaneous.

```ts
import { DbEventSource, openSqlite } from '@opnet-devs/opkit';

const source = new DbEventSource(openSqlite('/data/opstream.db'));
```

### With Postgres

OpKit's `MinimalDbAdapter` interface is structurally identical to OpStream's `DbAdapter`. Pass
OpStream's Postgres adapter directly:

```ts
import { DbEventSource } from '@opnet-devs/opkit';
import { openPostgresDb } from '@opnet-devs/opstream'; // OpStream's Postgres adapter

const source = new DbEventSource(await openPostgresDb(process.env.OPSTREAM_DB_URL!));
const sink   = await openPostgresDb(process.env.OPKIT_DB_URL!);

const indexer = await createIndexer({ schema, sink, source });
```

Source and sink can be the same Postgres instance — OpKit's `opkit_` table prefix prevents
collisions with OpStream's raw tables.

---

## RpcEventSource

Talks directly to any OPNET RPC node. No OpStream installation required — point it at a public
endpoint and you're indexing immediately.

```ts
import { RpcEventSource } from '@opnet-devs/opkit';
import { JSONRpcProvider } from 'opnet';

const source = new RpcEventSource(
  new JSONRpcProvider('https://mainnet.opnet.org'),
  { rpsLimit: 5 },
);
```

OpKit does not import from the `opnet` SDK directly. Instead it defines a minimal `BlockProvider`
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
import { createEventSource } from '@opnet-devs/opkit';
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
  db:  await openPostgresDb(process.env.OPSTREAM_DB_URL!),
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
import { probeOpStreamSchema, openSqlite } from '@opnet-devs/opkit';

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

The sink is where OpKit writes your `opkit_*` tables. Open it independently of the source:

```ts
import { openSqlite } from '@opnet-devs/opkit';

// SQLite
const sink = openSqlite('/data/opkit.db');

// Postgres (via OpStream's adapter)
const sink = await openPostgresDb(process.env.OPKIT_DB_URL!);
```

Pass the sink to `createIndexer`:

```ts
const indexer = await createIndexer({ schema, sink, source });
```

OpKit creates its tables on first run and does nothing on subsequent runs — `createIndexer` is
safe to call repeatedly against the same sink database.
