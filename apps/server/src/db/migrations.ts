import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dbTransaction, initializeDatabase, isPostgres, sqlite } from './index.js';

const sqliteMigrations = ['0001_initial.sql', '0002_multi_user.sql', '0003_email_otp.sql', '0004_restore_magic_links.sql'];
const migrationDirectories = [
  resolve(process.cwd(), 'migrations'),
  resolve(process.cwd(), '../../apps/server/migrations'),
  resolve(process.cwd(), 'apps/server/migrations'),
];

function readMigration(name: string): string {
  for (const directory of migrationDirectories) {
    const path = resolve(directory, name);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error(`Database migration file not found: ${name}`);
}

export async function applyMigrations(): Promise<void> {
  if (!isPostgres) {
    await initializeDatabase();
    sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = sqlite.prepare('SELECT name FROM schema_migrations WHERE name = ?');
    for (const name of sqliteMigrations) {
      if (applied.get(name)) continue;
      sqlite.exec(readMigration(name));
      sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
    }
    return;
  }

  await dbTransaction(async (database) => {
    await database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const migration = await database.get<{ name: string }>('SELECT name FROM schema_migrations WHERE name = ?', ['0001_postgres.sql']);
    if (migration) return;
    await database.exec(readMigration('0001_postgres.sql'));
    await database.run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', ['0001_postgres.sql', new Date().toISOString()]);
  });
}
