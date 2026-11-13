/**
 * MinimalDbAdapter — the database interface counter-index requires for its sink (write) connection.
 *
 * Structurally identical to @opnet-collective/opstream's DbAdapter. Pass the OpStream
 * adapter directly and TypeScript accepts it via structural typing — no import needed.
 *
 * counter-index also ships its own SqliteAdapter backed by better-sqlite3 for standalone
 * use and unit tests without OpStream.
 */

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Sql } from 'postgres';

type DB = ReturnType<typeof Database>;

// Narrow internal interface — avoids spreading into better-sqlite3's conditional rest type.
type Stmt = {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

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
// SqliteAdapter — better-sqlite3
// ---------------------------------------------------------------------------

export class SqliteAdapter implements MinimalDbAdapter {
  readonly dialect = 'sqlite' as const;

  private readonly _cache = new Map<string, Stmt>();

  constructor(public readonly rawDb: DB) {}

  private stmt(sql: string): Stmt {
    let s = this._cache.get(sql);
    if (!s) {
      s = this.rawDb.prepare(sql);
      this._cache.set(sql, s);
    }
    return s;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.stmt(sql).run(...params);
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    return this.stmt(sql).all(...params) as T[];
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

  /** Close the underlying database (used by graceful shutdown). Idempotent. */
  close(): void {
    if (this.rawDb.open) this.rawDb.close();
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
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return new SqliteAdapter(db);
}

/**
 * Create an in-memory SQLite adapter. For unit tests only — data is lost when
 * the process exits. Not for production use.
 */
export function createTestAdapter(): SqliteAdapter {
  return new SqliteAdapter(new Database(':memory:'));
}

// ---------------------------------------------------------------------------
// PostgresAdapter — postgres (npm)
// ---------------------------------------------------------------------------

/**
 * Postgres adapter backed by the `postgres` npm package.
 *
 * Accepts an existing `Sql` connection so callers control the pool lifecycle.
 * Use `openPostgres()` to open a new connection from a URL string.
 *
 * The store generates `$N`-style placeholders when `dialect === 'postgres'`,
 * so all queries are passed through to the driver without transformation.
 */
export class PostgresAdapter implements MinimalDbAdapter {
  readonly dialect = 'postgres' as const;
  // Holds the transaction-scoped sql connection when inside adapter.transaction().
  // All operations use this instead of the pool so they join the open transaction.
  private txSql: Sql | null = null;

  constructor(private readonly sql: Sql) {}

  private get activeSql(): Sql {
    return this.txSql ?? this.sql;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    await this.activeSql.unsafe(sql, params as never[]);
  }

  async get<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T | undefined> {
    const rows = await this.activeSql.unsafe(sql, params as never[]);
    return rows[0] as T | undefined;
  }

  async all<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const rows = await this.activeSql.unsafe(sql, params as never[]);
    return rows as unknown as T[];
  }

  async exec(sql: string): Promise<void> {
    await this.activeSql.unsafe(sql);
  }

  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    return this.sql.begin(async (txSql) => {
      this.txSql = txSql as unknown as Sql;
      try {
        return await fn();
      } finally {
        this.txSql = null;
      }
    }) as Promise<T>;
  }

  /** Close the underlying connection pool. Call on graceful shutdown. */
  async end(): Promise<void> {
    await this.sql.end();
  }
}

/**
 * Open a Postgres connection and return a `PostgresAdapter`.
 *
 * ```ts
 * const sink = await openPostgres(process.env.DATABASE_URL!);
 * const indexer = await createIndexer({ schema, sink, source });
 * // On shutdown:
 * await sink.end();
 * ```
 */
export async function openPostgres(connectionString: string): Promise<PostgresAdapter> {
  const { default: postgres } = await import('postgres');
  const sql = postgres(connectionString, { max: 10, onnotice: () => {} });
  // Verify the connection is reachable before returning
  await sql`SELECT 1`;
  return new PostgresAdapter(sql);
}
