import 'dotenv/config';
import { sqlite } from './db/index.js';
import { applyMigrations } from './db/migrations.js';
import { buildApp } from './app.js';
import { config } from './config.js';
import { startReminderScheduler } from './reminders/scheduler.js';

applyMigrations();
const app = await buildApp();
const scheduler = startReminderScheduler();
const server = await app.listen({ host: config.HOST, port: config.PORT });
app.log.info({ server }, 'ZarghamFlow server ready');

const stop = async (): Promise<void> => {
  clearInterval(scheduler);
  await app.close();
  sqlite.close();
};
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
