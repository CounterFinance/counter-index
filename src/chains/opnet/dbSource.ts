/**
 * DbEventSource — OPNET EventSource that reads directly from an OpStream-ready
 * database (events/transactions/blocks). Used for bulk historical backfill and
 * polling-based live mode. Produces chain-neutral `ChainEvent`s with OPNET
 * context under `chainMeta.kind === 'opnet'`.
 */

import type { MinimalDbAdapter } from '../../adapter.js';
import type { ChainEvent } from '../../types.js';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from '../../source.js';
import { opnetDecoder } from './opnetDecoder.js';
import { normaliseFromAddress } from './p2op.js';
import { OPNET_CHAIN_ID, OPNET_NETWORK } from './constants.js';
import type { OpnetChainMeta } from './types.js';

// ---------------------------------------------------------------------------
// Row shape returned by the JOIN query
// ---------------------------------------------------------------------------

interface EventJoinRow {
  id: number;
  block_number: number;
  tx_hash: string;
  contract_address: string;
  event_name: string;
  log_index: number;
  event_raw: Buffer | Uint8Array;
  data_length: number;
  from_address: string | null;
  gas_used: string | null;
  burned_bitcoin: string | null;
  failed: number | boolean | null;  // SQLite: 0/1 integer; Postgres: native boolean
  revert_reason: string | null;
  tx_index: number | null;
  block_timestamp: number | null;
}

/** Minimal sibling-event row — used to build the per-tx txEvents Map. */
interface TxSiblingRow {
  tx_hash: string;
  contract_address: string;
  event_name: string;
  event_raw: Buffer | Uint8Array;
}

const QUERY_BASE = `
  SELECT
    e.id,
    e.block_number,
    e.tx_hash,
    e.contract_address,
    e.event_name,
    e.log_index,
    e.event_raw,
    e.data_length,
    t.from_address,
    t.gas_used,
    t.burned_bitcoin,
    t.failed,
    t.revert_reason,
    t.tx_index,
    b.timestamp AS block_timestamp
  FROM events e
  LEFT JOIN transactions t ON t.tx_hash = e.tx_hash
  LEFT JOIN blocks b ON b.block_number = e.block_number
`;

/**
 * Build the event query with dialect-appropriate parameter placeholders.
 * SQLite uses positional `?`; Postgres uses `$N` (1-based).
 */
function buildQuery(
  fromBlock: number,
  toBlock: number,
  dialect: 'sqlite' | 'postgres',
  filters?: EventSourceFilters,
): { sql: string; params: unknown[] } {
  const p = (n: number): string => dialect === 'postgres' ? `$${n}` : '?';
  let sql = QUERY_BASE;
  const params: unknown[] = [fromBlock, toBlock];

  sql += ` WHERE e.block_number BETWEEN ${p(1)} AND ${p(2)}`;

  if (filters?.contract) {
    params.push(filters.contract);
    sql += ` AND e.contract_address = ${p(params.length)}`;
  }
  if (filters?.eventNames && filters.eventNames.length > 0) {
    const placeholders = filters.eventNames.map((_, i) => p(params.length + i + 1)).join(', ');
    sql += ` AND e.event_name IN (${placeholders})`;
    params.push(...filters.eventNames);
  }

  sql += ' ORDER BY e.block_number ASC, e.log_index ASC, e.id ASC';
  return { sql, params };
}

function rowToEvent(
  row: EventJoinRow,
  txEvents?: Map<string, Array<{ type: string; raw: Uint8Array }>>,
): ChainEvent {
  const rawData = row.event_raw instanceof Uint8Array
    ? row.event_raw
    : new Uint8Array(row.event_raw);

  // OpStream stores raw bytes only — decoding happens here, at read time, via the
  // OPNET decoder registry. Adding a new decoder instantly applies to all
  // historical events without any rewrite of the OpStream archive.
  const decoded = opnetDecoder.decode({ raw: rawData, eventName: row.event_name })?.decoded ?? null;
  const { address: fromAddress, pubkeyHex: fromAddressPubkey } =
    normaliseFromAddress(row.from_address);

  return {
    chainId:         OPNET_CHAIN_ID,
    network:         OPNET_NETWORK,
    blockNumber:     row.block_number,
    // OpStream's events JOIN does not carry a block hash; OPNET does not reorg at
    // the indexer's depth, so this stays empty. opStreamRpcSource supplies it.
    blockHash:       '',
    blockTimestamp:  row.block_timestamp ?? undefined,
    txHash:          row.tx_hash,
    txIndex:         row.tx_index ?? undefined,
    logIndex:        row.log_index,
    contractAddress: row.contract_address,
    eventName:       row.event_name,
    eventRaw:        rawData,
    decoded,
    dataLength:      row.data_length,
    txEvents,
    chainMeta: {
      kind:              'opnet',
      fromAddress,
      fromAddressPubkey,
      gasUsed:       row.gas_used != null ? BigInt(row.gas_used) : undefined,
      burnedBitcoin: row.burned_bitcoin != null ? BigInt(row.burned_bitcoin) : undefined,
      // SQLite stores failed as 0/1 (integer); Postgres returns native boolean.
      failed:        row.failed != null ? (row.failed !== 0 && row.failed !== false) : undefined,
      revertReason:  row.revert_reason ?? undefined,
    } as OpnetChainMeta,
  };
}

/**
 * Fetch all sibling events for the given tx_hashes in the block range and build
 * a per-tx Map keyed by contract address. Scoped by block_number so the query
 * plan uses the (block_number, log_index) index.
 */
async function fetchTxEventsMaps(
  db: MinimalDbAdapter,
  fromBlock: number,
  toBlock: number,
  txHashes: string[],
): Promise<Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>> {
  const result = new Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>();
  if (txHashes.length === 0) return result;

  const p = (n: number): string => db.dialect === 'postgres' ? `$${n}` : '?';
  const placeholders = txHashes.map((_, i) => p(i + 3)).join(', ');
  const sql = `
    SELECT tx_hash, contract_address, event_name, event_raw
    FROM events
    WHERE block_number BETWEEN ${p(1)} AND ${p(2)}
      AND tx_hash IN (${placeholders})
    ORDER BY block_number ASC, log_index ASC, id ASC
  `;
  const params: unknown[] = [fromBlock, toBlock, ...txHashes];
  const rows = await db.all<TxSiblingRow>(sql, params);

  for (const row of rows) {
    const raw = row.event_raw instanceof Uint8Array
      ? row.event_raw
      : new Uint8Array(row.event_raw);

    let perTx = result.get(row.tx_hash);
    if (!perTx) {
      perTx = new Map<string, Array<{ type: string; raw: Uint8Array }>>();
      result.set(row.tx_hash, perTx);
    }
    const bucket = perTx.get(row.contract_address);
    if (bucket) {
      bucket.push({ type: row.event_name, raw });
    } else {
      perTx.set(row.contract_address, [{ type: row.event_name, raw }]);
    }
  }

  return result;
}

export class DbEventSource implements EventSource {
  constructor(
    /** Read-only connection to an OpStream-ready database. */
    private readonly db: MinimalDbAdapter,
  ) {}

  async *queryStream(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): AsyncIterable<ChainEvent> {
    const { sql, params } = buildQuery(fromBlock, toBlock, this.db.dialect, filters);
    const rows = await this.db.all<EventJoinRow>(sql, params);
    if (rows.length === 0) return;

    // Fetch sibling-event sets for txEvents correlation (router pattern).
    const uniqueTxs = Array.from(new Set(rows.map(r => r.tx_hash)));
    const txMaps = await fetchTxEventsMaps(this.db, fromBlock, toBlock, uniqueTxs);

    for (const row of rows) {
      yield rowToEvent(row, txMaps.get(row.tx_hash));
    }
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
    options: { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? 10_000;
    let lastBlock = fromBlock - 1;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const tip = await this.db.get<{ max_block: number | null }>(
          'SELECT MAX(block_number) AS max_block FROM events',
        );
        const maxBlock = tip?.max_block ?? lastBlock;
        if (maxBlock > lastBlock) {
          for await (const e of this.queryStream(lastBlock + 1, maxBlock)) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = maxBlock;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[counter-index] subscribe poll error (will retry in ${intervalMs / 1000}s): ${msg}`);
      }
      if (!stopped) {
        setTimeout(() => { void poll(); }, intervalMs);
      }
    };

    setTimeout(() => { void poll(); }, 0);

    return () => { stopped = true; };
  }
}
