/**
 * evm-portfolio — a tiny but complete counter-index app.
 *
 * Indexes ERC-20 Transfer logs from one or more token contracts into running
 * holder balances + a transfer log, and serves it over GraphQL. This is the
 * "one framework, many chains" proof: the same schema/handlers/GraphQL the OPNET
 * app used, now pointed at EVM via EvmLogSource — with a schema-typed store
 * (no casts in the handler).
 *
 * Reusable: `demo.ts` drives it live against an anvil devnet; point `rpcUrl` at
 * any EVM RPC (and set `tokens`) to index a real chain.
 */

import type { Abi, PublicClient } from 'viem';
import { createIndexer, type Indexer } from '../../src/indexer.js';
import { defineSchema } from '../../src/schema.js';
import { openSqlite } from '../../src/adapter.js';
import { EvmLogSource } from '../../src/chains/evm/evmLogSource.js';

export const ERC20_ABI = [
  {
    type: 'event', name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

export const portfolioSchema = defineSchema({
  // Running balance per (token, holder).
  TokenHolder: {
    token:     { type: 'string' },
    holder:    { type: 'string' },
    balance:   { type: 'bigint' },
    lastBlock: { type: 'int' },
  },
  // Every transfer, as an audit log.
  TokenTransfer: {
    token: { type: 'string' },
    from:  { type: 'string' },
    to:    { type: 'string' },
    value: { type: 'bigint' },
    block: { type: 'int' },
  },
});

const ZERO = '0x0000000000000000000000000000000000000000';

export interface PortfolioOptions {
  chainId: number;
  network: string;
  /** Token contract addresses to index. */
  tokens: string[];
  /** RPC URL, or pass a configured viem `client` instead. */
  rpcUrl?: string;
  client?: PublicClient;
  /** Sink DB path. Defaults to in-memory. */
  dbPath?: string;
}

export async function buildPortfolioIndexer(opts: PortfolioOptions): Promise<Indexer<typeof portfolioSchema.entities>> {
  const indexer = await createIndexer({
    schema: portfolioSchema,
    sink: openSqlite(opts.dbPath ?? ':memory:'),
    source: new EvmLogSource({
      chainId: opts.chainId,
      network: opts.network,
      abi: ERC20_ABI as unknown as Abi,
      rpcUrl: opts.rpcUrl,
      client: opts.client,
      addresses: opts.tokens,
    }),
  });

  indexer.on('Transfer', async (event, ctx) => {
    const d = event.decoded;
    if (!d) return;
    const token = event.contractAddress.toLowerCase();
    const from = (d['from'] as string).toLowerCase();
    const to = (d['to'] as string).toLowerCase();
    const value = BigInt(d['value'] as bigint);

    // Audit log — note: no casts, the store is typed by the schema.
    await ctx.store.set('TokenTransfer', `${event.txHash}-${event.logIndex}`, {
      token, from, to, value, block: event.blockNumber,
    });

    // Running balances. Mints/burns touch the zero address — skip it.
    for (const [holder, delta] of [[to, value], [from, -value]] as const) {
      if (holder === ZERO) continue;
      const id = `${token}:${holder}`;
      const current = await ctx.store.get('TokenHolder', id);
      await ctx.store.set('TokenHolder', id, {
        token, holder,
        balance: (current ? BigInt(current.balance as bigint) : 0n) + delta,
        lastBlock: event.blockNumber,
      });
    }
  });

  return indexer;
}
