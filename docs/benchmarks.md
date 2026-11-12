# Benchmarks

## op-index's own backfill throughput

Reproduce: `npm run bench` (tune with `BENCH_BLOCKS` / `BENCH_PER_BLOCK`). This
streams synthetic events through the **full pipeline** — source → handlers →
schema-typed store → SQLite — and reports throughput + peak memory.

| Metric | Value |
|---|---|
| Node | v24.22.0 |
| Workload | 50,000 events (5,000 blocks × 10/block, 500 holders) |
| Sink | in-memory SQLite (`better-sqlite3`) |
| Elapsed | 0.26 s |
| **Events/sec** | **~192,000** |
| Blocks/sec | ~19,200 |
| Peak RSS | 125 MB |

(Measured on the dev machine for this session; absolute numbers vary by hardware.)

### Reading these honestly
- **Synthetic + in-memory.** No network. A real backfill is dominated by the
  RPC/data-source latency, not the indexer — which is exactly why the EVM adapter
  can later swap `eth_getLogs` for HyperSync (opidx-#18). This number measures the
  **indexer core**, not end-to-end sync against a live chain.
- Postgres will differ from SQLite (network round-trips vs in-process) — see the
  write-batching section below, where that difference is the whole point.

## Per-block write batching (M13)

Every entity write for a block is buffered and committed as a handful of chunked
multi-row upserts inside the block's single transaction, instead of one
round-trip per `store.set`. `get` reads the buffer first (read-your-writes), so
the balance pattern (`get` current → `set` current ± delta) still works mid-block.

`npm run bench:batch` — one block of 2000 ERC-20 transfers over 200 accounts
(2000 `Transfer` rows + sender/receiver `Balance` churn), counting **DB
round-trips** (the honest metric — each one is a full RTT on a networked Postgres):

| mode      | write round-trips | read round-trips | wall (in-mem SQLite) |
|-----------|------------------:|-----------------:|---------------------:|
| unbatched |              6000 |             4000 |              ~46 ms |
| batched   |             **2** |          **200** |              ~21 ms |
| reduction |      **3000× fewer** |     **20× fewer** |            ~2.2× faster |

Reading these honestly:
- **Round-trips are the real story, not the wall time.** The bench runs on
  in-memory SQLite where a round-trip is nearly free, so wall time only improves
  ~2×. On a networked Postgres each of the 6000 writes pays a full RTT (~0.5–2 ms
  LAN, more over WAN); cutting that to 2 is where batching pays off — the bench
  deliberately measures the round-trip count so the win is visible without a
  network in the loop.
- **The read reduction (20×) is incidental** — it comes from read-your-writes
  serving repeat balance lookups from the buffer. The structural read win (SQL
  `WHERE`/`LIMIT` pushdown over the secondary indexes added in this milestone,
  instead of whole-table scans) is tracked separately as opidx-#42 / M17.
- Writes are chunked to stay under the driver's bind-parameter ceiling (SQLite
  ~32766, Postgres 65535), so a very large block fans out into a few statements,
  not one oversized one. Verified on real Postgres in `tests/postgres.integration.test.ts`.
- The bench asserts the batched final state is **identical** to the unbatched
  one, and the crash-injection dogfood (`npm run dogfood:atomicity`) exercises the
  buffered path end-to-end — a mid-block crash still rolls the whole block back.

## Query pushdown (M17) — the opidx-#42 DoS fix

The GraphQL connection resolver used to call `store.list(entity)` — loading the
**whole table** into memory — then filter/sort/paginate in JS. On a big table one
query could OOM the process. `store.query()` now compiles the connection args into
a parameterised `WHERE … ORDER BY … LIMIT` (keyset) statement; a `first: 20` page
reads ~20 rows no matter the table size.

`npm run bench:query` — `holder = 0x7, order by block, first 20` over **200 000** rows:

| path | rows loaded | wall | added heap |
|------|------------:|-----:|-----------:|
| whole-table (old) | 200 000 | ~159 ms | ~18 MB |
| SQL pushdown (new) | **20** | **~1 ms** | negligible |
| reduction | **10 000× fewer** | **~154× faster** | — |

The bench asserts the pushdown page is identical to the whole-table page. Notes:
- **bigint** is stored as TEXT, so range/order `CAST(... AS NUMERIC)` — exact on
  Postgres (verified at uint256 scale in `tests/postgres.integration.test.ts`),
  exact to ~2^53 on SQLite. Equality/`_in` are exact TEXT compares everywhere.
- Pagination is **keyset** (`(sortValue, id) > cursor`), not offset — stable under
  concurrent writes, and a past-the-end cursor returns empty (the old code wrongly
  returned page 1). Field/order names are schema-validated, never interpolated.

## Cross-tool comparison

For apples-to-apples numbers against The Graph, Ponder, Subsquid, rindexer and
Substreams, run the maintained standard harness rather than trusting any single
vendor's post:

**[github.com/enviodev/open-indexer-benchmark](https://github.com/enviodev/open-indexer-benchmark)**
— scenarios include decoded-event-stream, state-aggregation, factory-registration,
external-contract-calls and time-based snapshots. It is Envio-maintained, so treat
the published leaderboard with that in mind and **re-run it on your own workload**.

Adding op-index as a target there (a thin adapter around `EvmLogSource` +
`createIndexer`) is the honest way to place it on that leaderboard; tracked as a
follow-up.
