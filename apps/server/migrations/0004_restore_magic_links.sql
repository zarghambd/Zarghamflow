PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;

CREATE TABLE login_tokens_restored (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  token_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('magic_link','action')),
  target_type TEXT,
  target_id TEXT,
  action TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  ip_hash TEXT NOT NULL
);

INSERT INTO login_tokens_restored (
  id,email,token_hash,kind,target_type,target_id,action,expires_at,consumed_at,created_at,ip_hash
)
SELECT id,email,token_hash,kind,target_type,target_id,action,expires_at,consumed_at,created_at,ip_hash
FROM login_tokens
WHERE kind = 'action';

DROP TABLE login_tokens;
ALTER TABLE login_tokens_restored RENAME TO login_tokens;
CREATE INDEX login_tokens_email_time ON login_tokens(email, created_at);

COMMIT;
PRAGMA foreign_keys = ON;