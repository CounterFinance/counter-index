# OpKit — Dockerfile template for indexer apps built on OpKit.
#
# OpKit is a library — it has no entry point of its own. Copy this file to
# YOUR indexer project and follow the four steps marked STEP below.
#
# Build context must be the Opnet-devs/ parent directory so the builder can
# reach both OpKit/ and your indexer:
#
#   docker build -f MyIndexer/Dockerfile -t my-indexer .
#
# Or use docker-compose.yml (which sets context: .. automatically).
#
# ─── Two-stage build ─────────────────────────────────────────────────────────
# Stage 1 compiles TypeScript → JavaScript and compiles native modules (better-sqlite3).
# Stage 2 copies the compiled output — no build tools or TypeScript compiler in production.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# Native addon build tools (required for better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /build

# STEP 1 — copy OpKit source (required — your package.json depends on it)
COPY OpKit/package*.json /OpKit/
COPY OpKit/src           /OpKit/src/
COPY OpKit/tsconfig.json /OpKit/

# STEP 2 — replace "MyIndexer" with your project directory name
COPY MyIndexer/package*.json ./
RUN npm install
COPY MyIndexer/src        ./src/
COPY MyIndexer/tsconfig.json ./

RUN npm run build   # compiles src/ → dist/
RUN npm prune --omit=dev  # strip devDeps, keep compiled native modules

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine

RUN apk add --no-cache dumb-init

WORKDIR /app

# Copy pruned node_modules (includes compiled better-sqlite3 binary — no recompile needed)
COPY --from=builder /build/package*.json ./
COPY --from=builder /build/node_modules  ./node_modules

# Compiled output
COPY --from=builder /build/dist ./dist

# OpKit compiled output (needed at runtime — file: dep resolves to /OpKit)
COPY --from=builder /OpKit/src  /OpKit/src/
COPY --from=builder /OpKit/package.json /OpKit/

RUN mkdir -p /app/data && \
    addgroup -g 1001 -S indexer && \
    adduser  -u 1001 -S indexer -G indexer && \
    chown -R indexer:indexer /app /OpKit
USER indexer

ENTRYPOINT ["dumb-init", "--"]

# STEP 3 — update this to your compiled entry point:
CMD ["node", "dist/main.js"]
