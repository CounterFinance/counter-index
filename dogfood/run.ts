/**
 * counter-index dogfood harness.
 *
 * Runs the framework end-to-end against a deterministic, seeded OPNET source and
 * snapshots the derived state (entities + GraphQL) to a golden file. This is the
 * golden-equivalence anchor for the M1-M3 refactors: the output must stay
 * byte-identical across those milestones (clean-break renames excepted).
 *
 *   npm run dogfood           # verify against the committed golden (exit 1 on diff)
 *   npm run dogfood -- --update   # rewrite the golden
 *
 * M4+ will extend this with a real EVM indexer driven against an anvil devnet.
 */

import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SqliteAdapter, openSqlite } from '../src/adapter.js';
import { DbEventSource } from '../src/chains/opnet/dbSource.js';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import type { EntityStore } from '../src/store.js';

const HERE   = dirname(fileURLToPath(import.meta.url));
const GOLDEN = join(HERE, 'golden', 'opnet-m1.json');

// ── Deterministic fixtures ───────────────────────────────────────────────────

const A = 0xaa, B = 0xbb, C = 0xcc;          // address markers
const addr = (m: number): string => '0x' + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? m : 0))).toString('hex');

/** Transferred layout: from(32) + to(32) + value(32, big-endian). */
function transferRaw(fromM: number, toM: number, value: number): Uint8Array {
  const raw = new Uint8Array(96);
  raw[31] = fromM;
  raw[63] = toM;
  raw[95] = value & 0xff;                     // all fixture values < 256
  return raw;
}

const OPSTREAM_SCHEMA = `
  CREATE TABLE blocks (
    block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL,
    timestamp INTEGER, tx_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE transactions (
    tx_hash TEXT NOT NULL PRIMARY KEY, block_number INTEGER NOT NULL, tx_index INTEGER NOT NULL,
    tx_type TEXT NOT NULL DEFAULT 'interaction', from_address TEXT, contract_address TEXT,
    gas_used TEXT, burned_bitcoin TEXT, failed INTEGER NOT NULL DEFAULT 0, revert_reason TEXT
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, block_number INTEGER NOT NULL, tx_hash TEXT NOT NULL,
    contract_address TEXT NOT NULL, event_name TEXT NOT NULL, log_index INTEGER NOT NULL DEFAULT 0,
    event_raw BLOB NOT NULL, data_length INTEGER NOT NULL
  );
`;

function seedSource(): SqliteAdapter {
  const db = new Database(':memory:');
  db.exec(OPSTREAM_SCHEMA);

  const blk = db.prepare(`INSERT INTO blocks (block_number, block_hash, timestamp) VALUES (?, ?, ?)`);
  blk.run(100, '0xblock100', 1_712_340_000);
  blk.run(101, '0xblock101', 1_712_340_010);

  const tx = db.prepare(`INSERT INTO transactions (tx_hash, block_number, tx_index, from_address, contract_address, gas_used, burned_bitcoin, failed) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`);
  tx.run('0xtx1', 100, 0, '0xalice',   '0xtoken1', '21000', '500');
  tx.run('0xtx2', 101, 0, '0xbob',     '0xtoken1', '22000', '600');
  tx.run('0xtx3', 101, 1, '0xalice',   '0xtoken2', '18000', '400');

  const ev = db.prepare(`INSERT INTO events (block_number, tx_hash, contract_address, event_name, log_index, event_raw, data_length) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const t1 = transferRaw(A, B, 100);  // token1: A -> B 100
  const t2 = transferRaw(B, C, 40);   // token1: B -> C 40
  const t3 = transferRaw(A, C, 7);    // token2: A -> C 7
  ev.run(100, '0xtx1', '0xtoken1', 'Transferred', 0, t1, t1.length);
  ev.run(101, '0xtx2', '0xtoken1', 'Transferred', 0, t2, t2.length);
  ev.run(101, '0xtx3', '0xtoken2', 'Transferred', 0, t3, t3.length);

  return new SqliteAdapter(db);
}

// ── Representative indexer: token transfers + running holder balances ────────

const schema = defineSchema({
  TokenTransfer: {
    token: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' },
    value: { type: 'bigint' }, block: { type: 'int' },
  },
  TokenHolder: {
    token: { type: 'string' }, holder: { type: 'string' }, balance: { type: 'bigint' },
  },
});

async function bumpBalance(store: EntityStore, token: string, holder: string, delta: bigint): Promise<void> {
  const existing = await store.get('TokenHolder', `${token}:${holder}`);
  const current = existing ? BigInt(existing['balance'] as string | bigint) : 0n;
  await store.set('TokenHolder', `${token}:${holder}`, { token, holder, balance: current + delta });
}

// ── Snapshot helpers ─────────────────────────────────────────────────────────

function normalise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return '0x' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalise(v)]));
  }
  return value;
}

const stableSort = (rows: unknown[]): unknown[] =>
  rows.map(normalise).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

async function snapshot(): Promise<unknown> {
  const sink   = openSqlite(':memory:');
  const source = new DbEventSource(seedSource());
  const indexer = await createIndexer({ schema, sink, source });

  indexer.on('Transferred', async (event, ctx) => {
    const d = event.decoded;
    if (!d) return;
    const token = event.contractAddress;
    const from = d['from'] as string, to = d['to'] as string, value = BigInt(d['value'] as string);
    await ctx.store.set('TokenTransfer', `${event.txHash}-${event.logIndex}`, { token, from, to, value, block: event.blockNumber });
    await bumpBalance(ctx.store, token, to, value);
    await bumpBalance(ctx.store, token, from, -value);
  });

  await indexer.sync(100, 101);

  // Entities straight from the store.
  const entities = {
    TokenHolder:   stableSort(await indexer.store.list('TokenHolder')),
    TokenTransfer: stableSort(await indexer.store.list('TokenTransfer')),
    counts: { TokenHolder: await indexer.store.count('TokenHolder'), TokenTransfer: await indexer.store.count('TokenTransfer') },
  };

  // Same data over the auto-generated GraphQL API (exercises that layer too).
  const handle = await indexer.serve({ port: 47821 });
  const q = async (query: string): Promise<unknown> => {
    const res = await fetch(handle.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
    });
    return (await res.json() as { data: unknown }).data;
  };
  const graphql = {
    tokenHolders:   normalise(sortNodes(await q('{ tokenHolders { totalCount nodes { id token holder balance } } }'))),
    tokenTransfers: normalise(sortNodes(await q('{ tokenTransfers { totalCount nodes { id token from to value block } } }'))),
  };
  await handle.stop();

  return { entities, graphql };
}

function sortNodes(data: unknown): unknown {
  const root = data as Record<string, { totalCount: number; nodes: unknown[] }>;
  for (const key of Object.keys(root)) {
    root[key].nodes = root[key].nodes.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return root;
}

// ── Runner ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const actual = JSON.stringify(normalise(await snapshot()), null, 2) + '\n';

  if (update || !existsSync(GOLDEN)) {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, actual);
    console.log(`[dogfood] golden ${update ? 'updated' : 'created'}: ${GOLDEN}`);
    return;
  }

  const expected = readFileSync(GOLDEN, 'utf8');
  if (expected === actual) {
    console.log('[dogfood] PASS — output matches golden (entities + GraphQL).');
    return;
  }

  console.error('[dogfood] FAIL — output diverged from golden.');
  const ea = expected.split('\n'), aa = actual.split('\n');
  for (let i = 0; i < Math.max(ea.length, aa.length); i++) {
    if (ea[i] !== aa[i]) {
      console.error(`  line ${i + 1}:\n    golden: ${ea[i] ?? '<eof>'}\n    actual: ${aa[i] ?? '<eof>'}`);
    }
  }
  process.exit(1);
}

main().catch((err: unknown) => { console.error(err); process.exit(1); });
