/**
 * Serving-scale read path (opidx-#57): the cacheable REST projection, the
 * structured SQL-over-HTTP query endpoint, and SSE live queries. All three ride
 * the same store.query SQL pushdown + keyset cursors as GraphQL, so these tests
 * also assert cursor interchange and allow-list rejection (no injection surface).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createIndexer, type Indexer } from '../src/indexer.js';
import { defineSchema } from '../src/schema.js';
import { createTestAdapter } from '../src/adapter.js';
import { buildReadPath, matchesFilters, type ReadPathOptions } from '../src/serving.js';
import type { StoreFilter } from '../src/store.js';

const schema = defineSchema({
  Balance: { holder: { type: 'string' }, amount: { type: 'bigint' } },
  Token:   { symbol: { type: 'string' }, decimals: { type: 'int' } },
});

let BASE_PORT = 48110;

async function seed(ix: Indexer): Promise<void> {
  await ix.store.set('Balance', 'a', { holder: '0xaaa', amount: 100n });
  await ix.store.set('Balance', 'b', { holder: '0xbbb', amount: 300n });
  await ix.store.set('Balance', 'c', { holder: '0xccc', amount: 200n });
  await ix.store.set('Balance', 'd', { holder: '0xddd', amount: 400n });
}

describe('serving read path (#57)', () => {
  let ix: Indexer;
  let port: number;
  let origin: string;
  const handles: Array<{ stop(): Promise<void> }> = [];

  beforeEach(async () => {
    ix = await createIndexer({ schema, sink: createTestAdapter() });
    await seed(ix);
    port = BASE_PORT++;
    origin = `http://localhost:${port}`;
  });

  afterEach(async () => {
    for (const h of handles) { try { await h.stop(); } catch { /* already stopped */ } }
    handles.length = 0;
  });

  async function serve(readPath: ReadPathOptions): Promise<void> {
    const h = await ix.serve({ port, readPath });
    handles.push(h);
  }

  // --- REST projection -------------------------------------------------------

  describe('REST projection', () => {
    it('lists entities with pageInfo + totalCount and a CDN cache header', async () => {
      await serve({ rest: true });
      const res = await fetch(`${origin}/v1/Balance?orderBy=amount&orderDirection=asc`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toMatch(/public, s-maxage=\d+, stale-while-revalidate=\d+/);
      expect(res.headers.get('etag')).toBeTruthy();
      const body = await res.json() as { data: { nodes: Array<{ id: string; amount: string }>; totalCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
      expect(body.data.totalCount).toBe(4);
      expect(body.data.nodes.map((n) => n.amount)).toEqual(['100', '200', '300', '400']); // bigint as string, asc
    });

    it('fetches a single record by id, 404 on unknown id', async () => {
      await serve({ rest: true });
      const ok = await fetch(`${origin}/v1/Balance/a`);
      expect(ok.status).toBe(200);
      const body = await ok.json() as { data: { id: string; holder: string; amount: string } };
      expect(body.data).toMatchObject({ id: 'a', holder: '0xaaa', amount: '100' });

      const miss = await fetch(`${origin}/v1/Balance/zzz`);
      expect(miss.status).toBe(404);
    });

    it('honours If-None-Match with a 304 (ETag revalidation)', async () => {
      await serve({ rest: true });
      const first = await fetch(`${origin}/v1/Balance`);
      const etag = first.headers.get('etag')!;
      expect(etag).toBeTruthy();
      const second = await fetch(`${origin}/v1/Balance`, { headers: { 'If-None-Match': etag } });
      expect(second.status).toBe(304);
    });

    it('filters, orders, and keyset-paginates via query string', async () => {
      await serve({ rest: true });
      // amount >= 200, desc, 2 per page.
      const p1 = await (await fetch(`${origin}/v1/Balance?amount_gte=200&orderBy=amount&orderDirection=desc&first=2`)).json() as { data: { nodes: Array<{ amount: string }>; pageInfo: { hasNextPage: boolean; endCursor: string } } };
      expect(p1.data.nodes.map((n) => n.amount)).toEqual(['400', '300']);
      expect(p1.data.pageInfo.hasNextPage).toBe(true);

      const p2 = await (await fetch(`${origin}/v1/Balance?amount_gte=200&orderBy=amount&orderDirection=desc&first=2&after=${encodeURIComponent(p1.data.pageInfo.endCursor)}`)).json() as { data: { nodes: Array<{ amount: string }>; pageInfo: { hasNextPage: boolean } } };
      expect(p2.data.nodes.map((n) => n.amount)).toEqual(['200']);
      expect(p2.data.pageInfo.hasNextPage).toBe(false);
    });

    it('projects with select=', async () => {
      await serve({ rest: true });
      const body = await (await fetch(`${origin}/v1/Balance/a`)).json() as { data: Record<string, unknown> };
      expect(Object.keys(body.data).sort()).toEqual(['amount', 'holder', 'id']);
      const list = await (await fetch(`${origin}/v1/Balance?select=amount`)).json() as { data: { nodes: Array<Record<string, unknown>> } };
      expect(Object.keys(list.data.nodes[0]).sort()).toEqual(['amount', 'id']); // id kept for cursor
    });

    it('rejects an unknown entity (404) and an unknown filter field (400, allow-list)', async () => {
      await serve({ rest: true });
      expect((await fetch(`${origin}/v1/Nope`)).status).toBe(404);
      const bad = await fetch(`${origin}/v1/Balance?evil_gte=1`);
      expect(bad.status).toBe(400); // 'evil' is not a schema field — store.query rejects it
    });

    it('mounts at a custom base', async () => {
      await serve({ rest: { base: '/api' } });
      expect((await fetch(`${origin}/api/Balance`)).status).toBe(200);
      expect((await fetch(`${origin}/v1/Balance`)).status).toBe(404); // default base not mounted
    });
  });

  // --- SQL over HTTP ---------------------------------------------------------

  describe('SQL over HTTP', () => {
    it('runs a structured query and returns a no-store connection', async () => {
      await serve({ sql: true });
      const res = await fetch(`${origin}/sql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity: 'Balance', where: { amount_gte: 200 }, orderBy: 'amount', orderDirection: 'asc', first: 10 }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json() as { data: { nodes: Array<{ amount: string }>; totalCount: number } };
      expect(body.data.totalCount).toBe(3);
      expect(body.data.nodes.map((n) => n.amount)).toEqual(['200', '300', '400']);
    });

    it('supports select projection and _in filters', async () => {
      await serve({ sql: true });
      const res = await fetch(`${origin}/sql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entity: 'Balance', where: { id_in: ['a', 'd'] }, orderBy: 'amount', select: ['amount'] }),
      });
      const body = await res.json() as { data: { nodes: Array<Record<string, unknown>> } };
      expect(body.data.nodes.map((n) => n.amount)).toEqual(['100', '400']);
      expect(Object.keys(body.data.nodes[0]).sort()).toEqual(['amount', 'id']);
    });

    it('rejects unknown entity (404), malformed JSON (400)', async () => {
      await serve({ sql: true });
      const e = await fetch(`${origin}/sql`, { method: 'POST', body: JSON.stringify({ entity: 'Nope' }) });
      expect(e.status).toBe(404);
      const m = await fetch(`${origin}/sql`, { method: 'POST', body: '{not json' });
      expect(m.status).toBe(400);
    });

    it('rejects an oversized body with 413', async () => {
      await serve({ sql: { path: '/sql' } });
      const huge = JSON.stringify({ entity: 'Balance', where: { holder: 'x'.repeat(2_000_000) } });
      const res = await fetch(`${origin}/sql`, { method: 'POST', body: huge });
      expect(res.status).toBe(413);
    });

    it('GET /sql is 405', async () => {
      await serve({ sql: true });
      expect((await fetch(`${origin}/sql`)).status).toBe(405);
    });
  });

  // --- SSE live queries ------------------------------------------------------

  describe('SSE live queries', () => {
    it('streams store changes matching the filter', async () => {
      await serve({ live: true });
      const ac = new AbortController();
      const res = await fetch(`${origin}/live?entity=Balance&amount_gte=250`, {
        headers: { accept: 'text/event-stream' }, signal: ac.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      const seen: string[] = [];

      const pump = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          seen.push(decoder.decode(value, { stream: true }));
          if (seen.join('').includes('event: change')) break;
        }
      })();

      // Give the stream a tick to establish, then write a matching + a non-matching change.
      await new Promise((r) => setTimeout(r, 50));
      await ix.store.set('Balance', 'a', { holder: '0xaaa', amount: 50n });   // below 250 — filtered out
      await ix.store.set('Balance', 'e', { holder: '0xeee', amount: 999n });  // matches

      await Promise.race([pump, new Promise((_r, rej) => setTimeout(() => rej(new Error('SSE timeout')), 3000))]);
      ac.abort();
      try { await pump; } catch { /* aborted */ }

      const text = seen.join('');
      expect(text).toContain('event: change');
      expect(text).toContain('"id":"e"');
      expect(text).toContain('"amount":"999"');
      expect(text).not.toContain('"id":"a"'); // the sub-threshold change was filtered
    });

    it('404s an unknown entity', async () => {
      await serve({ live: true });
      const res = await fetch(`${origin}/live?entity=Nope`);
      expect(res.status).toBe(404);
      await res.text();
    });
  });

  // --- Auth + caps -----------------------------------------------------------

  describe('auth + caps', () => {
    it('gates every read endpoint and marks REST private when auth is set', async () => {
      await serve({ rest: true, sql: true, live: true, auth: 'secret' });
      // No token → 401.
      expect((await fetch(`${origin}/v1/Balance`)).status).toBe(401);
      expect((await fetch(`${origin}/sql`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(`${origin}/live?entity=Balance`)).status).toBe(401);
      // With token → ok, and the response must not be shared-cached.
      const ok = await fetch(`${origin}/v1/Balance`, { headers: { authorization: 'Bearer secret' } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('private, no-store');
    });

    it('inherits the serve() auth token when readPath does not override it', async () => {
      const h = await ix.serve({ port, auth: 'topsecret', readPath: { rest: true } });
      handles.push(h);
      expect((await fetch(`${origin}/v1/Balance`)).status).toBe(401);
      expect((await fetch(`${origin}/v1/Balance`, { headers: { authorization: 'Bearer topsecret' } })).status).toBe(200);
    });

    it('clamps first to maxPageSize', async () => {
      await serve({ rest: true, maxPageSize: 2 });
      const body = await (await fetch(`${origin}/v1/Balance?first=1000`)).json() as { data: { nodes: unknown[] } };
      expect(body.data.nodes.length).toBe(2);
    });
  });

  // --- Coexistence with GraphQL ---------------------------------------------

  it('leaves GraphQL working alongside the read path', async () => {
    await serve({ rest: true, sql: true });
    const res = await fetch(`${origin}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ balances(orderBy: amount) { totalCount nodes { id amount } } }' }),
    });
    const body = await res.json() as { data: { balances: { totalCount: number } } };
    expect(body.data.balances.totalCount).toBe(4);
  });
});

describe('matchesFilters (SSE server-side predicate)', () => {
  const f = (field: string, op: StoreFilter['op'], value: unknown): StoreFilter => ({ field, op, value });
  const rec = { id: 'x', holder: '0xabcdef', amount: 200n, n: 200, tag: 'alpha' };

  it('matches each comparison operator against a bigint field', () => {
    expect(matchesFilters(rec, [f('amount', 'eq', 200n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'eq', 199n)])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'not', 199n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'not', 200n)])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'gt', 199n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'gt', 200n)])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'gte', 200n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'gte', 201n)])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'lt', 201n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'lt', 200n)])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'lte', 200n)])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'lte', 199n)])).toBe(false);
  });

  it('compares numbers and mixed number/string operands without NaN leaks', () => {
    expect(matchesFilters(rec, [f('n', 'gte', 200)])).toBe(true);
    expect(matchesFilters(rec, [f('n', 'lt', 150)])).toBe(false);
    // string operand coerced to number for a numeric compare
    expect(matchesFilters(rec, [f('n', 'gte', '200')])).toBe(true);
  });

  it('matches string operators', () => {
    expect(matchesFilters(rec, [f('tag', 'eq', 'alpha')])).toBe(true);
    expect(matchesFilters(rec, [f('holder', 'contains', 'cde')])).toBe(true);
    expect(matchesFilters(rec, [f('holder', 'contains', 'zzz')])).toBe(false);
    expect(matchesFilters(rec, [f('holder', 'starts_with', '0xab')])).toBe(true);
    expect(matchesFilters(rec, [f('holder', 'starts_with', '0xzz')])).toBe(false);
    expect(matchesFilters(rec, [f('holder', 'ends_with', 'cdef')])).toBe(true);
    expect(matchesFilters(rec, [f('holder', 'ends_with', 'abcd')])).toBe(false);
  });

  it('matches the in operator (and rejects a non-array value)', () => {
    expect(matchesFilters(rec, [f('amount', 'in', [100n, 200n, 300n])])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'in', [100n, 300n])])).toBe(false);
    expect(matchesFilters(rec, [f('amount', 'in', 200n)])).toBe(false); // not an array → no match
  });

  it('requires ALL filters to hold (AND semantics)', () => {
    expect(matchesFilters(rec, [f('amount', 'gte', 100n), f('tag', 'eq', 'alpha')])).toBe(true);
    expect(matchesFilters(rec, [f('amount', 'gte', 100n), f('tag', 'eq', 'beta')])).toBe(false);
    expect(matchesFilters(rec, [])).toBe(true); // vacuous truth — no filter excludes
  });
});

describe('buildReadPath', () => {
  it('returns undefined when nothing is enabled', () => {
    const ix0 = defineSchema({ X: { v: { type: 'int' } } });
    // store is irrelevant here — no route is enabled, so no router is built.
    const router = buildReadPath(ix0, { } as never, {});
    expect(router).toBeUndefined();
  });
});
