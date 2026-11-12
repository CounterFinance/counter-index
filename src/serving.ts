/**
 * Serving-scale read path (opidx-#57).
 *
 * GraphQL-over-POST is powerful but forfeits HTTP caching (POST is never cached)
 * and needs a WebSocket for live data. For a read-heavy indexer fronted by a CDN
 * that is the scaling cliff. This module adds three cache- and proxy-friendly
 * read surfaces, all built on the SAME SQL pushdown as the GraphQL resolver
 * (store.query / store.countWhere — field names validated against the schema,
 * values bound as parameters, never interpolated) and the SAME keyset cursors,
 * so a cursor from one surface is valid on the others:
 *
 *   • REST projection   GET  /v1/:entity            cacheable list (Cache-Control
 *                       GET  /v1/:entity/:id        s-maxage + stale-while-
 *                                                   revalidate + ETag/304)
 *   • SQL-over-HTTP      POST /sql                   a typed, allow-listed query
 *                                                   ({entity, where, orderBy, …})
 *                                                   — the full filter object REST
 *                                                   query-strings can't express
 *   • Live queries (SSE) GET  /live?entity=…         text/event-stream of store
 *                                                   changes matching the filter —
 *                                                   one plain HTTP GET, so proxies
 *                                                   and load balancers pass it
 *                                                   through unchanged (vs a WS
 *                                                   upgrade)
 *
 * No new runtime dependency: like the GraphQL server, this rides Node's built-in
 * http module. "SQL over HTTP" here is a structured, parameterised query — not
 * raw SQL text — so there is no identifier-interpolation attack surface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { Schema, SchemaDefinition, EntityDef, FieldType } from './schema.js';
import type { EntityStore, StoreFilter, FilterOp } from './store.js';
import { encodeCursor, decodeCursor, coerceCursorValue, serialiseRecord, parseFilterKey } from './graphql.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RestOptions {
  /** Mount prefix for the REST projection. Default '/v1'. */
  base?: string;
  /** `Cache-Control: s-maxage` seconds (shared/CDN cache TTL). Default 5. */
  maxAge?: number;
  /** `stale-while-revalidate` seconds. Default 30. */
  staleWhileRevalidate?: number;
}

export interface ReadPathOptions {
  /** Cacheable REST projection. `true` uses defaults; an object overrides them. */
  rest?: boolean | RestOptions;
  /** Structured SQL-over-HTTP query endpoint. `true` mounts POST /sql. */
  sql?: boolean | { path?: string };
  /** Server-Sent-Events live queries. `true` mounts GET /live. */
  live?: boolean | { path?: string };
  /** Max rows any single read may return (shared cap). Default 1000. */
  maxPageSize?: number;
  /** Require `Authorization: Bearer <token>` on every read endpoint when set. */
  auth?: string;
  /** Max request-body bytes for POST /sql. Default 1_000_000 (1 MB). */
  maxBody?: number;
}

/** Handles a request if it targets a read-path route; returns true when it did. */
export type ReadRouter = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Scalar coercion (query-string / JSON value → the field's type)
// ---------------------------------------------------------------------------

function coerceScalar(type: FieldType, raw: unknown): unknown {
  switch (type) {
    case 'bigint':  return typeof raw === 'bigint' ? raw : BigInt(String(raw));
    case 'int':
    case 'float':   return typeof raw === 'number' ? raw : Number(raw);
    case 'boolean': return typeof raw === 'boolean' ? raw : raw === 'true' || raw === '1';
    default:        return String(raw);
  }
}

/**
 * Turn a GraphQL-style where object ({ field_op: value }) into StoreFilters,
 * coercing each value to its schema field type. Unknown fields pass through as
 * strings so store.query's allow-list rejects them (400), never this layer.
 */
function buildFilters(def: EntityDef, where: Record<string, unknown>): StoreFilter[] {
  const out: StoreFilter[] = [];
  for (const [key, raw] of Object.entries(where)) {
    if (raw === null || raw === undefined) continue;
    const { field, op } = parseFilterKey(key);
    const type: FieldType | undefined = field === 'id' ? 'string' : def[field]?.type;
    let value: unknown;
    if (op === 'in') {
      const arr: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw];
      value = type ? arr.map((v) => coerceScalar(type, v)) : arr;
    } else {
      value = type ? coerceScalar(type, raw) : raw;
    }
    out.push({ field, op: op as FilterOp, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Connection runner — the one keyset-pagination path, shared by REST + SQL
// ---------------------------------------------------------------------------

interface ConnectionParams {
  where: StoreFilter[];
  orderBy?: string;
  orderDirection: 'asc' | 'desc';
  first: number;
  after?: string;
  select?: string[];
}

interface Connection {
  nodes: Record<string, unknown>[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  totalCount: number;
}

async function runConnection(
  store: EntityStore,
  def: EntityDef,
  entity: string,
  p: ConnectionParams,
  maxPageSize: number,
): Promise<Connection> {
  const cappedFirst = Math.min(Math.max(1, Math.trunc(p.first) || 1), maxPageSize);
  const orderField = p.orderBy ?? 'id';
  const orderType: FieldType = orderField === 'id' ? 'string' : (def[orderField]?.type ?? 'string');

  let cursor: { sortValue: unknown; id: string } | undefined;
  if (p.after) {
    const c = decodeCursor(p.after);
    cursor = { id: c.i, sortValue: coerceCursorValue(c.s, orderType) };
  }

  // Fetch one extra row to decide hasNextPage without a second query — exactly
  // the GraphQL resolver's strategy, so cursors are interchangeable.
  const rows = await store.query(entity, {
    where: p.where,
    orderBy: p.orderBy,
    orderDirection: p.orderDirection,
    cursor,
    limit: cappedFirst + 1,
  });
  const totalCount = await store.countWhere(entity, p.where);

  const hasNextPage = rows.length > cappedFirst;
  const page = hasNextPage ? rows.slice(0, cappedFirst) : rows;
  const last = page[page.length - 1];
  const endCursor = last ? encodeCursor(String(last['id']), String(last[orderField])) : null;

  let nodes = page.map((r) => serialiseRecord(r, def));
  if (p.select && p.select.length > 0) {
    const keep = new Set(p.select);
    keep.add('id'); // keep id so the cursor stays meaningful
    nodes = nodes.map((n) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(n)) if (keep.has(k)) out[k] = n[k];
      return out;
    });
  }
  return { nodes, pageInfo: { hasNextPage, endCursor }, totalCount };
}

// ---------------------------------------------------------------------------
// In-JS filter matching (SSE — the record is handed to us, not queried)
// ---------------------------------------------------------------------------

function cmp(a: unknown, b: unknown): number {
  try {
    if (typeof a === 'bigint' || typeof b === 'bigint') {
      const x = BigInt(a as string | number | bigint), y = BigInt(b as string | number | bigint);
      return x < y ? -1 : x > y ? 1 : 0;
    }
    if (typeof a === 'number' || typeof b === 'number') {
      const x = Number(a), y = Number(b);
      if (!Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : x > y ? 1 : 0;
    }
  } catch { /* fall through to string compare */ }
  const x = String(a), y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchOne(a: unknown, op: FilterOp, b: unknown): boolean {
  switch (op) {
    case 'eq':  return cmp(a, b) === 0;
    case 'not': return cmp(a, b) !== 0;
    case 'gt':  return cmp(a, b) > 0;
    case 'gte': return cmp(a, b) >= 0;
    case 'lt':  return cmp(a, b) < 0;
    case 'lte': return cmp(a, b) <= 0;
    case 'contains':    return String(a).includes(String(b));
    case 'starts_with': return String(a).startsWith(String(b));
    case 'ends_with':   return String(a).endsWith(String(b));
    case 'in':  return Array.isArray(b) && b.some((x) => cmp(a, x) === 0);
  }
}

/**
 * True when `record` satisfies every filter. The SSE server-side predicate: the
 * record is handed to us by onChange, so (unlike REST/SQL) we evaluate it in JS
 * rather than SQL. Exported for direct unit testing of the operator matrix.
 */
export function matchesFilters(record: Record<string, unknown>, filters: StoreFilter[]): boolean {
  for (const f of filters) {
    if (!matchOne(record[f.field], f.op, f.value)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

/** JSON-serialise, turning bigints into decimal strings (as GraphQL does). */
function jsonBody(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

function sendJson(res: ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : jsonBody(body);
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

/** Read a bounded request body; responds 413 and resolves null if it overflows. */
function readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    req.on('error', () => resolve(null));
    res.on('error', () => { /* broken pipe — ignore */ });
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      body += chunk.toString();
      if (body.length > maxBytes) {
        over = true;
        sendJson(res, 413, { errors: [{ message: 'request body too large' }] });
        req.resume();          // drain the rest cleanly (no connection reset)
        resolve(null);
      }
    });
    req.on('end', () => { if (!over) resolve(body); });
  });
}

function normRest(v: ReadPathOptions['rest']): Required<RestOptions> | null {
  if (!v) return null;
  const o = v === true ? {} : v;
  return {
    base: (o.base ?? '/v1').replace(/\/$/, ''),
    maxAge: o.maxAge ?? 5,
    staleWhileRevalidate: o.staleWhileRevalidate ?? 30,
  };
}

function normPath(v: boolean | { path?: string } | undefined, dflt: string): string | null {
  if (!v) return null;
  return (v === true ? dflt : (v.path ?? dflt));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Build the read-path router, or return undefined if nothing is enabled. The
 * GraphQL HTTP server calls it before its own 404; a true return means handled.
 */
export function buildReadPath(
  schema: Schema<SchemaDefinition>,
  store: EntityStore,
  opts: ReadPathOptions = {},
): ReadRouter | undefined {
  const rest = normRest(opts.rest);
  const sqlPath = normPath(opts.sql, '/sql');
  const livePath = normPath(opts.live, '/live');
  if (!rest && !sqlPath && !livePath) return undefined;

  const maxPageSize = opts.maxPageSize ?? 1000;
  const maxBody = opts.maxBody ?? 1_000_000;
  const auth = opts.auth;
  const entities = new Set(schema.entityNames());

  const authorised = (req: IncomingMessage): boolean =>
    !auth || req.headers['authorization'] === `Bearer ${auth}`;

  const parseSelect = (raw: string | null): string[] | undefined =>
    raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  return async (req, res, url): Promise<boolean> => {
    const path = url.pathname;

    // ── SQL-over-HTTP: POST /sql ──────────────────────────────────────────
    if (sqlPath && path === sqlPath) {
      if (req.method !== 'POST') { res.writeHead(405); res.end('Method not allowed'); return true; }
      if (!authorised(req)) { sendJson(res, 401, { errors: [{ message: 'unauthorized' }] }); return true; }
      const body = await readBody(req, res, maxBody);
      if (body === null) return true; // already responded (413 / abort)
      try {
        const q = JSON.parse(body) as {
          entity?: string;
          where?: Record<string, unknown>;
          orderBy?: string;
          orderDirection?: 'asc' | 'desc';
          first?: number;
          after?: string;
          select?: string[];
        };
        if (!q.entity || !entities.has(q.entity)) {
          sendJson(res, 404, { errors: [{ message: `unknown entity: ${String(q.entity)}` }] });
          return true;
        }
        const def = schema.getEntity(q.entity);
        const filters = buildFilters(def, q.where ?? {});
        const conn = await runConnection(store, def, q.entity, {
          where: filters,
          orderBy: q.orderBy,
          orderDirection: q.orderDirection === 'desc' ? 'desc' : 'asc',
          first: q.first ?? 100,
          after: q.after,
          select: q.select,
        }, maxPageSize);
        sendJson(res, 200, { data: conn }, { 'Cache-Control': 'no-store' });
      } catch (e) {
        sendJson(res, 400, { errors: [{ message: String(e) }] });
      }
      return true;
    }

    // ── Live queries (SSE): GET /live?entity=…&<filters> ──────────────────
    if (livePath && path === livePath) {
      if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return true; }
      if (!authorised(req)) { sendJson(res, 401, { errors: [{ message: 'unauthorized' }] }); return true; }
      const entity = url.searchParams.get('entity');
      if (!entity || !entities.has(entity)) {
        sendJson(res, 404, { errors: [{ message: `unknown entity: ${String(entity)}` }] });
        return true;
      }
      const def = schema.getEntity(entity);
      const where: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams) if (k !== 'entity') where[k] = v;
      const filters = buildFilters(def, where);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable proxy buffering (nginx)
      });
      res.write('retry: 2000\n');
      res.write(`event: open\ndata: ${jsonBody({ entity })}\n\n`);

      const unsubscribe = store.onChange((ev) => {
        if (ev.entity !== entity) return;
        if (ev.operation !== 'delete' && ev.record && !matchesFilters(ev.record, filters)) return;
        const payload = {
          entity: ev.entity,
          id: ev.id,
          operation: ev.operation,
          record: ev.record ? serialiseRecord(ev.record, def) : null,
        };
        res.write(`event: change\ndata: ${jsonBody(payload)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
      heartbeat.unref?.();
      const close = (): void => { clearInterval(heartbeat); unsubscribe(); };
      req.on('close', close);
      res.on('close', close);
      return true;
    }

    // ── REST projection: GET /v1/:entity[/:id] ────────────────────────────
    if (rest && (path === rest.base || path.startsWith(rest.base + '/'))) {
      if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return true; }
      if (!authorised(req)) { sendJson(res, 401, { errors: [{ message: 'unauthorized' }] }); return true; }
      const rel = path.slice(rest.base.length).replace(/^\//, '');
      const segs = rel.split('/').filter(Boolean);
      const entity = segs[0];
      if (!entity || !entities.has(entity)) {
        sendJson(res, 404, { errors: [{ message: `unknown entity: ${String(entity)}` }] });
        return true;
      }
      const def = schema.getEntity(entity);
      // A bearer-gated response must not land in a shared cache.
      const cacheControl = auth
        ? 'private, no-store'
        : `public, s-maxage=${rest.maxAge}, stale-while-revalidate=${rest.staleWhileRevalidate}`;

      try {
        let payload: unknown;
        if (segs.length >= 2) {
          // Single record by id.
          const id = decodeURIComponent(segs.slice(1).join('/'));
          const record = await store.get(entity, id);
          if (!record) { sendJson(res, 404, { errors: [{ message: 'not found' }] }, { 'Cache-Control': cacheControl }); return true; }
          payload = { data: serialiseRecord(record, def) };
        } else {
          // List / connection — query-string filters + paging.
          const sp = url.searchParams;
          const where: Record<string, unknown> = {};
          for (const [k, v] of sp) {
            if (k === 'orderBy' || k === 'orderDirection' || k === 'first' || k === 'after' || k === 'select') continue;
            where[k] = v;
          }
          const filters = buildFilters(def, where);
          const conn = await runConnection(store, def, entity, {
            where: filters,
            orderBy: sp.get('orderBy') ?? undefined,
            orderDirection: sp.get('orderDirection') === 'desc' ? 'desc' : 'asc',
            first: Number(sp.get('first') ?? 100),
            after: sp.get('after') ?? undefined,
            select: parseSelect(sp.get('select')),
          }, maxPageSize);
          payload = { data: conn };
        }

        const text = jsonBody(payload);
        const etag = `W/"${createHash('sha1').update(text).digest('hex').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, { 'Cache-Control': cacheControl, ETag: etag });
          res.end();
          return true;
        }
        sendJson(res, 200, text, { 'Cache-Control': cacheControl, ETag: etag });
      } catch (e) {
        sendJson(res, 400, { errors: [{ message: String(e) }] }, { 'Cache-Control': 'no-store' });
      }
      return true;
    }

    return false;
  };
}
