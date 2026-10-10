PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, timezone TEXT NOT NULL DEFAULT 'UTC', locale TEXT NOT NULL DEFAULT 'en-GB',
  settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, date TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
  client TEXT NOT NULL DEFAULT '', contacts TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', outcome TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL, follow_up_date TEXT, reminder_lead_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS meetings_user_date ON meetings(user_id, date, start) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, due_date TEXT NOT NULL, due_time TEXT,
  priority TEXT NOT NULL, status TEXT NOT NULL, category TEXT NOT NULL, client TEXT NOT NULL DEFAULT '', meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  notes TEXT NOT NULL DEFAULT '', completed_at TEXT, reminder_lead_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS tasks_user_due ON tasks(user_id, due_date, due_time) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS reminder_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, prefs_json TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_type TEXT NOT NULL CHECK(target_type IN ('task','meeting','followup','digest','overdue')),
  target_id TEXT NOT NULL, fire_at TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('email','push')), lead INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','sent','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, sent_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dedupe_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(state, fire_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL DEFAULT 'Unknown device', ip_hash TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, revoked_at, expires_at);
CREATE TABLE IF NOT EXISTS login_tokens (
  id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, token_hash TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('magic_link','action')),
  target_type TEXT, target_id TEXT, action TEXT, expires_at TEXT NOT NULL, consumed_at TEXT, created_at TEXT NOT NULL, ip_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_tokens_email_time ON login_tokens(email, created_at);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE SET NULL, event TEXT NOT NULL, details_json TEXT NOT NULL DEFAULT '{}', ip_hash TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox_changes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
  operation TEXT NOT NULL, payload_json TEXT NOT NULL, client_updated_at TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT
);
