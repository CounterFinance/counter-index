/**
 * Live reorg dogfood on anvil — proves the journal/rollback cycle on REAL chain
 * data (real logs, real block hashes journalled), not mocks.
 *
 *   npm run dogfood:reorg      # requires `anvil` on PATH
 *
 * Index transfers up to block t1 (snapshot balances), continue to t2, then
 * rollbackTo(t1): balances must equal the t1 snapshot. Re-sync t1->t2: balances
 * must equal the pre-rollback tip. If both hold, rollback + recovery are
 * chain-verified.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { openSqlite } from '../src/adapter.js';
import { EvmLogSource } from '../src/chains/evm/evmLogSource.js';
import type { Abi } from 'viem';

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(HERE, 'evm-fixture/out/MiniToken.sol/MiniToken.json'), 'utf8')) as {
  abi: readonly unknown[]; bytecode: { object: `0x${string}` };
};
const ABI = artifact.abi as never;
const RPC = 'http://127.0.0.1:8545';
const PK = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'] as const;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const anvil: ChildProcess = spawn('anvil', ['--port', '8545', '--silent'], { stdio: 'ignore' });
  let code = 0;
  try {
    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(100); } }
    const accts = PK.map((pk) => privateKeyToAccount(pk));
    const deployer = createWalletClient({ account: accts[0], chain: foundry, transport: http(RPC) });

    const dh = await deployer.deployContract({ abi: ABI, bytecode: artifact.bytecode.object, args: [1_000_000n] });
    const token = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
    const send = async (to: string, v: bigint): Promise<number> => {
      const h = await deployer.writeContract({ address: token, abi: ABI, functionName: 'transfer', args: [to, v] });
      const r = await pub.waitForTransactionReceipt({ hash: h });
      return Number(r.blockNumber);
    };
    const t1 = await send(accts[1].address, 100n);   // deployer -> B 100
    const t2 = await send(accts[2].address, 50n);    // deployer -> C 50

    const schema = defineSchema({ Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } } });
    const source = new EvmLogSource({ chainId: foundry.id, network: 'anvil', abi: ABI as unknown as Abi, client: pub, addresses: [token] });
    const indexer = await createIndexer({ schema, sink: openSqlite(':memory:'), source, reorg: { finalityDepth: 100 } });
    indexer.on('Transfer', async (event, ctx) => {
      const d = event.decoded!; const to = (d['to'] as string).toLowerCase(), from = (d['from'] as string).toLowerCase(), value = BigInt(d['value'] as bigint);
      for (const [h, delta] of [[to, value], [from, -value]] as const) {
        const cur = await ctx.store.get('Balance', h);
        await ctx.store.set('Balance', h, { holder: h, amount: (cur ? BigInt(cur.amount as bigint) : 0n) + delta });
      }
    });

    const bal = async (): Promise<Record<string, string>> => {
      const rows = await indexer.store.list('Balance');
      // Canonicalise key order — row iteration order is not part of the state, so
      // the snapshot comparison must be order-independent.
      const entries = rows.map((r) => [r.holder as string, String(r.amount)] as const).sort((a, b) => a[0].localeCompare(b[0]));
      return Object.fromEntries(entries);
    };

    await indexer.sync(0, t1);
    const snapAtT1 = JSON.stringify(await bal());
    await indexer.sync(t1 + 1, t2);
    const snapAtTip = JSON.stringify(await bal());

    await indexer.rollbackTo(t1, foundry.id);
    const afterRollback = JSON.stringify(await bal());

    await indexer.sync(t1 + 1, t2);
    const afterResync = JSON.stringify(await bal());

    const rollbackOk = afterRollback === snapAtT1;
    const recoverOk = afterResync === snapAtTip;
    console.log(`  snapshot@t1    ${snapAtT1}`);
    console.log(`  after rollback ${afterRollback}  ${rollbackOk ? 'OK (== t1 snapshot)' : 'MISMATCH'}`);
    console.log(`  after re-sync  ${afterResync}  ${recoverOk ? 'OK (== tip)' : 'MISMATCH'}`);
    if (rollbackOk && recoverOk) console.log('[dogfood:reorg] PASS — rollback + recovery chain-verified on real anvil data.');
    else { console.error('[dogfood:reorg] FAIL'); code = 1; }
  } catch (err) { console.error('[dogfood:reorg] ERROR', err); code = 1; }
  finally { anvil.kill('SIGTERM'); }
  process.exit(code);
}

void main();
