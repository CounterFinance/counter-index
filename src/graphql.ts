/**
 * GraphQL API layer for op-index.
 *
 * Automatically generates a GraphQL schema + resolvers from the defineSchema()
 * entity definitions and serves them over HTTP (and optionally WebSocket).
 *
 * Features:
 *   - One query pair per entity: pool(id) + pools(where, orderBy, orderDirection, first, after)
 *   - Cursor-based pagination with PageInfo (hasNextPage, endCursor, totalCount)
 *   - Filtering: exact match, _not, _gt, _lt, _gte, _lte, _contains, _starts_with, _ends_with
 *   - Ordering: any field, asc or desc (stable: secondary sort by id)
 *   - BigInt scalar — stored as bigint, serialised as decimal string over the wire
 *   - GraphiQL playground at GET /graphql
 *   - Optional GraphQL subscriptions via graphql-ws (peer dep: npm install graphql-ws ws)
 *   - Uses Node's built-in http module — no mandatory extra server dependency
 *
 * Usage:
 *   const indexer = await createIndexer({ schema, sink, source });
 *   const handle = await indexer.serve({ port: 4000 });
 *   // → http://localhost:4000/graphql
 *   // → subscriptions: ws://localhost:4000/graphql  (when subscriptions: true)
 */

import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  graphql,
  parse,
  Kind,
} from 'graphql';
import type { GraphQLFieldConfigMap, GraphQLInputFieldConfigMap, GraphQLEnumValueConfigMap, DocumentNode, SelectionNode } from 'graphql';
import type { Schema, SchemaDefinition, EntityDef, FieldType } from './schema.js';
import type { EntityStore, StoreFilter, FilterOp } from './store.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ServeOptions {
  /** Port to listen on. Default: 4000. */
  port?: number;
  /** Path for the GraphQL endpoint. Default: '/graphql'. */
  path?: string;
  /**
   * Enable GraphQL subscriptions over WebSocket (graphql-ws protocol).
   * Requires peer dependencies: npm install graphql-ws ws
   * The WebSocket server shares the same port as the HTTP server.
   * Default: false.
   */
  subscriptions?: boolean;
  /**
   * Provider for GET /health (JSON) and GET /metrics (Prometheus text). Numeric
   * values become `opindex_<key>` gauges; a nested object becomes labelled
   * gauges `opindex_<key>{key="<sub>"}`. Booleans map to 0/1.
   */
  status?: () => Record<string, unknown>;
  /** Max rows a connection's `first` can return. Default 1000. */
  maxPageSize?: number;
  /** Reject queries whose selection-set nesting exceeds this. Default 12. */
  maxQueryDepth?: number;
  /** Require `Authorization: Bearer <token>` on POST /graphql when set. */
  auth?: string;
  /** Simple per-IP rate limit for POST /graphql. */
  rateLimit?: { windowMs: number; max: number };
}

/** Max selection-set nesting depth of a GraphQL document (DoS guard). */
function queryDepth(document: DocumentNode): number {
  let max = 0;
  const walk = (selections: readonly SelectionNode[] | undefined, depth: number): void => {
    if (!selections) return;
    if (depth > max) max = depth;
    for (const sel of selections) {
      if (sel.kind === Kind.FIELD && sel.selectionSet) walk(sel.selectionSet.selections, depth + 1);
      else if (sel.kind === Kind.INLINE_FRAGMENT && sel.selectionSet) walk(sel.selectionSet.selections, depth);
    }
  };
  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) walk(def.selectionSet.selections, 1);
  }
  return max;
}

/** Render a flat/one-level-nested status map as Prometheus exposition text. */
/** Health shape emitted by the indexer (see src/lifecycle.ts). */
interface HealthLike {
  state?: string;
  uptimeMs?: number;
  reorgs?: number;
  errors?: number;
  chains?: Array<{ chainId: number; lastBlock?: number; blocksBehind?: number | null; idleMs?: number }>;
}
const HEALTH_STATES = ['starting', 'backfilling', 'live', 'degraded', 'stalled', 'draining', 'stopped'];

function renderMetrics(status: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(status)) {
    if (typeof v === 'number') { lines.push(`opindex_${k} ${v}`); continue; }
    if (typeof v === 'boolean') { lines.push(`opindex_${k} ${v ? 1 : 0}`); continue; }
    if (k === 'health' && v && typeof v === 'object') { renderHealth(v as HealthLike, lines); continue; }
    if (k === 'handlerLatencyMs' && v && typeof v === 'object') { renderHistogram('opindex_handler_latency_ms', v as HistogramLike, lines); continue; }
    if (v && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === 'number') lines.push(`opindex_${k}{key="${k2}"} ${v2}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function renderHealth(h: HealthLike, lines: string[]): void {
  // state as a one-hot gauge so Prometheus can alert on `== "stalled"`.
  for (const s of HEALTH_STATES) lines.push(`opindex_health_state{state="${s}"} ${h.state === s ? 1 : 0}`);
  if (typeof h.uptimeMs === 'number') lines.push(`opindex_uptime_ms ${h.uptimeMs}`);
  if (typeof h.reorgs === 'number') lines.push(`opindex_reorgs_total ${h.reorgs}`);
  if (typeof h.errors === 'number') lines.push(`opindex_errors_total ${h.errors}`);
  for (const c of h.chains ?? []) {
    if (typeof c.blocksBehind === 'number') lines.push(`opindex_chain_blocks_behind{chain="${c.chainId}"} ${c.blocksBehind}`);
    if (typeof c.lastBlock === 'number') lines.push(`opindex_chain_last_block{chain="${c.chainId}"} ${c.lastBlock}`);
    if (typeof c.idleMs === 'number') lines.push(`opindex_chain_idle_ms{chain="${c.chainId}"} ${c.idleMs}`);
  }
}

interface HistogramLike { buckets?: Array<{ le: number | '+Inf'; count: number }>; count?: number; sum?: number }
function renderHistogram(name: string, h: HistogramLike, lines: string[]): void {
  for (const b of h.buckets ?? []) lines.push(`${name}_bucket{le="${b.le}"} ${b.count}`);
  if (typeof h.count === 'number') lines.push(`${name}_count ${h.count}`);
  if (typeof h.sum === 'number') lines.push(`${name}_sum ${h.sum}`);
}

export interface ServeHandle {
  /** URL of the GraphQL endpoint. */
  url: string;
  /** Stop the HTTP server (and WebSocket server if subscriptions were enabled). */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// BigInt scalar
// ---------------------------------------------------------------------------

const BigIntScalar = new GraphQLScalarType({
  name: 'BigInt',
  description: 'Arbitrary-precision integer — serialised as a decimal string.',
  serialize(value) {
    return String(value);
  },
  parseValue(value) {
    if (typeof value === 'string' || typeof value === 'number') return BigInt(value);
    throw new TypeError(`BigInt cannot represent: ${String(value)}`);
  },
  parseLiteral(ast) {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) return BigInt(ast.value);
    throw new TypeError(`BigInt cannot represent literal kind: ${ast.kind}`);
  },
});

// ---------------------------------------------------------------------------
// FieldType → GraphQL output / input type
// ---------------------------------------------------------------------------

function gqlOutputType(type: FieldType) {
  switch (type) {
    case 'string':  return GraphQLString;
    case 'int':     return GraphQLInt;
    case 'float':   return GraphQLFloat;
    case 'bigint':  return BigIntScalar;
    case 'boolean': return GraphQLBoolean;
    case 'bytes':   return GraphQLString; // hex-encoded
  }
}

const gqlInputType = gqlOutputType;

// ---------------------------------------------------------------------------
// Filter operators per field type
// ---------------------------------------------------------------------------

const STRING_OPS  = ['', '_not', '_contains', '_starts_with', '_ends_with'] as const;
const NUMERIC_OPS = ['', '_not', '_gt', '_lt', '_gte', '_lte'] as const;
const BOOL_OPS    = ['', '_not'] as const;

function opsForType(type: FieldType): readonly string[] {
  switch (type) {
    case 'string':
    case 'bytes':   return STRING_OPS;
    case 'bigint':
    case 'int':
    case 'float':   return NUMERIC_OPS;
    case 'boolean': return BOOL_OPS;
  }
}

// ---------------------------------------------------------------------------
// Cursor helpers — opaque base64-encoded entity id
// ---------------------------------------------------------------------------

/** A keyset cursor carries the order-by value + id, so paging is stable in SQL. */
function encodeCursor(id: string, sortValue: string): string {
  return Buffer.from(JSON.stringify({ i: id, s: sortValue }), 'utf8').toString('base64');
}

function decodeCursor(cursor: string): { i: string; s: string } {
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8')) as { i?: unknown; s?: unknown };
    const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
    return { i: str(o.i), s: str(o.s) };
  } catch {
    // Back-compat: a legacy id-only cursor (plain base64 id).
    const id = Buffer.from(cursor, 'base64').toString('utf8');
    return { i: id, s: id };
  }
}

/** Reconstruct a typed cursor sort value from its stringified form. */
function coerceCursorValue(s: string, type: FieldType): unknown {
  switch (type) {
    case 'bigint':  return BigInt(s);
    case 'int':
    case 'float':   return Number(s);
    case 'boolean': return s === 'true' || s === '1';
    default:        return s;
  }
}

// ---------------------------------------------------------------------------
// Shared GraphQL types
// ---------------------------------------------------------------------------

const OrderDirectionEnum = new GraphQLEnumType({
  name: 'OrderDirection',
  values: {
    asc:  { value: 'asc' },
    desc: { value: 'desc' },
  },
});

const PageInfoType = new GraphQLObjectType({
  name: 'PageInfo',
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    endCursor:   { type: GraphQLString },
  },
});

// ---------------------------------------------------------------------------
// Build GraphQL types per entity
// ---------------------------------------------------------------------------

function buildFilterType(entityName: string, def: EntityDef): GraphQLInputObjectType {
  const fields: GraphQLInputFieldConfigMap = {};
  for (const op of STRING_OPS) {
    fields[`id${op}`] = { type: GraphQLString };
  }
  fields['id_in'] = { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) };
  for (const [fieldName, fieldDef] of Object.entries(def)) {
    const base = gqlInputType(fieldDef.type);
    for (const op of opsForType(fieldDef.type)) {
      fields[`${fieldName}${op}`] = { type: base };
    }
    // Membership filter: `field_in: [T]` → SQL `IN (...)`.
    fields[`${fieldName}_in`] = { type: new GraphQLList(new GraphQLNonNull(base)) };
  }
  return new GraphQLInputObjectType({ name: `${entityName}_filter`, fields });
}

function buildOrderByEnum(entityName: string, def: EntityDef): GraphQLEnumType {
  const values: GraphQLEnumValueConfigMap = { id: { value: 'id' } };
  for (const fieldName of Object.keys(def)) {
    values[fieldName] = { value: fieldName };
  }
  return new GraphQLEnumType({ name: `${entityName}_orderBy`, values });
}

function buildEntityType(entityName: string, def: EntityDef): GraphQLObjectType {
  const fields: GraphQLFieldConfigMap<Record<string, unknown>, unknown> = {
    id: { type: new GraphQLNonNull(GraphQLString) },
  };
  for (const [fieldName, fieldDef] of Object.entries(def)) {
    const base = gqlOutputType(fieldDef.type);
    fields[fieldName] = {
      type: fieldDef.optional ? base : new GraphQLNonNull(base),
    };
  }
  return new GraphQLObjectType({ name: entityName, fields });
}

function buildConnectionType(entityName: string, entityType: GraphQLObjectType): GraphQLObjectType {
  return new GraphQLObjectType({
    name: `${entityName}Connection`,
    fields: {
      nodes:      { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(entityType))) },
      pageInfo:   { type: new GraphQLNonNull(PageInfoType) },
      totalCount: { type: new GraphQLNonNull(GraphQLInt) },
    },
  });
}

// ---------------------------------------------------------------------------
// Where filter — apply to a record
// ---------------------------------------------------------------------------

// Order matters: multi-char suffixes (starts_with) before their prefixes; `in` last.
const KNOWN_OPS = ['not', 'gte', 'lte', 'gt', 'lt', 'contains', 'starts_with', 'ends_with', 'in'];

function parseFilterKey(key: string): { field: string; op: string } {
  for (const op of KNOWN_OPS) {
    if (key.endsWith(`_${op}`)) {
      return { field: key.slice(0, key.length - op.length - 1), op };
    }
  }
  return { field: key, op: 'eq' };
}

/** Translate the GraphQL `where` object ({field_op: value}) into StoreFilters. */
function whereToFilters(where: Record<string, unknown>): StoreFilter[] {
  const out: StoreFilter[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === null || value === undefined) continue;
    const { field, op } = parseFilterKey(key);
    out.push({ field, op: op as FilterOp, value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Serialise a store record for GraphQL output
// ---------------------------------------------------------------------------

function serialiseRecord(
  record: Record<string, unknown>,
  def: EntityDef,
): Record<string, unknown> {
  const out: Record<string, unknown> = { id: record['id'] };
  for (const [field, fieldDef] of Object.entries(def)) {
    const val = record[field];
    if (val === undefined || val === null) {
      out[field] = null;
    } else if (fieldDef.type === 'bigint') {
      out[field] = String(val as bigint);
    } else {
      out[field] = val;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Async stream — push-to-pull bridge for subscription resolvers
// ---------------------------------------------------------------------------

interface PushStream<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

function makePushStream<T>(): PushStream<T> {
  const queue: T[] = [];
  let waiting: ((result: IteratorResult<T, undefined>) => void) | null = null;
  let done = false;

  return {
    push(value: T) {
      if (done) return;
      if (waiting) {
        waiting({ value, done: false });
        waiting = null;
      } else {
        queue.push(value);
      }
    },
    end() {
      done = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      waiting?.({ value: undefined as any, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T, undefined>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
        return(): Promise<IteratorResult<T, undefined>> {
          done = true;
          waiting?.({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Build the full GraphQL schema (query + optional subscription)
// ---------------------------------------------------------------------------

export function buildGraphQLSchema(
  schema: Schema<SchemaDefinition>,
  store: EntityStore,
  options: { subscriptions?: boolean; maxPageSize?: number } = {},
): GraphQLSchema {
  // Hard cap on `first` — a client asking for first: 1e9 is clamped, not honoured.
  const maxPageSize = Math.max(1, options.maxPageSize ?? 1000);
  const queryFields: GraphQLFieldConfigMap<unknown, unknown> = {};
  const subscriptionFields: GraphQLFieldConfigMap<unknown, unknown> = {};

  for (const entityName of schema.entityNames()) {
    const def        = schema.getEntity(entityName);
    const entityType = buildEntityType(entityName, def);
    const connType   = buildConnectionType(entityName, entityType);
    const filterType = buildFilterType(entityName, def);
    const orderEnum  = buildOrderByEnum(entityName, def);
    const lowerName  = entityName.charAt(0).toLowerCase() + entityName.slice(1);

    // ── Singular: pool(id: String!): Pool ──────────────────────────────────
    queryFields[lowerName] = {
      type: entityType,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: async (_src: unknown, { id }: { id: string }) => {
        const record = await store.get(entityName, id);
        return record ? serialiseRecord(record, def) : null;
      },
    };

    // ── Plural: pools(where, orderBy, orderDirection, first, after): PoolConnection! ──
    queryFields[`${lowerName}s`] = {
      type: new GraphQLNonNull(connType),
      args: {
        where:          { type: filterType },
        orderBy:        { type: orderEnum },
        orderDirection: { type: OrderDirectionEnum },
        first:          { type: GraphQLInt },
        after:          { type: GraphQLString },
      },
      resolve: async (
        _src: unknown,
        {
          where,
          orderBy,
          orderDirection,
          first = 100,
          after,
        }: {
          where?:          Record<string, unknown>;
          orderBy?:        string;
          orderDirection?: 'asc' | 'desc';
          first?:          number;
          after?:          string;
        },
      ) => {
        // M17: push filter / order / keyset-paginate entirely into SQL — no
        // whole-table load (closes the DoS of opidx-#42).
        const dir: 'asc' | 'desc' = orderDirection === 'desc' ? 'desc' : 'asc';
        const filters = where ? whereToFilters(where) : undefined;
        const cappedFirst = Math.min(Math.max(1, first), maxPageSize);
        const orderField = orderBy ?? 'id';
        const orderType: FieldType = orderField === 'id' ? 'string' : (def[orderField]?.type ?? 'string');

        let cursor: { sortValue: unknown; id: string } | undefined;
        if (after) {
          const c = decodeCursor(after);
          cursor = { id: c.i, sortValue: coerceCursorValue(c.s, orderType) };
        }

        // Fetch one extra row to decide hasNextPage without a second query.
        const rows = await store.query(entityName, {
          where: filters, orderBy, orderDirection: dir, cursor, limit: cappedFirst + 1,
        });
        const totalCount = await store.countWhere(entityName, filters);

        const hasNextPage = rows.length > cappedFirst;
        const page = rows.slice(0, cappedFirst);
        const last = page[page.length - 1];
        const endCursor = last ? encodeCursor(String(last['id']), String(last[orderField])) : null;

        return {
          nodes:      page.map((r) => serialiseRecord(r, def)),
          pageInfo:   { hasNextPage, endCursor },
          totalCount,
        };
      },
    };

    // ── Subscription: poolUpdated: Pool ────────────────────────────────────
    if (options.subscriptions) {
      subscriptionFields[`${lowerName}Updated`] = {
        type: entityType,
        subscribe: () => {
          const stream = makePushStream<Record<string, unknown>>();
          const unsub = store.onChange((event) => {
            if (event.entity !== entityName || event.record === null) return;
            stream.push(serialiseRecord(event.record, def));
          });
          // Wrap so cleanup fires when the client disconnects
          return {
            [Symbol.asyncIterator](): AsyncIterator<Record<string, unknown>> {
              const inner = stream[Symbol.asyncIterator]();
              return {
                next: () => inner.next(),
                return: async () => {
                  unsub();
                  stream.end();
                  return inner.return?.() ?? Promise.resolve({ value: undefined as unknown as Record<string, unknown>, done: true as const });
                },
              };
            },
          };
        },
        // The yielded value from subscribe IS the resolved field value
        resolve: (record: unknown) => record as Record<string, unknown>,
      };
    }
  }

  // ── _meta: TheGraph-compatible indexed-block checkpoint ────────────────────

  const IndexerBlockType = new GraphQLObjectType({
    name: '_IndexerBlock',
    fields: {
      number:    { type: new GraphQLNonNull(GraphQLInt) },
      timestamp: { type: GraphQLInt },
    },
  });

  const IndexerMetaType = new GraphQLObjectType({
    name: '_IndexerMeta',
    fields: {
      block:             { type: new GraphQLNonNull(IndexerBlockType) },
      tipBlock:          { type: GraphQLInt },
      blocksBehind:      { type: GraphQLInt },
      hasIndexingErrors: { type: new GraphQLNonNull(GraphQLBoolean) },
      synced:            { type: new GraphQLNonNull(GraphQLBoolean) },
    },
  });

  queryFields['_meta'] = {
    type: IndexerMetaType,
    resolve: async () => {
      const cp = await store.readCheckpoint();
      if (!cp) return null;
      // Clamp to 0: tipBlock can be stale (set during backfill) while lastBlock advances
      // in live mode — never surface a negative value to consumers.
      const rawBehind   = cp.tipBlock != null ? cp.tipBlock - cp.lastBlock : null;
      const blocksBehind = rawBehind != null ? Math.max(0, rawBehind) : null;
      return {
        block:             { number: cp.lastBlock, timestamp: cp.lastBlockTs ?? null },
        tipBlock:          cp.tipBlock ?? null,
        blocksBehind,
        hasIndexingErrors: false,
        synced:            blocksBehind === null || blocksBehind === 0,
      };
    },
  };

  return new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: queryFields }),
    ...(options.subscriptions && Object.keys(subscriptionFields).length > 0
      ? { subscription: new GraphQLObjectType({ name: 'Subscription', fields: subscriptionFields }) }
      : {}),
    types: [BigIntScalar, OrderDirectionEnum, PageInfoType],
  });
}

// ---------------------------------------------------------------------------
// Optional WebSocket subscription server (graphql-ws peer dep)
// ---------------------------------------------------------------------------

/**
 * Attach a graphql-ws WebSocket server to an existing HTTP server.
 * Requires peer dependencies: npm install graphql-ws ws
 *
 * The WS server upgrades connections on the same port as the HTTP server —
 * no extra port needed. Clients connect to ws://host:port/graphql.
 */
export async function startSubscriptionServer(
  gqlSchema: GraphQLSchema,
  httpServer: Server,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let useServer: (options: { schema: GraphQLSchema }, ws: any) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let WebSocketServer: new (opts: { server: Server }) => any;

  try {
    // Dynamic import — graphql-ws and ws are optional peer dependencies.
    // Using Function constructor to prevent TypeScript from trying to resolve
    // the module paths at compile time (avoids compile-time module resolution errors).
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const load = new Function('specifier', 'return import(specifier)') as
      (s: string) => Promise<Record<string, unknown>>;

    const [wsGql, wsLib] = await Promise.all([load('graphql-ws/use/ws'), load('ws')]);
    useServer = wsGql['useServer'] as typeof useServer;
    WebSocketServer = wsLib['WebSocketServer'] as typeof WebSocketServer;
  } catch {
    throw new Error(
      '[op-index] subscriptions: true requires peer dependencies — run: npm install graphql-ws ws',
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const wss = new WebSocketServer({ server: httpServer });
  useServer({ schema: gqlSchema }, wss);
}

// ---------------------------------------------------------------------------
// GraphiQL HTML (CDN-hosted, no extra files)
// ---------------------------------------------------------------------------

const GRAPHIQL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>op-index — GraphiQL</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
  <style>body { margin: 0; } #graphiql { height: 100vh; }</style>
</head>
<body>
  <div id="graphiql"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script>
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(React.createElement(GraphiQL, {
      fetcher: GraphiQL.createFetcher({ url: window.location.href }),
    }));
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export function startGraphQLServer(
  gqlSchema: GraphQLSchema,
  options: ServeOptions = {},
): { server: Server; url: string } {
  const port = options.port ?? 4000;
  const path = options.path ?? '/graphql';
  const maxDepth = options.maxQueryDepth ?? 12;
  const authToken = options.auth;
  const rl = options.rateLimit;
  const MAX_BODY = 1_000_000;                        // 1 MB request-body cap
  const hits = new Map<string, number[]>();         // per-IP timestamps (rate limit)

  const json = (res: ServerResponse, code: number, body: unknown): void => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost`);

    // CORS headers — allow any origin for local dev
    res.setHeader('Access-Control-Allow-Origin',  '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Health + metrics (operational endpoints).
    if (req.method === 'GET' && url.pathname === '/health') {
      const s = options.status?.() ?? {};
      const state = (s['health'] as { state?: string } | undefined)?.state;
      // Report NOT-ready (503) when the indexer can't make progress, so a load
      // balancer / k8s readiness probe drains it. `degraded` stays 200 (it is
      // still progressing). No health info at all ⇒ assume ok (back-compat).
      const unhealthy = state === 'stalled' || state === 'stopped' || state === 'draining';
      res.writeHead(unhealthy ? 503 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: state ?? 'ok', ...s }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(renderMetrics(options.status?.() ?? {}));
      return;
    }

    if (url.pathname !== path) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }

    // GraphiQL playground — GET /graphql
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(GRAPHIQL_HTML);
      return;
    }

    // GraphQL query — POST /graphql
    if (req.method === 'POST') {
      // Rate limit (per-IP sliding window).
      if (rl) {
        const ip = req.socket.remoteAddress ?? 'unknown';
        const now = Date.now();
        const arr = (hits.get(ip) ?? []).filter((t) => now - t < rl.windowMs);
        if (arr.length >= rl.max) { json(res, 429, { errors: [{ message: 'rate limit exceeded' }] }); return; }
        arr.push(now); hits.set(ip, arr);
      }
      // Auth (optional bearer token).
      if (authToken && req.headers['authorization'] !== `Bearer ${authToken}`) {
        json(res, 401, { errors: [{ message: 'unauthorized' }] }); return;
      }

      let body = '';
      let tooLarge = false;
      let responded = false;
      const reply = (code: number, payload: unknown): void => {
        if (responded) return;
        responded = true;
        json(res, code, payload);
      };
      // A client that aborts or resets mid-upload emits 'error' on the request/
      // socket; without a listener Node escalates it to an uncaughtException that
      // would take the whole server down — exactly the DoS this endpoint guards
      // against. Swallow it: the request is already over.
      req.on('error', () => { /* client aborted — ignore */ });
      res.on('error', () => { /* broken pipe — ignore */ });
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;                                             // already over the cap — drain & discard
        body += chunk.toString();
        if (body.length > MAX_BODY) {
          tooLarge = true; body = '';
          reply(413, { errors: [{ message: 'request body too large' }] }); // respond at once
          req.resume();                                                    // drain the rest cleanly (no reset)
        }
      });
      req.on('end', () => {
        if (tooLarge || responded) return;
        void (async () => {
          try {
            const { query, variables, operationName } = JSON.parse(body) as {
              query: string;
              variables?: Record<string, unknown>;
              operationName?: string;
            };
            // Depth limit (nesting DoS guard) — before execution.
            try {
              const depth = queryDepth(parse(query));
              if (depth > maxDepth) {
                reply(400, { errors: [{ message: `query depth ${depth} exceeds max ${maxDepth}` }] });
                return;
              }
            } catch { /* parse error — let graphql() produce the proper error below */ }
            if (responded) return;

            const result = await graphql({
              schema:         gqlSchema,
              source:         query,
              variableValues: variables,
              operationName,
            });
            reply(200, result);
          } catch (e) {
            reply(400, { errors: [{ message: String(e) }] });
          }
        })();
      });
      return;
    }

    res.writeHead(405);
    res.end('Method not allowed');
  });

  server.listen(port);
  return { server, url: `http://localhost:${port}${path}` };
}
