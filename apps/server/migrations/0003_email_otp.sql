PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE login_tokens_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('email_otp','action')),
  target_type TEXT,
  target_id TEXT,
  action TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5)
);

INSERT INTO login_tokens_new (
  id,email,token_hash,kind,target_type,target_id,action,expires_at,consumed_at,created_at,ip_hash,attempts
)
SELECT id,email,token_hash,kind,target_type,target_id,action,expires_at,consumed_at,created_at,ip_hash,0
FROM login_tokens
WHERE kind = 'action';

DROP TABLE login_tokens;
ALTER TABLE login_tokens_new RENAME TO login_tokens;
CREATE INDEX login_tokens_email_time ON login_tokens(email, created_at);

COMMIT;
PRAGMA foreign_keys = ON;