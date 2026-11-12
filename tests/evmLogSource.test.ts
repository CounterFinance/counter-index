/**
 * EvmLogSource over a mocked viem transport — deterministic, offline. Proves the
 * eth_getLogs -> ChainEvent mapping, chunking, decoding, txEvents and filters
 * without a live RPC. A live anvil run lives in evmLogSource.anvil.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { createPublicClient, custom, toEventSelector, pad, numberToHex } from 'viem';
import type { Abi } from 'viem';
import { EvmLogSource } from '../src/chains/evm/evmLogSource.js';
import type { ChainEvent } from '../src/types.js';
import type { EvmChainMeta } from '../src/chains/evm/types.js';

const erc20Abi = [{
  type: 'event', name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
}] as const;

const TOPIC0 = toEventSelector(erc20Abi[0]);
const addr32 = (a: string): string => pad(a as `0x${string}`, { size: 32 });
const val32  = (n: bigint): string => pad(numberToHex(n), { size: 32 });
const TOKEN  = '0x00000000000000000000000000000000000000aa';
const A = '0x00000000000000000000000000000000000000a1';
const B = '0x00000000000000000000000000000000000000b2';

function rawLog(block: number, logIndex: number, txHash: string, from: string, to: string, value: bigint) {
  return {
    address: TOKEN,
    topics: [TOPIC0, addr32(from), addr32(to)],
    data: val32(value),
    blockNumber: numberToHex(block),
    blockHash: '0xblock' + block,
    transactionHash: txHash,
    transactionIndex: '0x0',
    logIndex: numberToHex(logIndex),
    removed: false,
  };
}

/** All logs, returned by eth_getLogs filtered on the requested fromBlock/toBlock. */
const ALL_LOGS = [
  rawLog(100, 0, '0xtxA', A, B, 100n),
  rawLog(101, 0, '0xtxB', B, A, 40n),
];

function mockClient(onGetLogs?: (p: { fromBlock: string; toBlock: string }) => void) {
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_blockNumber') return numberToHex(101);
    if (method === 'eth_getLogs') {
      const p = (params as [{ fromBlock: string; toBlock: string }])[0];
      onGetLogs?.(p);
      const from = Number(BigInt(p.fromBlock)), to = Number(BigInt(p.toBlock));
      return ALL_LOGS.filter((l) => {
        const bn = Number(BigInt(l.blockNumber));
        return bn >= from && bn <= to;
      });
    }
    if (method === 'eth_getBlockByNumber') {
      const bn = Number(BigInt((params as [string])[0]));
      const z = (n: number): string => '0x' + '0'.repeat(n);
      return {
        number: numberToHex(bn), hash: '0x' + bn.toString(16).padStart(64, '0'), parentHash: z(64),
        nonce: z(16), sha3Uncles: z(64), logsBloom: z(512), transactionsRoot: z(64), stateRoot: z(64),
        receiptsRoot: z(64), miner: z(40), difficulty: '0x0', totalDifficulty: '0x0', extraData: '0x',
        size: '0x0', gasLimit: '0x0', gasUsed: '0x0', timestamp: numberToHex(1_700_000_000 + bn),
        transactions: [], uncles: [], baseFeePerGas: '0x0',
      };
    }
    throw new Error(`unexpected method ${method}`);
  });
  return { client: createPublicClient({ transport: custom({ request }) }), request };
}

async function collect(iter: AsyncIterable<ChainEvent>): Promise<ChainEvent[]> {
  const out: ChainEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

describe('EvmLogSource.queryStream', () => {
  it('maps eth_getLogs results to decoded ChainEvents', async () => {
    const { client } = mockClient();
    const source = new EvmLogSource({ chainId: 1, network: 'eth-mainnet', abi: erc20Abi as unknown as Abi, client });

    const events = await collect(source.queryStream(100, 101));
    expect(events).toHaveLength(2);

    const [e0, e1] = events;
    expect(e0!.chainId).toBe(1);
    expect(e0!.network).toBe('eth-mainnet');
    expect(e0!.eventName).toBe('Transfer');
    expect(e0!.blockNumber).toBe(100);
    expect(e0!.blockHash).toBe('0xblock100');
    expect(e0!.txHash).toBe('0xtxA');
    expect(e0!.blockTimestamp).toBe(1_700_000_100);   // fetched per-block via getBlock
    expect((e0!.decoded!['value'])).toBe(100n);
    expect((e0!.chainMeta as EvmChainMeta).kind).toBe('evm');
    expect((e0!.chainMeta as EvmChainMeta).topics[0]).toBe(TOPIC0);
    expect(e1!.blockNumber).toBe(101);
    expect(e1!.decoded!['value']).toBe(40n);
  });

  it('chunks the range by maxBlockRange (multiple eth_getLogs calls)', async () => {
    const calls: Array<{ fromBlock: string; toBlock: string }> = [];
    const { client } = mockClient((p) => calls.push(p));
    const source = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client, maxBlockRange: 1 });

    const events = await collect(source.queryStream(100, 101));
    expect(events).toHaveLength(2);
    expect(calls).toHaveLength(2);                        // [100,100] and [101,101]
    expect(Number(BigInt(calls[0]!.toBlock))).toBe(100);
    expect(Number(BigInt(calls[1]!.fromBlock))).toBe(101);
  });

  it('applies the eventNames filter', async () => {
    const { client } = mockClient();
    const source = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client });
    const none = await collect(source.queryStream(100, 101, { eventNames: ['Swap'] }));
    expect(none).toHaveLength(0);
    const all = await collect(source.queryStream(100, 101, { eventNames: ['Transfer'] }));
    expect(all).toHaveLength(2);
  });

  it('subscribe() polls for new blocks, delivers them, and stop() halts', async () => {
    const { client } = mockClient();
    const source = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client });
    const got: ChainEvent[] = [];
    const stop = source.subscribe(100, async (e) => { got.push(e); }, { pollIntervalMs: 10_000 });
    await new Promise((r) => setTimeout(r, 60));   // let the first poll run
    stop();
    const countAfterStop = got.length;
    expect(countAfterStop).toBe(2);                // blocks 100 and 101 delivered once
    expect(got[0]!.eventName).toBe('Transfer');
    expect(got[0]!.blockTimestamp).toBe(1_700_000_100);
    await new Promise((r) => setTimeout(r, 30));
    expect(got.length).toBe(countAfterStop);       // no further polls after stop()
  });

  it('ordered-parallel: fetches chunks concurrently but yields blocks in order', async () => {
    // A client where each eth_getLogs takes ~20ms and returns one log at its block.
    let inFlight = 0, maxInFlight = 0;
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return '0x1';
      if (method === 'eth_getLogs') {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        const p = (params as [{ fromBlock: string; toBlock: string }])[0];
        const bn = Number(BigInt(p.fromBlock));
        return [rawLog(bn, 0, `0xtx${bn}`, A, B, BigInt(bn))];
      }
      throw new Error(`unexpected ${method}`);
    });
    const client = createPublicClient({ transport: custom({ request }) });

    const seq = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client, maxBlockRange: 1, fetchBlockTimestamps: false, concurrency: 1 });
    const par = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client, maxBlockRange: 1, fetchBlockTimestamps: false, concurrency: 6 });

    const t0 = Date.now();
    const seqEvents = await collect(seq.queryStream(1, 12));   // 12 chunks, serial ≈ 240ms
    const seqMs = Date.now() - t0;

    maxInFlight = 0;
    const t1 = Date.now();
    const parEvents = await collect(par.queryStream(1, 12));   // 12 chunks, ~6-wide ≈ 40ms
    const parMs = Date.now() - t1;

    // Same events, strictly ascending block order, on both paths.
    expect(parEvents.map((e) => e.blockNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(parEvents.map((e) => e.blockNumber)).toEqual(seqEvents.map((e) => e.blockNumber));
    expect(maxInFlight).toBeGreaterThan(1);                    // actually ran concurrently
    expect(parMs).toBeLessThan(seqMs);                         // and it was faster
  });

  it('groups sibling logs per tx into txEvents', async () => {
    const { client } = mockClient();
    const source = new EvmLogSource({ chainId: 1, network: 'eth', abi: erc20Abi as unknown as Abi, client });
    const [e0] = await collect(source.queryStream(100, 100));
    // txEvents is keyed by contract address (sibling-event map), per ChainEvent semantics.
    expect(e0!.txEvents?.get(TOKEN)).toBeDefined();
    expect(e0!.txEvents!.get(TOKEN)![0]!.type).toBe('Transfer');
  });
});
