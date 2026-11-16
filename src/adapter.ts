/**
 * MinimalDbAdapter — the database interface counter-index requires for its sink (write) connection.
 *
 * Structurally identical to @opnet-collective/opstream's DbAdapter. Pass the OpStream
 * adapter directly and TypeScript accepts it via structural typing — no import needed.
 *
 * counter-index also ships its own SqliteAdapter backed by better-sqlite3 for standalone
 * use and unit tests without OpStream.
 */

import type BetterSqlite3 from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import type { Sql } from 'postgres';

/**
 * Runtime require for modules loaded lazily: node:sqlite (keeps it out of
 * bundlers) and better-sqlite3 (an optional peer dependency — present only if the
 * consumer installed it, so it must never be imported eagerly).
 */
const nodeRequire = createRequire(import.meta.url);

type DB = BetterSqlite3.Database;
type BetterCtor = new (path: string, options?: BetterSqlite3.Options) => DB;
const loadBetterSqlite = (): BetterCtor => {
  try {
    return nodeRequire('better-sqlite3') as BetterCtor;
  } catch {
    throw new Error(
      "better-sqlite3 is not installed. Install it to use openBetterSqlite / SqliteAdapter, or use the default openSqlite (node:sqlite, no native dependency).",
    );
  }
};

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
/**
 * Open a SQLite database. Defaults to Node's built-in `node:sqlite` — NO native
 * dependency, so a clean install with no compile step. For the mature
 * better-sqlite3 native driver instead, use {@link openBetterSqlite} (install
 * better-sqlite3 yourself; it is an optional peer dependency).
 */
export function openSqlite(path: string): NodeSqliteAdapter {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p: string) => NodeDb };
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  return new NodeSqliteAdapter(db);
}

/**
 * Open a SQLite database on the better-sqlite3 native driver. better-sqlite3 is
 * an optional peer dependency — install it yourself to use this.
 */
export function openBetterSqlite(path: string): SqliteAdapter {
  const dir = dirname(path);
  if (dir && dir !== '.' && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const Database = loadBetterSqlite();
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return new SqliteAdapter(db);
}

/**
 * Create an in-memory SQLite adapter (better-sqlite3) for unit tests. Data is
 * lost when the process exits. Not for production use.
 */
export function createTestAdapter(): SqliteAdapter {
  return new SqliteAdapter(new (loadBetterSqlite())(':memory:'));
}

// ---------------------------------------------------------------------------
// NodeSqliteAdapter — Node's built-in node:sqlite (no native dependency)
// ---------------------------------------------------------------------------

/** The slice of node:sqlite's DatabaseSync this adapter uses. */
interface NodeDb {
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  exec(sql: string): void;
  close(): void;
  readonly isOpen: boolean;
}

/**
 * SQLite adapter backed by Node's built-in `node:sqlite` — NO native dependency,
 * so a clean install with no compile step and no install-script approval. This is
 * the default backend behind {@link openSqlite}; same dialect, SQL and behaviour
 * as {@link SqliteAdapter} (which stays available via {@link openBetterSqlite} for
 * the better-sqlite3 native driver). Validated for parity in tests/node-sqlite.test.ts.
 */
export class NodeSqliteAdapter implements MinimalDbAdapter {
  readonly dialect = 'sqlite' as const;
  private readonly _cache = new Map<string, ReturnType<NodeDb['prepare']>>();

  constructor(public readonly rawDb: NodeDb) {}

  private stmt(sql: string): ReturnType<NodeDb['prepare']> {
    let s = this._cache.get(sql);
    if (!s) { s = this.rawDb.prepare(sql); this._cache.set(sql, s); }
    return s;
  }

  async run(sql: string, params: unknown[] = []): Promise<void> {
    this.stmt(sql).run(...params);
  }

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const row = this.stmt(sql).get(...params) as Record<string, unknown> | undefined;
    return row === undefined ? undefined : ({ ...row } as T);   // node:sqlite rows are null-prototype
  }

  async all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (this.stmt(sql).all(...params) as Record<string, unknown>[]).map((r) => ({ ...r }) as T);
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

  close(): void {
    if (this.rawDb.isOpen) this.rawDb.close();
  }
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
