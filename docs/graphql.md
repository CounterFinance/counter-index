# GraphQL API

counter-index auto-generates a complete GraphQL schema from your `defineSchema()` entities. No SDL file
to write, no codegen to run, no resolvers to wire up manually. Call `indexer.serve()` and your
API is live.

## Starting the server

```ts
const handle = await indexer.serve({ port: 4000 });
// GET  http://localhost:4000/graphql  → GraphiQL playground
// POST http://localhost:4000/graphql  → execute queries
```

`serve()` returns a `ServeHandle`:

```ts
interface ServeHandle {
  url:  string;           // e.g. 'http://localhost:4000/graphql'
  stop(): Promise<void>;  // graceful shutdown
}
```

Always `await handle.stop()` before your process exits to drain in-flight requests cleanly.

### Options

```ts
interface ServeOptions {
  port?:          number;  // Default: 4000
  path?:          string;  // Default: '/graphql'
  subscriptions?: boolean; // Enable WebSocket subscriptions. Default: false
}
```

---

## GraphiQL playground

Opening `GET /graphql` in a browser loads GraphiQL — a full in-browser IDE with:

- Schema explorer sidebar (all entities, fields, and filter arguments)
- Query editor with syntax highlighting and autocomplete
- Variables and headers panels
- Response viewer
- Query history

It is served from the unpkg CDN (React 18 + GraphiQL 3) — no extra files, no build step.

---

## Generated queries

For every entity in your schema, counter-index generates two queries.

### Singular — fetch by id

```graphql
pool(id: "0xabc...") {
  id
  address
  token0
  reserve0   # returned as a decimal string — BigInt scalar
  active
}
```

Returns the entity or `null` if not found.

### Plural — Connection with pagination

```graphql
pools(
  where:          { token0: "WBTC", reserve0_gt: "500000", active: true }
  orderBy:        reserve0
  orderDirection: desc
  first:          20
  after:          "cG9vbC0y"   # cursor from a previous pageInfo.endCursor
) {
  items {
    id address token0 token1 reserve0 reserve1
  }
  pageInfo {
    hasNextPage
    endCursor
  }
  totalCount
}
```

The plural query name is the entity name lowercased with an `s` suffix: `Pool` → `pools`,
`Transfer` → `transfers`, `LiquidityPosition` → `liquidityPositions`.

---

## Cursor pagination

Plural queries use cursor-based pagination — more stable than offset pagination because inserted
or deleted records between pages do not shift earlier pages.

### How it works

1. Apply `where` filters → filtered list
2. Sort by `orderBy` / `orderDirection` → deterministic order (ties broken by `id`)
3. If `after` cursor provided → find that record in the list, slice everything after it
4. Take `first` items from the remaining list
5. Return `items`, `pageInfo`, and `totalCount`

### Walking pages

```graphql
# Page 1 — no cursor
query Page1 {
  pools(orderBy: id, orderDirection: asc, first: 10) {
    items { id address }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}

# Page 2 — pass endCursor from page 1
query Page2 {
  pools(orderBy: id, orderDirection: asc, first: 10, after: "<endCursor from page 1>") {
    items { id address }
    pageInfo { hasNextPage endCursor }
    totalCount
  }
}
```

`pageInfo.hasNextPage: false` means you have seen all matching records.
`totalCount` is the count of the full filtered set — it does not change as you page through.
`endCursor` is `null` when the returned page is empty.

### Cursor format

Cursors are opaque base64-encoded strings. Do not parse or construct them manually — always read
`endCursor` from `pageInfo` and pass it verbatim to the next `after` argument.

---

## Filtering — `where` argument

Every field in your schema gets a set of filter operators based on its type.

### String and bytes fields

| Operator | Example | Matches |
|---|---|---|
| (exact) | `token0: "WBTC"` | exactly `"WBTC"` |
| `_not` | `token0_not: "WBTC"` | anything except `"WBTC"` |
| `_contains` | `address_contains: "abc"` | contains substring |
| `_starts_with` | `address_starts_with: "0x"` | starts with prefix |
| `_ends_with` | `address_ends_with: "ff"` | ends with suffix |

### Numeric fields — `int`, `float`, `bigint`

| Operator | Example | Matches |
|---|---|---|
| (exact) | `feeBps: 30` | exactly `30` |
| `_not` | `feeBps_not: 30` | anything except `30` |
| `_gt` | `reserve0_gt: "1000000"` | greater than |
| `_lt` | `reserve0_lt: "1000000"` | less than |
| `_gte` | `reserve0_gte: "1000000"` | greater than or equal |
| `_lte` | `reserve0_lte: "1000000"` | less than or equal |

`bigint` filter values must be passed as quoted strings: `reserve0_gt: "1000000000000000000"`.

### Boolean fields

| Operator | Example |
|---|---|
| (exact) | `active: true` |
| `_not` | `active_not: true` |

### The `id` field

The `id` field always supports string operators — exact, `_not`, `_contains`, `_starts_with`,
`_ends_with` — regardless of entity type.

### Combining filters

All conditions in a `where` clause are combined with `AND`:

```graphql
pools(where: { token0: "WBTC", feeBps_lte: 30, active: true }) { items { id } }
```

---

## Ordering

```graphql
pools(orderBy: reserve0, orderDirection: desc) { items { id reserve0 } }
```

`orderBy` accepts any field name from the entity, plus `id`. `orderDirection` is `asc` (default)
or `desc`.

Ordering is **stable** — when two records have the same value for the `orderBy` field, they are
further sorted by `id` in ascending order. This guarantees that cursors are always deterministic,
even across pages.

---

## BigInt scalar

OPNET deals in 256-bit integers. counter-index exposes them as a custom `BigInt` scalar — serialised as
decimal strings over the wire so they survive JSON without precision loss.

```graphql
{ pool(id: "...") { reserve0 } }
# → { "data": { "pool": { "reserve0": "1000000000000000000" } } }
```

Pass BigInt values as **quoted strings** in filter arguments:

```graphql
pools(where: { reserve0_gt: "500000000000000000" }) { items { id } }
```

---

## Subscriptions

WebSocket subscriptions push updates to connected clients in real time, without polling. They are
opt-in — enabling them adds `graphql-ws` and `ws` as required peer dependencies.

### Setup

```bash
npm install graphql-ws ws
```

```ts
const handle = await indexer.serve({ port: 4000, subscriptions: true });
// HTTP:  http://localhost:4000/graphql
// WS:    ws://localhost:4000/graphql
```

The WebSocket server shares the same port as the HTTP server — no extra port to open or proxy.

### Available subscriptions

One subscription is generated per entity, named `<entityName>Updated`:

```graphql
subscription {
  poolUpdated {
    id
    address
    reserve0
    reserve1
  }
}
```

`poolUpdated` fires whenever `store.set('Pool', ...)` or `store.update('Pool', ...)` is called
— including from your event handlers during live indexing. It does **not** fire on
`store.delete()`.

### Connecting from a client

Any `graphql-ws` compatible client works. With `graphql-ws` on the frontend:

```ts
import { createClient } from 'graphql-ws';

const client = createClient({ url: 'ws://localhost:4000/graphql' });

const unsub = client.subscribe(
  { query: `subscription { poolUpdated { id reserve0 reserve1 } }` },
  {
    next: ({ data }) => console.log('update:', data?.poolUpdated),
    error: console.error,
    complete: () => console.log('subscription ended'),
  },
);

// Stop when done
unsub();
```

With Apollo Client:

```ts
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';

const wsLink = new GraphQLWsLink(
  createClient({ url: 'ws://localhost:4000/graphql' }),
);
```

### Subscription behaviour

- Multiple concurrent subscribers all receive the same events independently.
- Each subscriber's cleanup (unsubscribing, closing the tab) is handled automatically.
- The subscription resolver filters strictly by entity — `poolUpdated` never fires for `Token`
  writes, and vice versa.
- If the server restarts, clients must reconnect. `graphql-ws` handles automatic reconnection
  with exponential backoff.

---

## CORS

The server responds with permissive CORS headers by default, allowing requests from any origin:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Content-Type
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

This is intentional for local development. For production deployments behind a reverse proxy
(nginx, Caddy, Cloudflare), configure CORS at the proxy layer and restrict origins there.
