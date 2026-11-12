/**
 * M22 attack suite: the GraphQL API must reject/cap abusive requests and stay up.
 * Covers the DoS surface of bug opidx-#42 (unbounded pages) plus depth, auth,
 * rate-limit and body-size.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createIndexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { SqliteAdapter } from '../src/adapter.js';
import type { ServeHandle, ServeOptions } from '../src/graphql.js';

const schema = defineSchema({ Item: { v: { type: 'int' } } });

async function serve(opts: ServeOptions): Promise<ServeHandle> {
  const indexer = await createIndexer({ schema, sink: new SqliteAdapter(new Database(':memory:')) });
  for (let i = 0; i < 50; i++) await indexer.store.set('Item', `i${i}`, { v: i });
  return indexer.serve(opts);
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const AUTH = { authorization: 'Bearer secret' };
const MAIN = 'http://localhost:47960/graphql';   // maxPageSize+depth+auth
const RL   = 'http://localhost:47961/graphql';   // rate limit
const BODY = 'http://localhost:47962/graphql';   // plain (body-size)

describe('M22 GraphQL hardening', () => {
  let main: ServeHandle, rl: ServeHandle, body: ServeHandle;
  beforeAll(async () => {
    main = await serve({ port: 47960, maxPageSize: 5, maxQueryDepth: 4, auth: 'secret' });
    rl   = await serve({ port: 47961, rateLimit: { windowMs: 60_000, max: 3 } });
    body = await serve({ port: 47962 });
  });
  afterAll(async () => { await main.stop(); await rl.stop(); await body.stop(); });

  it('clamps an enormous `first` to maxPageSize', async () => {
    const r = await post(MAIN, { query: '{ items(first: 1000000000) { nodes { id } } }' }, AUTH);
    const j = await r.json() as { data: { items: { nodes: unknown[] } } };
    expect(j.data.items.nodes.length).toBe(5);     // capped, not 50 or 1e9
  });

  it('rejects an over-deep query (400)', async () => {
    const r = await post(MAIN, { query: '{ a { b { c { d { e { f } } } } } }' }, AUTH);  // depth 6 > 4
    const j = await r.json() as { errors?: Array<{ message: string }> };
    expect(r.status).toBe(400);
    expect(j.errors?.[0]?.message).toMatch(/depth \d+ exceeds max 4/);
  });

  it('rejects unauthenticated + wrong-token requests (401)', async () => {
    expect((await post(MAIN, { query: '{ items { totalCount } }' })).status).toBe(401);
    expect((await post(MAIN, { query: '{ items { totalCount } }' }, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('allows a correct token (200)', async () => {
    const r = await post(MAIN, { query: '{ items { totalCount } }' }, AUTH);
    expect(r.status).toBe(200);
    expect((await r.json() as { data: { items: { totalCount: number } } }).data.items.totalCount).toBe(50);
  });

  it('rate-limits a flood (429) and stays responsive', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(RL, { query: '{ items { totalCount } }' })).status);
    expect(codes.filter((c) => c === 200).length).toBe(3);
    expect(codes.filter((c) => c === 429).length).toBe(3);
  });

  it('rejects an oversized request body (413) and stays up', async () => {
    const huge = 'x'.repeat(1_100_000);
    const r = await fetch(BODY, { method: 'POST', headers: { 'content-type': 'application/json' }, body: `{"query":"${huge}"}` });
    expect(r.status).toBe(413);
    expect((await post(BODY, { query: '{ items { totalCount } }' })).status).toBe(200);  // server survived
  });
});
