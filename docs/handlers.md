# Handlers

Handlers are the heart of your indexer. They are async functions that op-index calls whenever a
matching on-chain event passes through the pipeline — whether from a historical backfill or a
live subscription. Your handler reads the decoded event, writes to the store, and returns.
op-index handles the rest.

## Event handlers — `indexer.on`

```ts
indexer.on(eventName: string, handler: EventHandler): void
```

Register a handler for a specific event name. Multiple handlers for the same event are supported
— they all fire, in registration order, each awaited before the next begins.

```ts
indexer.on('Transferred', async (event, ctx) => {
  const from  = event.decoded!['from']  as string;
  const to    = event.decoded!['to']    as string;
  const value = BigInt(event.decoded!['value'] as string);

  await ctx.store.set('Transfer', event.txHash, { from, to, value, block: event.blockNumber });
});
```

### Wildcard

Use `'*'` to receive every event regardless of name. Useful for analytics, debugging, or
catch-all logging:

```ts
indexer.on('*', async (event, ctx) => {
  console.log(`[${event.blockNumber}] ${event.eventName} from ${event.contractAddress}`);
});
```

Wildcard handlers run after named handlers for the same event.

### Multiple handlers for the same event

```ts
indexer.on('Synced', async (event, ctx) => {
  // handler A — update reserves
});

indexer.on('Synced', async (event, ctx) => {
  // handler B — emit a candle snapshot
  // guaranteed to run after handler A
});
```

## Block handlers — `indexer.onBlock`

Block handlers fire **once per block**, after all event handlers for that block have completed.
They are ideal for block-level aggregates — candle closes, reserve snapshots, any state that
should be computed after seeing all of a block's events.

```ts
indexer.onBlock(async ({ blockNumber, blockTimestamp, store }) => {
  const pools = await store.list('Pool');
  for (const pool of pools) {
    await store.set('Candle', `${pool['id']}:${blockNumber}`, {
      poolId:    pool['id'] as string,
      reserve0:  pool['reserve0'] as bigint,
      reserve1:  pool['reserve1'] as bigint,
      block:     blockNumber,
      timestamp: blockTimestamp ?? 0,
    });
  }
});
```

Block handlers only fire for blocks that contain at least one indexed event. Empty blocks (no
events matching your handlers) are not observed.

Multiple block handlers are supported and fire in registration order.

## The `DecodedEvent` object

Every handler receives the full event with all available chain context:

```ts
interface DecodedEvent {
  // Core identity
  blockNumber:     number;             // block height
  txHash:          string;             // transaction hash
  contractAddress: string;             // address of the emitting contract
  eventName:       string;             // e.g. 'Transferred', 'Synced'

  // Decoded payload
  decoded:         Record<string, unknown> | null;  // parsed event fields, or null if no decoder
  eventRaw:        Uint8Array;         // raw binary event data
  dataLength:      number;             // byte length of eventRaw

  // Transaction-level context (from OpStream joins or RPC tx fields)
  logIndex?:       number;             // position within the transaction
  txIndex?:        number;             // transaction index within the block
  blockTimestamp?: number;             // unix timestamp of the block
  fromAddress?:    string;             // address that submitted the transaction
  gasUsed?:        bigint;             // gas consumed by the transaction
  burnedBitcoin?:  bigint;             // bitcoin burned as fee
  failed?:         boolean;            // true if the transaction reverted
  revertReason?:   string;             // revert message, if failed
}
```

### Reading decoded fields

`event.decoded` is `null` when no decoder is registered for the event name. For built-in OPNET
events it is always populated. See [Decoders](./decoders.md) for details.

```ts
indexer.on('Swapped', async (event, ctx) => {
  if (!event.decoded) return; // guard against missing decoder

  const amountIn  = BigInt(event.decoded['amount0In'] as string);
  const amountOut = BigInt(event.decoded['amount1Out'] as string);
  // ...
});
```

## The `HandlerContext` object

The second argument to every event handler:

```ts
interface HandlerContext {
  store:          EntityStore;   // read/write your opindex_* tables
  block:          number;        // same as event.blockNumber
  blockTimestamp: number | undefined;
}
```

The block handler context is similar:

```ts
interface BlockContext {
  blockNumber:    number;
  blockTimestamp: number | undefined;
  store:          EntityStore;
}
```

## Processing guarantees

- Handlers are called **in block order** — events from block N always complete before block N+1
  begins, regardless of whether you're backfilling or live.
- Within a single block, events are processed in **log order** (ascending `logIndex`).
- If a handler throws, the error propagates to `sync()` / `subscribe()` and processing stops.
  There is no automatic retry — catching and logging errors inside your handler is your
  responsibility.

## Feeding events directly

For WebSocket push sources or testing, bypass the EventSource entirely:

```ts
// Raw bytes — op-index decodes them first
await indexer.processRawEvent('Transferred', rawBytes, {
  blockNumber:     50,
  txHash:          '0xtx',
  contractAddress: '0xtoken',
  blockTimestamp:  1712345678,
  fromAddress:     '0xsender',
});

// Pre-decoded — dispatch directly
await indexer.processEvent(event);

// Batch — preserves block ordering and fires block handlers at boundaries
await indexer.processEvents([event1, event2, event3]);
```
