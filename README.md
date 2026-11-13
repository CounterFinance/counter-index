# counter-index

Chain-neutral blockchain indexer framework. Define a schema, handle chain events, persist
derived state to SQLite or Postgres, and query it over GraphQL, REST, SQL-over-HTTP, and SSE,
all auto-generated from your schema with zero codegen.

The core engine is chain-agnostic; each chain ships as a source adapter under
`src/chains/<chain>`. Three adapters exist today, EVM-first: **EVM**
(`EvmLogSource` / `EvmAbiDecoder`, via `eth_getLogs`, works against any JSON-RPC node),
**Solana** (Anchor-style event decoding with a dependency-free Borsh codec), and **OPNET**
(`RpcEventSource` / `DbEventSource` / `WsEventSource`). Adding a chain is about two classes and
touches no core code, see [Adding a chain](docs/adding-a-chain.md). All chain-specific context
(addresses, gas, topics, revert reasons) lives under a `ChainEvent`'s `chainMeta`, keyed by
`kind`.

Built for production: per-block atomic commits with crash-safe exactly-once indexing,
journalled reorg rollback with deep-reorg detection, batched writes plus secondary indexes,
multichain (several chains into one store, filtered by `chainId`), a health-state machine with
`/metrics` and `/health`, OpenTelemetry-shaped tracing, graceful shutdown, config validation
with incremental migrations, and OHLCV candle aggregation. See the
[A+ roadmap](docs/roadmap-to-a-plus.md) for the full milestone list and the honest record of
what is deferred (HyperSync-accelerated backfill is tracked).

```
  EVM RPC      --> EvmLogSource     \
  Solana RPC   --> SolanaLogSource   +--> on(event, handler)  --> indexed tables
  OPNET RPC/DB --> RpcEventSource    /    onBlock(handler)            |
                                                              indexer.serve()
                                                                     |
                               GraphQL (+ subscriptions)  .  REST  .  SQL-over-HTTP  .  SSE
```

## Requirements

- Node.js >= 24
- A JSON-RPC endpoint for your chain (any EVM RPC, a Solana RPC, or an OPNET RPC / OpStream DB)

## Install

```bash
npm install @counterfinance/counter-index
```

## Minimal example (EVM)

```ts
import { createIndexer, defineSchema, openSqlite, EvmLogSource } from '@counterfinance/counter-index';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const schema = defineSchema({
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
  addresses: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'], // USDC
});
const sink = openSqlite('/data/counter-index.db');

const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transfer', async (event, ctx) => {
  const { from, to, value } = event.decoded!;
  await ctx.store.set('Transfer', `${event.txHash}-${event.logIndex}`, {
    from: from as string,
    to:   to   as string,
    value: value as bigint,
    block: event.blockNumber,
  });
});

await indexer.sync(18_000_000, 18_000_100);   // backfill a range
indexer.subscribe(18_000_101);                // then go live

// GraphQL at :4000/graphql; opt into the cacheable read path too:
const handle = await indexer.serve({ port: 4000, readPath: { rest: true, sql: true, live: true } });
```

## Documentation

| Guide | Description |
|---|---|
| [Quickstart](docs/quickstart.md) | Full annotated walkthrough, schema to live queries |
| [Schema](docs/schema.md) | `defineSchema()`: field types, optional fields, relations, unique constraints |
| [Handlers](docs/handlers.md) | `on()`, `onBlock()`, wildcard, `DecodedEvent` fields |
| [Store](docs/store.md) | CRUD API: get, set, update, delete, list, find, query, onChange |
| [Sources](docs/sources.md) | EVM, Solana, OPNET source adapters and the `createEventSource` factory |
| [GraphQL](docs/graphql.md) | `serve()`, queries, cursor pagination, filters, subscriptions |
| [Serving read path](docs/serving.md) | Cacheable REST, SQL-over-HTTP, and SSE live queries |
| [Adding a chain](docs/adding-a-chain.md) | How to add a new chain adapter, with a checklist |
| [Reorg design](docs/reorg-design.md) | Journal, rollback, fork detection, finality |
| [Operations](docs/operations.md) | Health states, metrics, tracing, graceful shutdown |
| [Security](docs/security.md) | GraphQL DoS caps, auth, rate limiting, the injection-safe filter path |
| [Durability](docs/durability.md) | Per-block atomicity and crash-safe exactly-once indexing |
| [Logging](docs/logging.md) | Bring-your-own plus the pino-compatible built-in logger |
| [Benchmarks](docs/benchmarks.md) | Backfill throughput and the cross-tool harness |
| [Deployment](docs/deployment.md) | Docker, docker-compose, justfile |

## Capabilities

- [x] EVM adapter (`eth_getLogs`, any JSON-RPC node), live-mainnet proven
- [x] Solana adapter (Anchor discriminator + Borsh), proven on synthetic fixtures
- [x] OPNET adapter (`RpcEventSource` / `DbEventSource` / `WsEventSource`)
- [x] Multichain: several chains into one store, filtered by `chainId`
- [x] Per-block atomic commits, crash-safe exactly-once indexing
- [x] Reorg handling: journalled rollback plus deep-reorg detection
- [x] Batched writes plus schema-driven secondary indexes
- [x] GraphQL API: auto-generated schema, cursor pagination, filters, GraphiQL
- [x] GraphQL subscriptions via `graphql-ws`
- [x] Serving read path: cacheable REST, SQL-over-HTTP, SSE live queries
- [x] Production ops: health-state machine, `/metrics`, tracing, graceful shutdown
- [x] Config validation plus incremental schema migrations
- [x] OHLCV candle aggregation (`defineCandles`)
- [x] CLI scaffolding: `npx @counterfinance/counter-index init`
- [ ] HyperSync-accelerated backfill (tracked)

## License

MIT
