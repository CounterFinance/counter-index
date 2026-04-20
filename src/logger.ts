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
