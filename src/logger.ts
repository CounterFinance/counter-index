import { hostname as osHostname } from 'node:os';

/**
 * Five-level logger contract (industry-standard hierarchy):
 *
 *   error   handler threw, source unreachable          (always)
 *   warn    chunk retry, WS→poll fallback, reorg       (always)
 *   info    startup, source selected, progress ticker,
 *           live-block heartbeat                       (≤ 1 line / sec)
 *   debug   per-window sync start/complete, per-block
 *           summary during sync, per-event dispatch    (10-100 / sec)
 *   trace   per-store write with elapsed_ms,
 *           per-handler invocation timing              (1000+ / sec)
 *
 * Consumers implement this interface and choose which levels they route
 * through. op-index never decides the output medium — ecosystem/CLI/etc.
 * plug in their own sink.
 */
export interface IndexerLogger {
  trace(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  debug(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  info(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  warn(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  error(ctx: string, msg: string, extra?: Record<string, unknown>): void;
}

export const noopLogger: IndexerLogger = {
  trace: () => {},
  debug: () => {},
  info:  () => {},
  warn:  () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Built-in structured logger (pino-compatible)
// ---------------------------------------------------------------------------

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/** pino's numeric levels — so JSON output pipes straight into `pino-pretty`. */
const LEVEL_VALUE: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const LEVEL_COLOR: Record<LogLevel, string> = { trace: '\x1b[90m', debug: '\x1b[36m', info: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' };
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export interface LoggerOptions {
  /** Minimum level to emit. Default 'info'. */
  level?: LogLevel;
  /** Human-readable output. Default: auto (true when stdout is a TTY). */
  pretty?: boolean;
  /** Sink for a finished line (no trailing newline). Default: stdout. */
  write?: (line: string) => void;
  /**
   * Base bindings attached to every JSON line (like pino's pid/hostname). Default
   * `{ pid, hostname }`. Pass `{}` to drop them, or add your own (service, env…).
   * Omitted from pretty output to keep it human-readable.
   */
  base?: Record<string, unknown>;
}

function formatValue(v: unknown): string {
  if (typeof v === 'bigint') return v.toString();
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v as string | number | boolean);
}

/**
 * A tidy structured logger. In JSON mode it emits pino-shaped lines
 * (`{"level":30,"time":...,"ctx":"indexer","msg":"...",...}`) that pipe directly
 * into `pino-pretty`; in pretty mode it prints `HH:MM:SS.mmm LEVEL (ctx): msg k=v`.
 *
 *   const indexer = await createIndexer({ schema, sink, logger: createLogger({ level: 'info' }) });
 */
export function createLogger(options: LoggerOptions = {}): IndexerLogger {
  const min = LEVEL_VALUE[options.level ?? 'info'];
  const isTty = Boolean(process.stdout.isTTY);
  const pretty = options.pretty ?? isTty;
  const color = pretty && isTty;
  const write = options.write ?? ((line: string): void => { process.stdout.write(line + '\n'); });
  const base = options.base ?? { pid: process.pid, hostname: osHostname() };

  const emit = (level: LogLevel, ctx: string, msg: string, extra?: Record<string, unknown>): void => {
    if (LEVEL_VALUE[level] < min) return;
    const time = Date.now();

    if (!pretty) {
      // pino-shaped: level, time, base bindings, then ctx/msg/fields.
      // Replacer keeps bigint (and other non-JSON values) from throwing.
      write(JSON.stringify({ level: LEVEL_VALUE[level], time, ...base, ctx, msg, ...extra },
        (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v)));
      return;
    }

    const ts = new Date(time).toISOString().slice(11, 23);           // HH:MM:SS.mmm
    const label = level.toUpperCase().padEnd(5);
    const head = color ? `${LEVEL_COLOR[level]}${label}${RESET}` : label;
    const name = color ? `${DIM}(${ctx})${RESET}` : `(${ctx})`;
    const fields = extra && Object.keys(extra).length > 0
      ? ' ' + Object.entries(extra).map(([k, v]) => `${k}=${formatValue(v)}`).join(' ')
      : '';
    write(`${ts} ${head} ${name}: ${msg}${fields}`);
  };

  return {
    trace: (ctx, msg, extra) => emit('trace', ctx, msg, extra),
    debug: (ctx, msg, extra) => emit('debug', ctx, msg, extra),
    info:  (ctx, msg, extra) => emit('info',  ctx, msg, extra),
    warn:  (ctx, msg, extra) => emit('warn',  ctx, msg, extra),
    error: (ctx, msg, extra) => emit('error', ctx, msg, extra),
  };
}
