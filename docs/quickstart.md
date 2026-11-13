# Quickstart

This guide walks you from a blank project to a live indexer that backfills historical blocks,
subscribes to new ones, and serves a GraphQL API your frontend can query.

## 1. Define your schema

Everything starts with `defineSchema`. Declare the entities you want to index, counter-index creates
one SQL table per entity in your sink database, prefixed `counterindex_` to avoid collisions.

```ts
import { defineSchema } from '@counterfinance/counter-index';

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
```

See [Schema](./schema.md) for all field types and options.

## 2. Open source and sink connections

**Source**: where counter-index reads raw chain events from.
**Sink**: where counter-index writes your derived `counterindex_*` tables.

```ts
import { DbEventSource, openSqlite } from '@counterfinance/counter-index';

// Fast path, OpStream-ready database (recommended for production)
const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/counterindex.db');
```

No OpStream? Use the RPC source instead:

```ts
import { RpcEventSource } from '@counterfinance/counter-index';
import { JSONRpcProvider } from 'opnet';

const source = new RpcEventSource(
  new JSONRpcProvider('https://mainnet.opnet.org'),
  { rpsLimit: 5 },
);
```

Or let counter-index probe and decide automatically:

```ts
import { createEventSource } from '@counterfinance/counter-index';

const source = await createEventSource({
  db:  '/data/opstream.db',                              // fast if present
  rpc: new JSONRpcProvider('https://mainnet.opnet.org'), // fallback
});
```

See [Sources](./sources.md) for Postgres, custom adapters, and the full options reference.

## 3. Create the indexer

`createIndexer` is async, it creates the `counterindex_*` tables in your sink database on first run
and is a no-op on subsequent runs.

```ts
import { createIndexer } from '@counterfinance/counter-index';

const indexer = await createIndexer({ schema, sink, source });
```

## 4. Register handlers

Handlers are async functions that fire when a specific event name is seen. counter-index calls them in
the order they were registered, awaiting each one before moving to the next.

```ts
indexer.on('Transferred', async (event, ctx) => {
  const from  = event.decoded!['from']  as string;
  const to    = event.decoded!['to']    as string;
  const value = BigInt(event.decoded!['value'] as string);

  // Write the transfer record
  await ctx.store.set('Transfer', event.txHash, {
    txHash: event.txHash, from, to, value, block: event.blockNumber,
  });

  // Update sender's account
  const sender = await ctx.store.get('Account', from);
  if (sender) {
    await ctx.store.update('Account', from, {
      balance:  (sender['balance']  as bigint) - value,
      txCount:  (sender['txCount']  as number) + 1,
      lastSeen: event.blockNumber,
    });
  }
});
```

Use `'*'` to catch every event regardless of name:

```ts
indexer.on('*', async (event, ctx) => {
  // fires for every event counter-index sees
});
```

See [Handlers](./handlers.md) for block handlers, the full `DecodedEvent` field reference,
and handler ordering guarantees.

## 5. Backfill historical blocks

`sync()` pulls the entire block range from the source in a single query (SQL) or a sequential
getBlock loop (RPC) and runs every event through your handlers in order.

```ts
const stats = await indexer.sync(941400, latestBlock);
console.log(stats);
// { eventsProcessed: 18420, eventsDecoded: 16540, blocksProcessed: 58600, lastBlock: 999999 }
```

You can filter by contract address or event name to skip irrelevant traffic:

```ts
await indexer.sync(fromBlock, toBlock, {
  contract:   '0xmotoswap_pair',
  eventNames: ['Synced', 'Swapped'],
});
```

## 6. Go live

`subscribe()` polls the source for new blocks on an interval and feeds each event through your
handlers in real time. It returns an unsubscribe function.

```ts
const stop = indexer.subscribe(latestBlock + 1);

// Custom poll interval (default: 10 000 ms)
const stop = indexer.subscribe(latestBlock + 1, { pollIntervalMs: 5000 });

// Stop when you're done
stop();
```

OPNET is a Bitcoin L2, its block cadence follows Bitcoin's rhythm rather than a fixed per-second
clock. A 10-second poll interval is more than sufficient for any non-latency-critical use case;
the default of 10,000 ms is a safe starting point and can be tuned down as the network matures.

## 7. Serve a GraphQL API

`indexer.serve()` auto-generates a complete GraphQL schema from your `defineSchema()` entities
and starts an HTTP server. No SDL file, no codegen, no configuration.

```ts
const handle = await indexer.serve({ port: 4000 });
// GET  http://localhost:4000/graphql → GraphiQL playground (open in browser)
// POST http://localhost:4000/graphql → execute queries
```

Query your data immediately:

```graphql
# Fetch a single transfer by id
{ transfer(id: "0xtxhash") { from to value block } }

# List with filtering, ordering, and cursor pagination
{
  transfers(
    where:          { from: "0xalice" }
    orderBy:        block
    orderDirection: desc
    first:          20
  ) {
    items { id from to value block }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}
```

For live updates, enable WebSocket subscriptions (requires peer deps):

```bash
npm install graphql-ws ws
```

```ts
const handle = await indexer.serve({ port: 4000, subscriptions: true });
// WS ws://localhost:4000/graphql

// Then from any GraphQL client:
// subscription { transferUpdated { id from to value } }
```

See [GraphQL](./graphql.md) for the full query reference, all filter operators, pagination
patterns, and subscription behaviour.

## 8. Query the store directly

You can also read indexed data without going through GraphQL, useful in the same process:

```ts
const all      = await indexer.store.list('Transfer');
const one      = await indexer.store.get('Transfer', txHash);
const whales   = await indexer.store.find('Account', (a) => (a['balance'] as bigint) > 1_000_000n);
const count    = await indexer.store.count('Account');

console.log(indexer.stats);
// { eventsProcessed, eventsDecoded, eventsSkipped, blocksProcessed, lastBlock }
```

See [Store](./store.md) for the full API.

## Full example

```ts
import {
  defineSchema, createIndexer,
  DbEventSource, openSqlite,
} from '@counterfinance/counter-index';

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

const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/counterindex.db');
const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transferred', async (event, ctx) => {
  const from  = event.decoded!['from']  as string;
  const to    = event.decoded!['to']    as string;
  const value = BigInt(event.decoded!['value'] as string);

  await ctx.store.set('Transfer', event.txHash, {
    txHash: event.txHash, from, to, value, block: event.blockNumber,
  });

  for (const [addr, delta] of [[from, -value], [to, value]] as [string, bigint][]) {
    const acct = await ctx.store.get('Account', addr);
    if (!acct) {
      await ctx.store.set('Account', addr, { address: addr, balance: delta, txCount: 1, lastSeen: event.blockNumber });
    } else {
      await ctx.store.update('Account', addr, {
        balance:  (acct['balance']  as bigint) + delta,
        txCount:  (acct['txCount']  as number) + 1,
        lastSeen: event.blockNumber,
      });
    }
  }
});

const latestBlock = 999_999;
await indexer.sync(941_400, latestBlock);
indexer.subscribe(latestBlock + 1);

const handle = await indexer.serve({ port: 4000, subscriptions: true });
console.log(`GraphQL ready at ${handle.url}`);
```
