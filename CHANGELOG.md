# Changelog

All notable changes to `@opnet-collective/op-index` are documented here.

## [0.1.2] — 2026-04-15

### Added

- **`OpStreamRpcEventSource`** — new `EventSource` implementation backed by OpStream's
  HTTP JSON-RPC API (`opstream_getBlockRange`). Fetches up to 1 000 blocks per call with
  full enrichment (timestamps, gasUsed, burnedBitcoin, revert reason) — the remote
  equivalent of `DbEventSource` without requiring direct database access.
  - `query()` chunks the requested range automatically and auto-retries with a smaller
    end block when the server returns `-32602` (tx/event limit exceeded).
  - `subscribe()` tries a WebSocket connection first (if `wsUrl` is provided) and falls
    back to HTTP polling after 5 seconds if the socket cannot connect. Polling can be
    forced via `forcePolling: true`.
  - Exported from the package root as `OpStreamRpcEventSource` and
    `OpStreamRpcEventSourceOptions`.

- **`createEventSource` — Tier 3: `opStreamRpc`** — the factory now accepts an
  `opStreamRpc` field (string URL or `{ url, wsUrl }` object) and selects
  `OpStreamRpcEventSource` between the `ws` tier and the `rpc` tier.
  `CreateEventSourceOptions` gains `opStreamRpcOptions` for forwarding constructor
  options.

- **`opstream_subscribe` protocol support** (`WsEventSource`, `OpStreamRpcEventSource`) —
  both WebSocket sources now send `opstream_subscribe("logs", filter)` on connect,
  opting in to server-side filtered push on new OpStream servers. A three-path message
  parser handles all server generations transparently:
  1. `opstream_subscription` notification (new subscribed mode)
  2. JSON-RPC ack (subscribe/unsubscribe response) — ignored
  3. Legacy plain `WebhookEvent` (old broadcast-only servers)
  Old servers are unaffected — they ignore the subscribe request and keep broadcasting.
  `WsEventSourceOptions` gains a `subscribeFilter` field (`{ address?, eventNames? }`)
  for server-side address/event-name filtering when the server supports it.

## [0.1.1] — 2026-04-07

### Added

- **`WsEventSource`** — live `EventSource` backed by OpStream's WebSocket broadcast.
  Connects to any OpStream WS endpoint, delivers events with sub-second latency, and
  reconnects automatically with exponential back-off.

- **`createEventSource` factory** (`eventSourceFactory.ts`) — probes what the caller
  provides and returns the best available source:
  - Tier 1: `DbEventSource` when an OpStream-ready SQLite or Postgres adapter is given.
  - Tier 2: `WsEventSource` when a `ws` URL is given and no DB is present.
  - Tier 3: `RpcEventSource` as the final fallback.

- **`probeOpStreamSchema`** — exported helper that checks whether a `MinimalDbAdapter`
  has the three OpStream tables (`events`, `transactions`, `blocks`).

- **`PostgresAdapter` / `openPostgres`** — Postgres backend for `MinimalDbAdapter`,
  backed by the `postgres` npm package.

## [0.1.0] — 2026-03-31

### Initial release

- `defineSchema` / `createIndexer` — core framework for defining entities and syncing
  chain data.
- `DbEventSource` — reads from an OpStream-ready SQLite or Postgres database via a
  single JOIN query.
- `RpcEventSource` — block-by-block backfill and polling using any `BlockProvider`
  (OPNET RPC or custom fetch adapter).
- `HandlerRegistry` — event and block handler registration with context injection.
- `SqliteAdapter` / `openSqlite` — SQLite backend using `better-sqlite3`.
- GraphQL serving via `createIndexer(...).serve()` on a configurable port.
- `decodeEvent` / `registerDecoder` — pluggable binary event decoder registry.
- `isOP20Contract` / `isOP721Contract` / `classifyContract` — contract standard helpers.
- `getNativeToken` / `isNativeToken` — native token metadata map.
