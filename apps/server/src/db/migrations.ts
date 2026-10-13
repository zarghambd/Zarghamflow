import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbTransaction, isPostgres, sqlite } from './index.js';

const sqliteMigrations = ['0001_initial.sql', '0002_multi_user.sql', '0003_email_otp.sql', '0004_restore_magic_links.sql'];

export async function applyMigrations(): Promise<void> {
  if (!isPostgres) {
    sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = sqlite.prepare('SELECT name FROM schema_migrations WHERE name = ?');
    for (const name of sqliteMigrations) {
      if (applied.get(name)) continue;
      sqlite.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
      sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    }
    return;
  }

  await dbTransaction(async (database) => {
    await database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const migration = await database.get<{ name: string }>('SELECT name FROM schema_migrations WHERE name = ?', ['0001_postgres.sql']);
    if (migration) return;
    await database.exec(readFileSync(resolve(process.cwd(), 'migrations', '0001_postgres.sql'), 'utf8'));
    await database.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', ['0001_postgres.sql', new Date().toISOString()]);
  });
}
