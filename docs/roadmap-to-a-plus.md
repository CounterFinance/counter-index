# Roadmap to A+

Where op-index is today (self-assessed **A−**): a chain-neutral core proven by a
zero-core-edit EVM adapter, journalled reorg handling verified on a live node,
multichain with a real composite key, a typed store, `/metrics` + `/health`, a
pino-grade logger, and **live-mainnet indexing** — 266 tests, 86.5%/82.4%
coverage, clean git history.

What separates **A−** from **A+** is not more features — it's **trust, speed, and
operability at production scale**, plus the polish that makes people *adopt* it.
This document lists every milestone to get there, continuing the M-series
(M1–M9 shipped). Each item: **priority** (P0 = blocks "production-grade", P1 =
strongly expected, P2 = differentiator), rough **effort**, and *why it matters*.

> **If you only do five things:** M10 (per-block atomicity), M12 (mutation +
> property tests), M13 (batched writes + indexes), M18 (graceful shutdown +
> real health states), M22 (security audit of the GraphQL filter path). Those
> five move the needle on trust/speed/safety more than anything else.

---

## Phase A — Correctness & trust (an A+ indexer is *trusted*)

### M10 — Per-block atomicity + crash safety  · P0 · ~1–2 days
Today a block's **entity writes auto-commit per `store.set`**, and only
`onBlock` + the checkpoint are wrapped in a transaction. A crash mid-block can
leave partial entity state with the checkpoint not advanced — correctness relies
on idempotent re-processing, not atomicity.
- [ ] Wrap **all** of a block's entity writes + `onBlock` + checkpoint in **one**
      `sink.transaction` so a block is all-or-nothing.
- [ ] Failure-injection tests: kill the process mid-block, restart, assert **no
      double-counting and no gaps** (the single most important durability test).
- [ ] Document the exactly-once / idempotency guarantee precisely.
*Why:* this is the difference between "probably correct" and "provably durable."

### M11 — Reorg hardening · P0 · ~2–3 days
Reorg handling exists and is live-verified, but only for the common cases.
- [ ] Reorgs **during backfill** (not just live).
- [ ] **Deep reorg** beyond `finalityDepth`: detect, stop, and alert instead of
      silently diverging.
- [ ] **Crash during rollback** → restart → consistent state.
- [ ] Reorg **across a getLogs batch boundary** and one **touching a factory**
      child.
- [ ] Property test (fast-check): journal **apply-then-undo == identity**.
- [ ] An anvil reorg **matrix** (shallow/deep/backfill-handoff/batch/factory) in CI.
*Why:* reorgs are where indexers silently corrupt. A+ means proven, not hoped.

### M12 — Test rigor (kill the "lying tests" risk for real) · P0 · ~2 days
- [ ] **Stryker mutation testing** configured; kill surviving mutants on core
      logic (store, reorg journal, decoders) with better assertions — so a wrong
      result *always* fails a test.
- [ ] **Property/fuzz tests** (fast-check): decoder ABI round-trips + malformed
      input (never throws), block-range splitting, balance-accumulation invariants.
- [ ] **Postgres contract tests** against a dockerized PG in CI (the Postgres
      path is currently lightly covered).
- [ ] **Golden snapshots for EVM** (mirror the OPNET golden) to lock behaviour.
- [ ] **Coverage floor enforced in CI** (e.g. fail < 85% lines / 80% branch).
*Why:* "266 tests" is an input; "mutations die and PG is tested" is an outcome.

---

## Phase B — Performance (an A+ indexer is *fast*)

### M13 — Write throughput · P0 · ~2 days  _(partly #34)_
Today it's one SQL round-trip per `store.set`.
- [ ] **Bulk per-block buffered writes**: accumulate a block's writes, flush as
      one multi-row `INSERT … ON CONFLICT` per table at `commitBlock` (3–10× on
      write-bound backfill). Buffer must be **read-your-writes** (a `get` in the
      same block sees pending writes).
- [ ] **Secondary indexes from the schema**: `{ type, index: true }` →
      `CREATE INDEX`. Right now `orderBy block` / `where token` scan.
- [ ] Prepared-statement reuse / caching on the hot path.
*Why:* the current ~192k ev/s is in-memory SQLite with trivial writes; batching
is what makes Postgres-over-network viable.

### M14 — Backfill speed · P1 · ~3–4 days  _(includes #18)_
- [ ] **HyperSync source** (`@envio-dev/hypersync-client`) as the fast EVM
      backfill path, with `EvmLogSource` as the fallback (token in NEEDS_YOU).
- [ ] **Ordered-parallel chunk fetching** (currently concurrency = 1).
- [ ] **Postgres `sql.cursor()` streaming** for very large ranges.
- [ ] **Per-chain connections** so `createMultiIndexer.syncAll()` runs chains in
      **parallel** (today it's sequential — one shared SQLite connection).
*Why:* backfill time is the first thing a user measures.

### M15 — Benchmarked & proven · P1 · ~1–2 days  _(extends docs/benchmarks.md)_
- [ ] Add op-index as a target in **enviodev/open-indexer-benchmark** and publish
      honest cross-tool numbers (don't trust any vendor's leaderboard).
- [ ] A **load/soak** test (hours of live indexing; watch memory + lag).
*Why:* credible numbers beat claims; soak tests find leaks.

---

## Phase C — Data model & query power

### M16 — Rich schema · P1 · ~3 days
- [ ] **Entity relationships / references** between entities with **nested
      GraphQL resolution** (e.g. `Swap.pool { … }`). Today entities are flat.
- [ ] **`index` + `unique`** field constraints in `defineSchema`.
- [ ] **Typed `event.decoded`**: infer the decoded payload type from the
      registered decoder/ABI so handlers aren't casting `as string`.
- [ ] Derived/computed fields.
*Why:* real apps (DEX, lending) need relations and typed payloads.

### M17 — Query power + API safety · P1 · ~2 days
- [ ] **Push filter/sort/pagination into SQL (P0, verified gap).** Today the
      GraphQL resolver calls `store.list(entity)` — **loading the entire table
      into memory** — then applies `where`/`orderBy`/`first`/`after` in **JS**.
      That doesn't scale and is a **DoS vector** (a query on a big table OOMs the
      process). Translate the connection args into a **parameterised**
      `WHERE … ORDER BY … LIMIT … (keyset) OFFSET` query (relies on M13 indexes).
- [ ] Rich filter operators (`_gt`/`_lt`/`_in`/`_contains`, `AND`/`OR`).
- [ ] **Cursor pagination stability** verified at scale (keyset, not offset).
- [ ] First-class **time-series helpers** (OHLC candles, periodic snapshots) on
      top of `onBlock`.
- [ ] **GraphQL depth + complexity + row-cap limiting** (DoS protection).
*Why:* the API is the product surface; it must be powerful, scalable *and* safe.

---

## Phase D — Operability (an A+ indexer runs in production unattended)

### M18 — Production ops · P0 · ~2–3 days
- [ ] **Graceful shutdown**: SIGTERM → finish the block, flush, checkpoint, close
      the server + DB. (A crash-at-shutdown corrupts.)
- [ ] **Real health states** on `/health`: `starting | backfilling | live |
      degraded | stalled` + per-chain lag — not just `ok`.
- [ ] **Expanded metrics**: per-chain blocks-behind, **reorg counter**, handler
      latency **histograms**, error rate, source request counts.
- [ ] **OpenTelemetry** spans per block/handler (traceable in Grafana/Tempo).
- [ ] Configurable **retry/backoff + rate-limit** per source; **backpressure**.
*Why:* "is it alive, how far behind, why is it slow" must be answerable at 3am.

### M19 — Deploy, config & migrations · P1 · ~2–3 days
- [ ] Production **Docker image** (multi-stage, non-root, dumb-init) + **Railway/k8s**
      deploy docs; horizontal-scaling model (one process per chain/profile).
- [ ] **Config validation** (env + file) with a schema (zod-style) and clear errors.
- [ ] **Incremental schema migrations** instead of `RESET_DB`-from-genesis.
- [ ] **Fast-sync / snapshot restore** from a peer (like OPNET's SYNC_SOURCE), and
      data-retention/pruning policies.
*Why:* re-indexing from genesis on every schema tweak is a dealbreaker at scale.

---

## Phase E — Chains, DX & ecosystem (adoption)

### M20 — A third chain + the fast path · P1 · ~1 week
- [ ] **Solana adapter** (instruction/discriminator decoding + a Solana source).
      Two adapters prove the thesis; three prove "many," and Solana is the
      highest-demand non-EVM chain.
- [ ] Wire **HyperSync** as the EVM default once M14 lands.
*Why:* "many chains" should be true, and Solana is where the demand is.

### M21 — DX & release engineering · P1 · ~3–4 days
- [ ] **CLI**: `op-index init` scaffolds a project; `op-index dev` with reload.
- [ ] **Named handlers** + **slow-handler WARN** (#34) → precise perf attribution.
- [ ] **Middleware/hooks** (before/after block, error handler), **dry-run/replay**.
- [ ] **Examples gallery**: ERC-20, ERC-721, a DEX (pairs+swaps), lending,
      multichain portfolio — each runnable.
- [ ] **typedoc API reference**, published **ADRs**, a docs **site**, an honest
      **comparison page** (vs Ponder/Subsquid/Envio).
- [ ] **Automated npm release** (semver, CHANGELOG, provenance) — currently manual.
*Why:* adoption is a function of first-run experience and docs, not features.

---

## Phase F — Security (non-negotiable for trust)

### M22 — Security audit + hardening · P0 · ~1–2 days
- [ ] **GraphQL path: injection-safe, not scale-safe** (verified). `where`/
      `orderBy`/pagination are applied in JS over a full `store.list()`, so there
      is **no SQL injection** — but the unbounded in-memory load is a **DoS**
      problem. Real SQL goes in via M17; here add a hard **row cap / query
      timeout** so one query can't OOM the process. (When M17 does move filters to
      SQL, keep `orderBy` field names and table names on an **allow-list** — never
      interpolate them — so the move doesn't *introduce* an injection vector.)
- [ ] **API auth** (optional bearer) + **rate limiting** + the complexity limit
      from M17.
- [ ] **Dependency audit** (`npm audit`, provenance, lockfile integrity) + a
      documented supply-chain posture.
- [ ] **Secrets handling** (tokens never logged; `.env` discipline).
- [ ] **Fuzz the decoders** for panics/DoS on adversarial input.
*Why:* one SQL-injection in a filter or one panic-on-bad-input is an instant F,
regardless of how good everything else is.

---

## Priority ladder (what order, honestly)

1. **M10, M22** — atomicity + the injection audit. Cheap, highest trust/safety ROI.
2. **M12** — mutation + property + PG tests. Proves correctness instead of asserting it.
3. **M13, M18** — batched writes/indexes + graceful shutdown/health. Makes it production-fast and operable.
4. **M11, M14** — reorg matrix + HyperSync/parallel backfill. Hardens the two hardest subsystems.
5. **M16, M17, M19** — relations, query power, migrations/deploy. Rounds out the product.
6. **M20, M21, M15** — Solana, DX/CLI/docs, public benchmarks. The adoption + "many chains" story.

## Tracked already
- **M14/#18** HyperSync · **M13&M21/#34** perf + named handlers. New work above gets its own `gli` issues under the epic when started.

## The honest bar for "A+"
A+ is reached when: a block is atomic and crash-proven; reorgs (incl. deep/backfill)
are tested on a devnet matrix; mutations die and Postgres is CI-tested; writes are
batched and indexed; it shuts down gracefully and reports real health + OTel traces;
the GraphQL API is injection-audited, auth'd and complexity-limited; there are three
chains; and there's a CLI, examples, docs site and automated releases. None of it is
exotic — it's the unglamorous 20% that production trust is made of.
