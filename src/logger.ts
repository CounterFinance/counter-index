export interface IndexerLogger {
  info(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  debug(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  warn(ctx: string, msg: string, extra?: Record<string, unknown>): void;
  error(ctx: string, msg: string, extra?: Record<string, unknown>): void;
}

export const noopLogger: IndexerLogger = {
  info:  () => {},
  debug: () => {},
  warn:  () => {},
  error: () => {},
};
