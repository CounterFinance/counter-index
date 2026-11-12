# Adding a new chain

op-index's core is chain-neutral: the indexer, store, schema, typed store and
GraphQL never know which chain they're on. A new chain is an **adapter** under
`src/chains/<chain>/` that produces `ChainEvent`s — the core doesn't change. (EVM
was added this way with zero core edits; use it as the reference.)

You implement **two things** — a `Decoder` and an `EventSource` — plus a small
meta type, and you wire them to the shared test suites.

## 1. Chain-specific metadata — `src/chains/<chain>/types.ts`

Core only knows `ChainMeta` has a `kind`. Define your concrete shape:

```ts
import type { ChainMeta } from '../../types.js';
export interface MyChainMeta extends ChainMeta {
  kind: 'mychain';
  from?: string;
  // …whatever your chain's tx/log context carries (gas, fee, flags, …)
}
```

Handlers narrow with `event.chainMeta?.kind === 'mychain'` and cast.

## 2. Decoder — `src/chains/<chain>/decoder.ts`

Implement the core `Decoder` (`src/decoder.ts`): turn a raw log into
`{ eventName, decoded }`, keyed however your chain identifies events (OPNET keys
by the on-chain event name; EVM keys by `topics[0]` + ABI; Solana would key by an
Anchor discriminator).

```ts
import type { Decoder, DecodeInput, DecodeResult } from '../../decoder.js';
export class MyDecoder implements Decoder {
  decode(input: DecodeInput): DecodeResult | null { /* … */ }
  decodableEvents(): string[] { /* … */ }
  canDecode(eventName: string): boolean { /* … */ }
}
```

**Must** return `null` only when the log can't be named, and **never throw** on
malformed input (return `{ eventName, decoded: null }`).

## 3. Source — `src/chains/<chain>/logSource.ts`

Implement the core `EventSource` (`src/source.ts`): `queryStream(from, to, filters)`
for backfill and `subscribe(from, onEvent)` for live, both producing `ChainEvent`:

```ts
return {
  chainId, network,                       // chain identity (real id where one exists)
  blockNumber, blockHash, parentHash,     // blockHash + parentHash enable reorg detection
  blockTimestamp,                         // populate it — time-series handlers need it
  txHash, txIndex, logIndex,
  contractAddress, eventName, eventRaw, decoded, dataLength,
  txEvents,                               // Map<contractAddress, {type,raw}[]> for router correlation
  chainMeta: { kind: 'mychain', /* … */ },
};
```

Optional: implement `DynamicSource` (`addAddress`) so `indexer.onFactory(...)` can
start watching factory-deployed contracts at runtime.

Heavy peer deps (an RPC client, an ABI lib) go in `peerDependenciesMeta` as
`optional` (like `viem`/`ws`), imported only inside the adapter — core stays
dependency-light.

## 4. Wire it up

- `src/chains/<chain>/index.ts` — barrel exporting the source, decoder, meta type.
- Re-export from `src/index.ts` under an "EVM/<chain> adapter" block.

## 5. Tests

- **Decoder contract**: run the shared suite — `runDecoderContract('MyDecoder',
  () => new MyDecoder(abi), cases)` (`tests/support/decoderContract.ts`). Every
  adapter passes the same behavioural contract.
- **Source unit test**: drive `queryStream`/`subscribe` over a *mock transport*
  (see `tests/evmLogSource.test.ts`) — assert the log→ChainEvent mapping,
  chunking, filters, `txEvents`, and `blockTimestamp`.
- **Live devnet dogfood**: deploy a contract, emit events, index, and assert
  derived state against on-chain reads (see `dogfood/evm-anvil.ts`).

---

## Checklist

- [ ] `src/chains/<chain>/types.ts` — `MyChainMeta extends ChainMeta` with a unique `kind`
- [ ] `Decoder` implemented; **never throws** on bad input; `null` only when unnameable
- [ ] `EventSource` implemented: `queryStream` + `subscribe`
- [ ] `ChainEvent` fully populated: `chainId`, `network`, `blockHash` (+ `parentHash` for reorgs), **`blockTimestamp`**, `txEvents`, `chainMeta`
- [ ] Real `chainId` where the chain has one (never a reserved/0 value)
- [ ] `DynamicSource.addAddress` if the chain has factories
- [ ] Heavy deps declared as **optional peer deps**, imported only in the adapter
- [ ] Barrel + re-export from `src/index.ts`
- [ ] Passes the shared **Decoder contract** suite
- [ ] Source **unit test** over a mock transport
- [ ] **Live devnet** dogfood asserting derived state vs on-chain reads
- [ ] Core unchanged — `grep -r "mychain\|<dep>" src --include=*.ts | grep -v src/chains/` is empty
- [ ] `tsc`, `lint`, `test`, `typecheck` green; coverage not regressed
- [ ] If multichain: entities get the `chainId` dimension for free via `{ multichain: true }`
