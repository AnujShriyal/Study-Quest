-- One-time additive migration for databases created with the original schema.
-- Existing undated totals remain in legacy columns but are not assigned to a
-- guessed calendar day; the member's next sync supplies dated buckets.
ALTER TABLE members ADD COLUMN daily_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE members ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE members ADD COLUMN today_date TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN cap_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN cap_week INTEGER NOT NULL DEFAULT 0;
