/**
 * Atomicity dogfood (M10): prove a crash-ridden index equals a clean one.
 *
 *   npm run dogfood:atomicity
 *
 * 1. Clean run → golden balances.
 * 2. Fresh DB, then repeatedly kill the worker (process.exit 137) mid-block at
 *    random points, restarting each time (resuming from the checkpoint); a final
 *    uninterrupted pass guarantees completion.
 * 3. The crash-ridden result MUST equal the clean run: no partial blocks, no
 *    double counts, no gaps. If per-block writes weren't atomic, re-processing a
 *    committed-but-uncheckpointed block would double-count and this would fail.
 */

import { spawnSync } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const TO = 60, EPB = 10, HOLDERS = 20, TOTAL = TO * EPB;   // 600 events
const TSX = 'node_modules/.bin/tsx';
const dir = mkdtempSync(join(tmpdir(), 'opindex-atomicity-'));
const GOLDEN = join(dir, 'golden.db');
const CRASH = join(dir, 'crash.db');

function run(db: string, crashAt: number): number {
  const r = spawnSync(TSX, ['dogfood/atomicity-worker.ts'], {
    env: { ...process.env, DB_PATH: db, TO: String(TO), EPB: String(EPB), HOLDERS: String(HOLDERS), CRASH_AT: String(crashAt) },
    stdio: 'pipe',
  });
  return r.status ?? -1;
}

function dump(db: string): string {
  const d = new Database(db, { readonly: true });
  try {
    const rows = d.prepare('SELECT holder, n FROM opindex_balance ORDER BY holder').all();
    return JSON.stringify(rows);
  } catch { return '{}'; } finally { d.close(); }
}

function main(): void {
  let code = 0;
  try {
    rmSync(GOLDEN, { force: true });
    if (run(GOLDEN, -1) !== 0) throw new Error('clean run failed');
    const golden = dump(GOLDEN);

    rmSync(CRASH, { force: true });
    let crashes = 0, restarts = 0;
    for (let i = 0; i < 40; i++) {
      const crashAt = Math.floor(Math.random() * TOTAL);
      const status = run(CRASH, crashAt);
      restarts++;
      if (status === 137) crashes++;
      else if (status === 0) break;        // completed without hitting the crash point
      else throw new Error(`worker exited ${status}`);
    }
    run(CRASH, -1);                         // guarantee completion
    const final = dump(CRASH);

    const totalGolden = JSON.parse(golden).reduce((s: number, r: { n: number }) => s + r.n, 0);
    console.log(`  events total        ${TOTAL}`);
    console.log(`  crashes injected    ${crashes} (over ${restarts} restarts)`);
    console.log(`  golden sum(n)       ${totalGolden}`);
    console.log(`  golden == final     ${golden === final}`);

    if (golden === final && totalGolden === TOTAL && crashes > 0) {
      console.log('[dogfood:atomicity] PASS — crash-ridden run equals clean run (no partial blocks, no double counts, no gaps).');
    } else {
      console.error('[dogfood:atomicity] FAIL'); console.error('  golden', golden.slice(0, 160)); console.error('  final ', final.slice(0, 160));
      code = 1;
    }
  } catch (err) { console.error('[dogfood:atomicity] ERROR', err); code = 1; }
  finally { rmSync(dir, { recursive: true, force: true }); }
  process.exit(code);
}

main();
