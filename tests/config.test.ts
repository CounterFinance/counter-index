/**
 * Config validation (M19): coerce + validate from env, apply defaults, and
 * report EVERY problem at once with a clear message.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError, type ConfigSchema } from '../src/config.js';

const schema = {
  databaseUrl: { type: 'url', required: true, description: 'Postgres connection' },
  rpcUrl:      { type: 'url', required: true },
  chainId:     { type: 'integer', required: true, min: 1 },
  fromBlock:   { type: 'integer', default: 0, min: 0 },
  finality:    { type: 'integer', default: 12 },
  port:        { type: 'number', default: 4000, min: 1, max: 65535 },
  logLevel:    { type: 'string', default: 'info', enum: ['debug', 'info', 'warn', 'error'] as const },
  metrics:     { type: 'boolean', default: true },
} satisfies ConfigSchema;

describe('loadConfig', () => {
  it('coerces types and applies defaults', () => {
    const cfg = loadConfig(schema, {
      DATABASE_URL: 'postgres://localhost/db', RPC_URL: 'https://rpc.example',
      CHAIN_ID: '137', PORT: '8080', METRICS: 'false',
    });
    expect(cfg.chainId).toBe(137);
    expect(cfg.fromBlock).toBe(0);          // default
    expect(cfg.finality).toBe(12);          // default
    expect(cfg.port).toBe(8080);
    expect(cfg.logLevel).toBe('info');      // default
    expect(cfg.metrics).toBe(false);        // coerced boolean
  });

  it('reports ALL problems at once', () => {
    try {
      loadConfig(schema, { RPC_URL: 'not a url', CHAIN_ID: 'abc', PORT: '999999' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const p = (e as ConfigError).problems;
      expect(p.some((x) => x.includes('DATABASE_URL') && x.includes('required'))).toBe(true);
      expect(p.some((x) => x.includes('RPC_URL') && x.includes('valid URL'))).toBe(true);
      expect(p.some((x) => x.includes('CHAIN_ID') && x.includes('number'))).toBe(true);
      expect(p.some((x) => x.includes('PORT') && x.includes('<= 65535'))).toBe(true);
    }
  });

  it('enforces integer, min/max and enum', () => {
    expect(() => loadConfig(schema, { DATABASE_URL: 'postgres://x/y', RPC_URL: 'https://x', CHAIN_ID: '1.5' }))
      .toThrow(/CHAIN_ID.*integer/);
    expect(() => loadConfig(schema, { DATABASE_URL: 'postgres://x/y', RPC_URL: 'https://x', CHAIN_ID: '0' }))
      .toThrow(/CHAIN_ID.*>= 1/);
    expect(() => loadConfig(schema, { DATABASE_URL: 'postgres://x/y', RPC_URL: 'https://x', CHAIN_ID: '1', LOG_LEVEL: 'trace' }))
      .toThrow(/LOG_LEVEL.*one of/);
  });

  it('honours a custom env name', () => {
    const cfg = loadConfig({ token: { type: 'string', env: 'HYPERSYNC_TOKEN', default: 'none' } }, { HYPERSYNC_TOKEN: 'abc' });
    expect(cfg.token).toBe('abc');
  });
});
