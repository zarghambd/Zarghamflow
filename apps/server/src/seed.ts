import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { isPostgres, sqlite } from './db/index.js';

if (config.NODE_ENV === 'production') throw new Error('Refusing to seed sample records in production.');
if (isPostgres) throw new Error('The seed command only supports SQLite. Unset DATABASE_URL to seed a local development database.');
const seedEmail = config.OWNER_EMAIL ?? config.ADMIN_EMAIL;
if (!seedEmail) throw new Error('Set OWNER_EMAIL or ADMIN_EMAIL before seeding.');
const schemaExists = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
if (!schemaExists) {
  sqlite.exec(readFileSync(resolve(process.cwd(), 'migrations/0001_initial.sql'), 'utf8'));
  sqlite.prepare('INSERT INTO schema_migrations(name,applied_at) VALUES(?,?)').run('0001_initial.sql', new Date().toISOString());
}
const stamp = new Date().toISOString();
const userId = sqlite.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(seedEmail) as { id: string } | undefined;
const ownerId = userId?.id ?? randomUUID();
if (!userId) sqlite.prepare('INSERT INTO users(id,email,timezone,locale,settings_json,role,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(ownerId, seedEmail.toLowerCase(), Intl.DateTimeFormat().resolvedOptions().timeZone, 'en-GB', '{}', 'admin', 1, stamp, stamp);
const meetingId = randomUUID();
sqlite.prepare(`INSERT INTO meetings(id,user_id,title,date,start,end,client,contacts,type,location,notes,outcome,status,follow_up_date,created_at,updated_at,version)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(meetingId, ownerId, 'Acme discovery call', stamp.slice(0,10), '10:00', '10:45', 'Acme Ltd', 'Alex Morgan', 'Video', '', 'Discuss expansion priorities', '', 'Scheduled', null, stamp, stamp);
sqlite.prepare(`INSERT INTO tasks(id,user_id,title,due_date,due_time,priority,status,category,client,meeting_id,notes,created_at,updated_at,version)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(randomUUID(), ownerId, 'Send discovery summary', stamp.slice(0,10), null, 'High', 'To Do', 'Follow-up', 'Acme Ltd', meetingId, '', stamp, stamp);
sqlite.prepare('INSERT OR IGNORE INTO reminder_prefs(user_id,prefs_json,updated_at) VALUES(?,?,?)').run(ownerId, JSON.stringify({}), stamp);
console.log('Seeded owner account with one sample meeting and task.');
sqlite.close();
