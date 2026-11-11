/**
 * Live demo of evm-portfolio against an anvil devnet.
 *
 *   npm run example:evm      # requires `anvil` on PATH (foundry)
 *
 * Spins anvil, deploys MiniToken, performs transfers, indexes them with the
 * portfolio app, serves GraphQL, and runs live queries against it — printing a
 * real holder leaderboard + transfer log sourced entirely from on-chain events.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { buildPortfolioIndexer } from './portfolio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(
  readFileSync(join(HERE, '../../dogfood/evm-fixture/out/MiniToken.sol/MiniToken.json'), 'utf8'),
) as { abi: readonly unknown[]; bytecode: { object: `0x${string}` } };
const ABI = artifact.abi as never;
const RPC = 'http://127.0.0.1:8545';
const PK = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const anvil: ChildProcess = spawn('anvil', ['--port', '8545', '--silent'], { stdio: 'ignore' });
  let code = 0;
  try {
    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    for (let i = 0; i < 50; i++) { try { await pub.getBlockNumber(); break; } catch { await sleep(100); } }

    const accts = PK.map((pk) => privateKeyToAccount(pk));
    const deployer = createWalletClient({ account: accts[0], chain: foundry, transport: http(RPC) });
    const walletB = createWalletClient({ account: accts[1], chain: foundry, transport: http(RPC) });

    const deployHash = await deployer.deployContract({ abi: ABI, bytecode: artifact.bytecode.object, args: [1_000_000n] });
    const token = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
    console.log(`Deployed MiniToken at ${token}`);

    const send = async (w: typeof deployer, to: string, v: bigint): Promise<void> => {
      const h = await w.writeContract({ address: token, abi: ABI, functionName: 'transfer', args: [to, v] });
      await pub.waitForTransactionReceipt({ hash: h });
    };
    await send(deployer, accts[1].address, 100n);
    await send(deployer, accts[2].address, 7n);
    await send(walletB, accts[2].address, 40n);
    console.log('Performed 3 transfers.');

    const tip = Number(await pub.getBlockNumber());
    const indexer = await buildPortfolioIndexer({ client: pub, chainId: foundry.id, network: 'anvil', tokens: [token] });
    await indexer.sync(0, tip);

    const handle = await indexer.serve({ port: 4000 });
    const q = async (query: string): Promise<unknown> => {
      const r = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
      return (await r.json() as { data: unknown }).data;
    };

    console.log('\n── Holder leaderboard (GraphQL) ──');
    const holders = await q('{ tokenHolders(orderBy: balance, orderDirection: desc) { totalCount nodes { holder balance } } }') as { tokenHolders: { totalCount: number; nodes: Array<{ holder: string; balance: string }> } };
    for (const h of holders.tokenHolders.nodes) console.log(`  ${h.holder}  ${h.balance}`);

    console.log('\n── Transfer log (GraphQL) ──');
    const transfers = await q('{ tokenTransfers(orderBy: block, orderDirection: asc) { totalCount nodes { from to value block } } }') as { tokenTransfers: { totalCount: number; nodes: Array<{ from: string; to: string; value: string; block: number }> } };
    for (const t of transfers.tokenTransfers.nodes) console.log(`  block ${t.block}: ${t.from} -> ${t.to}  ${t.value}`);

    console.log(`\n[example:evm] OK — indexed ${holders.tokenHolders.totalCount} holders, ${transfers.tokenTransfers.totalCount} transfers; GraphQL served at ${handle.url}`);
    await handle.stop();
  } catch (err) {
    console.error('[example:evm] ERROR', err);
    code = 1;
  } finally {
    anvil.kill('SIGTERM');
  }
  process.exit(code);
}

void main();
