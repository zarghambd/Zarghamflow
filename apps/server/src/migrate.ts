import 'dotenv/config';
import { sqlite } from './db/index.js';
import { applyMigrations } from './db/migrations.js';

try {
  applyMigrations();
  console.log('Database migrations are up to date.');
} finally {
  sqlite.close();
}
