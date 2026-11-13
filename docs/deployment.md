# Deployment

counter-index is a library — it has no entry point of its own. You deploy *your indexer app*, which
imports counter-index and wires everything together. This guide covers the recommended way to do that
with Docker and docker-compose.

## Project layout

The recommended layout for a project built on counter-index:

```
opnet-collective/
  counter-index/               ← counter-index library (this repo)
  my-indexer/             ← your indexer app
    src/
      main.ts             ← entry point (~50 lines)
      handlers/
        transfers.ts      ← your event handlers
    Dockerfile
    docker-compose.yml
    package.json          ← "@counterfinance/counter-index": "^0.1.0"
    tsconfig.json
```

## Scaffold a new indexer

The fastest way to start is `npx @counterfinance/counter-index init`:

```bash
npx @counterfinance/counter-index init my-indexer
# Creates my-indexer/ in the current directory with:
#   package.json, tsconfig.json, .gitignore, .env.example
#   src/main.ts, src/handlers/transfers.ts
#   Dockerfile, docker-compose.yml
cd my-indexer && npm install && npm run dev
```

No monorepo required — works anywhere Node ≥ 24 and npx are available.

If you are working inside the counter-index monorepo, the `just scaffold` command does the same thing:

```bash
cd counter-index
just scaffold my-indexer
# Creates ../my-indexer/ — identical output
```

## Dockerfile

counter-index ships a two-stage `Dockerfile` template. Stage 1 compiles TypeScript and builds native
modules; stage 2 runs only the compiled output — no build tools or TypeScript compiler in
production.

Copy it to your indexer root (no modifications needed for a standard layout):

```dockerfile
# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-slim AS builder
WORKDIR /build

COPY package*.json ./
RUN npm ci
COPY src        ./src/
COPY tsconfig.json ./
RUN npm run build          # compiles src/ → dist/

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /build/package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /build/dist ./dist

RUN mkdir -p /app/data && \
    groupadd -r indexer && \
    useradd -r -g indexer indexer && \
    chown -R indexer:indexer /app
USER indexer

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
```

A `.dockerignore` prevents `node_modules/` and `.db` files from bloating the build context:

```
node_modules/
dist/
.git/
*.db
.env
```

## docker-compose.yml

counter-index's `docker-compose.yml` wires OpStream and your indexer together on a shared volume:

```yaml
services:
  opstream:
    image: ghcr.io/opnet-collective/opstream:latest
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db

  counter-index-indexer:
    build:
      context: .
      dockerfile: Dockerfile
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db
      - OPINDEX_DB_PATH=/data/opindex.db
      - FROM_BLOCK=941400
    ports:
      - "4000:4000"   # GraphQL API
    depends_on:
      - opstream

volumes:
  chain_data:
```

SQLite: both services mount the same named volume — `opstream.db` and `opindex.db` live side by side.

For Postgres, add the bundled Postgres profile:

```yaml
  postgres:
    image: postgres:16-alpine
    profiles: [postgres]
    environment:
      POSTGRES_DB: opnet
      POSTGRES_USER: opnet
      POSTGRES_PASSWORD: opnet
    volumes:
      - pg_data:/var/lib/postgresql/data

volumes:
  pg_data:
```

## justfile commands

If you have [just](https://github.com/casey/just) installed, counter-index's `justfile` covers the full
development lifecycle:

```bash
just                   # list all available commands

# Development
just install           # npm install
just test              # run vitest
just typecheck         # npx tsc --noEmit

# Docker
just docker-build      # build the indexer image
just docker-up         # start OpStream + your indexer (SQLite)
just docker-up -- --profile postgres  # start with Postgres
just docker-down       # stop all services
just docker-logs       # tail logs from all services

# Scaffold
just scaffold my-indexer  # generate a new starter indexer project
```

## Environment variables

Recommended environment variable conventions for your `src/main.ts`:

```ts
const OPSTREAM_DB = process.env['OPSTREAM_DB_PATH'] ?? '/data/opstream.db';
const OPINDEX_DB  = process.env['OPINDEX_DB_PATH']  ?? '/data/opindex.db';
const FROM_BLOCK  = Number(process.env['FROM_BLOCK'] ?? '941400');
const PORT        = Number(process.env['PORT']        ?? '4000');
```

## Production checklist

- **Separate source and sink databases** — OpStream writes to `opstream.db` continuously;
  keeping `opindex.db` separate prevents write contention.
- **Run behind a reverse proxy** — nginx, Caddy, or Cloudflare in front of port 4000 gives you
  TLS, rate limiting, and origin-restricted CORS without changing counter-index's configuration.
- **Mount volumes on fast storage** — SQLite is extremely fast on SSDs; avoid network-attached
  storage for the database files.
- **Handle `SIGTERM` cleanly** — call `stop()` on your subscribe handle and the GraphQL server
  handle so in-flight requests drain before the process exits:

```ts
process.on('SIGTERM', async () => {
  stopSubscription();
  await graphqlHandle.stop();
  process.exit(0);
});
```

## Development without Docker

```bash
cd counter-index
npm install
npm test              # run all tests
npm run test:watch    # watch mode
npx tsc --noEmit      # type-check only
```

No database setup needed — tests use an in-memory SQLite adapter.
