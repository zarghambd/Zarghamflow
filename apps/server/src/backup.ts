import 'dotenv/config';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { sqlite } from './db/index.js';
import { config } from './config.js';

const dbPath = resolve(process.cwd(), config.DATABASE_PATH);
const backupDir = resolve(process.cwd(), 'backups');
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(backupDir, `zarghamflow-${stamp}.sqlite`);
try {
  await sqlite.backup(destination);
  const cutoff = Date.now() - 14 * 24 * 60 * 60_000;
  for (const name of readdirSync(backupDir)) {
    const path = resolve(backupDir, name);
    if (name.startsWith('zarghamflow-') && statSync(path).mtimeMs < cutoff) unlinkSync(path);
  }
  console.log(JSON.stringify({ event: 'database_backup_created', source: dbPath, destination }));
} finally {
  sqlite.close();
}
