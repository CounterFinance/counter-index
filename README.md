# OpKit

Indexer framework for [OPNET](https://opnet.org) (Bitcoin L2). Define a schema, handle chain
events, persist derived state to SQLite or Postgres, and serve it over a GraphQL API with
cursor pagination and live subscriptions — all auto-generated from your schema, zero codegen.

```
OpStream DB ──→ DbEventSource ──→ OpKit handlers ──→ opkit_* tables
  (or OPNET RPC)                                           ↓
                                                   indexer.serve()
                                                           ↓
                                          GraphQL (HTTP + WebSocket) ──→ Frontend
```

## Requirements

- Node.js >= 22
- An OpStream-ready database **or** any OPNET RPC node as the event source

## Install

```bash
npm install @opnet-devs/opkit
```

## Minimal example

```ts
import { defineSchema, createIndexer, DbEventSource, openSqlite } from '@opnet-devs/opkit';

const schema = defineSchema({
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/opkit.db');

const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transferred', async (event, ctx) => {
  const { from, to, value } = event.decoded!;
  await ctx.store.set('Transfer', event.txHash, {
    from: from as string,
    to:   to   as string,
    value: BigInt(value as string),
    block: event.blockNumber,
  });
});

await indexer.sync(941400, latestBlock);          // backfill
indexer.subscribe(latestBlock + 1);               // go live

const handle = await indexer.serve({ port: 4000 }); // GraphQL at :4000/graphql
```

## Documentation

| Guide | Description |
|---|---|
| [Quickstart](docs/quickstart.md) | Full annotated walkthrough — schema to live queries |
| [Schema](docs/schema.md) | `defineSchema()` — field types, optional fields |
| [Handlers](docs/handlers.md) | `on()`, `onBlock()`, wildcard, `DecodedEvent` fields |
| [Store](docs/store.md) | CRUD API — get, set, update, delete, list, find, onChange |
| [Sources](docs/sources.md) | `DbEventSource`, `RpcEventSource`, `createEventSource`, Postgres |
| [GraphQL](docs/graphql.md) | `serve()`, queries, cursor pagination, filters, subscriptions |
| [Decoders](docs/decoders.md) | Built-in OPNET decoders + `registerDecoder()` |
| [Deployment](docs/deployment.md) | Docker, docker-compose, justfile |

## Roadmap

- [x] `DbEventSource` — index from OpStream-ready SQLite / Postgres
- [x] `RpcEventSource` — index directly from any OPNET RPC node
- [x] `createEventSource` — capability-probing DB → RPC fallback factory
- [x] Block handlers — `indexer.onBlock(handler)`
- [x] GraphQL API — auto-generated schema, cursor pagination, GraphiQL playground
- [x] GraphQL subscriptions — `serve({ subscriptions: true })` via `graphql-ws`
- [ ] Reorg handling — rollback `opkit_*` state on chain reorgs
- [ ] Tier 2 EventSource — OpStream WebSocket push (sub-second latency)
- [ ] CLI scaffolding — `opkit init`

## License

MIT
