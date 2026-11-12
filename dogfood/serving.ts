/**
 * Dogfood: serving-scale read path (opidx-#57). Proves the three cache- and
 * proxy-friendly read surfaces a CDN-fronted indexer needs, all on the same SQL
 * pushdown as GraphQL:
 *
 *   1. REST projection  — a GET list with a CDN cache header + ETag, then a
 *      conditional GET that comes back 304 (the edge-cache revalidation win
 *      GraphQL-over-POST can't get).
 *   2. SQL over HTTP     — a structured, allow-listed query (the full filter
 *      object a REST query-string can't express), parameterised end to end.
 *   3. Live queries (SSE)— one plain HTTP GET that streams store changes as they
 *      land, filtered server-side — no WebSocket upgrade.
 *
 *   npx tsx dogfood/serving.ts
 */

import Database from 'better-sqlite3';
import { createIndexer } from '../src/index.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';

const schema = defineSchema({
  Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } },
});

const PORT = 48130;
const ORIGIN = `http://localhost:${PORT}`;
const fail = (m: string): never => { console.error(`[dogfood:serving] FAIL — ${m}`); process.exit(1); };

async function main(): Promise<void> {
  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
  for (const [id, holder, amount] of [['a', '0xaaa', 100n], ['b', '0xbbb', 300n], ['c', '0xccc', 200n], ['d', '0xddd', 400n]] as const) {
    await indexer.store.set('Balance', id, { holder, amount });
  }

  const handle = await indexer.serve({ port: PORT, readPath: { rest: true, sql: true, live: true } });
  try {
    // 1. REST projection — cacheable list + ETag revalidation.
    const list = await fetch(`${ORIGIN}/v1/Balance?orderBy=amount&orderDirection=asc`);
    const cc = list.headers.get('cache-control') ?? '';
    const etag = list.headers.get('etag') ?? '';
    if (!/s-maxage=\d+/.test(cc) || !/stale-while-revalidate=\d+/.test(cc)) fail(`REST missing CDN cache header: ${cc}`);
    if (!etag) fail('REST missing ETag');
    const listBody = await list.json() as { data: { nodes: Array<{ amount: string }>; totalCount: number } };
    if (listBody.data.totalCount !== 4) fail(`REST totalCount expected 4, got ${listBody.data.totalCount}`);
    if (listBody.data.nodes.map((n) => n.amount).join(',') !== '100,200,300,400') fail('REST ordering wrong');

    const revalidate = await fetch(`${ORIGIN}/v1/Balance?orderBy=amount&orderDirection=asc`, { headers: { 'If-None-Match': etag } });
    if (revalidate.status !== 304) fail(`REST conditional GET expected 304, got ${revalidate.status}`);
    await revalidate.text();

    // 2. SQL over HTTP — structured allow-listed query.
    const sql = await fetch(`${ORIGIN}/sql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity: 'Balance', where: { amount_gte: 200 }, orderBy: 'amount', orderDirection: 'desc', first: 10, select: ['amount'] }),
    });
    if (sql.headers.get('cache-control') !== 'no-store') fail('SQL endpoint should be no-store');
    const sqlBody = await sql.json() as { data: { nodes: Array<{ amount: string }>; totalCount: number } };
    if (sqlBody.data.totalCount !== 3) fail(`SQL totalCount expected 3, got ${sqlBody.data.totalCount}`);
    if (sqlBody.data.nodes.map((n) => n.amount).join(',') !== '400,300,200') fail('SQL filter/order wrong');
    // Allow-list: an unknown field must be rejected, never interpolated.
    const inj = await fetch(`${ORIGIN}/sql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity: 'Balance', where: { 'amount); DROP TABLE Balance;--_gte': 1 } }),
    });
    if (inj.status !== 400) fail(`SQL injection attempt should be 400, got ${inj.status}`);
    await inj.text();

    // 3. SSE live query — stream a change as it lands.
    const ac = new AbortController();
    const live = await fetch(`${ORIGIN}/live?entity=Balance&amount_gte=500`, { headers: { accept: 'text/event-stream' }, signal: ac.signal });
    if (!(live.headers.get('content-type') ?? '').includes('text/event-stream')) fail('SSE wrong content-type');
    const reader = live.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        if (buf.includes('event: change')) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await indexer.store.set('Balance', 'a', { holder: '0xaaa', amount: 10n });   // below threshold — filtered out
    await indexer.store.set('Balance', 'whale', { holder: '0xfff', amount: 1_000_000n }); // streamed
    await Promise.race([pump, new Promise((_r, rej) => setTimeout(() => rej(new Error('SSE timeout')), 3000))]).catch((e) => fail(String(e)));
    ac.abort();
    try { await pump; } catch { /* aborted */ }
    if (!buf.includes('"id":"whale"') || !buf.includes('"amount":"1000000"')) fail('SSE did not stream the matching change');
    if (buf.includes('"id":"a"')) fail('SSE streamed a change the filter should have dropped');

    console.log('  REST   GET /v1/Balance → CDN cache header + ETag; conditional GET → 304 (edge-cacheable)');
    console.log('  SQL    POST /sql {where, orderBy, select} → 3 rows, no-store; injection attempt → 400 (allow-list)');
    console.log('  SSE    GET /live → streamed the whale change, dropped the sub-threshold one (server-side filter)');
    console.log('[dogfood:serving] PASS — REST + SQL-over-HTTP + SSE live queries on one zero-dep http server.');
  } finally {
    await handle.stop();
  }
}

void main();
