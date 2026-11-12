# Serving-scale read path

GraphQL is op-index's default read API, but GraphQL-over-POST can't be cached by
a CDN (POST is never cached) and needs a WebSocket for live data. For a
read-heavy indexer behind an edge cache, that's the scaling cliff. `serve()` can
mount three extra read surfaces — all on the **same SQL pushdown and keyset
cursors** as GraphQL (`store.query` / `store.countWhere`, field names validated
against the schema, values bound as parameters — no identifier interpolation),
so a cursor from one surface is valid on the others. No new runtime dependency:
they ride the same built-in `http` server.

```ts
const handle = await indexer.serve({
  port: 4000,
  readPath: {
    rest: true,                       // GET  /v1/:entity[/:id]   (cacheable)
    sql:  true,                       // POST /sql                (structured query)
    live: true,                       // GET  /live?entity=…      (SSE)
    maxPageSize: 1000,                // shared cap on rows per read
    auth: process.env.READ_TOKEN,     // optional bearer on every read endpoint
  },
});
```

`readPath` inherits the GraphQL endpoint's `auth` token and `maxPageSize` unless
it overrides them. All three surfaces are **off by default**.

## REST projection — `GET /v1/:entity[/:id]`

Cacheable list + single-record reads. Query string: any `field` or `field_op`
filter (`amount_gte`, `holder_contains`, `id_in=a,b`), plus `orderBy`,
`orderDirection` (`asc`/`desc`), `first`, `after` (cursor), `select` (comma list).

```
GET /v1/Balance?amount_gte=100&orderBy=amount&orderDirection=desc&first=50
GET /v1/Balance/0xabc…                      # single record by id
```

Response:

```json
{ "data": { "nodes": [ … ], "pageInfo": { "hasNextPage": true, "endCursor": "…" }, "totalCount": 123 } }
```

Caching: responses carry `Cache-Control: public, s-maxage=<maxAge>,
stale-while-revalidate=<swr>` (defaults 5s / 30s — tune via
`rest: { maxAge, staleWhileRevalidate }`) and a weak `ETag`; a conditional
`If-None-Match` request returns `304`. `s-maxage` targets shared/CDN caches while
leaving browsers conservative. When `auth` is set the response is
`private, no-store` instead — a bearer-gated read must never land in a shared
cache. Mount prefix defaults to `/v1` (`rest: { base: '/api' }`).

## SQL-over-HTTP — `POST /sql`

A typed, allow-listed query for the full filter object a REST query-string can't
express. **Not raw SQL** — a structured request compiled through the same
pushdown, so there is no injection surface.

```
POST /sql
{ "entity": "Balance", "where": { "amount_gte": 200, "holder_starts_with": "0x" },
  "orderBy": "amount", "orderDirection": "desc", "first": 100, "after": "<cursor>",
  "select": ["holder", "amount"] }
```

Returns the same `{ data: { nodes, pageInfo, totalCount } }` shape, `Cache-Control:
no-store`. Unknown entity → `404`, unknown filter field → `400` (the allow-list
rejects it), oversized body → `413`.

## Live queries (SSE) — `GET /live?entity=…`

A plain-HTTP `text/event-stream` of store changes matching an entity + optional
filters — proxies and load balancers pass it through unchanged (no WebSocket
upgrade). Same filter syntax as REST.

```
GET /live?entity=Balance&amount_gte=1000
Accept: text/event-stream

event: open
data: {"entity":"Balance"}

event: change
data: {"entity":"Balance","id":"0xabc…","operation":"set","record":{…}}
```

`set`/`update` events are filtered server-side (only matching records stream);
`delete` events always stream so clients can drop the row. A `: ping` heartbeat
every 15s keeps intermediaries from closing the connection. Filtering here is
evaluated in JS against the changed record (the record is handed to the stream by
the store, not re-queried), with the same operator semantics as the SQL path.

## Which surface?

| Need | Use |
|---|---|
| Hot, repeated reads behind a CDN | **REST** (edge-cacheable + ETag) |
| Rich ad-hoc filters, one round trip | **SQL-over-HTTP** or GraphQL |
| Nested/related entities in one request | **GraphQL** |
| Push updates as they're indexed | **SSE** (`/live`) or GraphQL subscriptions (WS) |
