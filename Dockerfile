# OpKit — Dockerfile template for indexer apps built with OpKit
#
# OpKit is a library — it has no entry point of its own. This file is a
# starting point for YOUR indexer service.
#
# How to adapt:
#   1. Copy this file to your indexer project root.
#   2. Update the COPY lines to match your project structure.
#   3. Set the CMD to your indexer's entry point (e.g., src/main.ts).
#
# Build context: the Opnet-devs/ parent directory (required for file:../OpKit):
#   docker build -f YourIndexer/Dockerfile -t my-indexer ..
#
# Or let docker-compose.yml handle the context — see docker-compose.yml.

FROM node:22-alpine

# dumb-init: proper PID 1 signal handling (SIGTERM → clean shutdown)
RUN apk add --no-cache dumb-init

WORKDIR /app

# ── OpKit (library dep — resolved via file:../OpKit in package.json) ──────────
COPY OpKit/ /OpKit/

# ── Indexer app ───────────────────────────────────────────────────────────────
# Replace "MyIndexer" with your project directory name:
COPY MyIndexer/package*.json ./
RUN npm install --prefer-offline

COPY MyIndexer/src/        ./src/
COPY MyIndexer/tsconfig.json ./

# Persistent data directories (override with volume mounts at runtime)
RUN mkdir -p /app/data

# Drop root — run as unprivileged user
RUN addgroup -g 1001 -S indexer && \
    adduser  -u 1001 -S indexer -G indexer && \
    chown -R indexer:indexer /app /OpKit
USER indexer

ENTRYPOINT ["dumb-init", "--"]

# Replace with your indexer's entry point:
CMD ["npx", "tsx", "src/main.ts"]
