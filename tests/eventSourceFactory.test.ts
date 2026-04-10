/**
 * createEventSource factory tests.
 *
 * Uses in-memory SQLite adapters to test the schema probe without real files.
 */

import { describe, it, expect, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../src/adapter.js';
import { DbEventSource } from '../src/source.js';
import { RpcEventSource, type BlockProvider } from '../src/rpcSource.js';
import { createEventSource, probeOpStreamSchema } from '../src/eventSourceFactory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPSTREAM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS blocks      (block_number INTEGER PRIMARY KEY, block_hash TEXT NOT NULL, timestamp INTEGER, tx_count INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS transactions(tx_hash TEXT NOT NULL PRIMARY KEY, block_number INTEGER NOT NULL, tx_index INTEGER NOT NULL, tx_type TEXT NOT NULL DEFAULT 'interaction', from_address TEXT, contract_address TEXT, gas_used TEXT, burned_bitcoin TEXT, failed INTEGER NOT NULL DEFAULT 0, revert_reason TEXT);
  CREATE TABLE IF NOT EXISTS events      (id INTEGER PRIMARY KEY AUTOINCREMENT, block_number INTEGER NOT NULL, tx_hash TEXT NOT NULL, contract_address TEXT NOT NULL, event_name TEXT NOT NULL, log_index INTEGER NOT NULL DEFAULT 0, event_raw BLOB NOT NULL, decoded_json TEXT, data_length INTEGER NOT NULL);
`;

function makeOpStreamAdapter(): SqliteAdapter {
  const db = new DatabaseSync(':memory:');
  db.exec(OPSTREAM_SCHEMA);
  return new SqliteAdapter(db);
}

function makeEmptyAdapter(): SqliteAdapter {
  const db = new DatabaseSync(':memory:');
  // No tables — not OpStream-ready
  return new SqliteAdapter(db);
}

const stubRpc: BlockProvider = {
  getBlock:       async () => null,
  getBlockNumber: async () => 0n,
};

// ---------------------------------------------------------------------------
// probeOpStreamSchema
// ---------------------------------------------------------------------------

describe('probeOpStreamSchema', () => {
  it('returns true for an OpStream-ready adapter', async () => {
    expect(await probeOpStreamSchema(makeOpStreamAdapter())).toBe(true);
  });

  it('returns false for an empty adapter (missing tables)', async () => {
    expect(await probeOpStreamSchema(makeEmptyAdapter())).toBe(false);
  });

  it('returns false when only some tables exist', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY)'); // missing transactions + blocks
    const adapter = new SqliteAdapter(db);
    expect(await probeOpStreamSchema(adapter)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createEventSource
// ---------------------------------------------------------------------------

describe('createEventSource', () => {
  it('returns DbEventSource when db adapter is OpStream-ready', async () => {
    const source = await createEventSource({ db: makeOpStreamAdapter() });
    expect(source).toBeInstanceOf(DbEventSource);
  });

  it('returns RpcEventSource when only rpc is provided', async () => {
    const source = await createEventSource({ rpc: stubRpc });
    expect(source).toBeInstanceOf(RpcEventSource);
  });

  it('falls back to RpcEventSource when db probe fails and rpc is provided', async () => {
    const source = await createEventSource({ db: makeEmptyAdapter(), rpc: stubRpc });
    expect(source).toBeInstanceOf(RpcEventSource);
  });

  it('warns to console when db probe fails before falling back', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await createEventSource({ db: makeEmptyAdapter(), rpc: stubRpc });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not OpStream-ready'));
    warn.mockRestore();
  });

  it('throws when db is not OpStream-ready and no rpc fallback is given', async () => {
    await expect(createEventSource({ db: makeEmptyAdapter() }))
      .rejects.toThrow('not OpStream-ready');
  });

  it('throws when neither db nor rpc is provided', async () => {
    await expect(createEventSource({}))
      .rejects.toThrow('no valid source');
  });

  it('accepts a pre-opened MinimalDbAdapter (not just a string path)', async () => {
    const adapter = makeOpStreamAdapter();
    const source  = await createEventSource({ db: adapter });
    expect(source).toBeInstanceOf(DbEventSource);
  });

  it('forwards rpcOptions to RpcEventSource', async () => {
    // RpcEventSource with rpsLimit=1 → minIntervalMs=1000
    // We just confirm it constructs without error and is the right type
    const source = await createEventSource(
      { rpc: stubRpc },
      { rpcOptions: { rpsLimit: 1, maxRetries: 1 } },
    );
    expect(source).toBeInstanceOf(RpcEventSource);
  });
});
