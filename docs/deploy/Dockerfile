# Reference production image for an counter-index indexer (M19).
# Multi-stage, non-root, dumb-init for correct signal handling (so SIGTERM
# reaches the process and triggers indexer.installSignalHandlers() -> graceful
# shutdown). Copy this into your indexer app and adjust the entrypoint.

# ---- builder ----------------------------------------------------------------
FROM node:24-alpine AS builder
WORKDIR /app
# Install deps against the lockfile for reproducible builds.
COPY package.json package-lock.json* ./
RUN npm ci
# Build the TypeScript indexer to ./dist.
COPY . .
RUN npm run build

# Drop devDependencies for the runtime layer.
RUN npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:24-alpine AS runtime
# dumb-init = PID 1 that forwards signals; without it SIGTERM is swallowed and
# Kubernetes/Railway kill the pod ungracefully mid-block.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
WORKDIR /app

# Run as a non-root user.
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./package.json
USER app

# The indexer serves /health; let the orchestrator read it (503 => drain).
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 \
  CMD wget -qO- http://127.0.0.1:4000/health | grep -qv '"state":"stalled"' || exit 1

# dumb-init -> node so SIGTERM is delivered and shutdown() runs.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
