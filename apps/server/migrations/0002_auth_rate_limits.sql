CREATE TABLE IF NOT EXISTS auth_rate_limits (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('signup', 'verify')),
  ip_hash TEXT NOT NULL,
  email_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_rate_limits_ip_time ON auth_rate_limits(kind, ip_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_rate_limits_email_time ON auth_rate_limits(kind, email_hash, created_at);
