/**
 * MinimalDbAdapter — the database interface OpKit requires for its sink (write) connection.
 *
 * Structurally identical to @opnet-devs/opstream's DbAdapter. Pass the OpStream
 * adapter directly and TypeScript accepts it via structural typing — no import needed.
 *
 * OpKit also ships its own SqliteAdapter backed by node:sqlite (Node 22+ built-in)
 * for standalone use and unit tests without OpStream.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface MinimalDbAdapter {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  readonly dialect: 'sqlite' | 'postgres';
}

// ---------------------------------------------------------------------------
// SqliteAdapter — node:sqlite built-in, no npm runtime deps
// ---------------------------------------------------------------------------

export class SqliteAdapter implements MinimalDbAdapter {
  readonly dialect = 'sqlite' as const;

  private readonly _cache = new Map<string, StatementSync>();

  constructor(public readonly rawDb: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this._cache.get(sql);
    if (!s) {
      s = this.rawDb.prepare(sql);
      this._cache.set(sql, s);
    }
    return s;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.stmt(sql).run(...(params as Parameters<StatementSync['run']>));
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.stmt(sql).get(
      ...(params as Parameters<StatementSync['get']>),
    ) as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.stmt(sql).all(
      ...(params as Parameters<StatementSync['all']>),
    ) as T[];
  }

  async exec(sql: string): Promise<void> {
    this.rawDb.exec(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.rawDb.exec('BEGIN');
    try {
      const result = await fn();
      this.rawDb.exec('COMMIT');
      return result;
    } catch (err) {
      this.rawDb.exec('ROLLBACK');
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Open a SQLite file as a MinimalDbAdapter. Creates parent directories as needed.
 * Sets WAL mode and busy timeout for concurrent access with OpStream.
 */
export function openSqlite(path: string): SqliteAdapter {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return new SqliteAdapter(db);
}

/**
 * Create an in-memory SQLite adapter. For unit tests only — data is lost when
 * the process exits. Not for production use.
 */
export function createTestAdapter(): SqliteAdapter {
  return new SqliteAdapter(new DatabaseSync(':memory:'));
}
