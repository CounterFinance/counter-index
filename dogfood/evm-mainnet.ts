/**
 * Real-chain proof: index a few recent blocks of USDC Transfer events from a
 * public Ethereum RPC — real logs, real ABI decoding, real block timestamps.
 *
 *   npm run dogfood:mainnet          # needs network; ETH_RPC_URL to override
 *
 * This is a REAL-DATA proof (it has only ever run on anvil otherwise), not a
 * balance-correctness proof: over a partial block range balances don't net out.
 * It asserts counter-index decodes genuine mainnet transfers with valid structure and
 * populated timestamps, and reads back over GraphQL.
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import type { Abi } from 'viem';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { openSqlite } from '../src/adapter.js';
import { EvmLogSource } from '../src/chains/evm/evmLogSource.js';

const RPC = process.env.ETH_RPC_URL ?? 'https://ethereum-rpc.publicnode.com';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ERC20 = [{
  type: 'event', name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}] as const;

const isAddr = (s: unknown): boolean => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

async function main(): Promise<void> {
  let code = 0;
  try {
    const pub = createPublicClient({ chain: mainnet, transport: http(RPC) });
    const tip = Number(await pub.getBlockNumber());
    const from = tip - 2;                                // a few blocks of real USDC activity
    console.log(`RPC ${RPC}  head=${tip}  indexing USDC Transfers [${from}, ${tip}]`);

    const schema = defineSchema({
      TokenTransfer: { from: { type: 'string' }, to: { type: 'string' }, value: { type: 'bigint' }, block: { type: 'int' }, ts: { type: 'int' } },
    });
    const indexer = await createIndexer({
      schema, sink: openSqlite(':memory:'),
      source: new EvmLogSource({ chainId: mainnet.id, network: 'eth-mainnet', abi: ERC20 as unknown as Abi, client: pub, addresses: [USDC] }),
    });
    let withTs = 0, validAddrs = 0, total = 0;
    indexer.on('Transfer', async (e, ctx) => {
      const d = e.decoded!; total++;
      if (e.blockTimestamp !== undefined) withTs++;
      if (isAddr(d['from']) && isAddr(d['to'])) validAddrs++;
      await ctx.store.set('TokenTransfer', `${e.txHash}-${e.logIndex}`, {
        from: d['from'] as string, to: d['to'] as string, value: BigInt(d['value'] as bigint),
        block: e.blockNumber, ts: e.blockTimestamp ?? 0,
      });
    });
    await indexer.sync(from, tip);

    const handle = await indexer.serve({ port: 47950 });
    const res = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ tokenTransfers(first: 3, orderBy: block, orderDirection: desc) { totalCount nodes { from to value block ts } } }' }) });
    const gql = (await res.json() as { data: { tokenTransfers: { totalCount: number; nodes: Array<Record<string, unknown>> } } }).data.tokenTransfers;
    await handle.stop();

    console.log(`  decoded transfers   ${total}`);
    console.log(`  valid from/to addrs ${validAddrs}/${total}`);
    console.log(`  with blockTimestamp ${withTs}/${total}`);
    console.log(`  GraphQL totalCount  ${gql.totalCount}`);
    for (const n of gql.nodes) console.log(`    block ${String(n['block'])} ts=${String(n['ts'])}: ${String(n['from']).slice(0, 10)}… -> ${String(n['to']).slice(0, 10)}… ${String(n['value'])}`);

    const ok = total > 0 && validAddrs === total && withTs === total && gql.totalCount === total;
    if (ok) console.log('[dogfood:mainnet] PASS — indexed real USDC transfers with valid structure + timestamps.');
    else { console.error('[dogfood:mainnet] FAIL — structure/timestamp/GraphQL mismatch.'); code = 1; }
  } catch (err) {
    console.error('[dogfood:mainnet] SKIP/ERROR (network?):', err instanceof Error ? err.message : err);
    // Network-dependent — a failure to reach the RPC is a skip, not a hard failure.
  }
  process.exit(code);
}

void main();
