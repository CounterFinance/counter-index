# Store

The store is op-index's async CRUD interface over your `opindex_*` tables. You access it inside
handlers via `ctx.store`, or from outside the handler pipeline via `indexer.store`. It abstracts
over SQLite and Postgres — the same API works for both.

## Reference

### `store.set(entity, id, data)`

Insert or overwrite an entity. If a record with the given `id` already exists it is replaced in
full. This is an upsert — there is no separate `insert`.

```ts
await ctx.store.set('Pool', contractAddress, {
  address:  contractAddress,
  token0:   '0xwbtc',
  token1:   '0xmoto',
  reserve0: 1_000_000n,
  reserve1: 500_000n,
  feeBps:   30,
  active:   true,
});
```

`id` is always a `string`. Choose something stable and unique — contract address, transaction
hash, composite key, etc. op-index does not generate ids for you.

### `store.get(entity, id)`

Fetch a single entity by id. Returns `undefined` if not found.

```ts
const pool = await ctx.store.get('Pool', contractAddress);
if (pool) {
  const reserve0 = pool['reserve0'] as bigint;
}
```

### `store.update(entity, id, partial)`

Merge partial fields into an existing entity. Only the fields you pass are changed — all others
are left untouched. **Throws** if the entity does not exist.

```ts
await ctx.store.update('Pool', contractAddress, {
  reserve0: newReserve0,
  reserve1: newReserve1,
});
```

This is the correct choice for event handlers that only touch a subset of fields (e.g. a `Synced`
event updates reserves but not token addresses).

> **Footgun: entities created before `FROM_BLOCK` do not exist in the store.**
>
> If you set `FROM_BLOCK` to a block after a contract was deployed, the `set()` that would have
> created the entity never runs — but later `update()` events for that entity still fire and will
> throw. Always guard with `store.get()` before calling `update()` on an entity that may predate
> your index start:
>
> ```ts
> indexer.on('MarketCapacityUpdated', async (event, ctx) => {
>   const market = await ctx.store.get('Market', marketId);
>   if (!market) return; // created before FROM_BLOCK — skip
>   await ctx.store.update('Market', marketId, { capacity: newCapacity });
> });
> ```

### `store.delete(entity, id)`

Remove an entity. No-op if it does not exist — never throws on missing records.

```ts
await ctx.store.delete('Pool', contractAddress);
```

### `store.list(entity)`

Return all entities of a given type. Order is not guaranteed — use the GraphQL API if you need
sorted or filtered results.

```ts
const pools = await ctx.store.list('Pool');
```

For large datasets, prefer the GraphQL layer's cursor-paginated `pools()` query over loading
everything into memory with `list()`.

### `store.count(entity)`

Return the number of entities of a given type.

```ts
const total = await ctx.store.count('Pool');
```

### `store.find(entity, predicate)`

Filter entities in JavaScript after a full table scan. Convenient for small datasets; avoid it
at production scale — the GraphQL `where` filters push predicate logic closer to the database.

```ts
const activePools = await ctx.store.find('Pool', (p) => p['active'] === true);
const whales      = await ctx.store.find('Account', (a) => (a['balance'] as bigint) > 1_000_000n);
```

### `store.onChange(handler)`

Subscribe to all store mutations. The handler fires synchronously after each write, with the
resulting record (or `null` for deletes). Returns an unsubscribe function.

```ts
const unsub = indexer.store.onChange((event) => {
  console.log(`${event.operation} ${event.entity} ${event.id}`);
  if (event.record) {
    console.log('new state:', event.record);
  }
});

// Stop listening
unsub();
```

`StoreChangeEvent` shape:

```ts
interface StoreChangeEvent {
  entity:    string;                         // e.g. 'Pool'
  id:        string;                         // entity id
  record:    Record<string, unknown> | null; // null when deleted
  operation: 'set' | 'update' | 'delete';
}
```

`onChange` is what powers GraphQL subscriptions internally — every `store.set()` and
`store.update()` in your handlers automatically pushes updates to any connected WebSocket clients
when `serve({ subscriptions: true })` is active.

## Type conventions

The store uses `Record<string, unknown>` for all data in and out. Cast field values explicitly:

```ts
const pool = await ctx.store.get('Pool', id);
const reserve0 = pool!['reserve0'] as bigint;
const feeBps   = pool!['feeBps']   as number;
const active   = pool!['active']   as boolean;
```

`bigint` fields are deserialised from SQL's decimal string representation back to native `BigInt`
on every read — you never need to call `BigInt()` on store results, only on values coming from
`event.decoded` (which arrives as strings from the decoder).

> **Postgres `int` fields return as strings at runtime.**
>
> node-postgres maps `BIGINT` columns to JavaScript strings (not numbers) to avoid precision loss.
> The `as number` cast above is compile-time only — at runtime `feeBps` is still the string `"30"`.
> This is harmless for most reads, but causes silent bugs when you do arithmetic and then store
> the result back:
>
> ```ts
> // ❌ "30" + 1 = "301"  (string concat)
> const next = (pool!['feeBps'] as number) + 1;
>
> // ✓ 30 + 1 = 31
> const next = Number(pool!['feeBps']) + 1;
> ```
>
> Use `Number()` whenever you read an `int` field and plan to do arithmetic on it.

## Accessing the store outside handlers

`indexer.store` exposes the same `EntityStore` interface after `createIndexer()` resolves:

```ts
const indexer = await createIndexer({ schema, sink, source });

// Read derived state from anywhere in your app
const count  = await indexer.store.count('Pool');
const latest = await indexer.store.find('Transfer', (t) => t['block'] === latestBlock);
```
