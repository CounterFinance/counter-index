/**
 * Dogfood: Solana adapter (M20). Decode Anchor events (discriminator + Borsh)
 * from synthetic program logs, index them through the SAME createIndexer the EVM
 * and OPNET adapters use, and query the result over GraphQL. Proves the
 * chain-neutral thesis on a third, non-EVM chain — no network.
 *
 *   npx tsx dogfood/solana.ts
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import {
  SolanaDecoder, anchorEventDiscriminator, SolanaLogSource, BorshWriter, base58Encode, type SolanaTx,
} from '../src/chains/solana/index.js';

const schema = defineSchema({ Holder: { balance: { type: 'bigint' } } });
const decoder = new SolanaDecoder([
  { name: 'TransferEvent', fields: [{ name: 'from', type: 'pubkey' }, { name: 'to', type: 'pubkey' }, { name: 'amount', type: 'u64' }] },
]);

const PROGRAM = 'Tok3nXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const transferLog = (from: number, to: number, amount: bigint): string => {
  const raw = new BorshWriter().write('pubkey', key(from)).write('pubkey', key(to)).write('u64', amount)
    .concat(anchorEventDiscriminator('TransferEvent'));
  return `Program data: ${Buffer.from(raw).toString('base64')}`;
};

const fail = (m: string): never => { console.error(`[dogfood:solana] FAIL — ${m}`); process.exit(1); };

async function main(): Promise<void> {
  // Synthetic mint → alice(1) → bob(2) → alice flows across three slots.
  const txs: SolanaTx[] = [
    { slot: 10, signature: 's1', blockTime: 1_700_000_000, logs: [transferLog(0, 1, 1_000n)] },
    { slot: 11, signature: 's2', blockTime: 1_700_000_001, logs: [transferLog(1, 2, 400n)] },
    { slot: 12, signature: 's3', blockTime: 1_700_000_002, logs: [transferLog(2, 1, 150n)] },
  ];
  const source = new SolanaLogSource({
    chainId: 900, network: 'solana-mainnet', programId: PROGRAM, decoder,
    fetchSlots: async function* (from, to) { for (const t of txs) if (t.slot >= from && t.slot <= to) yield t; },
  });

  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source });
  indexer.on('TransferEvent', async (e, ctx) => {
    const d = e.decoded!;
    const amount = d['amount'] as bigint;
    for (const [who, delta] of [[d['to'], amount], [d['from'], -amount]] as const) {
      const cur = await ctx.store.get('Holder', who as string);
      await ctx.store.set('Holder', who as string, { balance: (cur ? (cur.balance as bigint) : 0n) + delta });
    }
  });

  await indexer.sync(10, 12, undefined, 12);

  const handle = await indexer.serve({ port: 47981 });
  try {
    const r = await fetch(handle.url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `{ holders(orderBy: balance, orderDirection: desc) { nodes { id balance } } }` }),
    });
    const j = await r.json() as { data: { holders: { nodes: Array<{ id: string; balance: string }> } } };
    const byId = Object.fromEntries(j.data.holders.nodes.map((n) => [n.id, BigInt(n.balance)]));

    const alice = base58Encode(key(1)), bob = base58Encode(key(2)), mint = base58Encode(key(0));
    if (byId[alice] !== 750n) fail(`alice expected 750, got ${byId[alice]}`);   // -? 1000 in, 400 out, 150 in
    if (byId[bob] !== 250n) fail(`bob expected 250, got ${byId[bob]}`);         // 400 in, 150 out
    if (byId[mint] !== -1000n) fail(`mint expected -1000, got ${byId[mint]}`);

    console.log(`  decoded 3 Anchor TransferEvents (discriminator + Borsh) over slots 10–12`);
    console.log(`  balances via GraphQL:  alice=${byId[alice]}  bob=${byId[bob]}  mint=${byId[mint]}`);
    console.log(`  same createIndexer + store + GraphQL as EVM/OPNET — chainMeta.kind = "solana"`);
    console.log(`[dogfood:solana] PASS — a non-EVM chain indexed through the chain-neutral core.`);
  } finally {
    await handle.stop();
  }
}

void main();
