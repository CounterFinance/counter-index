/**
 * Dev-loop helpers. These pair with the `counter-index dev <entry>` CLI (which
 * runs your entry under `tsx watch`, sets COUNTERINDEX_DEV, and points
 * COUNTERINDEX_DEV_ENTRY at your file) to give a one-command, fast-reload loop
 * with no HMR machinery: a full process restart, made cheap by the event cache
 * (no re-fetch) and checkpoint resume (no re-processing when nothing changed).
 *
 *   import {
 *     createCachedSource, createIndexer, defineSchema, openSqlite,
 *     devCachePath, devStatePath, devResumeFrom, devReady, devOnError,
 *   } from '@counterfinance/counter-index';
 *
 *   const source = await createCachedSource(mySource, { path: devCachePath() });
 *   const indexer = await createIndexer({
 *     schema, source, sink: openSqlite(devStatePath()), onError: devOnError,
 *   });
 *   indexer.on('Transfer', handler);
 *   const { from, resumed } = await devResumeFrom(indexer.store, FROM, TO);
 *   await indexer.sync(from, TO);
 *   await indexer.serve({ port: 4000 });
 *   devReady(resumed ? 'resumed from checkpoint' : 'full replay');
 *
 * The sink path is keyed by a fingerprint of your entry file: edit a handler and
 * the fingerprint changes, so a fresh sink forces a full replay (from cache);
 * restart without editing and the same sink resumes from its checkpoint.
 */

import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { EntityStore } from './store.js';
import type { ChainEvent } from './types.js';

const CACHE_DIR = '.counterindex-cache';

/** True when running under `counter-index dev` (the CLI sets COUNTERINDEX_DEV=1). */
export function isDevMode(): boolean {
  return process.env['COUNTERINDEX_DEV'] === '1';
}

function color(code: string, s: string): string {
  return process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

/**
 * Print a clean "reloaded in Xms" line (time since process start, i.e. the
 * restart cost). No-op outside dev mode, so it's safe to leave in a shared entry.
 */
export function devReady(label?: string): void {
  if (!isDevMode()) return;
  const ms = Math.round(performance.now());
  process.stdout.write(`${color('32', '⚡ counter-index')} reloaded in ${color('1', `${ms}ms`)}${label ? ` (${label})` : ''}\n`);
}

/**
 * A short hash of the entry file's contents, used to key the dev sink. Changes
 * when you edit the file, which is the signal to rebuild derived state. Falls
 * back to a stable key when no entry is known (so standalone use still works).
 */
export function devFingerprint(entryPath?: string): string {
  const entry = entryPath ?? process.env['COUNTERINDEX_DEV_ENTRY'];
  if (!entry) return 'default';
  try {
    return createHash('sha1').update(readFileSync(entry, 'utf8')).digest('hex').slice(0, 12);
  } catch {
    return 'default';
  }
}

/** The shared, fingerprint-independent event cache path. */
export function devCachePath(dir: string = CACHE_DIR): string {
  mkdirSync(dir, { recursive: true });
  return join(dir, 'events.db');
}

/** The derived-state sink path, keyed by the entry fingerprint (edit -> fresh sink). */
export function devStatePath(fingerprint: string = devFingerprint(), dir: string = CACHE_DIR): string {
  mkdirSync(dir, { recursive: true });
  return join(dir, `state-${fingerprint}.db`);
}

export interface DevResume {
  /** The block to actually sync from (checkpoint + 1 when resuming, else `from`). */
  from: number;
  /** True when a prior checkpoint let us skip ahead (incremental replay). */
  resumed: boolean;
  /** The last checkpointed block, or -1 if none. */
  lastBlock: number;
}

/**
 * Incremental replay: if the sink already holds a checkpoint at or past `from`,
 * resume from `lastBlock + 1` instead of re-running the whole range. Paired with
 * {@link devStatePath}, an unchanged handler resumes (fast) while an edited one
 * gets a fresh sink and replays fully from the event cache (no re-fetch).
 */
export async function devResumeFrom(store: EntityStore, from: number, to: number): Promise<DevResume> {
  const cp = await store.readCheckpoint();
  if (cp && cp.lastBlock >= from) {
    return { from: Math.min(cp.lastBlock + 1, to + 1), resumed: true, lastBlock: cp.lastBlock };
  }
  return { from, resumed: false, lastBlock: cp?.lastBlock ?? -1 };
}

/**
 * A readable handler-error printer for the indexer's `onError` hook: names the
 * event and its location, the message, and a trimmed stack. The indexer still
 * rolls the block back (onError only observes); this just makes the failure
 * legible during development instead of a wall of framework frames.
 */
export function devOnError(err: unknown, event?: ChainEvent): void {
  const name = event?.eventName ?? 'event';
  const where = event ? ` @ block ${event.blockNumber} tx ${event.txHash}${event.logIndex != null ? `#${event.logIndex}` : ''}` : '';
  const message = err instanceof Error ? err.message : String(err);
  const frames = err instanceof Error && err.stack
    ? err.stack.split('\n').slice(1).filter((l) => !l.includes('node:internal')).slice(0, 4).join('\n')
    : '';
  process.stderr.write(
    `\n${color('31', `✖ handler error in "${name}"`)}${where}\n` +
    `  ${message}\n` +
    (frames ? `${color('90', frames)}\n` : '') + '\n',
  );
}
