# Changelog

All notable changes to `@counterfinance/counter-index` are documented here.

## [0.1.12-alpha.3] — 2026-04-22

### Fixed

- **Subscribe poll loop now recovers from hung OpStream connections.**
  `rpc()` had no fetch timeout — a connection that was accepted but never responded
  blocked `_subscribePoll()` forever, silently killing the loop with no log and no crash.
  Added `AbortSignal.timeout(60_000)` as the default so every RPC call throws after 60s,
  the catch fires, and the next poll resumes on schedule.

- **Poll errors are now visible in logs.**
  Both `OpStreamRpcEventSource._subscribePoll()` and `DbEventSource.subscribe()` had bare
  `catch {}` blocks that swallowed every error silently. Any OpStream outage, network blip,
  or bad response was invisible — operators only saw "no handler activity recorded" hours
  later. Now logs: `[counter-index] subscribe poll error (will retry in Xs): <message>`.

## [0.1.12-alpha.2] — 2026-04-21

### Fixed

- **`OpStreamRpcEventSource.queryStream()` now truly streams across halved sub-chunks.**
  In `0.1.12-alpha.1`, `fetchChunk()` returned `Promise<DecodedEvent[]>` and, when the
  server halved a range with `-32602`, recursed with `return [...events, ...remaining]`.
  `queryStream()` awaited that promise before yielding anything, so every halved
  sub-chunk inside one `chunkSize` boundary was materialised into one array before the
  consumer saw a single event — defeating the backpressure that `for await … await
  dispatch()` provides. On dense testnet ranges (thousands of events per block) this
  reproducibly OOM'd the process at the `--max-old-space-size` ceiling.

  `fetchChunk()` is now an `async *` generator that yields events from each successfully
  fetched sub-chunk immediately and recurses the halved remainder via `yield*` — never
  materialising a cross-sub-chunk array. Peak memory during backfill is now bounded by
  a single sub-chunk (typically a few thousand events), independent of `chunkSize` or
  the `sync()` window width.

  Regression test: `tests/opStreamRpcSource.test.ts` now asserts that the remainder
  fetch is deferred until after the first sub-chunk's events have been consumed.

## [0.1.12] — 2026-04-20

### Added

- **Streaming `queryStream()` replaces `query()`** — `EventSource` interface now exposes
  `queryStream(fromBlock, toBlock, filters): AsyncIterable<DecodedEvent>` instead of
  `query(): Promise<DecodedEvent[]>`. All three sources (`OpStreamRpcEventSource`,
  `RpcEventSource`, `DbEventSource`) stream events one by one; peak memory is bounded
  by a single chunk rather than the entire block range. Fixes OOM on dense chains with
  large `sync()` windows.

- **Per-block transactional writes** — `store.beginBlock()` / `store.commitBlock()` coalesce
  all entity writes for one block into a single `BEGIN … COMMIT`. Writes are only visible
  after the full block commits — no partial-block state is ever queryable.

- **`_meta` GraphQL field** — a `_meta` root query field exposes indexer progress:
  ```graphql
  { _meta { block { number timestamp } tipBlock blocksBehind synced hasIndexingErrors } }
  ```
  - `block.number` — last fully committed block (every entity ≤ this block is durable).
  - `tipBlock` — chain tip at last sync, written atomically with each block's entities.
  - `blocksBehind` — `tipBlock - block.number`; null if tip is unknown.
  - `synced` — `true` when `blocksBehind === 0` (live) or tip is unknown; `false` during
    active backfill. Use this to distinguish **backfilling** from **live** mode at a glance.
  - `hasIndexingErrors` — always `false` for now; reserved for handler-error tracking.

- **`opindex_meta` checkpoint table** — persisted atomically with block writes. On restart
  the indexer resumes from `opindex_meta.last_block + 1` automatically.

- **`IndexerLogger` interface** — five-level logger (`trace`/`debug`/`info`/`warn`/`error`)
  injectable via `createIndexer({ logger })`. Defaults to a no-op logger so existing
  consumers are unaffected. `counter-index` emits no `console.log` itself; all output is
  routed through the injected logger.

- **`sync()` `knownTip` parameter** — `sync(from, to, filters?, knownTip?)` accepts the
  chain tip so `_meta.tipBlock` and `_meta.synced` reflect real catch-up state during
  multi-window backfills (not just the current window's `toBlock`).

- **Range-end checkpoint** — `sync()` writes a checkpoint to `toBlock` even when the last
  N blocks had no matching events, so `_meta.block.number` always means "scanned up to
  here", not "last block with a matching event".

- **`block.timestamp` in `_meta`** — `_meta.block.timestamp` is the Unix-ms timestamp of
  the last committed block when the source provides it (OpStream sources do; pure RPC does
  not — returns `null`).

### Changed

- **`EventSource.query()` removed** — replaced by `queryStream()`. Any custom `EventSource`
  implementation must migrate to the new async-iterable interface.

### Fixed

- **`opindex_meta` integer overflow on Postgres** — `updated_at` and `last_block_ts` now
  use `BIGINT` instead of `INTEGER`. `Date.now()` (~1.78 × 10¹² in 2026) overflows
  Postgres `int4` (~2.1 × 10⁹).
- **Postgres `NOTICE` spam** — `openPostgres()` now sets `onnotice: () => {}` to suppress
  the `CREATE TABLE IF NOT EXISTS` NOTICE objects that were cluttering stdout.

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
  `^5.0.0` but counter-index imports from `'graphql-ws/use/ws'` which is the v6 path.
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
