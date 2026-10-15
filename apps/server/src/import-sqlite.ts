import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { closeDatabase, dbTransaction, isPostgres } from './db/index.js';
import { applyMigrations } from './db/migrations.js';
import { copySqliteData, type SqliteImportCount } from './sqlite-importer.js';

class DryRunRollback extends Error {
  constructor(readonly counts: SqliteImportCount[]) {
    super('Dry run: imported rows were rolled back.');
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sourceArgument = args.filter((arg) => arg !== '--dry-run');

if (sourceArgument.length !== 1 || sourceArgument[0]?.startsWith('-')) {
  throw new Error('Usage: npm run db:import-sqlite -- <source.sqlite> [--dry-run]');
}
if (!isPostgres) throw new Error('DATABASE_URL must be set to a PostgreSQL destination before importing SQLite data.');

const sourcePath = resolve(process.env.INIT_CWD ?? process.cwd(), sourceArgument[0]!);
if (!existsSync(sourcePath)) throw new Error(`SQLite source file does not exist: ${sourcePath}`);

const { default: Sqlite } = await import('better-sqlite3');
const source = new Sqlite(sourcePath, { readonly: true, fileMustExist: true });

try {
  await applyMigrations();
  let counts: SqliteImportCount[];
  try {
    counts = await dbTransaction(async (target) => {
      const imported = await copySqliteData(source, target);
      if (dryRun) throw new DryRunRollback(imported);
      return imported;
    });
  } catch (error) {
    if (!dryRun || !(error instanceof DryRunRollback)) throw error;
    counts = error.counts;
  }

  for (const { table, rows } of counts) console.log(`${table}: ${rows}`);
  console.log(dryRun ? 'Dry run complete; imported rows were rolled back.' : 'SQLite import completed and row counts were verified.');
} finally {
  source.close();
  await closeDatabase();
}
