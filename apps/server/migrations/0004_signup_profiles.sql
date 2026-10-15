ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_otps ADD COLUMN flow TEXT NOT NULL DEFAULT 'login' CHECK (flow IN ('signup','login'));
ALTER TABLE auth_otps ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE auth_otps ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS meetings_user_title_active ON meetings(user_id, lower(trim(title))) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS tasks_user_title_active ON tasks(user_id, lower(trim(title))) WHERE deleted_at IS NULL;
