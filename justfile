# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  op-index — justfile                                                         ║
# ║  Indexer framework for OPNET                                                 ║
# ╚══════════════════════════════════════════════════════════════════════════════╝

# ── Colours ───────────────────────────────────────────────────────────────────
export RED    := '\033[0;31m'
export GREEN  := '\033[0;32m'
export YELLOW := '\033[0;33m'
export BLUE   := '\033[0;34m'
export CYAN   := '\033[0;36m'
export BOLD   := '\033[1m'
export RESET  := '\033[0m'

# ── Default ───────────────────────────────────────────────────────────────────
default:
    @just --list

# ══════════════════════════════════════════════════════════════════════════════
# §0  Scaffold — create a new op-index-based indexer app
# ══════════════════════════════════════════════════════════════════════════════

# Scaffold a new indexer app: just scaffold my-indexer
# Creates <name>/ next to op-index/ with everything wired and ready to run.
scaffold name="my-indexer":
    #!/usr/bin/env bash
    set -euo pipefail

    DEST="../{{name}}"
    OPINDEX_REL="../op-index"   # relative from the new project to op-index

    if [ -d "$DEST" ]; then
        echo "${RED}✘  $DEST already exists — choose a different name${RESET}"
        exit 1
    fi

    echo "${BLUE}▶ Scaffolding indexer app '{{name}}' at $DEST ...${RESET}"
    mkdir -p "$DEST/src/handlers" "$DEST/data"

    # ── package.json ──────────────────────────────────────────────────────────
    cat > "$DEST/package.json" << 'PKGJSON'
{
  "name": "NAME_PLACEHOLDER",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=22.0.0" },
  "scripts": {
    "start": "npx tsx src/main.ts",
    "typecheck": "npx tsc --noEmit"
  },
  "dependencies": {
    "@opnet-collective/op-index": "file:../op-index"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0"
  }
}
PKGJSON
    # Patch in the real name
    sed -i "s/NAME_PLACEHOLDER/{{name}}/" "$DEST/package.json"

    # ── tsconfig.json ─────────────────────────────────────────────────────────
    cat > "$DEST/tsconfig.json" << 'TSCONFIG'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
TSCONFIG

    # ── .gitignore ────────────────────────────────────────────────────────────
    cat > "$DEST/.gitignore" << 'GITIGNORE'
node_modules/
dist/
data/
.env
GITIGNORE

    # ── .env.example ─────────────────────────────────────────────────────────
    cat > "$DEST/.env.example" << 'ENVEX'
# OpStream source database (SQLite — different file from sink)
OPSTREAM_DB_PATH=../OpStream/data/opstream.db

# This indexer's own database (sink — opindex_* tables)
OPINDEX_DB_PATH=data/opindex.db

# Postgres alternative (set both to override SQLite paths above):
# OPSTREAM_DB_URL=postgres://user:pass@localhost:5432/opstream
# OPINDEX_DB_URL=postgres://user:pass@localhost:5432/opstream

# Backfill starting block
FROM_BLOCK=941400

LOG_LEVEL=INFO
ENVEX

    # ── src/handlers/transfers.ts ─────────────────────────────────────────────
    cat > "$DEST/src/handlers/transfers.ts" << 'HANDLER'
/**
 * Example handler — index OP-20 Transfer events into an Account entity.
 *
 * This file shows the pattern. Replace or extend with your own logic.
 */

import type { DecodedEvent, HandlerContext } from '@opnet-collective/op-index';

export async function onTransferred(event: DecodedEvent, ctx: HandlerContext): Promise<void> {
  if (!event.decoded) return;

  const from  = event.decoded['from']  as string;
  const to    = event.decoded['to']    as string;
  const value = BigInt(event.decoded['value'] as string);

  // Debit sender
  const sender = await ctx.store.get('Account', from);
  if (sender) {
    await ctx.store.update('Account', from, {
      balance: (sender['balance'] as bigint) - value,
      txCount: (sender['txCount'] as number) + 1,
      lastSeen: event.blockNumber,
    });
  } else {
    await ctx.store.set('Account', from, {
      address: from,
      balance: 0n - value,
      txCount: 1,
      lastSeen: event.blockNumber,
    });
  }

  // Credit receiver
  const receiver = await ctx.store.get('Account', to);
  if (receiver) {
    await ctx.store.update('Account', to, {
      balance: (receiver['balance'] as bigint) + value,
      lastSeen: event.blockNumber,
    });
  } else {
    await ctx.store.set('Account', to, {
      address: to,
      balance: value,
      txCount: 0,
      lastSeen: event.blockNumber,
    });
  }
}
HANDLER

    # ── src/main.ts ───────────────────────────────────────────────────────────
    cat > "$DEST/src/main.ts" << 'MAIN'
/**
 * Indexer entry point.
 *
 * 1. Define your schema (entities → opindex_* SQL tables).
 * 2. Open source (OpStream DB) and sink (this indexer's DB).
 * 3. Register event handlers.
 * 4. Backfill historical blocks, then go live.
 */

import {
  defineSchema,
  createIndexer,
  DbEventSource,
  openSqlite,
} from '@opnet-collective/op-index';

import { onTransferred } from './handlers/transfers.js';

// ── Schema ────────────────────────────────────────────────────────────────────
const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
});

// ── Config ────────────────────────────────────────────────────────────────────
const OPSTREAM_DB = process.env['OPSTREAM_DB_PATH'] ?? '../OpStream/data/opstream.db';
const OPINDEX_DB  = process.env['OPINDEX_DB_PATH']  ?? 'data/opindex.db';
const FROM_BLOCK  = Number(process.env['FROM_BLOCK'] ?? 941400);

// ── Connections ───────────────────────────────────────────────────────────────
// source — read-only, points at OpStream's database
// sink   — this indexer's own database (opindex_* tables)
const source = new DbEventSource(openSqlite(OPSTREAM_DB));
const sink   = openSqlite(OPINDEX_DB);

// ── Indexer ───────────────────────────────────────────────────────────────────
const indexer = await createIndexer({ schema, sink, source });

indexer.on('Transferred', onTransferred);

// Add more handlers here:
// indexer.on('Swapped',  onSwapped);
// indexer.on('Synced',   onSynced);
// indexer.on('*',        onAnyEvent);   // wildcard

// ── Run ───────────────────────────────────────────────────────────────────────
// Backfill: sync all events OpStream has already indexed.
// sync() stops when there are no more events — safe to set a high ceiling.
const TO_BLOCK = Number(process.env['TO_BLOCK'] ?? 999_999_999);
const stats = await indexer.sync(FROM_BLOCK, TO_BLOCK);
console.log('Backfill complete:', stats);

// Live: poll OpStream DB every 10s for new blocks (picks up from where sync left off)
const stop = indexer.subscribe(stats.lastBlock + 1);
console.log('Live indexing started. Ctrl+C to stop.');

process.on('SIGINT',  () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
MAIN

    # ── Dockerfile ────────────────────────────────────────────────────────────
    cat > "$DEST/Dockerfile" << 'DFILE'
# Generated by: just scaffold (op-index)
# Build context: Opnet-devs/ parent directory
#   docker build -f NAME_PLACEHOLDER/Dockerfile -t NAME_PLACEHOLDER ..

FROM node:22-alpine
RUN apk add --no-cache dumb-init

WORKDIR /app

COPY op-index/ /op-index/
COPY NAME_PLACEHOLDER/package*.json ./
RUN npm install --prefer-offline

COPY NAME_PLACEHOLDER/src/        ./src/
COPY NAME_PLACEHOLDER/tsconfig.json ./

RUN mkdir -p /app/data && \
    addgroup -g 1001 -S indexer && \
    adduser  -u 1001 -S indexer -G indexer && \
    chown -R indexer:indexer /app /op-index
USER indexer

ENTRYPOINT ["dumb-init", "--"]
CMD ["npx", "tsx", "src/main.ts"]
DFILE
    sed -i "s/NAME_PLACEHOLDER/{{name}}/g" "$DEST/Dockerfile"

    # ── docker-compose.yml ────────────────────────────────────────────────────
    cat > "$DEST/docker-compose.yml" << 'COMPOSE'
# NAME_PLACEHOLDER + OpStream — full stack
# Run from the Opnet-devs/ parent: docker compose -f NAME_PLACEHOLDER/docker-compose.yml up -d

services:
  opstream:
    build:
      context: ..
      dockerfile: OpStream/Dockerfile
    image: opstream:latest
    container_name: opstream
    restart: unless-stopped
    env_file: ../OpStream/.env
    volumes:
      - chain_data:/app/data
    healthcheck:
      test: ["CMD", "sh", "-c", "test -f /app/data/opstream.db || sleep 5"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 120s

  indexer:
    build:
      context: ..
      dockerfile: NAME_PLACEHOLDER/Dockerfile
    image: NAME_PLACEHOLDER:latest
    container_name: NAME_PLACEHOLDER
    restart: unless-stopped
    env_file: .env
    environment:
      OPSTREAM_DB_PATH: /app/data/opstream.db
      OPINDEX_DB_PATH:  /app/data/opindex.db
    volumes:
      - chain_data:/app/data
    depends_on:
      opstream:
        condition: service_healthy

volumes:
  chain_data:
COMPOSE
    sed -i "s/NAME_PLACEHOLDER/{{name}}/g" "$DEST/docker-compose.yml"

    # ── Install deps ──────────────────────────────────────────────────────────
    echo "${BLUE}▶ Installing dependencies...${RESET}"
    (cd "$DEST" && npm install --silent)

    echo ""
    echo "${GREEN}${BOLD}✔ Scaffolded: $DEST${RESET}"
    echo ""
    echo "  ${CYAN}Files created:${RESET}"
    echo "    package.json · tsconfig.json · .gitignore · .env.example"
    echo "    src/main.ts · src/handlers/transfers.ts"
    echo "    Dockerfile · docker-compose.yml"
    echo ""
    echo "  ${CYAN}Next steps:${RESET}"
    echo "    1. cd $DEST"
    echo "    2. cp .env.example .env  (set OPSTREAM_DB_PATH)"
    echo "    3. npx tsx src/main.ts"
    echo ""
    echo "  ${CYAN}Or run the full stack with Docker:${RESET}"
    echo "    cd ..  &&  docker compose -f {{name}}/docker-compose.yml up -d"
    echo ""

# ══════════════════════════════════════════════════════════════════════════════
# §1  Setup
# ══════════════════════════════════════════════════════════════════════════════

# Install dependencies
install:
    @echo "${BLUE}▶ Installing dependencies...${RESET}"
    npm install
    @echo "${GREEN}✔ Done${RESET}"

# ══════════════════════════════════════════════════════════════════════════════
# §2  Develop / Validate
# ══════════════════════════════════════════════════════════════════════════════

# Run all tests
test:
    @echo "${BLUE}▶ Running tests...${RESET}"
    npx vitest run
    @echo "${GREEN}✔ All tests passed${RESET}"

# Watch mode tests
test-watch:
    npx vitest

# TypeScript type check (no emit)
typecheck:
    @echo "${BLUE}▶ Type checking...${RESET}"
    npx tsc --noEmit
    @echo "${GREEN}✔ No type errors${RESET}"

# ESLint — errors block, warnings are informational
lint:
    @echo "${BLUE}▶ Linting...${RESET}"
    npx eslint src
    @echo "${GREEN}✔ No lint errors${RESET}"

# ESLint with auto-fix
lint-fix:
    @echo "${BLUE}▶ Linting (fix)...${RESET}"
    npx eslint src --fix
    @echo "${GREEN}✔ Done${RESET}"

# Run tests + typecheck + lint
check: test typecheck lint

# ══════════════════════════════════════════════════════════════════════════════
# §3  Docker (full-stack — OpStream + op-index-based indexer)
# ══════════════════════════════════════════════════════════════════════════════
#
# Run these from the Opnet-devs/ PARENT directory:
#   cd .. && just -f op-index/justfile docker-up
#
# Or from op-index/ using absolute context:
#   just docker-up

# Build the Docker images (context: Opnet-devs/ parent for local op-index dep)
docker-build:
    @echo "${BLUE}▶ Building Docker images...${RESET}"
    docker compose build
    @echo "${GREEN}✔ Images built${RESET}"

# Start the full stack in background (OpStream + op-index-indexer)
docker-up:
    @echo "${BLUE}▶ Starting full stack (OpStream + op-index-indexer)...${RESET}"
    docker compose up -d
    @echo "${GREEN}✔ Running — 'just docker-logs' to follow output${RESET}"

# Start in foreground (logs visible, Ctrl+C to stop)
docker-fg:
    docker compose up

# Stop all containers (data preserved)
docker-down:
    @echo "${YELLOW}▶ Stopping containers...${RESET}"
    docker compose down

# Rebuild and redeploy after code changes
docker-redeploy: docker-build
    @echo "${YELLOW}▶ Redeploying...${RESET}"
    docker compose down
    docker compose up -d
    @echo "${GREEN}✔ Redeployed${RESET}"

# Stream logs from both services
docker-logs:
    docker compose logs -f

# Stream opstream logs only
docker-logs-stream:
    docker compose logs -f opstream

# Stream op-index-indexer logs only
docker-logs-indexer:
    docker compose logs -f op-index-indexer

# Show container status
docker-status:
    docker compose ps

# Open a shell inside the op-index-indexer container
docker-shell:
    docker compose exec op-index-indexer sh

# Remove images + volumes (does NOT delete host ./data)
docker-clean:
    #!/usr/bin/env bash
    echo "${RED}${BOLD}⚠  This removes Docker images and named volumes.${RESET}"
    read -r -p "Type 'yes' to confirm: " CONFIRM
    if [ "$CONFIRM" = "yes" ]; then
        docker compose down --rmi local --volumes
        echo "${GREEN}✔ Cleaned${RESET}"
    else
        echo "${YELLOW}Aborted${RESET}"
    fi

# ══════════════════════════════════════════════════════════════════════════════
# §4  Utilities
# ══════════════════════════════════════════════════════════════════════════════

# Check all prerequisites (node version, tsx, docker)
doctor:
    #!/usr/bin/env bash
    echo "${CYAN}${BOLD}op-index Doctor${RESET}"
    echo ""

    # Node.js
    if command -v node >/dev/null 2>&1; then
        NODE_VER=$(node --version)
        MAJOR=$(echo "$NODE_VER" | cut -d. -f1 | tr -d 'v')
        if [ "$MAJOR" -ge 22 ]; then
            echo "  ${GREEN}✔${RESET}  node $NODE_VER"
        else
            echo "  ${RED}✘${RESET}  node $NODE_VER — need v22+ (node:sqlite built-in)"
        fi
    else
        echo "  ${RED}✘${RESET}  node — not found"
    fi

    # tsx
    if npx tsx --version >/dev/null 2>&1; then
        TSX_VER=$(npx tsx --version 2>/dev/null | head -1)
        echo "  ${GREEN}✔${RESET}  tsx $TSX_VER"
    else
        echo "  ${YELLOW}⚠${RESET}  tsx — run 'just install'"
    fi

    # vitest
    if npx vitest --version >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  vitest $(npx vitest --version 2>/dev/null)"
    else
        echo "  ${YELLOW}⚠${RESET}  vitest — run 'just install'"
    fi

    # Docker
    if command -v docker >/dev/null 2>&1; then
        echo "  ${GREEN}✔${RESET}  docker $(docker --version | cut -d' ' -f3 | tr -d ',')"
    else
        echo "  ${YELLOW}⚠${RESET}  docker — not found (optional, for containerised deployment)"
    fi

    # node_modules
    if [ -d node_modules ]; then
        echo "  ${GREEN}✔${RESET}  node_modules present"
    else
        echo "  ${YELLOW}⚠${RESET}  node_modules missing — run 'just install'"
    fi

    echo ""
