/**
 * Built-in structured logger: pino-shaped JSON, pretty mode, level filtering.
 */

import { describe, it, expect } from 'vitest';
import { createLogger } from '../src/logger.js';

function capture(opts: Parameters<typeof createLogger>[0]): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const log = createLogger({ ...opts, write: (l) => lines.push(l) });
  return { lines, log };
}

describe('createLogger', () => {
  it('emits pino-shaped JSON (numeric levels) by default', () => {
    const { lines, log } = capture({ pretty: false, level: 'debug' });
    log.info('indexer', 'subscribe start', { from_block: 100 });
    const obj = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(obj['level']).toBe(30);               // pino: info = 30
    expect(obj['ctx']).toBe('indexer');
    expect(obj['msg']).toBe('subscribe start');
    expect(obj['from_block']).toBe(100);
    expect(typeof obj['time']).toBe('number');
  });

  it('filters below the configured level', () => {
    const { lines, log } = capture({ pretty: false, level: 'warn' });
    log.info('x', 'skipped');
    log.debug('x', 'skipped');
    log.warn('x', 'kept');
    log.error('x', 'kept');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)['level']).toBe(40);
    expect(JSON.parse(lines[1]!)['level']).toBe(50);
  });

  it('renders a tidy pretty line with fields', () => {
    const { lines, log } = capture({ pretty: true, level: 'info' });
    log.info('store', 'wrote', { entity: 'Holder', ms: 2 });
    // HH:MM:SS.mmm INFO  (store): wrote entity=Holder ms=2
    expect(lines[0]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} INFO\s+\(store\): wrote entity=Holder ms=2$/);
  });

  it('serialises bigint fields without throwing', () => {
    const { lines, log } = capture({ pretty: false, level: 'trace' });
    expect(() => log.trace('store', 'bignum', { v: 123n })).not.toThrow();
    expect(JSON.parse(lines[0]!)['v']).toBe('123');
  });
});
