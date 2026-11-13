# Quickstart

This guide walks you from a blank project to a live indexer that backfills historical blocks,
subscribes to new ones, and serves a GraphQL API your frontend can query. The examples are
EVM-first (any JSON-RPC node); the same flow works for the Solana and OPNET adapters, which
differ only in the source you plug in (see [Sources](./sources.md)).

## 1. Define your schema

Everything starts with `defineSchema`. Declare the entities you want to index, counter-index
creates one SQL table per entity in your sink database, prefixed `counterindex_` to avoid
collisions.

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

The EVM adapter reads logs from any JSON-RPC node via `eth_getLogs`, decoding them against a
viem ABI:

```ts
import { createIndexer, EvmLogSource, openSqlite } from '@counterfinance/counter-index';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL) });

const source = new EvmLogSource({
  chainId: mainnet.id, network: 'ethereum', abi, client,
  addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], // USDC
});
const sink = openSqlite('/data/counterindex.db');
```

Other chains swap only the source: `SolanaLogSource` for Anchor programs, or `RpcEventSource` /
`DbEventSource` for OPNET (over an RPC node or an OpStream-ready database). See
[Sources](./sources.md) for Postgres, custom adapters, and the full options reference.

## 3. Create the indexer

`createIndexer` is async, it creates the `counterindex_*` tables in your sink database on first
run and is a no-op on subsequent runs.

```ts
const indexer = await createIndexer({ schema, sink, source });
```

## 4. Register handlers

Handlers are async functions that fire when a specific event name is seen. counter-index calls
them in the order they were registered, awaiting each one before moving to the next. Decoded
EVM arguments arrive already typed (a `uint256` is a `bigint`, an `address` is a `string`).

```ts
indexer.on('Transfer', async (event, ctx) => {
  const from  = event.decoded!['from']  as string;
  const to    = event.decoded!['to']    as string;
  const value = event.decoded!['value'] as bigint;

  // Write the transfer record
  await ctx.store.set('Transfer', `${event.txHash}-${event.logIndex}`, {
    from, to, value, block: event.blockNumber,
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

`sync()` pulls the block range from the source (an `eth_getLogs` range for EVM, a SQL query for
an OpStream DB, a sequential getBlock loop for an RPC source) and runs every event through your
handlers in order.

```ts
const stats = await indexer.sync(18_000_000, 18_000_100);
console.log(stats);
// { eventsProcessed: 18420, eventsDecoded: 16540, blocksProcessed: 101, lastBlock: 18000100 }
```

You can filter by contract address or event name to skip irrelevant traffic:

```ts
await indexer.sync(fromBlock, toBlock, {
  contract:   '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  eventNames: ['Transfer'],
});
```

## 6. Go live

`subscribe()` polls the source for new blocks on an interval and feeds each event through your
handlers in real time. It returns an unsubscribe function.

```ts
const stop = indexer.subscribe(18_000_101);

// Custom poll interval (default: 10 000 ms)
const stop = indexer.subscribe(18_000_101, { pollIntervalMs: 5000 });

// Stop when you're done
stop();
```

Match the poll interval to your chain's block time: a few seconds for most EVM chains, longer
for slow-cadence chains (OPNET, for example, follows Bitcoin's block rhythm, so a 10 second
interval is ample). The default of 10 000 ms is a safe starting point.

## 7. Serve a GraphQL API

`indexer.serve()` auto-generates a complete GraphQL schema from your `defineSchema()` entities
and starts an HTTP server. No SDL file, no codegen, no configuration.

```ts
const handle = await indexer.serve({ port: 4000 });
// GET  http://localhost:4000/graphql -> GraphiQL playground (open in browser)
// POST http://localhost:4000/graphql -> execute queries
```

Query your data immediately:

```graphql
# Fetch a single transfer by id
{ transfer(id: "0xtxhash-0") { from to value block } }

# List with filtering, ordering, and cursor pagination
{
  transfers(
    where:          { from: "0xalice" }
    orderBy:        block
    orderDirection: desc
    first:          20
  ) {
    nodes { id from to value block }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}
```

Need cache-friendly reads, a structured query endpoint, or live updates without a WebSocket?
Opt into the [serving read path](./serving.md): `serve({ readPath: { rest: true, sql: true,
live: true } })` adds a cacheable REST projection, SQL-over-HTTP, and SSE live queries.

For GraphQL subscriptions over WebSocket, install the peer deps and enable them:

```bash
npm install graphql-ws ws
```

```ts
const handle = await indexer.serve({ port: 4000, subscriptions: true });
// WS ws://localhost:4000/graphql
//
// subscription { transferUpdated { id from to value } }
```

See [GraphQL](./graphql.md) for the full query reference, all filter operators, pagination
patterns, and subscription behaviour.

## 8. Query the store directly

You can also read indexed data without going through GraphQL, useful in the same process:

```ts
const all      = await indexer.store.list('Transfer');
const one      = await indexer.store.get('Transfer', `${txHash}-0`);
const whales   = await indexer.store.find('Account', (a) => (a['balance'] as bigint) > 1_000_000n);
const count    = await indexer.store.count('Account');

console.log(indexer.stats);
// { eventsProcessed, eventsDecoded, eventsSkipped, blocksProcessed, lastBlock }
```

See [Store](./store.md) for the full API.

## Full example

```ts
import {
  defineSchema, createIndexer, EvmLogSource, openSqlite,
} from '@counterfinance/counter-index';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL) });
const source = new EvmLogSource({
  chainId: mainnet.id, network: 'ethereum', abi, client,
  addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
});
const sink = openSqlite('/data/counterindex.db');
const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transfer', async (event, ctx) => {
  const from  = event.decoded!['from']  as string;
  const to    = event.decoded!['to']    as string;
  const value = event.decoded!['value'] as bigint;

  await ctx.store.set('Transfer', `${event.txHash}-${event.logIndex}`, {
    from, to, value, block: event.blockNumber,
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

const latestBlock = 18_000_100;
await indexer.sync(18_000_000, latestBlock);
indexer.subscribe(latestBlock + 1);

const handle = await indexer.serve({ port: 4000, subscriptions: true });
console.log(`GraphQL ready at ${handle.url}`);
```
