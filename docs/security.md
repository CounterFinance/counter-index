# Security

## Threat model
counter-index serves a public GraphQL API over indexed data. The attack surface is the
HTTP server (`indexer.serve`) and the decoders (adversarial on-chain bytes). We do
**not** accept writes from the network, indexing input comes from a trusted
source adapter.

## Protections (M22)

| Threat | Mitigation | `serve()` option |
|---|---|---|
| Unbounded page (`first: 1e9`) | `first` is **clamped** to a max page size | `maxPageSize` (default 1000) |
| Whole-table load per query | Row cap today; **SQL pushdown** of filter/sort/paging in M17 (bug opidx-#42) |, |
| Deeply-nested query DoS | Reject before execution if selection-set depth exceeds the limit | `maxQueryDepth` (default 12) |
| Request floods | Per-IP sliding-window rate limit | `rateLimit: { windowMs, max }` |
| Oversized body | 1 MB body cap → 413 (stops buffering past the cap) | built-in |
| Unauthorized access | Optional `Authorization: Bearer <token>` on POST /graphql | `auth` |
| Malformed on-chain bytes | Decoders **never throw** (return `null`/named-no-fields) |, (fuzzed) |

`/health` and `/metrics` stay unauthenticated by design (load balancers, Prometheus).

## SQL injection
None. GraphQL `where`/`orderBy`/pagination are applied in JS over store reads, not
interpolated into SQL. When M17 moves them into SQL, `orderBy` field names and
table names will be taken from an **allow-list** (the schema), never interpolated.

## Dependency posture
- `npm audit --omit=dev`: **0 vulnerabilities** (checked).
- Runtime deps are minimal (`bech32`, `better-sqlite3`, `graphql`, `postgres`);
  `viem`/`ws`/`graphql-ws` are **optional** peers, imported only in adapters.
- Secrets (RPC/HyperSync tokens) come from env and are never logged.

## Verification
`tests/security.test.ts` is a runnable attack suite, it serves the API and fires
oversized pages, over-deep queries, unauthenticated + wrong-token requests, a
request flood, and an oversized body; each is rejected/capped and the server stays
responsive. `tests/fuzz.decoders.test.ts` fuzzes both decoders with thousands of
random inputs, asserting no panic.
