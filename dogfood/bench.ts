/**
 * counter-index backfill micro-benchmark (honest, reproducible).
 *
 *   npm run bench
 *
 * Streams N synthetic events through the full pipeline (source -> handlers ->
 * typed store -> SQLite) and reports events/sec, blocks/sec and peak RSS. These
 * are counter-index's OWN numbers on this machine; for cross-tool comparison run the
 * standard harness at github.com/enviodev/open-indexer-benchmark (see
 * docs/benchmarks.md).
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';
import type { ChainEvent } from '../src/types.js';

const BLOCKS = Number(process.env.BENCH_BLOCKS ?? 5000);
const PER_BLOCK = Number(process.env.BENCH_PER_BLOCK ?? 10);
const HOLDERS = 500;
const TOTAL = BLOCKS * PER_BLOCK;

const genSource: EventSource = {
  async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
    let i = 0;
    for (let b = from; b <= to; b++) {
      for (let k = 0; k < PER_BLOCK; k++) {
        const h = `h${i % HOLDERS}`;
        yield {
          chainId: 1, network: 'bench', blockNumber: b, blockHash: `0x${b}`,
          txHash: `0x${b}-${k}`, logIndex: k, contractAddress: '0xtoken',
          eventName: 'Transfer', eventRaw: new Uint8Array(0),
          decoded: { holder: h, amount: String(i) }, dataLength: 0,
        };
        i++;
      }
    }
  },
  subscribe(): UnsubscribeFn { return () => {}; },
};

async function main(): Promise<void> {
  const schema = defineSchema({ Holder: { holder: { type: 'string' }, balance: { type: 'bigint' } } });
  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')), source: genSource });
  indexer.on('Transfer', async (e, ctx) => {
    const d = e.decoded!;
    await ctx.store.set('Holder', d['holder'] as string, { holder: d['holder'] as string, balance: BigInt(d['amount'] as string) });
  });

  const t0 = performance.now();
  await indexer.sync(1, BLOCKS);
  const secs = (performance.now() - t0) / 1000;
  const rssMb = Math.round(process.memoryUsage().rss / 1e6);

  console.log(`node               ${process.version}`);
  console.log(`events             ${TOTAL} (${BLOCKS} blocks x ${PER_BLOCK}/block, ${HOLDERS} holders)`);
  console.log(`elapsed            ${secs.toFixed(2)} s`);
  console.log(`events/sec         ${Math.round(TOTAL / secs)}`);
  console.log(`blocks/sec         ${Math.round(BLOCKS / secs)}`);
  console.log(`entitiesWritten    ${indexer.stats.entitiesWritten}`);
  console.log(`peak RSS           ${rssMb} MB`);
}

void main();
