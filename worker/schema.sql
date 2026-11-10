-- Study Quest friends sync — D1 schema
-- Apply with: npx wrangler d1 execute study-quest --remote --file schema.sql

CREATE TABLE IF NOT EXISTS members (
  room          TEXT    NOT NULL,
  user_id       TEXT    NOT NULL,
  name          TEXT    NOT NULL,
  secret_hash   TEXT    NOT NULL,
  today_seconds INTEGER NOT NULL DEFAULT 0,
  week_seconds  INTEGER NOT NULL DEFAULT 0,
  streak        INTEGER NOT NULL DEFAULT 0,
  level         INTEGER NOT NULL DEFAULT 1,
  total_seconds INTEGER NOT NULL DEFAULT 0,
  last_seen     INTEGER NOT NULL,
  PRIMARY KEY (room, user_id)
);

CREATE INDEX IF NOT EXISTS idx_members_room_seen ON members (room, last_seen);
