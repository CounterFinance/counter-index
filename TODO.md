# op-index — Future work

Items intentionally deferred from prior sprints. Listed with rationale so we
don't re-litigate each decision next time.

## Named handlers

**What:** accept an optional handler name in registration:
```ts
indexer.on('Swapped', 'motoswap.swap', handler);
indexer.on('Swapped', 'slohm.swap',    handler);  // second handler for same event
```

**Why:** today the event name is the only identifier in DEBUG/TRACE logs.
When two handlers fire for the same event (e.g. both Motoswap and Slohm
hook `Transferred`), logs can't tell which is slow. Named handlers make
perf tables and trace timings precise.

**Why deferred:** requires a breaking signature change (`on(eventName, name, handler)`)
or an overload resolution scheme. Pre-1.0 we can absorb this cleanly, but it
pairs naturally with a wider "named subgraphs" concept we haven't scoped yet.

**Suggested milestone:** 0.2.0, alongside a broader subgraph-addressing pass.

---

## Entity delta counters in IndexerStats

**What:** extend `IndexerStats` with:
```ts
entitiesCreated:  number;
entitiesUpdated:  number;
entitiesDeleted:  number;
writesByTable:    Record<string, number>;
writesByHandler:  Record<string, number>;  // depends on named handlers
```

Surface them in the per-block INFO log (live mode) and in `sync complete`:
```
live block  block=12345  events_in_block=12  created=3  updated=9  deleted=0  elapsed_ms=18
```

**Why:** tells consumers at a glance how much work each block did. Today the
indexer only exposes `eventsProcessed`, which doesn't distinguish reads-vs-writes
or creates-vs-updates.

**Why deferred:** requires threading a counter through `store.set/update/delete`
and a small stats-merge API. Straightforward but not urgent; the perf module
in OpIndexEcosystem already derives table-level write counts externally.

**Suggested milestone:** next patch (0.1.14) — small, self-contained.

---

## Bulk per-block writes (buffered commitBlock)

**What:** buffer all `store.set/update/delete` calls within a block, flush as one
batched `INSERT ... VALUES (...), (...), ... ON CONFLICT ...` at `commitBlock()`.

**Why:** on dense blocks with 100+ entity writes, that's 100 DB roundtrips.
Postgres multi-row INSERT collapses them to one per table per block. Expected
3-10× throughput win on write-bound backfills.

**Why deferred:** the streaming refactor already solved the primary goal
(memory boundedness); write-batching is a throughput optimisation. It also
subtly changes consistency semantics for handlers that read-their-own-writes
within the same block (they'd need to hit the buffer, not the DB).

**Suggested milestone:** 0.1.15 or 0.2.0. Gate behind `batchPerBlock: boolean`
option (default true once validated).

---

## Postgres sql.cursor() for DbEventSource

**What:** the Postgres path of `DbEventSource.queryStream()` currently loads the
full result set before yielding (the Postgres driver's default). Switch to
`sql.cursor(100)` for true server-side streaming.

**Why:** for very large ranges (e.g. historical backfill of 100k+ blocks from
a Postgres source), the current path can still spike memory inside the driver
buffer even though the indexer consumer is lazy.

**Why deferred:** the OpStream HTTP source is the primary backfill path in
production. DbEventSource is mostly used for tests and local dev where ranges
are small.

**Suggested milestone:** 0.1.15.

---

## Ordered-parallel chunk fetching

**What:** fetch N chunks in parallel in `OpStreamRpcEventSource.queryStream()`,
preserving order via a bounded output queue.

**Why:** today concurrency=1. HTTP round-trip is the bottleneck on remote
OpStream instances (~50-200ms per chunk). 4× parallel fetching would give
~3× throughput for backfill-bound deploys.

**Why deferred:** adds meaningful complexity (bounded queue, error handling,
back-pressure). concurrency=1 streaming already fixes the OOM and is fast
enough for current deployments.

**Suggested milestone:** 0.2.0 with benchmark evidence.

---

## Slow-handler WARN

**What:** if a handler takes > N ms (configurable, default 1000ms), emit a
WARN line with handler identifier and block.

**Why:** catches pathological handlers in prod without needing TRACE logs on.

**Why deferred:** needs named handlers to be useful (otherwise the WARN
says "a handler for Transferred took 2s" with no way to narrow it down).

**Suggested milestone:** paired with named handlers.

---

## Handler-level stats in perf.ts (ecosystem-side)

**What:** the ecosystem's `perf.ts` wraps `indexer.on()` today, but doesn't know
which module the handler belongs to. Tagging handlers at registration would
let the perf report group by module:
```
module=motoswap  handlers=5  calls=4823  db_writes=3102  total_ms=1240
module=slohm     handlers=3  calls=812   db_writes=1624  total_ms=390
```

**Why deferred:** requires coordination with op-index named handlers.

---

## DECODER_REGISTRY introspection

**What:** expose the current registered decoders via a public method so
consumers can verify at boot which event names will decode successfully.

**Why:** silent decode failures (event name registered but data malformed) are
currently only visible as `event.decoded === null` in handlers. A boot-time
manifest of "these events are decodable" catches misregistration early.

**Suggested milestone:** 0.1.15.

---

## Reorg handling (POST-MVP)

**What:** detect chain reorgs and roll back affected entities.

**Why deferred:** OPNET reorg depth is bounded and OpStream already handles
most of this at the source level. Not a 0.x concern.

**Suggested milestone:** 1.0 or later — needs design doc.
