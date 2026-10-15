import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { DatabaseSession } from './db/index.js';
import { copySqliteData } from './sqlite-importer.js';

type SqliteDatabase = InstanceType<typeof Database>;
const migration = (name: string) => readFileSync(join(process.cwd(), 'migrations', name), 'utf8');
const databases: SqliteDatabase[] = [];

function createDatabase(): SqliteDatabase {
  const database = new Database(':memory:');
  database.exec(migration('0001_initial.sql'));
  database.exec(migration('0002_multi_user.sql'));
  database.exec(migration('0005_auth_rate_limits.sql'));
  databases.push(database);
  return database;
}

function session(database: SqliteDatabase): DatabaseSession {
  return {
    async exec(sql) {
      database.exec(sql);
    },
    async get<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return database.prepare(sql).get(...params) as T | undefined;
    },
    async all<T extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) {
      return database.prepare(sql).all(...params) as T[];
    },
    async run(sql: string, params: readonly unknown[] = []) {
      return { changes: database.prepare(sql).run(...params).changes };
    }
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('SQLite import', () => {
  it('copies linked planner rows while preserving IDs, versions, and row counts', async () => {
    const source = createDatabase();
    const target = createDatabase();
    source.prepare(`INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)`).run('user-1', 'owner@example.test', 'created', 'updated');
    source.prepare(`INSERT INTO meetings (id,user_id,title,date,start,"end",type,status,created_at,updated_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('meeting-1', 'user-1', 'Review', '2032-04-12', '09:00', '10:00', 'Video', 'Scheduled', 'created', 'updated', 7);
    source.prepare(`INSERT INTO tasks (id,user_id,title,due_date,priority,status,category,created_at,updated_at,version,meeting_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run('task-1', 'user-1', 'Prepare notes', '2032-04-12', 'High', 'To Do', 'Admin', 'created', 'updated', 9, 'meeting-1');

    const counts = await copySqliteData(source, session(target));

    expect(counts.find(({ table }) => table === 'users')?.rows).toBe(1);
    expect(counts.find(({ table }) => table === 'meetings')?.rows).toBe(1);
    expect(counts.find(({ table }) => table === 'tasks')?.rows).toBe(1);
    expect(target.prepare('SELECT id, version FROM meetings').get()).toEqual({ id: 'meeting-1', version: 7 });
    expect(target.prepare('SELECT id, version, meeting_id FROM tasks').get()).toEqual({ id: 'task-1', version: 9, meeting_id: 'meeting-1' });
  });

  it('supports dry-run transaction rollback without writing imported rows', async () => {
    const source = createDatabase();
    const target = createDatabase();
    source.prepare(`INSERT INTO users (id,email,created_at,updated_at) VALUES (?,?,?,?)`).run('user-1', 'owner@example.test', 'created', 'updated');

    target.exec('BEGIN');
    await copySqliteData(source, session(target));
    target.exec('ROLLBACK');

    expect(target.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 0 });
  });
});
