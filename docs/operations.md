# Operating counter-index in production

What an on-call engineer needs at 3am: *is it alive, how far behind is it, why is
it slow, and can I restart it without corrupting state.* This is M18.

Verify the whole chapter end-to-end with `npm run dogfood:ops` (health states →
metrics scrape → graceful shutdown, all asserted).

## Health states

`indexer.health()` (and `GET /health`) returns one of:

| state | meaning | `/health` HTTP |
|-------|---------|----------------|
| `starting` | constructed, not yet syncing | 200 |
| `backfilling` | catching up; some chain is past the live-lag threshold | 200 |
| `live` | every chain is within `liveLagThreshold` of its tip | 200 |
| `degraded` | still progressing, but a source error occurred within `degradeMs` | 200 |
| `stalled` | no block committed on any chain for longer than `stallMs` | **503** |
| `draining` | graceful shutdown in progress | **503** |
| `stopped` | shut down | **503** |

`degraded` and `stalled` are **derived at read time** from the clock + lag, there
is no background timer, and a newly-discovered lagging chain demotes a `live`
indexer back to `backfilling` automatically. The 503 states are what a Kubernetes
readiness probe or a load balancer should drain on. Tune the thresholds:

```ts
await createIndexer({
  schema, sink, source,
  lifecycle: { stallMs: 30_000, liveLagThreshold: 2, degradeMs: 15_000 },
});
```

## Metrics (`GET /metrics`, Prometheus text format)

```
opindex_blocksProcessed 1041
opindex_eventsProcessed 51233
opindex_entitiesWritten 51233
opindex_reorgs_total 0
opindex_errors_total 0
opindex_uptime_ms 3600123
opindex_health_state{state="live"} 1          # one-hot gauge, alert on == "stalled"
opindex_health_state{state="stalled"} 0
opindex_chain_blocks_behind{chain="1"} 0      # per-chain lag
opindex_chain_last_block{chain="1"} 21034111
opindex_chain_idle_ms{chain="1"} 812
opindex_handler_latency_ms_bucket{le="5"} 50891   # handler latency histogram
opindex_handler_latency_ms_bucket{le="+Inf"} 51233
opindex_handler_latency_ms_count 51233
opindex_handler_latency_ms_sum 48210
opindex_writesByTable{key="Transfer"} 51233
```

Useful alerts: `opindex_health_state{state="stalled"} == 1`,
`opindex_chain_blocks_behind > <N>`, `rate(opindex_errors_total[5m]) > 0`, and a
latency SLO from the histogram (`histogram_quantile(0.99, ...)`).

## Graceful shutdown

```ts
const indexer = await createIndexer({ schema, sink, source });
indexer.subscribe(fromBlock);
await indexer.serve({ port: 4000 });
indexer.installSignalHandlers();        // SIGTERM/SIGINT → shutdown() → exit(0)

indexer.onShutdown(async () => { /* flush your own resources */ });
```

`shutdown()` (idempotent):
1. marks the indexer `draining` (so `/health` returns 503 and LBs drain it),
2. stops the live subscription (no new blocks start),
3. **awaits the in-flight block**: block commits are atomic (see
   [durability.md](./durability.md)), so this lands on a clean block boundary;
   the checkpoint never advances past partially-applied state,
4. closes the HTTP server, then the sink DB,
5. runs your `onShutdown` hooks.

Because of step 3 + per-block atomicity, a `SIGTERM` (or a crash) can only ever
cost you the *current* block, which is simply re-fetched and re-applied on restart
(exactly-once). There is no partial-block corruption to clean up.

## Tracing (OpenTelemetry-shaped hook)

counter-index does **not** bundle the OpenTelemetry SDK, a library shouldn't force a
tracing backend on its host. Instead it emits one span per block through a small
`Tracer` interface you can point anywhere:

```ts
import { jsonTracer } from '@counterfinance/counter-index';

// Local dogfooding, one JSON line per block span:
await createIndexer({ schema, sink, source, tracer: jsonTracer((line) => logger.info(line)) });
```

Bridging to a real collector is a ~10-line shim, wrap your OTel tracer so
`startSpan(name, attrs)` returns `{ setAttribute, end }`:

```ts
import { trace } from '@opentelemetry/api';
const otel = trace.getTracer('counter-index');
const tracer = {
  startSpan(name, attrs = {}) {
    const span = otel.startSpan(name, { attributes: attrs });
    return { setAttribute: (k, v) => span.setAttribute(k, v), end: () => span.end() };
  },
};
await createIndexer({ schema, sink, source, tracer });
```

This is deliberately a **hook, not an integration**: spans don't reach a
collector until you wire one. Labelled honestly so nobody assumes otherwise.

## Retry / backoff on the source

Transient RPC failures (`eth_getLogs`, `eth_getBlock*`) are retried with
exponential backoff + full jitter when you opt in on the source:

```ts
new EvmLogSource({ chainId, network, abi, rpcUrl, retry: { attempts: 4, baseMs: 200, maxMs: 5000 } });
```

The source exposes `requests` and `retries` counters. `withRetry` is also exported
for your own fetches. Retry lives on the **source** (where the network call is),
not the indexer, so it wraps the actual failing call rather than a whole stream.

## Still open (honest)

- **Config validation** (env/file schema with clear errors) and **incremental
  migrations** instead of reset-from-genesis are M19, not done here.
- The OTel bridge above is documented but not shipped as a package export.
