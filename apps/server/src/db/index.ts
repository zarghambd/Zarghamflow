import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { Pool, type PoolClient } from '@neondatabase/serverless';
import { config } from '../config.js';

type SqliteDatabase = InstanceType<typeof Database>;
type SqlParams = readonly unknown[];
type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number };

const sqliteTransaction = new AsyncLocalStorage<boolean>();
let sqliteInstance: SqliteDatabase | undefined;
const isPostgres = Boolean(config.DATABASE_URL);
const pool = config.DATABASE_URL ? new Pool({ connectionString: config.DATABASE_URL, max: 5 }) : undefined;
let sqliteQueue: Promise<void> = Promise.resolve();

if (!isPostgres) {
  const { default: Sqlite } = await import('better-sqlite3');
  const databasePath = resolve(process.cwd(), config.DATABASE_PATH);
  mkdirSync(dirname(databasePath), { recursive: true });
  sqliteInstance = new Sqlite(databasePath);
  sqliteInstance.pragma('journal_mode = WAL');
  sqliteInstance.pragma('foreign_keys = ON');
  sqliteInstance.pragma('busy_timeout = 5000');
}

export { isPostgres };

export const sqlite: SqliteDatabase = new Proxy({} as SqliteDatabase, {
  get(_target, property) {
    if (!sqliteInstance) {
      throw new Error('The SQLite connection is unavailable when DATABASE_URL is configured.');
    }
    const value = Reflect.get(sqliteInstance, property, sqliteInstance) as unknown;
    return typeof value === 'function' ? value.bind(sqliteInstance) : value;
  },
});

export interface DatabaseSession {
  exec(sql: string): Promise<void>;
  get<T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined>;
  all<T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]>;
  run(sql: string, params?: SqlParams): Promise<{ changes: number }>;
}

function postgresPlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function withSqliteLock<T>(operation: () => Promise<T>): Promise<T> {
  if (sqliteTransaction.getStore()) return await operation();
  let release!: () => void;
  const previous = sqliteQueue;
  sqliteQueue = new Promise<void>((resolveQueue) => { release = resolveQueue; });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function sqliteSession(): DatabaseSession {
  return {
    async exec(sql) {
      sqliteInstance!.exec(sql);
    },
    async get<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      return sqliteInstance!.prepare(sql).get(...params) as T | undefined;
    },
    async all<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      return sqliteInstance!.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: SqlParams = []) {
      return { changes: sqliteInstance!.prepare(sql).run(...params).changes };
    },
  };
}

function postgresSession(client: Pool | PoolClient): DatabaseSession {
  return {
    async exec(sql) {
      await client.query(sql);
    },
    async get<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      const result = await client.query(postgresPlaceholders(sql), [...params]) as QueryResult;
      return result.rows[0] as T | undefined;
    },
    async all<T extends Record<string, unknown>>(sql: string, params: SqlParams = []) {
      const result = await client.query(postgresPlaceholders(sql), [...params]) as QueryResult;
      return result.rows as T[];
    },
    async run(sql: string, params: SqlParams = []) {
      const result = await client.query(postgresPlaceholders(sql), [...params]) as QueryResult;
      return { changes: result.rowCount };
    },
  };
}

const sqliteQueries = sqliteSession();
const queries = pool ? postgresSession(pool) : sqliteQueries;

export const dbGet = <T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T | undefined> =>
  pool ? queries.get<T>(sql, params) : withSqliteLock(async () => await queries.get<T>(sql, params));

export const dbAll = <T extends Record<string, unknown>>(sql: string, params?: SqlParams): Promise<T[]> =>
  pool ? queries.all<T>(sql, params) : withSqliteLock(async () => await queries.all<T>(sql, params));

export const dbRun = (sql: string, params?: SqlParams): Promise<{ changes: number }> =>
  pool ? queries.run(sql, params) : withSqliteLock(async () => await queries.run(sql, params));

export async function dbTransaction<T>(operation: (session: DatabaseSession) => Promise<T>): Promise<T> {
  if (pool) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(postgresSession(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  if (!sqliteInstance) throw new Error('The SQLite database is not initialized.');
  if (sqliteTransaction.getStore()) return operation(sqliteQueries);
  const release = await (async () => {
    let unlock!: () => void;
    const previous = sqliteQueue;
    sqliteQueue = new Promise<void>((resolveQueue) => { unlock = resolveQueue; });
    await previous;
    return unlock;
  })();
  try {
    sqliteInstance.exec('BEGIN IMMEDIATE');
    const result = await sqliteTransaction.run(true, () => operation(sqliteQueries));
    sqliteInstance.exec('COMMIT');
    return result;
  } catch (error) {
    sqliteInstance.exec('ROLLBACK');
    throw error;
  } finally {
    release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
  } else {
    sqliteInstance?.close();
  }
}
