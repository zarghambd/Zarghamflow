CREATE TABLE IF NOT EXISTS email_change_otps (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_change_otps_user_time ON email_change_otps(user_id, created_at);
