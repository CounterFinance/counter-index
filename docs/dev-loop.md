# Fast dev loop

Iterating on handlers is slow when every restart re-fetches the same blocks from
the chain. counter-index separates **fetching** (slow, networked) from
**processing** (fast, your handlers) with a persistent event cache: fetch a range
once, and every later run replays it from disk with zero calls to the source. Edit
a handler, restart, and a re-sync over an already-cached range hits the cache, not
the RPC.

## One command: `counter-index dev`

```bash
npx counter-index dev src/dev.ts
```

Runs your entry under `tsx watch`, restarting on every save, with the dev event
cache switched on (it sets `COUNTERINDEX_DEV=1` and points `COUNTERINDEX_DEV_ENTRY`
at your file). There is no in-process hot-module-replacement: it is a full
restart, made cheap by two things, the cache (no re-fetch) and checkpoint resume
(no re-processing when nothing changed). A full restart is simpler and more
reliable than HMR, and once fetching and re-processing are off the table the
restart cost is a Node boot, not a chain sync.

Your entry opts into the cache and resume with a few helpers:

```ts
// src/dev.ts
import {
  createIndexer, createCachedSource, openSqlite,
  devCachePath, devStatePath, devResumeFrom, devReady, devOnError,
} from '@counterfinance/counter-index';

const source = await createCachedSource(mySource, { path: devCachePath() });
const indexer = await createIndexer({
  schema, source, sink: openSqlite(devStatePath()), onError: devOnError,
});
indexer.on('Transfer', async (e, ctx) => { /* edit me and save */ });

const { from, resumed } = await devResumeFrom(indexer.store, FROM, TO);
await indexer.sync(from, TO);
await indexer.serve({ port: 4000 });
devReady(resumed ? 'resumed from checkpoint' : 'full replay');
```

`devReady()` prints a clean `⚡ counter-index reloaded in Xms` line on each restart.

## Incremental replay

The derived-state sink (`devStatePath()`) is keyed by a fingerprint of your entry
file:

- **Restart without editing** -> same fingerprint -> same sink. `devResumeFrom`
  finds the checkpoint and resumes from `lastBlock + 1`, re-processing only the
  new blocks.
- **Edit a handler** -> the fingerprint changes -> a fresh sink -> `devResumeFrom`
  sees no checkpoint and replays the whole range, from the event cache, with no
  re-fetch.

So a no-op restart is near-instant even over a large cached range, and an actual
handler edit correctly rebuilds all derived state.

## Readable handler errors

Pass `devOnError` as the indexer's `onError` to render a handler throw as a short,
legible block instead of a wall of framework frames:

```
✖ handler error in "Swap" @ block 18000042 tx 0xabc…#3
  bad reserve math at block 18000042
    at <anonymous> (src/dev.ts:21:13)
```

A thrown handler still aborts its block (the per-block atomicity guarantee) and
the sync, so in the dev loop you read the error, fix it, and save to restart.

## Use it manually (without the CLI)

Wrap your source in `createCachedSource`, point the sink at a throwaway database,
and run your entry file under `tsx watch` so a save restarts the process:

```ts
// dev.ts
import { createIndexer, createCachedSource, EvmLogSource, openSqlite } from '@counterfinance/counter-index';
import { createPublicClient, http, parseAbi } from 'viem';
import { mainnet } from 'viem/chains';

const abi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const client = createPublicClient({ chain: mainnet, transport: http(process.env.RPC_URL) });

const source = await createCachedSource(
  new EvmLogSource({ chainId: mainnet.id, network: 'ethereum', abi, client, addresses: ['0x…'] }),
);

const indexer = await createIndexer({
  schema,
  source,
  sink: openSqlite(':memory:'),   // fresh derived state every run; the cache is what persists
});

indexer.on('Transfer', async (e, ctx) => { /* edit me and save */ });

await indexer.sync(18_000_000, 18_000_100);   // 1st run fetches + caches; later runs replay instantly
const handle = await indexer.serve({ port: 4000 });
```

```bash
npx tsx watch dev.ts
```

The first run pays the network cost once and writes the events to
`.counterindex-cache/events.db` (gitignored). Every save after that restarts the
process and replays those blocks from the cache, so the loop stays off the
network. Point the sink at `:memory:` (or a scratch file you drop each run) so the
new handler rebuilds state from scratch.

## API

```ts
const cache = await createCachedSource(innerSource, {
  path: '.counterindex-cache/events.db',   // cache file; default shown
  // adapter: openSqlite(':memory:'),       // or pass a pre-opened adapter (tests)
  onReplay: ({ from, to, gapsFetched, fromCache }) => { /* log cache hits */ },
});

await cache.clear();          // drop the cache, force a cold re-fetch next run
await cache.stats();          // { events, ranges, fetchedFromSource }
```

- **Filter-independent.** The cache stores the raw event stream and applies
  `queryStream` filters on read, so changing a contract or event-name filter
  between runs still replays from cache.
- **Gap-aware.** Syncing `[0, 5]` then `[0, 10]` fetches only `6..10`; the cached
  prefix is reused.
- **Live is not cached.** `subscribe()` passes straight through to the inner
  source, so going live still streams real new blocks.

## Caveats

This is a development aid, not production state. Point it at a throwaway cache
file. The cache replays exactly what the source yielded at fetch time, so if the
chain history you are indexing changes (a reorg of a range you cached), `clear()`
and re-fetch. The cache holds decoded events in full fidelity (bigints, raw bytes,
and sibling-event maps round-trip), but it is sized for focused dev ranges, not
whole-chain archives.
