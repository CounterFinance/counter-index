# OpKit

Indexer framework for [OPNET](https://opnet.org) (Bitcoin L2). Define a schema, write event handlers, query indexed chain data.

OpKit is to OPNET what [Envio](https://envio.dev) / [The Graph](https://thegraph.com) is to EVM — but lighter, TypeScript-native, and built for OPNET's event model.

```
OPNET node ──→ opnet SDK (RPC) ──→ OpStream (scan + store) ──→ OpKit (index + query)
                                                                     ↓
                                                               Your app / dashboard
```

## Install

```bash
npm install @opnet-devs/opkit
```

## Quickstart

```ts
import { defineSchema, createIndexer } from '@opnet-devs/opkit';

// 1. Define your entities
const schema = defineSchema({
  Account: {
    address:  { type: 'string' },
    balance:  { type: 'bigint' },
    txCount:  { type: 'int' },
    lastSeen: { type: 'int' },
  },
  Transfer: {
    txHash: { type: 'string' },
    from:   { type: 'string' },
    to:     { type: 'string' },
    value:  { type: 'bigint' },
    block:  { type: 'int' },
  },
});

// 2. Create an indexer and register handlers
const indexer = createIndexer({ schema });

indexer.on('Transferred', (event, ctx) => {
  const { from, to, value } = event.decoded!;

  ctx.store.set('Transfer', event.txHash, {
    txHash: event.txHash,
    from, to, value: BigInt(value as string),
    block: event.blockNumber,
  });

  // Update sender account
  const sender = ctx.store.get('Account', from as string);
  if (sender) {
    ctx.store.update('Account', from as string, {
      balance: (sender.balance as bigint) - BigInt(value as string),
      txCount: (sender.txCount as number) + 1,
      lastSeen: event.blockNumber,
    });
  }
});

// 3. Feed events (from OpStream, RPC, WebSocket, or any source)
indexer.processEvents(events);

// 4. Query
const accounts = indexer.store.list('Account');
const whales = indexer.store.find('Account', (a) => (a.balance as bigint) > 100_000_000n);
const tx = indexer.store.get('Transfer', txHash);

console.log(indexer.stats);
// { eventsProcessed: 1842, eventsDecoded: 1654, eventsSkipped: 188, lastBlock: 9400 }
```

## How It Works

### Schema (`defineSchema`)

Declare your indexed entities as typed fields:

```ts
const schema = defineSchema({
  Token: {
    address:     { type: 'string' },
    symbol:      { type: 'string' },
    decimals:    { type: 'int' },
    totalSupply: { type: 'bigint' },
  },
});
```

Field types: `string`, `int`, `float`, `bigint`, `boolean`, `bytes`.

### Handlers (`indexer.on`)

Register functions that run when a specific event is seen. Handlers get the decoded event and a context with the entity store.

```ts
indexer.on('Transferred', (event, ctx) => {
  // track balances, update accounts, etc.
});

indexer.on('*', (event, ctx) => {
  // wildcard — runs for every event
});
```

### Store (`ctx.store`)

CRUD interface to your indexed entities:

```ts
ctx.store.set('Account', id, data);        // insert or overwrite
ctx.store.get('Account', id);              // lookup by id
ctx.store.update('Account', id, partial);  // merge fields
ctx.store.delete('Account', id);           // remove
ctx.store.list('Account');                 // all entities
ctx.store.count('Account');                // count
ctx.store.find('Account', predicate);      // filter
```

### Event Source (bring your own)

OpKit is source-agnostic. Feed it events from anywhere:

```ts
// From OpStream's SQLite DB
const events = db.prepare('SELECT * FROM events WHERE block > ?').all(lastBlock);
indexer.processEvents(events);

// From opnet SDK WebSocket
ws.on('event', (raw) => {
  indexer.processRawEvent(raw.eventName, raw.data, {
    blockNumber: raw.block,
    txHash: raw.txHash,
    contractAddress: raw.contract,
  });
});
```

### Built-in Event Decoders

OpKit ships with binary decoders for OPNET's big-endian event format so `processRawEvent()` works out of the box:

`Transferred`, `Synced`, `LiquidityListed`, `LiquidityAdded`, `PoolCreated`, `SwapExecuted`, `Swapped`

Register your own:

```ts
import { registerDecoder } from '@opnet-devs/opkit';

registerDecoder('MyEvent', (rawBytes) => {
  // parse raw bytes, return object or null
});
```

## Project Structure

```
src/
  schema.ts          # defineSchema() — entity definition DSL
  store.ts           # createStore() — in-memory entity store
  handler.ts         # HandlerRegistry — event handler dispatch
  indexer.ts         # createIndexer() — main orchestrator
  types.ts           # DecodedEvent type
  decoders/
    eventDecoders.ts # Built-in OPNET binary event decoders
tests/
  schema.test.ts
  store.test.ts
  indexer.test.ts    # Full pipeline integration test
```

## Development

```bash
npm install
npm test            # vitest
npm run test:watch  # watch mode
```

Requires Node.js >= 22. Zero runtime dependencies.

## Roadmap

- [ ] SQLite-backed persistent store
- [ ] Reorg handling (rollback entity state on chain reorgs)
- [ ] Block handlers (run logic every block, not just on events)
- [ ] Backfill orchestration (replay historical blocks through handlers)
- [ ] GraphQL query layer
- [ ] CLI scaffolding (`opkit init`)
- [ ] More built-in decoders (OP-20 Approval, OP-721, and more)

## License

MIT
