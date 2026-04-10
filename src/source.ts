/**
 * EventSource — abstraction over where OpKit reads raw chain events from.
 *
 * Two implementations:
 *   DbEventSource   — direct SQL against OpStream's events/transactions/blocks tables.
 *                     Used for backfill (bulk historical) and polling-based live mode.
 *                     Requires a MinimalDbAdapter pointed at an OpStream-ready DB.
 *
 *   RpcEventSource  — future: WebSocket/HTTP against OpStream's RPC endpoint.
 *                     Swap at config time — handlers and store are unaffected.
 *
 * The source is READ-ONLY. OpKit never writes to OpStream's tables through this interface.
 */

import type { MinimalDbAdapter } from './adapter.js';
import type { DecodedEvent } from './types.js';
import { decodeEvent } from './decoders/eventDecoders.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export type UnsubscribeFn = () => void;

export interface EventSourceFilters {
  /** Only return events from this contract address. */
  contract?: string;
  /** Only return events with these names. */
  eventNames?: string[];
}

export interface EventSource {
  /**
   * Backfill: fetch all events in [fromBlock, toBlock] inclusive, ordered by
   * block_number ASC, log_index ASC. Filters are ANDed.
   */
  query(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): Promise<DecodedEvent[]>;

  /**
   * Live: poll for new events after fromBlock and call onEvent for each.
   * Returns an unsubscribe function that stops polling when called.
   * Default poll interval: 10 seconds.
   */
  subscribe(
    fromBlock: number,
    onEvent: (e: DecodedEvent) => Promise<void>,
    options?: { pollIntervalMs?: number },
  ): UnsubscribeFn;
}

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
  decoded_json: string | null;
  data_length: number;
  // from transactions JOIN
  from_address: string | null;
  gas_used: string | null;
  burned_bitcoin: string | null;
  failed: number | null;   // SQLite stores boolean as 0/1
  revert_reason: string | null;
  tx_index: number | null;
  // from blocks JOIN
  block_timestamp: number | null;
}

// ---------------------------------------------------------------------------
// DbEventSource — reads from an OpStream-ready database
// ---------------------------------------------------------------------------

/**
 * The JOIN query enriches each event with transaction context (from_address,
 * gas_used, etc.) and block timestamp in a single round-trip. This is the
 * advantage of sharing the same DB as OpStream — no extra RPC calls needed.
 */
const QUERY_SQL = `
  SELECT
    e.id,
    e.block_number,
    e.tx_hash,
    e.contract_address,
    e.event_name,
    e.log_index,
    e.event_raw,
    e.decoded_json,
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
  WHERE e.block_number BETWEEN ? AND ?
`;

function buildQuery(
  fromBlock: number,
  toBlock: number,
  filters?: EventSourceFilters,
): { sql: string; params: unknown[] } {
  let sql = QUERY_SQL;
  const params: unknown[] = [fromBlock, toBlock];

  if (filters?.contract) {
    sql += ' AND e.contract_address = ?';
    params.push(filters.contract);
  }
  if (filters?.eventNames && filters.eventNames.length > 0) {
    const placeholders = filters.eventNames.map(() => '?').join(', ');
    sql += ` AND e.event_name IN (${placeholders})`;
    params.push(...filters.eventNames);
  }

  sql += ' ORDER BY e.block_number ASC, e.log_index ASC, e.id ASC';
  return { sql, params };
}

function rowToEvent(row: EventJoinRow): DecodedEvent {
  const rawData = row.event_raw instanceof Uint8Array
    ? row.event_raw
    : new Uint8Array(row.event_raw);

  // Use pre-stored decoded_json if available, otherwise try to decode now
  let decoded: Record<string, unknown> | null = null;
  if (row.decoded_json) {
    try { decoded = JSON.parse(row.decoded_json) as Record<string, unknown>; } catch { /* ignore */ }
  }
  if (!decoded) {
    decoded = decodeEvent(row.event_name, rawData);
  }

  return {
    blockNumber:    row.block_number,
    txHash:         row.tx_hash,
    contractAddress:row.contract_address,
    eventName:      row.event_name,
    eventRaw:       rawData,
    decoded,
    dataLength:     row.data_length,
    logIndex:       row.log_index,
    blockTimestamp: row.block_timestamp ?? undefined,
    txIndex:        row.tx_index ?? undefined,
    fromAddress:    row.from_address ?? undefined,
    gasUsed:        row.gas_used != null ? BigInt(row.gas_used) : undefined,
    burnedBitcoin:  row.burned_bitcoin != null ? BigInt(row.burned_bitcoin) : undefined,
    failed:         row.failed != null ? row.failed !== 0 : undefined,
    revertReason:   row.revert_reason ?? undefined,
  };
}

export class DbEventSource implements EventSource {
  constructor(
    /** Read-only connection to an OpStream-ready database. */
    private readonly db: MinimalDbAdapter,
  ) {}

  async query(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): Promise<DecodedEvent[]> {
    const { sql, params } = buildQuery(fromBlock, toBlock, filters);
    const rows = await this.db.all<EventJoinRow>(sql, params);
    return rows.map(rowToEvent);
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: DecodedEvent) => Promise<void>,
    options: { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? 10_000;
    let lastBlock = fromBlock - 1;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        // Find the latest block in the source DB
        const tip = await this.db.get<{ max_block: number | null }>(
          'SELECT MAX(block_number) AS max_block FROM events',
        );
        const maxBlock = tip?.max_block ?? lastBlock;
        if (maxBlock > lastBlock) {
          const events = await this.query(lastBlock + 1, maxBlock);
          for (const e of events) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = maxBlock;
        }
      } catch {
        // poll errors are non-fatal — next tick will retry
      }
      if (!stopped) {
        setTimeout(() => { void poll(); }, intervalMs);
      }
    };

    // Start first poll on next tick
    setTimeout(() => { void poll(); }, 0);

    return () => { stopped = true; };
  }
}
