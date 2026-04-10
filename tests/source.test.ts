/**
 * DbEventSource tests — uses an in-memory SQLite seeded with fake OpStream schema.
 *
 * The "source" adapter mimics an OpStream-ready DB: events, transactions, blocks tables.
 * This tests the JOIN query, field mapping, and filter logic without a real OpStream instance.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SqliteAdapter } from '../src/adapter.js';
import { DbEventSource } from '../src/source.js';

// Minimal OpStream schema — just the tables DbEventSource JOINs against
const OPSTREAM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS blocks (
    block_number INTEGER PRIMARY KEY,
    block_hash   TEXT NOT NULL,
    timestamp    INTEGER,
    tx_count     INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS transactions (
    tx_hash      TEXT NOT NULL PRIMARY KEY,
    block_number INTEGER NOT NULL,
    tx_index     INTEGER NOT NULL,
    tx_type      TEXT NOT NULL DEFAULT 'interaction',
    from_address TEXT,
    contract_address TEXT,
    gas_used     TEXT,
    burned_bitcoin TEXT,
    failed       INTEGER NOT NULL DEFAULT 0,
    revert_reason TEXT
  );
  CREATE TABLE IF NOT EXISTS events (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    block_number     INTEGER NOT NULL,
    tx_hash          TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    event_name       TEXT NOT NULL,
    log_index        INTEGER NOT NULL DEFAULT 0,
    event_raw        BLOB NOT NULL,
    decoded_json     TEXT,
    data_length      INTEGER NOT NULL
  );
`;

function makeSourceAdapter() {
  const db = new DatabaseSync(':memory:');
  db.exec(OPSTREAM_SCHEMA);

  // Seed blocks
  db.prepare(`INSERT INTO blocks (block_number, block_hash, timestamp) VALUES (?, ?, ?)`)
    .run(100, '0xblock100', 1712340000);
  db.prepare(`INSERT INTO blocks (block_number, block_hash, timestamp) VALUES (?, ?, ?)`)
    .run(101, '0xblock101', 1712340010);

  // Seed transactions
  db.prepare(`INSERT INTO transactions (tx_hash, block_number, tx_index, from_address, contract_address, gas_used, burned_bitcoin, failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('0xtx1', 100, 0, '0xalice', '0xtoken1', '21000', '500', 0);
  db.prepare(`INSERT INTO transactions (tx_hash, block_number, tx_index, from_address, contract_address, gas_used, burned_bitcoin, failed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('0xtx2', 101, 0, '0xbob', '0xtoken1', '22000', '600', 0);
  db.prepare(`INSERT INTO transactions (tx_hash, block_number, tx_index, from_address, contract_address, gas_used, burned_bitcoin, failed, revert_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('0xtx3', 101, 1, '0xcharlie', '0xtoken2', '18000', '400', 1, 'insufficient balance');

  // Seed events (raw = empty blob for simplicity)
  const emptyBlob = new Uint8Array(0);
  db.prepare(`INSERT INTO events (block_number, tx_hash, contract_address, event_name, log_index, event_raw, decoded_json, data_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(100, '0xtx1', '0xtoken1', 'Transferred', 0, emptyBlob, JSON.stringify({ from: '0xalice', to: '0xbob', value: '1000' }), 0);
  db.prepare(`INSERT INTO events (block_number, tx_hash, contract_address, event_name, log_index, event_raw, decoded_json, data_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(101, '0xtx2', '0xtoken1', 'Transferred', 0, emptyBlob, JSON.stringify({ from: '0xbob', to: '0xcharlie', value: '500' }), 0);
  db.prepare(`INSERT INTO events (block_number, tx_hash, contract_address, event_name, log_index, event_raw, decoded_json, data_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(101, '0xtx2', '0xtoken1', 'Approval', 1, emptyBlob, JSON.stringify({ owner: '0xbob', spender: '0xdex', value: '9999' }), 0);
  db.prepare(`INSERT INTO events (block_number, tx_hash, contract_address, event_name, log_index, event_raw, decoded_json, data_length) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(101, '0xtx3', '0xtoken2', 'Transferred', 0, emptyBlob, null, 0);

  return new SqliteAdapter(db);
}

let source: DbEventSource;

beforeEach(() => {
  source = new DbEventSource(makeSourceAdapter());
});

describe('DbEventSource.query', () => {
  it('returns all events in range ordered by block, log_index', async () => {
    const events = await source.query(100, 101);
    expect(events).toHaveLength(4);
    expect(events[0]!.blockNumber).toBe(100);
    expect(events[1]!.blockNumber).toBe(101);
    // Within block 101: sorted by log_index ASC then id ASC.
    // tx2-Transferred(log=0,id=2), tx3-Transferred(log=0,id=4), tx2-Approval(log=1,id=3)
    expect(events[1]!.logIndex).toBe(0);  // tx2 Transferred
    expect(events[2]!.logIndex).toBe(0);  // tx3 Transferred (same log_index, higher id)
    expect(events[3]!.logIndex).toBe(1);  // tx2 Approval
  });

  it('respects fromBlock/toBlock range', async () => {
    const events = await source.query(101, 101);
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.blockNumber === 101)).toBe(true);
  });

  it('filters by contract address', async () => {
    const events = await source.query(100, 101, { contract: '0xtoken2' });
    expect(events).toHaveLength(1);
    expect(events[0]!.contractAddress).toBe('0xtoken2');
  });

  it('filters by event names', async () => {
    const events = await source.query(100, 101, { eventNames: ['Approval'] });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventName).toBe('Approval');
  });

  it('returns empty for out-of-range blocks', async () => {
    const events = await source.query(999, 1000);
    expect(events).toHaveLength(0);
  });

  it('populates blockTimestamp from blocks JOIN', async () => {
    const events = await source.query(100, 100);
    expect(events[0]!.blockTimestamp).toBe(1712340000);
  });

  it('populates fromAddress and gasUsed from transactions JOIN', async () => {
    const events = await source.query(100, 100);
    expect(events[0]!.fromAddress).toBe('0xalice');
    expect(events[0]!.gasUsed).toBe(21000n);
    expect(events[0]!.burnedBitcoin).toBe(500n);
    expect(events[0]!.failed).toBe(false);
  });

  it('populates failed=true and revertReason for failed tx', async () => {
    const events = await source.query(101, 101, { contract: '0xtoken2' });
    expect(events[0]!.failed).toBe(true);
    expect(events[0]!.revertReason).toBe('insufficient balance');
  });

  it('uses pre-stored decoded_json when available', async () => {
    const events = await source.query(100, 100);
    expect(events[0]!.decoded).not.toBeNull();
    expect(events[0]!.decoded!['value']).toBe('1000');
  });
});
