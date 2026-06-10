-- Initial schema — users, groups, memberships, media (PRD §6).
-- Applied with: wrangler d1 migrations apply cf-mediashare-db [--local|--remote]

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  -- Operators (deployers) can manage any media item, not just their own.
  is_admin   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE groups (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE memberships (
  user_id  TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE INDEX idx_memberships_group ON memberships (group_id);

CREATE TABLE media (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
  uploader_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('photo', 'video')),
  r2_key_original TEXT NOT NULL,
  r2_key_display  TEXT NOT NULL,
  r2_key_thumb    TEXT NOT NULL,
  width           INTEGER,
  height          INTEGER,
  duration        REAL,
  caption         TEXT,
  file_name       TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  -- ISO 8601 with milliseconds so cursor pagination rarely ties (id breaks ties).
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Gallery query: group-filtered, newest-first (F4).
CREATE INDEX idx_media_group_created ON media (group_id, created_at DESC, id DESC);
