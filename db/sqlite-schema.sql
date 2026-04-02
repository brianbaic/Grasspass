-- GrassPass SQLite Schema
-- Simplified from PostgreSQL: only 5 tables
-- app_state stores the authoritative JSON blob
-- Users, invites, sessions stored relationally for auth queries
-- All timestamps stored as ISO8601 TEXT strings

CREATE TABLE IF NOT EXISTS grasspass_app_state (
  state_key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS grasspass_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS grasspass_invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  note TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT,
  used_by_user_id TEXT
);

CREATE TABLE IF NOT EXISTS grasspass_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grasspass_backup_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS grasspass_sessions_user_id_idx
  ON grasspass_sessions (user_id);

CREATE INDEX IF NOT EXISTS grasspass_backup_runs_created_at_idx
  ON grasspass_backup_runs (created_at DESC);
