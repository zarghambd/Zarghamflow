import 'dotenv/config';
import { closeDatabase } from './db/index.js';
import { applyMigrations } from './db/migrations.js';

try {
  await applyMigrations();
  console.log('Database migrations are up to date.');
} finally {
  await closeDatabase();
}
