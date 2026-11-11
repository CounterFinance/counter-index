/**
 * Live EVM dogfood: op-index indexing a real contract on an anvil devnet.
 *
 *   npm run dogfood:evm        # requires `anvil` on PATH (foundry)
 *
 * Spawns anvil, deploys MiniToken, performs known transfers, indexes the chain
 * with EvmLogSource -> createIndexer (running holder balances), then asserts the
 * indexed balances EQUAL on-chain balanceOf() for every account. This is a real
 * end-to-end run, not mocks: if it prints PASS, the EVM source is chain-verified.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createPublicClient, createWalletClient, http, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { EvmLogSource } from '../src/chains/evm/evmLogSource.js';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { openSqlite } from '../src/adapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const artifact = JSON.parse(readFileSync(join(HERE, 'evm-fixture/out/MiniToken.sol/MiniToken.json'), 'utf8')) as {
  abi: readonly unknown[]; bytecode: { object: `0x${string}` };
};
const ABI = artifact.abi as never;
const RPC = 'http://127.0.0.1:8545';

// anvil deterministic accounts
const PK = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForAnvil(pub: ReturnType<typeof createPublicClient>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await pub.getBlockNumber(); return; } catch { await sleep(100); }
  }
  throw new Error('anvil did not become ready');
}

async function main(): Promise<void> {
  const anvil: ChildProcess = spawn('anvil', ['--port', '8545', '--silent'], { stdio: 'ignore' });
  let failed = false;
  try {
    const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
    await waitForAnvil(pub);

    const acct = PK.map((pk) => privateKeyToAccount(pk));
    const deployer = createWalletClient({ account: acct[0], chain: foundry, transport: http(RPC) });
    const walletB  = createWalletClient({ account: acct[1], chain: foundry, transport: http(RPC) });

    const SUPPLY = 1_000_000n;
    // deploy
    const deployHash = await deployer.deployContract({ abi: ABI, bytecode: artifact.bytecode.object, args: [SUPPLY] });
    const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
    const token = deployRcpt.contractAddress!;

    // known transfers: deployer->B 100, deployer->C 7, B->C 40
    const send = async (w: typeof deployer, to: string, value: bigint): Promise<void> => {
      const h = await w.writeContract({ address: token, abi: ABI, functionName: 'transfer', args: [to, value] });
      await pub.waitForTransactionReceipt({ hash: h });
    };
    await send(deployer, acct[1].address, 100n);
    await send(deployer, acct[2].address, 7n);
    await send(walletB,  acct[2].address, 40n);

    const tip = Number(await pub.getBlockNumber());

    // index with op-index
    const schema = defineSchema({ TokenHolder: { holder: { type: 'string' }, balance: { type: 'bigint' } } });
    const indexer = await createIndexer({ schema, sink: openSqlite(':memory:'),
      source: new EvmLogSource({ chainId: foundry.id, network: 'anvil', abi: ABI, client: pub, addresses: [token] }) });

    indexer.on('Transfer', async (event, ctx) => {
      const d = event.decoded; if (!d) return;
      const from = (d['from'] as string).toLowerCase();
      const to = (d['to'] as string).toLowerCase();
      const value = BigInt(d['value'] as bigint);
      for (const [h, delta] of [[to, value], [from, -value]] as const) {
        const cur = await ctx.store.get('TokenHolder', h);
        await ctx.store.set('TokenHolder', h, { holder: h, balance: (cur ? BigInt(cur.balance as bigint) : 0n) + delta });
      }
    });
    await indexer.sync(0, tip);

    // assert indexed balances == on-chain balanceOf for every account
    const accounts = acct.map((a) => a.address);
    let allMatch = true;
    for (const addr of accounts) {
      const onChain = await pub.readContract({ address: token, abi: ABI, functionName: 'balanceOf', args: [addr] }) as bigint;
      const row = await indexer.store.get('TokenHolder', addr.toLowerCase());
      const indexed = row ? BigInt(row.balance as bigint) : 0n;
      const ok = indexed === onChain;
      allMatch &&= ok;
      console.log(`  ${getAddress(addr)}  indexed=${indexed}  onChain=${onChain}  ${ok ? 'OK' : 'MISMATCH'}`);
    }

    if (allMatch) console.log('[dogfood:evm] PASS — indexed balances equal on-chain balanceOf for all accounts.');
    else { console.error('[dogfood:evm] FAIL — balance mismatch.'); failed = true; }
  } catch (err) {
    console.error('[dogfood:evm] ERROR', err);
    failed = true;
  } finally {
    anvil.kill('SIGTERM');
  }
  process.exit(failed ? 1 : 0);
}

void main();
