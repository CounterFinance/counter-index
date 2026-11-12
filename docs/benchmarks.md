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
- **One `store.set` per event**, no batching. The deferred "bulk per-block writes"
  optimisation (buffer a block's writes into one multi-row upsert) would raise
  write-bound throughput further; see the roadmap §9 backlog.
- Postgres will differ from SQLite (network round-trips vs in-process).

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
