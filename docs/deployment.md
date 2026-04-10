# Deployment

OpKit is a library — it has no entry point of its own. You deploy *your indexer app*, which
imports OpKit and wires everything together. This guide covers the recommended way to do that
with Docker and docker-compose.

## Project layout

The recommended layout for a project built on OpKit:

```
Opnet-devs/
  OpKit/                  ← OpKit library (this repo)
  MyIndexer/              ← your indexer app
    src/
      main.ts             ← entry point (~50 lines)
      handlers/
        transfers.ts      ← your event handlers
    Dockerfile            ← copy of OpKit/Dockerfile, customised
    docker-compose.yml    ← wires OpStream + your indexer together
    package.json          ← depends on file:../OpKit
    tsconfig.json
```

## Scaffold a new indexer

The fastest way to start is `npx @opnet-devs/opkit init`:

```bash
npx @opnet-devs/opkit init my-indexer
# Creates my-indexer/ in the current directory with:
#   package.json, tsconfig.json, .gitignore, .env.example
#   src/main.ts, src/handlers/transfers.ts
#   Dockerfile, docker-compose.yml
cd my-indexer && npm install && npm run dev
```

No monorepo required — works anywhere Node ≥ 22 and npx are available.

If you are working inside the OpKit monorepo, the `just scaffold` command does the same thing:

```bash
cd OpKit
just scaffold my-indexer
# Creates ../my-indexer/ — identical output
```

## Dockerfile

OpKit ships a `Dockerfile` template. Copy it to your indexer project and update the `COPY`
paths and `CMD` to match your entry point:

```dockerfile
# Build context must be the Opnet-devs/ parent directory so both
# OpKit and MyIndexer are available to the builder.
# docker build -f MyIndexer/Dockerfile -t my-indexer ..

FROM node:22-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app

# Copy OpKit source (local file: dependency)
COPY OpKit/package*.json /OpKit/
COPY OpKit/src           /OpKit/src/

# Copy your indexer
COPY MyIndexer/package*.json ./
RUN npm install --omit=dev
COPY MyIndexer/src ./src

RUN addgroup -S opkit && adduser -S opkit -G opkit
USER opkit

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--experimental-vm-modules", "src/main.ts"]
```

## docker-compose.yml

OpKit's `docker-compose.yml` wires OpStream and your indexer together on a shared volume:

```yaml
services:
  opstream:
    image: ghcr.io/opnet-devs/opstream:latest
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db

  opkit-indexer:
    build:
      context: ..
      dockerfile: MyIndexer/Dockerfile
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db
      - OPKIT_DB_PATH=/data/opkit.db
      - FROM_BLOCK=941400
    ports:
      - "4000:4000"   # GraphQL API
    depends_on:
      - opstream

volumes:
  chain_data:
```

SQLite: both services mount the same named volume — `opstream.db` and `opkit.db` live side by side.

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

If you have [just](https://github.com/casey/just) installed, OpKit's `justfile` covers the full
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
const OPKIT_DB    = process.env['OPKIT_DB_PATH']    ?? '/data/opkit.db';
const FROM_BLOCK  = Number(process.env['FROM_BLOCK'] ?? '941400');
const PORT        = Number(process.env['PORT']        ?? '4000');
```

## Production checklist

- **Separate source and sink databases** — OpStream writes to `opstream.db` continuously;
  keeping `opkit.db` separate prevents write contention.
- **Run behind a reverse proxy** — nginx, Caddy, or Cloudflare in front of port 4000 gives you
  TLS, rate limiting, and origin-restricted CORS without changing OpKit's configuration.
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
cd OpKit
npm install
npm test              # run all 155 tests
npm run test:watch    # watch mode
npx tsc --noEmit      # type-check only
```

No database setup needed — tests use an in-memory SQLite adapter.
