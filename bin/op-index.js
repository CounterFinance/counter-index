#!/usr/bin/env node
/**
 * op-index CLI — scaffold a new op-index indexer project.
 *
 * Usage:
 *   npx @opnet-devs/op-index init [project-name]
 *
 * Generates a ready-to-run starter project in ./<project-name>/ next to wherever
 * the command is run from. Refuses to write into a non-empty directory.
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { cwd, argv, exit } from 'node:process';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const [,, command, ...rest] = argv;

if (command !== 'init') {
  console.error(`Usage: op-index init [project-name]`);
  exit(1);
}

const projectName = rest[0] ?? basename(cwd());
const projectDir  = resolve(cwd(), projectName);

if (existsSync(projectDir)) {
  const entries = readdirSync(projectDir);
  if (entries.length > 0) {
    console.error(`[op-index] Error: directory "${projectDir}" is not empty.`);
    console.error('  Choose a different project name or empty the directory first.');
    exit(1);
  }
}

console.log(`[op-index] Scaffolding new indexer: ${projectName}`);
console.log(`[op-index] Writing to: ${projectDir}\n`);

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

const files = {
  'package.json': `{
  "name": "${projectName}",
  "version": "0.1.0",
  "type": "module",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "start": "node --import tsx/esm src/main.ts",
    "dev":   "node --import tsx/esm --watch src/main.ts",
    "build": "tsc"
  },
  "dependencies": {
    "@opnet-devs/op-index": "^0.1.0",
    "opnet": "^1.0.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0"
  }
}
`,

  'tsconfig.json': `{
  "compilerOptions": {
    "target":      "ES2022",
    "module":      "NodeNext",
    "moduleResolution": "NodeNext",
    "strict":      true,
    "outDir":      "dist",
    "rootDir":     "src"
  },
  "include": ["src"]
}
`,

  '.gitignore': `node_modules/
dist/
*.db
.env
`,

  '.dockerignore': `node_modules/
dist/
.git/
*.db
*.db-shm
*.db-wal
.env
.env.*
!.env.example
`,

  '.env.example': `OPSTREAM_DB_PATH=/data/opstream.db
OPINDEX_DB_PATH=/data/opindex.db
OPSTREAM_WS_URL=ws://localhost:8080
FROM_BLOCK=941400
PORT=4000
`,

  'Dockerfile': `# Two-stage build: compile TypeScript + native modules in stage 1, run compiled JS in stage 2.
# Build context: parent directory of ${projectName}
#   docker build -f ${projectName}/Dockerfile -t ${projectName} ..

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

# Native addon build tools (required for better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /build
COPY package*.json ./
RUN npm install
COPY src ./src
COPY tsconfig.json ./
RUN npm run build   # compiles src/ → dist/
RUN npm prune --omit=dev  # strip devDeps, keep compiled native modules

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine
RUN apk add --no-cache dumb-init
WORKDIR /app

# Copy pruned node_modules (includes compiled better-sqlite3 binary — no recompile needed)
COPY --from=builder /build/package*.json ./
COPY --from=builder /build/node_modules  ./node_modules
COPY --from=builder /build/dist ./dist

RUN mkdir -p /app/data && \\
    addgroup -g 1001 -S indexer && \\
    adduser  -u 1001 -S indexer -G indexer && \\
    chown -R indexer:indexer /app
USER indexer

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
`,

  'docker-compose.yml': `services:
  opstream:
    image: ghcr.io/opnet-devs/opstream:latest
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db

  indexer:
    build: .
    volumes:
      - chain_data:/data
    environment:
      - OPSTREAM_DB_PATH=/data/opstream.db
      - OPINDEX_DB_PATH=/data/opindex.db
      - FROM_BLOCK=941400
      - PORT=4000
    ports:
      - "4000:4000"
    depends_on:
      - opstream

volumes:
  chain_data:
`,

  'src/main.ts': `import {
  defineSchema, createIndexer,
  DbEventSource, openSqlite,
} from '@opnet-devs/op-index';
import { registerTransferHandlers } from './handlers/transfers.js';

const OPSTREAM_DB = process.env['OPSTREAM_DB_PATH'] ?? '/data/opstream.db';
const OPINDEX_DB  = process.env['OPINDEX_DB_PATH']  ?? '/data/opindex.db';
const FROM_BLOCK  = Number(process.env['FROM_BLOCK'] ?? '941400');
const PORT        = Number(process.env['PORT']        ?? '4000');

const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
  Transfer: {
    txHash: { type: 'string' },
    from:   { type: 'string' },
    to:     { type: 'string' },
    value:  { type: 'bigint' },
    block:  { type: 'int' },
  },
});

const source  = new DbEventSource(openSqlite(OPSTREAM_DB));
const sink    = openSqlite(OPINDEX_DB);
const indexer = await createIndexer({ schema, sink, source });

registerTransferHandlers(indexer);

const latestBlock = FROM_BLOCK + 58_600; // adjust to your backfill range
await indexer.sync(FROM_BLOCK, latestBlock);
indexer.subscribe(latestBlock + 1);

const handle = await indexer.serve({ port: PORT, subscriptions: false });
console.log(\`GraphQL ready at \${handle.url}\`);

process.on('SIGTERM', async () => {
  await handle.stop();
  process.exit(0);
});
`,

  'src/handlers/transfers.ts': `import type { Indexer } from '@opnet-devs/op-index';

export function registerTransferHandlers(indexer: Indexer): void {
  indexer.on('Transferred', async (event, ctx) => {
    const from  = event.decoded!['from']  as string;
    const to    = event.decoded!['to']    as string;
    const value = BigInt(event.decoded!['value'] as string);

    await ctx.store.set('Transfer', event.txHash, {
      txHash: event.txHash, from, to, value, block: event.blockNumber,
    });

    for (const [addr, delta] of [[from, -value], [to, value]] as [string, bigint][]) {
      const acct = await ctx.store.get('Account', addr);
      if (!acct) {
        await ctx.store.set('Account', addr, {
          address: addr, balance: delta, txCount: 1, lastSeen: event.blockNumber,
        });
      } else {
        await ctx.store.update('Account', addr, {
          balance:  (acct['balance']  as bigint) + delta,
          txCount:  (acct['txCount']  as number) + 1,
          lastSeen: event.blockNumber,
        });
      }
    }
  });
}
`,
};

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

for (const [relativePath, content] of Object.entries(files)) {
  const fullPath = join(projectDir, relativePath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
  console.log(`  created  ${relativePath}`);
}

console.log(`
Done! Next steps:

  cd ${projectName}
  npm install
  # Edit src/main.ts and src/handlers/transfers.ts
  npm run dev
`);
