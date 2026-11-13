# Decoders

OPNET emits events as raw big-endian binary data. counter-index ships built-in decoders for the most
common OPNET protocol events, and lets you register your own for custom contracts.

When a decoder is registered for an event name, `event.decoded` in your handler will be a
populated object. When no decoder exists, `event.decoded` is `null` and the raw bytes are still
available in `event.eventRaw`.

## Built-in decoders

| Event | Protocol | Decoded fields |
|---|---|---|
| `Transferred` | OP-20 | `from: string`, `to: string`, `value: string` |
| `Approval` | OP-20 | `owner: string`, `spender: string`, `value: string` |
| `ApprovalForAll` | OP-721 | `owner: string`, `operator: string`, `approved: boolean` |
| `Synced` | Motoswap | `reserve0: string`, `reserve1: string` |
| `Swapped` | Motoswap | `sender: string`, `amount0In: string`, `amount1In: string`, `amount0Out: string`, `amount1Out: string`, `to: string` |
| `LiquidityAdded` | Motoswap | `sender: string`, `amount0: string`, `amount1: string` |
| `PoolCreated` | Motoswap Factory | `token0: string`, `token1: string` |
| `LiquidityListed` | NativeSwap | `totalLiquidity: string`, `provider: string` |
| `SwapExecuted` | NativeSwap | `buyer: string`, `amountIn: string`, `amountOut: string` |

All numeric fields (`value`, `reserve0`, `amount0In`, etc.) are returned as **decimal strings**
because they represent 256-bit unsigned integers. Cast them with `BigInt()` in your handler:

```ts
indexer.on('Transferred', async (event, ctx) => {
  const value = BigInt(event.decoded!['value'] as string);
  // ...
});
```

Address fields (`from`, `to`, `sender`, etc.) are returned as lowercase hex strings.

## Registering a custom decoder

```ts
import { registerDecoder } from '@counterfinance/counter-index';

registerDecoder('MyCustomEvent', (rawBytes: Uint8Array) => {
  if (rawBytes.length < 64) return null; // guard against malformed data

  // Read a U256 from offset 0 (big-endian, 32 bytes)
  const amountBytes = rawBytes.slice(0, 32);
  const amount = BigInt('0x' + Buffer.from(amountBytes).toString('hex'));

  // Read an address from offset 32 (last 20 bytes of a 32-byte word)
  const addrBytes = rawBytes.slice(44, 64); // skip leading 12 zero bytes
  const address = '0x' + Buffer.from(addrBytes).toString('hex');

  return {
    amount: amount.toString(), // return as decimal string, consistent with built-ins
    address,
  };
});
```

Return `null` if the bytes are malformed or too short, counter-index will set `event.decoded = null`
and continue processing.

`registerDecoder` is global and takes effect immediately. Call it once at startup, before
`createIndexer()` or `indexer.sync()`.

## Reading the decoder registry

```ts
import { DECODER_REGISTRY } from '@counterfinance/counter-index';

// Map<eventName, decoder function>
console.log([...DECODER_REGISTRY.keys()]);
// ['Transferred', 'Approval', 'ApprovalForAll', 'Synced', ...]
```

## Handling unknown events

If you want to inspect all events including those without decoders, register a wildcard handler
and check `event.decoded`:

```ts
indexer.on('*', async (event) => {
  if (!event.decoded) {
    // Unknown event, raw bytes available in event.eventRaw
    console.log(`Unknown event: ${event.eventName} (${event.dataLength} bytes)`);
  }
});
```

## Binary format reference

OPNET events follow a big-endian ABI similar to Ethereum's, each value is padded to 32 bytes.
Reading the raw bytes:

```ts
function readU256(bytes: Uint8Array, offset: number): bigint {
  const slice = bytes.slice(offset, offset + 32);
  return BigInt('0x' + Buffer.from(slice).toString('hex'));
}

function readAddress(bytes: Uint8Array, offset: number): string {
  // Address is 20 bytes, right-aligned in a 32-byte word
  const slice = bytes.slice(offset + 12, offset + 32);
  return '0x' + Buffer.from(slice).toString('hex');
}

function readBool(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset + 31] !== 0;
}
```

Use these helpers in your `registerDecoder` callback for consistent, correct decoding.
