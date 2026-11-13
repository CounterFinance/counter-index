/**
 * Atomicity dogfood worker (M10). Indexes a deterministic event stream into a
 * FILE-backed SQLite sink, resuming from the checkpoint. With CRASH_AT set it
 * calls process.exit(137) — simulating `kill -9` — from INSIDE a block's commit
 * transaction, so the partial block must roll back and leave no trace. The
 * orchestrator (atomicity.ts) spawns this repeatedly and compares the result to
 * a clean run.
 */

import { openSqlite } from '../src/adapter.js';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

const DB = process.env.DB_PATH as string;
const TO = Number(process.env.TO ?? 50);
const EPB = Number(process.env.EPB ?? 10);
const HOLDERS = Number(process.env.HOLDERS ?? 20);
const CRASH_AT = Number(process.env.CRASH_AT ?? -1);   // global event ordinal to crash at

const holderFor = (ordinal: number): string => `h${ordinal % HOLDERS}`;

function makeEvent(block: number, e: number): ChainEvent {
  const ordinal = (block - 1) * EPB + e;
  return {
    chainId: 1, network: 'atomicity', blockNumber: block, blockHash: `0x${block}`,
    txHash: `0x${block}-${e}`, logIndex: e, contractAddress: '0xc', eventName: 'Inc',
    eventRaw: new Uint8Array(0), decoded: { holder: holderFor(ordinal), ordinal }, dataLength: 0,
  };
}

const source: EventSource = {
  async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
    for (let b = from; b <= to; b++) for (let e = 0; e < EPB; e++) yield makeEvent(b, e);
  },
  subscribe(): UnsubscribeFn { return () => {}; },
};

async function main(): Promise<void> {
  const schema = defineSchema({ Balance: { holder: { type: 'string' }, n: { type: 'int' } } });
  const sink = openSqlite(DB);
  const indexer = await createIndexer({ schema, sink, source });

  indexer.on('Inc', async (event, ctx) => {
    const ordinal = event.decoded!['ordinal'] as number;
    // Crash mid-block: we're inside commitBlock's transaction here. Exiting before
    // the write (and before the block's checkpoint) must leave NO partial state.
    if (ordinal === CRASH_AT) process.exit(137);
    const h = event.decoded!['holder'] as string;
    const cur = await ctx.store.get('Balance', h);
    await ctx.store.set('Balance', h, { holder: h, n: (cur ? Number(cur['n']) : 0) + 1 });
  });

  // Resume from the durable checkpoint (TypedStore is the base store at runtime).
  const cp = await (indexer.store as unknown as { readCheckpoint(): Promise<{ lastBlock: number } | undefined> }).readCheckpoint();
  const from = cp ? cp.lastBlock + 1 : 1;
  if (from <= TO) await indexer.sync(from, TO);
  console.log(`DONE from=${from}`);
  process.exit(0);
}

void main();
