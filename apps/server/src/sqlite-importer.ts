import type Database from 'better-sqlite3';
import type { DatabaseSession } from './db/index.js';

type SqliteDatabase = InstanceType<typeof Database>;

const tables = [
  {
    name: 'users',
    required: true,
    columns: ['id', 'email', 'timezone', 'locale', 'settings_json', 'role', 'active', 'created_at', 'updated_at']
  },
  {
    name: 'meetings',
    required: true,
    columns: ['id', 'user_id', 'title', 'date', 'start', 'end', 'client', 'contacts', 'type', 'location', 'notes', 'outcome', 'status', 'follow_up_date', 'reminder_lead_json', 'created_at', 'updated_at', 'deleted_at', 'version']
  },
  {
    name: 'tasks',
    required: true,
    columns: ['id', 'user_id', 'title', 'due_date', 'due_time', 'priority', 'status', 'category', 'client', 'meeting_id', 'notes', 'completed_at', 'reminder_lead_json', 'created_at', 'updated_at', 'deleted_at', 'version']
  },
  { name: 'reminder_prefs', columns: ['user_id', 'prefs_json', 'updated_at'] },
  {
    name: 'reminders',
    columns: ['id', 'user_id', 'target_type', 'target_id', 'fire_at', 'channel', 'lead', 'state', 'attempts', 'last_error', 'sent_at', 'created_at', 'updated_at', 'dedupe_key']
  },
  { name: 'push_subscriptions', columns: ['id', 'user_id', 'endpoint', 'p256dh', 'auth', 'created_at', 'updated_at'] },
  { name: 'sessions', columns: ['id', 'user_id', 'token_hash', 'device', 'ip_hash', 'created_at', 'last_seen_at', 'expires_at', 'revoked_at'] },
  { name: 'login_tokens', columns: ['id', 'email', 'token_hash', 'kind', 'target_type', 'target_id', 'action', 'expires_at', 'consumed_at', 'created_at', 'ip_hash'] },
  { name: 'audit_log', columns: ['id', 'user_id', 'event', 'details_json', 'ip_hash', 'created_at'] },
  { name: 'outbox_changes', columns: ['id', 'user_id', 'entity', 'entity_id', 'operation', 'payload_json', 'client_updated_at', 'created_at', 'applied_at'] },
  { name: 'auth_rate_limits', columns: ['id', 'kind', 'ip_hash', 'email_hash', 'created_at'] }
] as const;

export type SqliteImportCount = { table: string; rows: number };

export async function copySqliteData(source: SqliteDatabase, target: DatabaseSession): Promise<SqliteImportCount[]> {
  const counts: SqliteImportCount[] = [];

  for (const table of tables) {
    const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table.name);
    if (!exists) {
      if ('required' in table && table.required) throw new Error(`SQLite source is missing required table "${table.name}".`);
      counts.push({ table: table.name, rows: 0 });
      continue;
    }

    const sourceColumns = new Set(
      (source.prepare(`PRAGMA table_info(${table.name})`).all() as Array<{ name: string }>).map((column) => column.name)
    );
    const missingColumns = table.columns.filter((column) => !sourceColumns.has(column));
    if (missingColumns.length) {
      throw new Error(`SQLite source table "${table.name}" is missing required columns: ${missingColumns.join(', ')}.`);
    }

    const columns = [...table.columns];
    const selected = columns.join(', ');
    const sourceCount = Number((source.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get() as { count: number }).count);
    const destinationBefore = Number((await target.get<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${table.name}`))?.count ?? 0);
    const insert = `INSERT INTO ${table.name} (${selected}) VALUES (${columns.map(() => '?').join(', ')})`;
    const rows = source.prepare(`SELECT ${selected} FROM ${table.name}`).iterate() as Iterable<Record<string, unknown>>;

    for (const row of rows) {
      await target.run(insert, columns.map((column) => row[column]));
    }

    const destinationAfter = Number((await target.get<{ count: string | number }>(`SELECT COUNT(*) AS count FROM ${table.name}`))?.count ?? 0);
    const copiedRows = destinationAfter - destinationBefore;
    if (copiedRows !== sourceCount) {
      throw new Error(`Row-count verification failed for "${table.name}": expected ${sourceCount}, copied ${copiedRows}.`);
    }
    counts.push({ table: table.name, rows: sourceCount });
  }

  return counts;
}
