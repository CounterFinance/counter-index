/**
 * Dev-loop helpers: dev-mode detection, the "reloaded in Xms" print, entry
 * fingerprinting, cache/state paths, checkpoint-based incremental replay
 * (devResumeFrom), and the handler-error printer (devOnError).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isDevMode, devReady, devFingerprint, devCachePath, devStatePath, devResumeFrom, devOnError,
} from '../src/dev.js';
import type { EntityStore } from '../src/store.js';
import type { ChainEvent } from '../src/types.js';

const DEV = process.env['COUNTERINDEX_DEV'];
const ENTRY = process.env['COUNTERINDEX_DEV_ENTRY'];
afterEach(() => {
  if (DEV === undefined) delete process.env['COUNTERINDEX_DEV']; else process.env['COUNTERINDEX_DEV'] = DEV;
  if (ENTRY === undefined) delete process.env['COUNTERINDEX_DEV_ENTRY']; else process.env['COUNTERINDEX_DEV_ENTRY'] = ENTRY;
  vi.restoreAllMocks();
});

const checkpointStore = (cp: { lastBlock: number } | undefined): EntityStore =>
  ({ readCheckpoint: async () => cp } as unknown as EntityStore);

describe('dev helpers', () => {
  it('isDevMode reflects COUNTERINDEX_DEV', () => {
    process.env['COUNTERINDEX_DEV'] = '1';
    expect(isDevMode()).toBe(true);
    process.env['COUNTERINDEX_DEV'] = '0';
    expect(isDevMode()).toBe(false);
  });

  it('devReady is a no-op outside dev mode and prints inside it', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    delete process.env['COUNTERINDEX_DEV'];
    devReady('x');
    expect(out).not.toHaveBeenCalled();
    process.env['COUNTERINDEX_DEV'] = '1';
    devReady('resumed from checkpoint');
    expect(out).toHaveBeenCalledOnce();
    expect(out.mock.calls[0][0]).toContain('reloaded in');
    expect(out.mock.calls[0][0]).toContain('resumed from checkpoint');
  });

  it('devFingerprint hashes entry file contents and changes on edit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-fp-'));
    try {
      const f = join(dir, 'entry.ts');
      writeFileSync(f, 'const a = 1;');
      const fp1 = devFingerprint(f);
      writeFileSync(f, 'const a = 2;');            // "edit the handler"
      const fp2 = devFingerprint(f);
      expect(fp1).not.toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{12}$/);
      expect(devFingerprint(join(dir, 'nope.ts'))).toBe('default');  // missing -> stable fallback
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('devStatePath is keyed by fingerprint; devCachePath is not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ci-paths-'));
    try {
      expect(devCachePath(dir)).toBe(join(dir, 'events.db'));
      expect(devStatePath('aaa', dir)).toBe(join(dir, 'state-aaa.db'));
      expect(devStatePath('bbb', dir)).not.toBe(devStatePath('aaa', dir));  // edit -> different sink
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('devResumeFrom (incremental replay)', () => {
    it('resumes from checkpoint + 1 when the sink already holds progress', async () => {
      const r = await devResumeFrom(checkpointStore({ lastBlock: 30 }), 1, 60);
      expect(r).toEqual({ from: 31, resumed: true, lastBlock: 30 });
    });

    it('does a full replay when there is no checkpoint (fresh sink)', async () => {
      const r = await devResumeFrom(checkpointStore(undefined), 1, 60);
      expect(r).toEqual({ from: 1, resumed: false, lastBlock: -1 });
    });

    it('does a full replay when the checkpoint is behind the requested start', async () => {
      const r = await devResumeFrom(checkpointStore({ lastBlock: 5 }), 10, 60);
      expect(r).toEqual({ from: 10, resumed: false, lastBlock: 5 });
    });

    it('clamps to to+1 when already fully synced (no work to redo)', async () => {
      const r = await devResumeFrom(checkpointStore({ lastBlock: 60 }), 1, 60);
      expect(r).toEqual({ from: 61, resumed: true, lastBlock: 60 });
    });
  });

  describe('devOnError', () => {
    const ev: ChainEvent = {
      chainId: 1, network: 'eth', blockNumber: 42, blockHash: '0x', txHash: '0xabc', logIndex: 3,
      contractAddress: '0xc', eventName: 'Swap', eventRaw: new Uint8Array(0), decoded: {}, dataLength: 0,
    };

    it('prints the event, location, and message', () => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      devOnError(new Error('boom: bad reserve math'), ev);
      const printed = err.mock.calls.map((c) => c[0]).join('');
      expect(printed).toContain('Swap');
      expect(printed).toContain('block 42');
      expect(printed).toContain('0xabc');
      expect(printed).toContain('boom: bad reserve math');
    });

    it('handles a thrown non-Error and a missing event without crashing', () => {
      const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      expect(() => devOnError('string failure')).not.toThrow();
      expect(err.mock.calls.join('')).toContain('string failure');
    });
  });
});
