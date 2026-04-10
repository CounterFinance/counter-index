/**
 * createEventSource — capability-probing EventSource factory.
 *
 * Give it what you have; it probes and picks the fastest available engine:
 *
 *   Tier 1 — DbEventSource   (OpStream-ready DB present → sub-millisecond SQL)
 *   Tier 2 — WsEventSource   (OpStream WebSocket broadcast → sub-second latency)
 *   Tier 3 — RpcEventSource  (plain OPNET getBlock loop — O(N), always works)
 *
 * Usage:
 *   // Prefer OpStream DB, fall back to RPC if it's not ready:
 *   const source = await createEventSource({
 *     db:  'data/opstream.db',
 *     rpc: new JSONRpcProvider('https://mainnet.opnet.org'),
 *   });
 *
 *   // DB + WS (backfill via DB, live via WS — caller wires them separately):
 *   const source = await createEventSource({ db: adapter, ws: 'ws://localhost:8080' });
 *
 *   // DB only (throws if not OpStream-ready):
 *   const source = await createEventSource({ db: adapter });
 *
 *   // RPC only (no DB):
 *   const source = await createEventSource({ rpc: provider });
 */

import type { MinimalDbAdapter } from './adapter.js';
import { openSqlite } from './adapter.js';
import type { EventSource } from './source.js';
import { DbEventSource } from './source.js';
import type { BlockProvider, RpcEventSourceOptions } from './rpcSource.js';
import { RpcEventSource } from './rpcSource.js';
import { WsEventSource, type WsEventSourceOptions } from './wsSource.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateEventSourceOptions {
  /** Options forwarded to RpcEventSource when it is chosen. */
  rpcOptions?: RpcEventSourceOptions;
  /** Options forwarded to WsEventSource when it is chosen. */
  wsOptions?: WsEventSourceOptions;
}

export interface EventSourceInput {
  /**
   * Path to an OpStream-ready SQLite file OR a pre-opened MinimalDbAdapter
   * (sqlite or postgres). Probed first — if the three OpStream tables are
   * present, returns DbEventSource (fast). Otherwise warns and falls back.
   */
  db?: string | MinimalDbAdapter;

  /**
   * OpStream WebSocket broadcast URL (e.g. 'ws://localhost:8080').
   * Tier 2 — chosen over RPC when present, but after DB probe fails.
   * WsEventSource is live-only; pass `db` as well for backfill support.
   */
  ws?: string;

  /**
   * OPNET RPC provider (e.g. opnet SDK's JSONRpcProvider). Used when db is
   * absent or the schema probe fails and no ws URL is provided.
   * Triggers Tier-3 getBlock loop.
   */
  rpc?: BlockProvider;
}

/**
 * Capability-probing EventSource factory.
 *
 * @throws if neither `db` nor `rpc` is provided, or if `db` is provided and
 *   not OpStream-ready while no `rpc` fallback is given.
 */
export async function createEventSource(
  input: EventSourceInput,
  options?: CreateEventSourceOptions,
): Promise<EventSource> {
  // ── Tier 1: OpStream-ready DB ─────────────────────────────────────────────
  if (input.db !== undefined) {
    const adapter: MinimalDbAdapter = typeof input.db === 'string'
      ? openSqlite(input.db)
      : input.db;

    const ready = await probeOpStreamSchema(adapter);

    if (ready) {
      return new DbEventSource(adapter);
    }

    // DB exists but is not OpStream-ready
    if (!input.ws && !input.rpc) {
      throw new Error(
        '[OpKit] createEventSource: the provided database is not OpStream-ready ' +
        '(missing events / transactions / blocks tables). ' +
        'Either point at an OpStream database or provide a ws URL / rpc fallback.',
      );
    }

    console.warn(
      '[OpKit] createEventSource: database is not OpStream-ready — ' +
      `falling back to ${input.ws ? 'WsEventSource' : 'RpcEventSource'}.`,
    );
  }

  // ── Tier 2: OpStream WebSocket broadcast ─────────────────────────────────
  if (input.ws) {
    return new WsEventSource(input.ws, options?.wsOptions);
  }

  // ── Tier 3: RPC fallback ──────────────────────────────────────────────────
  if (input.rpc) {
    return new RpcEventSource(input.rpc, options?.rpcOptions);
  }

  throw new Error(
    '[OpKit] createEventSource: no valid source provided. ' +
    'Pass a db path/adapter, a ws URL, an rpc BlockProvider, or a combination.',
  );
}

// ---------------------------------------------------------------------------
// Schema probe (internal)
// ---------------------------------------------------------------------------

/**
 * Returns true if the adapter has the three tables DbEventSource JOINs against.
 * Never throws — a false return means "not OpStream-ready".
 */
export async function probeOpStreamSchema(adapter: MinimalDbAdapter): Promise<boolean> {
  try {
    await adapter.get('SELECT 1 FROM events LIMIT 1');
    await adapter.get('SELECT 1 FROM transactions LIMIT 1');
    await adapter.get('SELECT 1 FROM blocks LIMIT 1');
    return true;
  } catch {
    return false;
  }
}
