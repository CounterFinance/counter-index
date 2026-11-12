/**
 * CLI scaffold (M21): `op-index init <dir>` generates a runnable starter project
 * with valid files and the correct package dependency.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/op-index.js', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'opidx-cli-'));

afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('op-index CLI', () => {
  it('init scaffolds a valid project', () => {
    const dir = join(tmp, 'my-indexer');
    execFileSync('node', [bin, 'init', dir], { encoding: 'utf8' });

    for (const f of ['package.json', 'tsconfig.json', 'src']) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@opnet-collective/op-index']).toBeDefined();   // correct package name
  });

  it('refuses a non-empty target and errors on an unknown command', () => {
    const dir = join(tmp, 'again');
    execFileSync('node', [bin, 'init', dir], { encoding: 'utf8' });
    // Second init into the now-populated dir must fail.
    expect(() => execFileSync('node', [bin, 'init', dir], { stdio: 'pipe' })).toThrow();
    // Unknown command exits non-zero.
    expect(() => execFileSync('node', [bin, 'bogus'], { stdio: 'pipe' })).toThrow();
  });
});
