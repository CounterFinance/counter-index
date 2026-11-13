# counter-index — Dockerfile template for indexer apps built on counter-index.
#
# counter-index is a library published to npm. Copy this file to your indexer
# project and adjust the CMD if your entry point differs from dist/main.js.
#
#   docker build -t my-indexer .
#   docker-compose up
#
# ─── Two-stage build ─────────────────────────────────────────────────────────
# Stage 1 compiles TypeScript and builds native modules (better-sqlite3).
# Stage 2 copies only the compiled output — no build tools in production.

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

# Native addon build tools (required for better-sqlite3)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY src         ./src/
COPY tsconfig.json ./

RUN npm run build           # compiles src/ → dist/
RUN npm prune --omit=dev    # strip devDeps, keep compiled native modules

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends dumb-init && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pruned node_modules (includes compiled better-sqlite3 binary)
COPY --from=builder /build/package*.json  ./
COPY --from=builder /build/node_modules   ./node_modules
COPY --from=builder /build/dist           ./dist

RUN mkdir -p /app/data && \
    groupadd -r indexer && \
    useradd  -r -g indexer indexer && \
    chown -R indexer:indexer /app
USER indexer

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
