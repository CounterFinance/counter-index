/**
 * EvmLogSource — an EventSource over `eth_getLogs`, implementing the same core
 * interface as the OPNET sources. Backfill chunks the block range and fetches
 * logs per chunk (server-side address filtering); live mode polls the head.
 * Logs are decoded through an EvmAbiDecoder, so nothing above the source changes.
 *
 * Requires the optional peer dependency `viem`. Pass a configured viem
 * PublicClient (recommended — you control chain/transport/retries) or an rpcUrl.
 */

import { createPublicClient, http } from 'viem';
import type { PublicClient, Abi, Log } from 'viem';
import type { EventSource, EventSourceFilters, UnsubscribeFn } from '../../source.js';
import type { ChainEvent } from '../../types.js';
import type { EvmChainMeta } from './types.js';
import { EvmAbiDecoder } from './evmDecoder.js';

export interface EvmLogSourceOptions {
  /** EIP-155 chain id stamped on every event. */
  chainId: number;
  /** Human-readable network label, e.g. "eth-mainnet", "base-mainnet". */
  network: string;
  /** ABI(s) used to decode logs (and, with `addresses`, to filter). */
  abi: Abi | Abi[];
  /** A configured viem PublicClient. Preferred. */
  client?: PublicClient;
  /** Or an RPC URL — a default http() client is built from it. */
  rpcUrl?: string;
  /** Restrict logs to these contract addresses (server-side filter). */
  addresses?: string[];
  /** Max blocks per eth_getLogs call. Default 2000. */
  maxBlockRange?: number;
  /** Poll interval for live mode (ms). Default 12000. */
  pollIntervalMs?: number;
}

const hexToBytes = (hex: string): Uint8Array =>
  new Uint8Array(Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex'));

export class EvmLogSource implements EventSource {
  private readonly client: PublicClient;
  private readonly decoder: EvmAbiDecoder;
  private readonly chainId: number;
  private readonly network: string;
  private readonly addresses?: `0x${string}`[];
  private readonly maxBlockRange: number;
  private readonly defaultPollMs: number;

  constructor(options: EvmLogSourceOptions) {
    if (!options.client && !options.rpcUrl) {
      throw new Error('[op-index] EvmLogSource requires either `client` or `rpcUrl`.');
    }
    this.client = options.client ?? createPublicClient({ transport: http(options.rpcUrl) });
    this.decoder = new EvmAbiDecoder(options.abi);
    this.chainId = options.chainId;
    this.network = options.network;
    this.addresses = options.addresses as `0x${string}`[] | undefined;
    this.maxBlockRange = options.maxBlockRange ?? 2000;
    this.defaultPollMs = options.pollIntervalMs ?? 12_000;
  }

  async *queryStream(
    fromBlock: number,
    toBlock: number,
    filters?: EventSourceFilters,
  ): AsyncIterable<ChainEvent> {
    const addressFilter = this.resolveAddressFilter(filters);

    for (let f = fromBlock; f <= toBlock; f += this.maxBlockRange) {
      const end = Math.min(f + this.maxBlockRange - 1, toBlock);
      const logs = await this.client.getLogs({
        address: addressFilter,
        fromBlock: BigInt(f),
        toBlock: BigInt(end),
      });
      const ordered = [...logs].sort(compareLogs);
      const txEventsByTx = buildTxEventsMap(ordered, this.decoder);

      for (const log of ordered) {
        const event = this.toChainEvent(log, txEventsByTx);
        if (filters?.eventNames && !filters.eventNames.includes(event.eventName)) continue;
        yield event;
      }
    }
  }

  subscribe(
    fromBlock: number,
    onEvent: (e: ChainEvent) => Promise<void>,
    options: { pollIntervalMs?: number } = {},
  ): UnsubscribeFn {
    const intervalMs = options.pollIntervalMs ?? this.defaultPollMs;
    let lastBlock = fromBlock - 1;
    let stopped = false;

    const poll = async (): Promise<void> => {
      if (stopped) return;
      try {
        const tip = Number(await this.client.getBlockNumber());
        if (tip > lastBlock) {
          for await (const e of this.queryStream(lastBlock + 1, tip)) {
            if (stopped) return;
            await onEvent(e);
          }
          lastBlock = tip;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[op-index] EvmLogSource poll error (retry in ${intervalMs / 1000}s): ${msg}`);
      }
      if (!stopped) setTimeout(() => { void poll(); }, intervalMs);
    };

    setTimeout(() => { void poll(); }, 0);
    return () => { stopped = true; };
  }

  private resolveAddressFilter(filters?: EventSourceFilters): `0x${string}`[] | undefined {
    if (filters?.contract) return [filters.contract as `0x${string}`];
    return this.addresses;
  }

  private toChainEvent(
    log: Log,
    txEventsByTx: Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>,
  ): ChainEvent {
    const raw = hexToBytes(log.data);
    const decodedLog = this.decoder.decode({ raw, topics: log.topics });
    const eventName = decodedLog?.eventName ?? (log.topics[0] ?? 'unknown');

    const chainMeta: EvmChainMeta = {
      kind: 'evm',
      topics: [...log.topics],
      removed: log.removed,
    };

    return {
      chainId:         this.chainId,
      network:         this.network,
      blockNumber:     Number(log.blockNumber ?? 0n),
      blockHash:       log.blockHash ?? '',
      txHash:          log.transactionHash ?? '',
      txIndex:         log.transactionIndex ?? undefined,
      logIndex:        log.logIndex ?? undefined,
      contractAddress: log.address,
      eventName,
      eventRaw:        raw,
      decoded:         decodedLog?.decoded ?? null,
      dataLength:      raw.length,
      txEvents:        log.transactionHash ? txEventsByTx.get(log.transactionHash) : undefined,
      chainMeta,
    };
  }
}

function compareLogs(a: Log, b: Log): number {
  const bn = Number(a.blockNumber ?? 0n) - Number(b.blockNumber ?? 0n);
  if (bn !== 0) return bn;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/**
 * Group every log in the chunk by tx hash, then by contract address — the
 * router-pattern sibling map (matches the OPNET sources' `txEvents` shape:
 * Map<contractAddress, {type,raw}[]>, shared by reference across a tx's events).
 */
function buildTxEventsMap(
  logs: Log[],
  decoder: EvmAbiDecoder,
): Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>> {
  const byTx = new Map<string, Map<string, Array<{ type: string; raw: Uint8Array }>>>();
  for (const log of logs) {
    if (!log.transactionHash) continue;
    const raw = hexToBytes(log.data);
    const type = decoder.decode({ raw, topics: log.topics })?.eventName ?? (log.topics[0] ?? 'unknown');
    let perTx = byTx.get(log.transactionHash);
    if (!perTx) { perTx = new Map(); byTx.set(log.transactionHash, perTx); }
    const bucket = perTx.get(log.address);
    if (bucket) bucket.push({ type, raw });
    else perTx.set(log.address, [{ type, raw }]);
  }
  return byTx;
}
