import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlite } from './index.js';

export function applyMigrations(): void {
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = sqlite.prepare('SELECT name FROM schema_migrations WHERE name = ?');
  const migrations = ['0001_initial.sql', '0002_multi_user.sql', '0003_email_otp.sql', '0004_restore_magic_links.sql'];
  for (const name of migrations) {
    if (applied.get(name)) continue;
    sqlite.exec(readFileSync(resolve(process.cwd(), 'migrations', name), 'utf8'));
    sqlite.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(name, new Date().toISOString());
  }
}
