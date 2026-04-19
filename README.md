# op-index

Indexer framework for [OPNET](https://opnet.org) (Bitcoin L1). Define a schema, handle chain
events, persist derived state to SQLite or Postgres, and serve it over a GraphQL API with
cursor pagination and live subscriptions — all auto-generated from your schema, zero codegen.

```
  OpStream DB --> DbEventSource   ‾‾‾‾‾‾‾‾\
  OPNET RPC   --> RpcEventSource  ---------+--> on(event, handler) --> opindex_* tables
  OpStream WS --> OpStreamRpcEventSource _/    onBlock(handler)             |
                                                                     indexer.serve()
                                                                            |
                                                             +--------------+--------------+
                                                      HTTP /graphql              WebSocket subs
                                                      GraphiQL playground        (graphql-ws)
```

**Start with `RpcEventSource`** — works against any public OPNET node, no extra infrastructure needed:
- Testnet: `https://testnet.opnet.org`
- Mainnet: `https://mainnet.opnet.org`

`DbEventSource` and `OpStreamRpcEventSource` require [OpStream](https://github.com/user-attachments/assets/33fa0410-fe7f-4785-9d1d-62118a81dbfb) — currently in private development by the opnet-collective. op-index itself is fully open source and source-agnostic.

## Requirements

- Node.js >= 24
- An OPNET RPC **or** an OpStream-ready database as the event source

## Install

```bash
npm install @opnet-collective/op-index
```

## Minimal example

```ts
import { defineSchema, createIndexer, DbEventSource, openSqlite } from '@opnet-collective/op-index';

const schema = defineSchema({
  Transfer: {
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

const source = new DbEventSource(openSqlite('/data/opstream.db'));
const sink   = openSqlite('/data/opindex.db');

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

- [x] `RpcEventSource` — index directly from any OPNET RPC node
- [x] `DbEventSource` — index from OpStream-ready SQLite / Postgres
- [x] `WsEventSource` — OpStream WebSocket push (sub-second latency)
- [x] `createEventSource` — capability-probing DB → WS → RPC fallback factory
- [x] Block handlers — `indexer.onBlock(handler)`
- [x] GraphQL API — auto-generated schema, cursor pagination, GraphiQL playground
- [x] GraphQL subscriptions — `serve({ subscriptions: true })` via `graphql-ws`
- [x] CLI scaffolding — `npx @opnet-collective/op-index init`
- [ ] Reorg handling — rollback `opindex_*` state on chain reorgs

## License

MIT
