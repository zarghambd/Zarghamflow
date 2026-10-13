import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function resolveDatabasePath(): string {
  const candidates = [
    process.env.DATABASE_PATH,
    resolve(process.cwd(), 'apps/server/data/zarghamflow.sqlite'),
    resolve(process.cwd(), 'apps/server/data/smoke.sqlite'),
    resolve(process.cwd(), 'data/zarghamflow.sqlite'),
    resolve(process.cwd(), '../server/data/zarghamflow.sqlite')
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  const fallback = candidates[0] ?? resolve(process.cwd(), 'apps/server/data/zarghamflow.sqlite');
  mkdirSync(dirname(fallback), { recursive: true });
  return fallback;
}

export const sqlite = new Database(resolveDatabasePath());
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');
