# Changelog

All notable changes to `@opnet-collective/op-index` are documented here.

## [0.1.10] — 2026-04-19

- docs: improve README architecture diagram + highlight RpcEventSource with public node URLs

## [0.1.9] — 2026-04-19

### Fixed

- **`OpStreamRpcEventSource` now synthesises `logIndex`** — `opstream_getBlockRange`
  does not project `logIndex` on raw `RpcEvent` entries. Without a counter every
  event in a tx would land at `logIndex = undefined`, collapsing to the same slot
  when used as part of a composite entity key (`${txHash}-${logIndex}` → always
  `${txHash}-0`). A 0-based per-tx counter now mirrors `RpcEventSource` semantics:
  resets at each tx boundary, increments for every event including filtered-out ones
  so post-filter events have a stable position.

### Added

- **`fromAddress` is now bech32m P2OP** across all three event sources
  (`RpcEventSource`, `OpStreamRpcEventSource`, `DbEventSource`). Previously the
  field forwarded the raw upstream value — a 0x-prefixed 32-byte schnorr pubkey
  hex — while all decoded event fields (`buyer`, `sender`, etc.) were already in
  bech32m form. Consumers had to convert manually. All three sources now normalise
  at the boundary.
- **`event.fromAddressPubkey?: string`** (new field on `DecodedEvent`) — the original
  32-byte pubkey hex is preserved here when the source supplied a pubkey. Undefined
  when `fromAddress` was already a bech32m address (no pubkey available).
- **`pubkeyHexToP2op`, `isP2opAddress`, `normaliseFromAddress`** exported from the
  package root — consumers that need P2OP address derivation can reuse the same
  algorithm instead of copying it.
- **`bech32` runtime dependency** added (zero-dep, ~2 KB) for bech32m encoding.

## [0.1.6] — 2026-04-17

### Fixed

- **`graphql-ws` peer dependency corrected to `^6.0.0`** — the declared peer dep was
  `^5.0.0` but op-index imports from `'graphql-ws/use/ws'` which is the v6 path.
  Consumers installing `graphql-ws@6` no longer get a peer dep conflict warning.

## [0.1.5] — 2026-04-16

### Added

- **CI/CD release infrastructure** — `ci.yml` (typecheck + lint + test on push/PR),
  `release.yml` (semver label → `npm version` → CHANGELOG prepend → annotated tag →
  push dev + fast-forward main on every dev→main merge).
- **ESLint** — flat config (`eslint.config.mjs`) with type-aware TypeScript rules,
  `no-floating-promises` and `no-misused-promises` as errors.
- **`justfile`** — `lint`, `lint-fix`, `check` recipes added.
- **`CONTRIBUTING.md`** — documents the branch workflow, semver labels, and lint steps.

## [0.1.4] — 2026-04-15

### Changed

- **`Connection.items` → `Connection.nodes`** — renamed the result array field on all
  connection types to match the Relay spec and The Graph convention. Any query using
  `{ items { ... } }` must be updated to `{ nodes { ... } }`.

## [0.1.3] — 2026-04-15

### Added

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

## [0.1.2] — 2026-04-14

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
