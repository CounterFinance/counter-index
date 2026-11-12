# Deploying op-index

op-index is a library you embed in your own indexer process. This is how to run
that process in production. See also [operations.md](./operations.md) (health,
metrics, shutdown) and [durability.md](./durability.md) (atomicity, reorgs).

## Config (validated, fail-fast)

Load config from the environment with `loadConfig` — it coerces types, applies
defaults, and reports **every** problem at once so a bad deploy dies at startup,
not an hour into a backfill:

```ts
import { loadConfig } from '@opnet-collective/op-index';

const cfg = loadConfig({
  databaseUrl: { type: 'url',     required: true, description: 'Postgres DSN' },
  rpcUrl:      { type: 'url',     required: true },
  chainId:     { type: 'integer', required: true, min: 1 },
  fromBlock:   { type: 'integer', default: 0, min: 0 },
  finality:    { type: 'integer', default: 12 },
  port:        { type: 'number',  default: 4000, min: 1, max: 65535 },
  logLevel:    { type: 'string',  default: 'info', enum: ['debug','info','warn','error'] },
});
// Env: DATABASE_URL, RPC_URL, CHAIN_ID, FROM_BLOCK, FINALITY, PORT, LOG_LEVEL
```

A missing/invalid value throws a `ConfigError` listing each problem.

## Docker

A reference image is in [`deploy/Dockerfile`](./deploy/Dockerfile): multi-stage,
non-root, and `dumb-init` as PID 1 so **SIGTERM reaches the process** and triggers
graceful shutdown (finish the in-flight block, flush, checkpoint, close). Without
an init that forwards signals, the orchestrator kills the pod mid-block.

```dockerfile
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
```

Wire shutdown + health in your entrypoint:

```ts
const indexer = await createIndexer({ schema, sink, source, reorg: { finalityDepth: cfg.finality } });
await indexer.serve({ port: cfg.port });        // GET /health, GET /metrics
indexer.subscribe(cfg.fromBlock);
indexer.installSignalHandlers();                // SIGTERM/SIGINT -> shutdown() -> exit(0)
```

## Kubernetes / Railway

- **Readiness probe → `GET /health`.** It returns **503** when `stalled`,
  `draining`, or `stopped`, so the orchestrator drains the pod automatically; 200
  otherwise (`degraded` stays 200 — still progressing).
- **`terminationGracePeriodSeconds` ≥ your max block time** so the in-flight block
  can finish before SIGKILL. Block commits are atomic, so a kill only ever costs
  the current block (re-applied on restart — exactly-once).
- **Metrics:** scrape `GET /metrics` (Prometheus). Alert on
  `opindex_health_state{state="stalled"} == 1` and `opindex_chain_blocks_behind`.

```yaml
readinessProbe:
  httpGet: { path: /health, port: 4000 }
  periodSeconds: 10
terminationGracePeriodSeconds: 60
```

## Horizontal scaling

op-index scales by **partitioning writers**, not by replicating one. Each chain
(or each disjoint contract set) is its own single-writer process with its own
per-chain checkpoint — never two writers on the same `(chainId, entity)` range, or
they race the checkpoint. Read scaling is separate: the GraphQL API is stateless,
so run many read replicas of `serve()` against the same Postgres and put them
behind a load balancer. For multichain, `createMultiIndexer` with a dedicated
`sink` connection per chain backfills chains in parallel (see benchmarks.md).

## Schema migrations

Adding a field to your schema is applied **in place** on startup (`ALTER TABLE ADD
COLUMN`, existing rows get the field's default) — no reset-from-genesis. op-index
does **not** auto-apply lossy changes (type changes, drops, renames); do those as
a deliberate migration + re-index of the affected entity.

## Not covered here

Fast-sync / snapshot restore from a peer and automated data-retention policies are
a documented follow-up — today, re-index from `fromBlock` or restore a Postgres
base backup.
