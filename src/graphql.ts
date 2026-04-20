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
import type { Server } from 'node:http';
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
  Kind,
} from 'graphql';
import type { GraphQLFieldConfigMap, GraphQLInputFieldConfigMap, GraphQLEnumValueConfigMap } from 'graphql';
import type { Schema, SchemaDefinition, EntityDef, FieldType } from './schema.js';
import type { EntityStore } from './store.js';

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

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf8');
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
  for (const [fieldName, fieldDef] of Object.entries(def)) {
    const base = gqlInputType(fieldDef.type);
    for (const op of opsForType(fieldDef.type)) {
      fields[`${fieldName}${op}`] = { type: base };
    }
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

const KNOWN_OPS = ['not', 'gt', 'lt', 'gte', 'lte', 'contains', 'starts_with', 'ends_with'];

function parseFilterKey(key: string): { field: string; op: string } {
  for (const op of KNOWN_OPS) {
    if (key.endsWith(`_${op}`)) {
      return { field: key.slice(0, key.length - op.length - 1), op };
    }
  }
  return { field: key, op: 'eq' };
}

function compareValues(a: unknown, b: unknown, type: FieldType): number {
  if (type === 'bigint') {
    const ba = BigInt(String(a));
    const bb = BigInt(String(b));
    return ba < bb ? -1 : ba > bb ? 1 : 0;
  }
  if (type === 'int' || type === 'float') return Number(a) - Number(b);
  return String(a).localeCompare(String(b));
}

function matchesFilter(
  record: Record<string, unknown>,
  where: Record<string, unknown>,
  def: EntityDef,
): boolean {
  for (const [key, filterValue] of Object.entries(where)) {
    if (filterValue === null || filterValue === undefined) continue;
    // Filter values are always scalars from GraphQL input — safe to coerce.
    const fv = filterValue as string | number | boolean | bigint;
    const { field, op } = parseFilterKey(key);
    const fieldType: FieldType = field === 'id' ? 'string' : (def[field]?.type ?? 'string');
    const recordValue = record[field];
    switch (op) {
      case 'eq':
        if (String(recordValue) !== String(fv)) return false;
        break;
      case 'not':
        if (String(recordValue) === String(fv)) return false;
        break;
      case 'gt':
        if (compareValues(recordValue, fv, fieldType) <= 0) return false;
        break;
      case 'lt':
        if (compareValues(recordValue, fv, fieldType) >= 0) return false;
        break;
      case 'gte':
        if (compareValues(recordValue, fv, fieldType) < 0) return false;
        break;
      case 'lte':
        if (compareValues(recordValue, fv, fieldType) > 0) return false;
        break;
      case 'contains':
        if (!String(recordValue).includes(String(fv))) return false;
        break;
      case 'starts_with':
        if (!String(recordValue).startsWith(String(fv))) return false;
        break;
      case 'ends_with':
        if (!String(recordValue).endsWith(String(fv))) return false;
        break;
    }
  }
  return true;
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
  options: { subscriptions?: boolean } = {},
): GraphQLSchema {
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
        let records = await store.list(entityName);

        // Filter
        if (where && Object.keys(where).length > 0) {
          records = records.filter((r) => matchesFilter(r, where, def));
        }

        // Sort — stable: primary on orderBy field, secondary on id (tiebreaker)
        if (orderBy) {
          const dir = orderDirection === 'desc' ? -1 : 1;
          const fieldType: FieldType = orderBy === 'id' ? 'string' : (def[orderBy]?.type ?? 'string');
          records = [...records].sort((a, b) => {
            const primary = dir * compareValues(a[orderBy], b[orderBy], fieldType);
            if (primary !== 0) return primary;
            return String(a['id']).localeCompare(String(b['id']));
          });
        }

        const totalCount = records.length;

        // Cursor — find the position of the `after` item, then slice past it
        if (after) {
          const cursorId = decodeCursor(after);
          const idx = records.findIndex((r) => r['id'] === cursorId);
          if (idx !== -1) records = records.slice(idx + 1);
        }

        const hasNextPage = records.length > first;
        const page = records.slice(0, first);

        const endCursor = page.length > 0
          ? encodeCursor(String(page[page.length - 1]['id']))
          : null;

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
      const blocksBehind = cp.tipBlock != null ? cp.tipBlock - cp.lastBlock : null;
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
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        void (async () => {
          try {
            const { query, variables, operationName } = JSON.parse(body) as {
              query: string;
              variables?: Record<string, unknown>;
              operationName?: string;
            };
            const result = await graphql({
              schema:         gqlSchema,
              source:         query,
              variableValues: variables,
              operationName,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ errors: [{ message: String(e) }] }));
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
