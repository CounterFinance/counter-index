# Logging

counter-index logs through a small injectable interface, so it integrates with your
stack two ways.

## 1. Bring your own logger

`IndexerLogger` is a five-method contract (`trace`/`debug`/`info`/`warn`/`error`,
each `(ctx, msg, fields)`). Adapt pino, winston, or anything:

```ts
import pino from 'pino';
const p = pino();
const logger = {
  trace: (ctx, msg, f) => p.trace({ ctx, ...f }, msg),
  debug: (ctx, msg, f) => p.debug({ ctx, ...f }, msg),
  info:  (ctx, msg, f) => p.info({ ctx, ...f }, msg),
  warn:  (ctx, msg, f) => p.warn({ ctx, ...f }, msg),
  error: (ctx, msg, f) => p.error({ ctx, ...f }, msg),
};
const indexer = await createIndexer({ schema, sink, logger });
```

The default is a no-op (counter-index never decides your output medium).

## 2. Built-in structured logger (pino-compatible)

`createLogger()` ships tidy logs with no dependency:

```ts
import { createLogger } from '@counterfinance/counter-index';
const indexer = await createIndexer({ schema, sink, logger: createLogger({ level: 'info' }) });
```

- **JSON mode** (non-TTY / production) emits **pino-shaped** lines, pino's numeric
  levels (`10`–`50`), `time`, base bindings (`pid`, `hostname`), then `ctx`, `msg`
  and your fields:
  ```json
  {"level":30,"time":1763000000000,"pid":4211,"hostname":"box","ctx":"indexer","msg":"subscribe start","from_block":100}
  ```
  Because the shape matches pino, it pipes straight into tooling:
  ```bash
  node indexer.js | pino-pretty          # pretty-print locally
  node indexer.js | vector / promtail ...  # ship JSON lines to Loki/Datadog/ELK
  ```
- **Pretty mode** (TTY) prints a clean, coloured line for humans:
  ```
  12:34:56.789 INFO  (indexer): subscribe start from_block=100
  ```

Options: `level`, `pretty` (auto by TTY), `base` (override/extend pid/hostname -
e.g. `{ service, env }`), `write` (custom sink). bigint fields are serialised
safely. The five levels map to volume as documented in `src/logger.ts`
(info ≤ ~1/s, debug 10–100/s, trace 1000+/s).

## Metrics vs logs

Logs are for events; **operational numbers live on `/metrics`** (Prometheus) and
`/health` from `indexer.serve()`: see the observability section of the roadmap.
Don't scrape logs for throughput; scrape `/metrics`.
