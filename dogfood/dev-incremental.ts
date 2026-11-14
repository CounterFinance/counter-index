/**
 * Dogfood: incremental replay + the dev error printer.
 *
 *   npx tsx dogfood/dev-incremental.ts
 *
 * The dev sink is keyed by a fingerprint of your entry, so:
 *   - restart WITHOUT editing (same fingerprint -> same sink) resumes from the
 *     checkpoint and re-processes only the new blocks;
 *   - edit a handler (fingerprint changes -> fresh sink) replays the whole range
 *     from the event cache (no re-fetch).
 * We prove both, then show devOnError rendering a handler throw cleanly while the
 * indexer keeps going.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createIndexer, createCachedSource, openSqlite,
  devStatePath, devCachePath, devResumeFrom, devOnError,
} from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import type { ChainEvent } from '../src/types.js';
import type { EventSource, UnsubscribeFn } from '../src/source.js';

const fail = (m: string): never => { console.error(`[dogfood:dev-incremental] FAIL — ${m}`); process.exit(1); };
const schema = defineSchema({ Hit: { block: { type: 'int' } } });

const EVENTS: ChainEvent[] = Array.from({ length: 60 }, (_, i) => ({
  chainId: 1, network: 'eth', blockNumber: i + 1, blockHash: `0x${i + 1}`,
  txHash: `0x${i + 1}`, logIndex: 0, contractAddress: '0xc', eventName: 'Ping',
  eventRaw: new Uint8Array(0), decoded: { n: i + 1 }, dataLength: 0,
}));
class Source implements EventSource {
  async *queryStream(from: number, to: number): AsyncIterable<ChainEvent> {
    for (const e of EVENTS) if (e.blockNumber >= from && e.blockNumber <= to) yield e;
  }
  subscribe(): UnsubscribeFn { return () => {}; }
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'ci-dev-'));
  try {
    const cache = await createCachedSource(new Source(), { path: devCachePath(dir) });
    const sinkV1 = devStatePath('handler-v1', dir);   // same entry fingerprint across runs 1 and 2

    // ---- Run 1: fresh sink. Index blocks 1..30, checkpoint lands at 30. ----
    const seen1: number[] = [];
    const ix1 = await createIndexer({ schema, source: cache, sink: openSqlite(sinkV1) });
    ix1.on('Ping', async (e, ctx) => { seen1.push(e.blockNumber); await ctx.store.set('Hit', String(e.blockNumber), { block: e.blockNumber }); });
    const p1 = await devResumeFrom(ix1.store, 1, 60);
    if (p1.resumed) fail('run 1 should be a full replay (no checkpoint yet)');
    await ix1.sync(p1.from, 30);
    if (seen1.length !== 30) fail(`run 1 should process 30 blocks, got ${seen1.length}`);

    // ---- Run 2: SAME fingerprint -> SAME sink -> resume. Only 31..60 re-processed. ----
    const seen2: number[] = [];
    const ix2 = await createIndexer({ schema, source: cache, sink: openSqlite(sinkV1) });
    ix2.on('Ping', async (e, ctx) => { seen2.push(e.blockNumber); await ctx.store.set('Hit', String(e.blockNumber), { block: e.blockNumber }); });
    const p2 = await devResumeFrom(ix2.store, 1, 60);
    if (!p2.resumed || p2.from !== 31) fail(`run 2 should resume from 31, got ${JSON.stringify(p2)}`);
    await ix2.sync(p2.from, 60);
    if (seen2.length !== 30 || seen2[0] !== 31) fail(`run 2 should process only 31..60, saw ${seen2.length} starting ${seen2[0]}`);
    if ((await ix2.store.count('Hit')) !== 60) fail('full 1..60 should be indexed after resume');

    // ---- Run 3: EDITED handler -> new fingerprint -> fresh sink -> full replay. ----
    const seen3: number[] = [];
    const ix3 = await createIndexer({ schema, source: cache, sink: openSqlite(devStatePath('handler-v2', dir)) });
    ix3.on('Ping', async (e, ctx) => { seen3.push(e.blockNumber); await ctx.store.set('Hit', String(e.blockNumber), { block: e.blockNumber }); });
    const p3 = await devResumeFrom(ix3.store, 1, 60);
    if (p3.resumed) fail('run 3 (edited handler, fresh sink) should be a full replay');
    await ix3.sync(p3.from, 60);
    if (seen3.length !== 60) fail(`run 3 should replay all 60, got ${seen3.length}`);

    // ---- Error print: a handler throw renders cleanly via onError, then (by the
    // atomicity guarantee) aborts the block and the sync. In the dev loop you read
    // the clean error, fix, and save to restart. We catch it like a real entry would.
    const ix4 = await createIndexer({ schema, source: cache, sink: openSqlite(':memory:'), onError: devOnError });
    ix4.on('Ping', async (e) => { if (e.blockNumber === 3) throw new Error('bad reserve math at block 3'); });
    console.log('  (expect one clean error block below, for block 3:)');
    let threw = false;
    try { await ix4.sync(1, 5); } catch { threw = true; }   // devOnError prints first, then sync aborts
    if (!threw) fail('a throwing handler should abort the sync (atomicity)');

    console.log(`  run 1 (cold):     processed ${seen1.length} blocks (1..30), checkpoint at 30`);
    console.log(`  run 2 (resume):   processed ${seen2.length} blocks (31..60 only) — incremental, not 60`);
    console.log(`  run 3 (edited):   processed ${seen3.length} blocks (full 1..60 replay from cache)`);
    console.log('[dogfood:dev-incremental] PASS — resume vs full-replay by fingerprint, clean error print.');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
