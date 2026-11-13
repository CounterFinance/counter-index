# evm-portfolio

A complete counter-index app in ~120 lines: index ERC-20 `Transfer` logs from any EVM
chain into **running holder balances** + a **transfer log**, served over GraphQL.

It's the "one framework, many chains" proof, the same schema → handlers →
GraphQL shape the OPNET app used, now pointed at EVM through `EvmLogSource`, with
a schema-typed store (the handler writes rows with **no casts**).

## Run the live demo (anvil)

Requires [foundry](https://book.getfoundry.sh/) (`anvil`) on your PATH.

```bash
npm run example:evm
```

This spins an anvil devnet, deploys a token, performs transfers, indexes them,
and prints a live holder leaderboard + transfer log queried over GraphQL:

```
Deployed MiniToken at 0x5fbdb2315678afecb367f032d93f642f64180aa3
Performed 3 transfers.

── Holder leaderboard (GraphQL) ──
  0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266  999893
  0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc  47
  0x70997970c51812dc3a010c7d01b50e0d17dc79c8  60
...
```

## Point it at a real chain

```ts
import { buildPortfolioIndexer } from './portfolio.js';

const indexer = await buildPortfolioIndexer({
  chainId: 1,
  network: 'eth-mainnet',
  rpcUrl:  process.env.ETH_RPC_URL,          // any EVM RPC
  tokens:  ['0xA0b8...', '0xdAC1...'],            // token contracts to index
  dbPath:  './portfolio.db',                 // persist (omit for in-memory)
});
await indexer.sync(fromBlock, await currentBlock);
indexer.subscribe(fromBlock);                 // then follow the head
await indexer.serve({ port: 4000 });          // GraphQL at :4000/graphql
```

## GraphQL

```graphql
# Top holders of a token
{ tokenHolders(orderBy: balance, orderDirection: desc, first: 20) {
    nodes { token holder balance lastBlock }
} }

# A token's transfer log
{ tokenTransfers(where: { token: "0x..." }, orderBy: block, orderDirection: desc) {
    totalCount
    nodes { from to value block }
} }
```

## Multichain

Swap `buildPortfolioIndexer` for `createMultiIndexer` with a `{ multichain: true }`
schema and one `EvmLogSource` per chain to index several chains into one store and
filter by `chainId`: see `src/multiIndexer.ts` and `tests/multiIndexer.test.ts`.

## Extending to ERC-721

ERC-20 and ERC-721 share the `Transfer(address,address,uint256)` signature (same
`topics[0]`), but ERC-721 indexes the third arg (4 topics vs 3). Branch on
`event.chainMeta` (`kind: 'evm'`) `topics.length` to route NFT transfers to a
separate entity.
