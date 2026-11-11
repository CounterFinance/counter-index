# op-index — Multichain Architecture & Roadmap

Status: design doc. Target: evolve op-index from an OPNET-only indexer into a
**chain-neutral core + per-chain adapters**, without breaking the OPNET path.

The guiding principle: **handlers, the store, the schema, and the GraphQL layer
never learn which chain they are on.** Everything chain-specific is pushed down
into a source adapter and a decoder.

**Direction (locked):** this is a **clean break** — no backwards-compatibility
layer, no deprecation shims. OPNET is no longer live, so it is **not** the
reference path; it is demoted to one optional legacy adapter (useful as a test
fixture and because the decoders already exist), with **no reserved chain ID**.
The design is **EVM-first**: real EIP-155 chain IDs, ABI-based decoding, and
`eth_getLogs` as the primary source. Rename, move, and restructure anything —
downstream consumers (e.g. OpIndexEcosystem) are expected to update to the new
API, not be preserved.

---

## 1. Honest inventory — what already exists

Strong, reusable, do **not** rebuild:

| Capability | Where | Notes |
|---|---|---|
| Zero-codegen schema → GraphQL | `schema.ts`, `graphql.ts` | Relay cursor pagination, filters, `graphql-ws` subscriptions, all derived from `defineSchema` |
| Single universal event struct | `types.ts` `DecodedEvent` | Every source produces this one shape — the abstraction seam already exists |
| Pluggable `EventSource` | `source.ts` | `queryStream(from,to,filters)` + `subscribe()`; clean, chain-shaped seam |
| Memory-bounded streaming backfill | `indexer.ts` `sync()` | `AsyncIterable`, never materialises a range |
| **Atomic per-block commit + checkpoint** | `indexer.ts:206` `dispatchBlock` | `sink.transaction(() => { dispatchBlock; writeBlockCheckpoint })` — crash-safe resume is already solved |
| Decode-at-read-time registry | `decoders/eventDecoders.ts` | `registerDecoder` / `DECODER_REGISTRY`; add a decoder, all history re-decodes |
| `txEvents` sibling correlation | `source.ts` | Router pattern handled for you |
| Dual sink SQLite/Postgres | `adapter.ts` | Dialect-aware SQL |
| Perf timing hooks | consumer `perf.ts` | External wrap of `on()` |

Gaps (the whole point of this doc):

1. The event/transaction model is **OPNET-shaped**, not chain-neutral.
2. No **`chainId`/network** dimension anywhere (events, entities, GraphQL).
3. Decoding keys on **event name only** — no ABI/topic/discriminator model.
4. No **EVM/Solana source adapters**.
5. No **reorg rollback** (checkpoint is forward-only; `TODO.md` defers to 1.0 —
   acceptable on OPNET, **mandatory** on EVM/L2s/Solana).
6. No framework-level **factory/dynamic-source** pattern (consumers do it by hand).
7. Store is **string-keyed with manual casts** (`from as string`) — no type inference.
8. No **`/metrics` or `/health`** endpoint; backfill concurrency = 1.

---

## 2. The core refactor — `ChainEvent`

Today `DecodedEvent` mixes three concerns: universal fields, OPNET-specific
fields, and decode output. Split them.

```ts
// Universal — every chain produces exactly this.
export interface ChainEvent {
  chainId: number;            // EIP-155 chain id: 1 = Ethereum, 8453 = Base, etc. No reserved values.
  network: string;            // "eth-mainnet", "base-mainnet", "sol-mainnet", ...
  blockNumber: number;        // slot number on Solana
  blockHash: string;          // NEW — required for reorg detection (see §6)
  parentHash?: string;        // NEW — enables fork-point detection
  blockTimestamp?: number;
  txHash: string;
  txIndex?: number;
  logIndex?: number;          // intra-tx ordering (EVM log index / OPNET log_index)
  contractAddress: string;    // program id on Solana
  eventName: string;          // decoder key for OPNET; topic0-derived for EVM
  raw: Uint8Array;            // topics+data concat on EVM; event payload on OPNET
  decoded: Record<string, unknown> | null;

  // Sibling correlation (unchanged semantics)
  txEvents?: Map<string, Array<{ type: string; raw: Uint8Array }>>;

  // Chain-specific context — namespaced, never read by core/handlers-by-default
  chainMeta?: ChainMeta;
}

// Discriminated union so OPNET fields don't leak onto EVM events.
export type ChainMeta =
  | { kind: 'opnet'; fromAddress?: string; fromAddressPubkey?: string;
      gasUsedSat?: bigint; burnedBitcoin?: bigint; failed?: boolean; revertReason?: string | null }
  | { kind: 'evm'; from?: string; topics: string[]; gasUsed?: bigint;
      effectiveGasPrice?: bigint; removed?: boolean }
  | { kind: 'solana'; signer?: string; programId: string; innerInstructionIndex?: number };
```

**No alias, no shim.** `DecodedEvent` is renamed to `ChainEvent` and the
OPNET-specific top-level fields are removed outright — they move under
`chainMeta` with `kind: 'opnet'`. This is a breaking change by design; there is
no compatibility layer to maintain. The OPNET decoders (`eventDecoders.ts`,
`standards.ts`, `p2op.ts`, `tokens.ts`) are retained but relocated behind the
OPNET adapter so the core imports nothing Bitcoin-specific.

Acceptance: core (`indexer.ts`, `store.ts`, `graphql.ts`, `schema.ts`) imports
**zero** chain-specific symbols; grep for `burnedBitcoin`/`p2op`/`satoshi` in the
core returns nothing. EVM handlers read `event.chainMeta` with `kind: 'evm'`
narrowing. OPNET adapter still produces valid `ChainEvent`s in its own tests.

> **Implemented (M1, see DECISIONS D5):** rather than a closed union in core, the
> engine defines only the open base `ChainMeta { kind: string }`; each adapter
> owns its concrete meta (`OpnetChainMeta extends ChainMeta` in
> `src/chains/opnet/types.ts`). This keeps core from enumerating any chain and
> makes adding EVM (M4) a zero-core-edit change. Handlers narrow on `kind` and
> cast to the adapter meta type.

---

## 3. Generalized decoder model

Today: `decodeEvent(eventName, raw)` → single global registry keyed by name.

Target: a **per-source decoder strategy** so the key can be chain-appropriate.

```ts
export interface Decoder {
  /** Produce an eventName + decoded fields from a raw log, or null to skip. */
  decode(raw: RawLog): { eventName: string; decoded: Record<string, unknown> } | null;
}

// OPNET: keep the existing name-keyed registry (no behaviour change).
class OpnetDecoder implements Decoder { /* wraps DECODER_REGISTRY */ }

// EVM: ABI-driven. Key on topics[0] (the event signature hash).
class EvmAbiDecoder implements Decoder {
  constructor(abis: InterfaceAbi[]);   // builds topic0 -> fragment map
  // decode(): match topics[0], decode indexed topics + data via ethers Interface
}
```

The source owns its decoder; the indexer stays decoder-agnostic. `registerDecoder`
stays for OPNET back-compat. Add **`DECODER_REGISTRY` introspection**
(existing TODO item) so boot can print which events are decodable per chain.

---

## 4. EVM source adapter (`EvmLogSource`)

Implements the existing `EventSource` interface — nothing above it changes.

- `queryStream(from,to,filters)`: batched `eth_getLogs` with **server-side**
  `address` + `topics` filters (the EVM advantage — no scan-everything). Chunk by
  block range, respect provider range caps, exponential backoff, yield lazily.
- `subscribe()`: poll `eth_blockNumber`, or `eth_subscribe("logs")` over WS when
  available; emit `ChainEvent` with `blockHash`/`parentHash` populated.
- Decoder: `EvmAbiDecoder` built from the ABIs the consumer registers.
- `txEvents`: group logs by `transactionHash` within the fetched range (same
  pattern as `fetchTxEventsMaps`).

Solana (`SolanaSource`) is a later milestone: Helius/`getSignaturesForAddress` +
Anchor-discriminator decoding; slots as block numbers. Design the interface now
so it isn't EVM-only, implement later.

---

## 5. Multi-network — one schema, many chains

A portfolio spans chains, so entity identity must include the chain.

- `defineSchema` gains an optional `multichain: true` flag that injects a
  `chainId` column into every entity and makes the **effective primary key
  `(chainId, id)`**.
- `store.set/get/update/delete` gain an implicit `chainId` from the handler
  context (the source stamps it), so handlers stay chain-agnostic:
  `ctx.store.set('TokenHolder', `${token}:${holder}`, {...})` writes the current
  chain's row automatically.
- GraphQL exposes `chainId` as both a field and a filter arg; cursor pagination
  keys become `(chainId, ...)`.
- **Orchestration**: `createMultiIndexer({ schema, sink, sources: [...] })` runs
  one `sync`/`subscribe` loop per source against a shared store. Each source has
  its own checkpoint row (`writeBlockCheckpoint` keyed by `chainId`). No shared
  mutable block cursor — independent per chain.

Acceptance: a single GraphQL endpoint returns `tokenHolders(where:{chainId:1})`
and `(where:{chainId:8453})` from the same schema, backfilled by two EVM sources
(e.g. Ethereum + Base).

---

## 6. Reorg handling (promoted from "post-MVP" to required)

On EVM/L2s and Solana, reorgs are routine. Design:

- **Per-block write journal**: inside `dispatchBlock`'s existing transaction,
  record an inverse-op log of every `store.set/update/delete` for the last
  `R` blocks (R = confirmation depth, configurable per chain, e.g. 12 for ETH
  mainnet, higher for fast L2s). Journal is pruned past finality.
- **Fork detection** in `subscribe`: compare incoming `parentHash` against the
  stored `blockHash` of `blockNumber-1`. On mismatch, walk back to the fork
  point, **replay the journal in reverse** to undo entity writes, rewind the
  checkpoint, and re-sync from the fork.
- **Finality lag** option: index at `tip - confirmations` by default for a
  simpler consumer, with an opt-in "unsafe head" mode for low latency.

This is the one item that needs a short design note of its own before coding —
the journal format and the undo semantics for counter-style updates
(`balance += x`) are the subtle part (store the delta, not the absolute).

Acceptance: an injected fork in a test source rolls entity state back to the
pre-fork values; no orphaned rows; checkpoint rewinds.

---

## 7. Framework-level factory / dynamic sources

`OpIndexEcosystem` discovers farms/tokens by hand (allow-list checks inside
handlers). Lift it into the framework:

```ts
indexer.onFactory('MotoChefDeployed', (event) => ({
  address: event.decoded!.motoChef as string,   // new contract to start watching
  // optional fromBlock override, template tag
}));
```

The indexer adds the child address to the live filter set and (optionally)
back-scans from its deployment block. This is standard in The Graph (templates)
and Ponder (factory sources); having it is table-stakes parity.

---

## 8. Typed store from schema (DX, differentiator)

Kill the `from as string` casts. Infer entity row types from `defineSchema` via
TS generics so `store.set('TokenHolder', key, row)` type-checks `row` against the
schema and `store.get(...)` returns the typed row. Zero codegen, unlike Ponder's
generate step — this is a genuine ergonomic edge worth showing.

---

## 9. Observability & throughput (existing TODO items, folded in)

- `/health` and `/metrics` (Prometheus) on `serve()` — lag, blocks/sec, events/sec,
  per-handler timings, reorg count.
- **Entity delta counters** in `IndexerStats` (created/updated/deleted,
  writesByTable) — existing TODO, surface in the per-block INFO line.
- **Named handlers** `on(event, name, handler)` — existing TODO; unlocks
  per-handler perf and slow-handler WARN.
- **Bulk per-block writes** (buffered `commitBlock`) — existing TODO; 3–10× on
  write-bound backfill.
- **Ordered-parallel chunk fetching** + Postgres `sql.cursor()` — existing TODO;
  matters more on EVM's huge ranges.

---

## 10. Proof-of-generality deliverable

An `examples/evm-portfolio/` app in-repo: point `EvmLogSource` at an ERC-20 +
ERC-721 set on one EVM chain, index `Transfer` into `TokenHolder`/`TokenTransfer`
with running balances, serve the same GraphQL shape `OpIndexEcosystem` serves for
OPNET. This is the artifact that proves "one framework, many chains" end to end.

---

## 11. Milestones (sequenced for `/general-pass`, each `/bob-pass`-gated)

Each milestone is an independent branch off `dev`, tested, and merged before the
next. M1 is a pure refactor (no behaviour change) and unblocks everything.

| # | Milestone | Scope | Risk | Depends on |
|---|---|---|---|---|
| **M1** | `ChainEvent` model (clean break) | §2 — rename `DecodedEvent`→`ChainEvent`, add `chainId`/`network`/`blockHash`/`parentHash`, move OPNET fields under `chainMeta`, relocate OPNET decoders behind an adapter, purge chain-specifics from core. No shim. | Low (refactor, fully testable) | — |
| **M2** | Decoder strategy interface | §3 — `Decoder` interface, wrap existing registry as `OpnetDecoder`, registry introspection | Low | M1 |
| **M3** | Typed store from schema | §8 — generic inference, remove casts | Low (types only) | M1 |
| **M4** | `EvmAbiDecoder` + `EvmLogSource` | §3/§4 — `eth_getLogs` batching, WS subscribe, ABI decode, `txEvents` grouping | Med | M1, M2 |
| **M5** | Multi-network store + `createMultiIndexer` | §5 — `chainId` entity dimension, per-chain checkpoints, GraphQL filter | Med | M1 |
| **M6** | Reorg handling | §6 — write journal, fork detection, rollback, finality lag (needs design note first) | High | M1, M5 |
| **M7** | Factory / dynamic sources | §7 | Med | M1 |
| **M8** | Observability + throughput | §9 — metrics/health, delta counters, named handlers, bulk writes, parallel fetch | Med | M1 |
| **M9** | `examples/evm-portfolio` | §10 — end-to-end proof | Low | M4, M5 |

Suggested order: **M1 → M2 → M3 → M4 → M5 → M9** (a shippable multichain story),
then **M6 → M7 → M8** (hardening + parity).

### Definition of done (every milestone)
- `npx tsc --noEmit` clean, `eslint` zero errors (CLAUDE.md).
- Vitest coverage for new behaviour; OPNET adapter tests still green.
- Branch off `dev`, PR to `dev` with one `semver:` label, alpha publish flow.
- `/bob-pass` green (CRAP hotspots, interface depth, mutation survivors addressed).

---

## 12. External references to base on (2026)

Don't rebuild solved layers — study / adopt these. All open source unless noted.
Benchmark numbers in the ecosystem are mostly vendor-run; verify on own workload.

| For | Project | Repo / link | Steal |
|---|---|---|---|
| **M4** EVM source speed | **Envio HyperSync** | `enviodev/hypersync-client-node`, `enviodev/hyperindex` | Adopt HyperSync as the primary EVM source adapter (raw `eth_getLogs` as fallback). Fastest backfill path; rindexer/Squid top results all read it. Hosted layer needs an API token; clients are open. |
| **M6** reorg | **Ponder** | `ponder-sh/ponder` | Rollback to common ancestor against an **internal transaction log, not user tables** — validates our write-journal design (§6). Read its sync engine. |
| **M6** reorg (simple default) | **Envio HyperIndex** | `enviodev/hyperindex` | Confirmation-threshold model: safe below `max_reorg_depth` (default 200 blocks under head), configurable per chain. Good conservative default to offer. |
| **M6** reorg (canonical) | **The Graph** | `graphprotocol/graph-node` | Block pointers + revert handling, the heavyweight reference (Rust). |
| **M5** multichain ordering | **Ponder** | `ponder-sh/ponder` (see issue #2417) | Omnichain (one merged stream, ts→chainId→block) vs multichain (independent, their new default). Omnichain live indexing **trails the slowest chain** — reason we chose per-chain independent checkpoints. |
| **M2** batch processor | **Subsquid / SQD** | `subsquid/squid-sdk` | Archive/batch-processor design (OpStream is modelled on their Archive); external-call batching. |
| **Peer to read fully** | **Ponder** | `ponder-sh/ponder` | Closest analog: TS, schema+handlers+GraphQL, factory sources, store API. |
| **Rust alt** | **rindexer** | `joshstevens19/rindexer` | ABI-driven EVM indexer, HyperSync-backed. |
| **M8** test rig | **Open Indexer Benchmark** | `enviodev/open-indexer-benchmark` | Maintained harness: decoded-event-stream, state-aggregation, factory-registration, external-calls, time-snapshots, block-handlers. Use its scenarios as our perf/acceptance tests; rerun on our workload. |
| **M7** factory at scale | Envio (lesson) | — | HyperIndex strained around ~8M factory addresses; design the factory filter for scale. |
| **Solana (later)** | HyperIndex Solana / carbon | `enviodev/hyperindex`, `sevenlabs-hq/carbon` | Instruction-level indexing (HyperIndex Solana stable Sept 2026); verify current state when reached. |

**One-line strategy:** adopt HyperSync as a source adapter (M4), copy Ponder's
rollback-via-internal-log (M6), and use open-indexer-benchmark as the test rig (M8).
</content>
</invoke>
